import { FakeResendServer } from '@test-support/fake-resend-server';
import { TEST_CONFIG } from '@test-support/setup';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtures } from '../helpers/fixtures';
import { generateSvixId, signPayload } from '../helpers/svix';

describe('Direct email API v2', () => {
  const resendServer = new FakeResendServer();
  const database = new Client({ connectionString: TEST_CONFIG.postgresql.url });
  const baseUrl = `${TEST_CONFIG.appBaseUrl}/api/emails/v2`;
  const webhookUrl = `${TEST_CONFIG.appBaseUrl}/api/webhooks/resend/v1`;

  beforeAll(async () => {
    await database.connect();
    resendServer.reset();
    await resendServer.start(TEST_CONFIG.resendApiBaseUrl);
  });

  afterAll(async () => {
    await database.end();
    await resendServer.close();
  });

  beforeEach(async () => {
    await database.query('TRUNCATE TABLE resend_wh_emails');
    await database.query('TRUNCATE TABLE email_outbox_batches CASCADE');
    await database.query('TRUNCATE TABLE email_messages CASCADE');
    await database.query('TRUNCATE TABLE email_conversations CASCADE');
    await database.query('TRUNCATE TABLE email_address_allowlist_entries');
    resendServer.reset();
  });

  it('checks authentication and idempotency before parsing JSON', async () => {
    const unauthorized = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(unauthorized.status).toBe(401);

    const missingKey = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.conversationV2ApiKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(missingKey.status).toBe(400);

    const malformed = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('malformed-direct-email'),
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: 'Request body must be valid JSON',
    });
  });

  it('validates content and rejects Reply-To', async () => {
    const missingSubject = await send('missing-subject', { subject: '' });
    expect(missingSubject.status).toBe(400);

    const missingContent = await send('missing-content', {
      text: undefined,
      html: undefined,
    });
    expect(missingContent.status).toBe(400);

    const replyTo = await send('direct-reply-to', {
      replyTo: { address: 'replies@example.com' },
    });
    expect(replyTo.status).toBe(400);
    await expect(replyTo.json()).resolves.toEqual({
      error: 'replyTo is not supported for direct email',
    });

    const invalidText = await send('invalid-direct-text', { text: 42 });
    expect(invalidText.status).toBe(400);
    await expect(invalidText.json()).resolves.toEqual({
      error: 'text must be a nonempty string when provided',
    });
  });

  it('requires an exact FROM allowlist entry', async () => {
    await allowAddress('system@example.com', 'REPLY_TO');
    const denied = await send('wrong-role');
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toEqual({
      error:
        'The requested email identity is not allowed. Contact the administrator.',
    });
    expect(resendServer.sends).toHaveLength(0);
  });

  it('persists intent before sending without conversation or reply metadata', async () => {
    await allowAddress('system@example.com', 'FROM');
    const pause = resendServer.pauseNextSend();
    const request = send('direct-success');
    await pause.arrival;

    const pending = await database.query(
      `SELECT id, kind, conversation_id, state, from_address, from_name,
              to_address, to_name, reply_to_address, parent_message_id,
              in_reply_to_internet_message_id, reference_internet_message_ids
       FROM email_messages WHERE idempotency_key = $1`,
      ['direct-success'],
    );
    const conversations = await database.query(
      'SELECT count(*)::int AS count FROM email_conversations',
    );
    expect(pending.rows[0]).toMatchObject({
      kind: 'DIRECT',
      conversation_id: null,
      state: 'PENDING',
      from_address: 'system@example.com',
      from_name: 'System Team',
      to_address: 'person@example.com',
      to_name: 'External Person',
      reply_to_address: null,
      parent_message_id: null,
      in_reply_to_internet_message_id: null,
      reference_internet_message_ids: [],
    });
    expect(conversations.rows[0].count).toBe(0);

    pause.release();
    const response = await request;
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body).toEqual({
      email: {
        id: pending.rows[0].id,
        state: 'accepted',
        resendEmailId: 'sent-1',
      },
    });
    expect(resendServer.sends[0]).toMatchObject({
      idempotencyKey: `email/${pending.rows[0].id}`,
      input: {
        from: 'System Team <system@example.com>',
        to: ['External Person <person@example.com>'],
        subject: 'Verify your email',
        text: 'Use the verification link.',
        html: '<p>Use the verification link.</p>',
      },
    });
    expect(resendServer.sends[0].input.reply_to).toBeUndefined();
    expect(resendServer.sends[0].input.headers).toBeUndefined();
    expect(resendServer.sentMetadataRequestCount).toBe(0);
  });

  it('makes sequential and concurrent retries idempotent', async () => {
    await allowAddress('system@example.com', 'FROM');
    const [first, concurrent] = await Promise.all([
      send('direct-idempotent'),
      send('direct-idempotent'),
    ]);
    expect([first.status, concurrent.status].sort()).toEqual([200, 201]);
    const firstBody = await first.json();
    const concurrentBody = await concurrent.json();
    expect(firstBody.email.id).toBe(concurrentBody.email.id);
    expect(resendServer.sends).toHaveLength(1);

    const replay = await send('direct-idempotent');
    expect(replay.status).toBe(200);
    expect((await replay.json()).email.id).toBe(firstBody.email.id);

    const changed = await send('direct-idempotent', {
      subject: 'Changed subject',
    });
    expect(changed.status).toBe(409);
    expect(resendServer.sends).toHaveLength(1);
  });

  it('keeps direct and conversation operations in one idempotency namespace', async () => {
    await allowAddress('system@example.com', 'FROM');
    const direct = await send('cross-operation-key');
    expect(direct.status).toBe(201);

    const conversation = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/conversations/v1`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.conversationApiKey}`,
          'content-type': 'application/json',
          'idempotency-key': 'cross-operation-key',
        },
        body: JSON.stringify({
          topic: {
            type: 'account',
            externalId: 'cross-operation',
            title: 'Cross operation',
          },
          participant: { email: 'person@example.com' },
          message: { text: 'Conversation message' },
        }),
      },
    );
    expect(conversation.status).toBe(409);
    expect(resendServer.sends).toHaveLength(1);
  });

  it('persists known and ambiguous provider failures without retrying', async () => {
    await allowAddress('system@example.com', 'FROM');
    resendServer.failNextSendStatus = 422;
    const failed = await send('direct-failed');
    expect(failed.status).toBe(502);
    expect((await failed.json()).email.state).toBe('failed');
    const failedReplay = await send('direct-failed');
    expect(failedReplay.status).toBe(502);

    resendServer.disconnectAfterNextSend = true;
    const indeterminate = await send('direct-indeterminate');
    expect(indeterminate.status).toBe(502);
    expect((await indeterminate.json()).email.state).toBe('indeterminate');
    const indeterminateReplay = await send('direct-indeterminate');
    expect(indeterminateReplay.status).toBe(502);
    expect(resendServer.sends).toHaveLength(1);

    resendServer.malformedNextSendResponse = true;
    const malformed = await send('direct-malformed-success');
    expect(malformed.status).toBe(502);
    expect((await malformed.json()).email.state).toBe('indeterminate');
    expect(resendServer.sends).toHaveLength(2);
  });

  it('projects delivery webhooks onto direct email intent', async () => {
    await allowAddress('system@example.com', 'FROM');
    const sent = await send('direct-delivered');
    expect(sent.status).toBe(201);

    const event = fixtures.email.delivered();
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      {
        ...event,
        data: { ...event.data, email_id: 'sent-1' },
      },
      generateSvixId(),
    );
    const webhook = await fetch(webhookUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    expect(webhook.status).toBe(200);

    const projected = await database.query(
      `SELECT delivery_state FROM email_messages
       WHERE idempotency_key = 'direct-delivered'`,
    );
    expect(projected.rows[0].delivery_state).toBe('DELIVERED');
  });

  async function allowAddress(address: string, role: 'FROM' | 'REPLY_TO') {
    await database.query(
      `INSERT INTO email_address_allowlist_entries (address, role)
       VALUES ($1, $2::"EmailAddressRole")`,
      [address, role],
    );
  }

  function headers(idempotencyKey: string) {
    return {
      authorization: `Bearer ${TEST_CONFIG.conversationV2ApiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
  }

  function send(
    idempotencyKey: string,
    overrides: Record<string, unknown> = {},
  ) {
    const body: Record<string, unknown> = {
      from: { address: ' System@Example.com ', name: 'System Team' },
      to: { address: ' Person@Example.com ', name: 'External Person' },
      subject: 'Verify your email',
      text: 'Use the verification link.',
      html: '<p>Use the verification link.</p>',
      ...overrides,
    };
    return fetch(baseUrl, {
      method: 'POST',
      headers: headers(idempotencyKey),
      body: JSON.stringify(body),
    });
  }
});
