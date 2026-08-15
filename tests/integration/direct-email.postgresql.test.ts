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
  const outboxUrl = `${baseUrl}/outbox`;
  const drainUrl = `${outboxUrl}/drain`;
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
        authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
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

  it('protects direct outbox enqueue and drain with separate credentials', async () => {
    const unauthorizedEnqueue = await fetch(outboxUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(unauthorizedEnqueue.status).toBe(401);

    const missingKey = await fetch(outboxUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(missingKey.status).toBe(400);

    const emailCredentialDrain = await drain(TEST_CONFIG.emailV2ApiKey, {});
    expect(emailCredentialDrain.status).toBe(401);

    const drainCredential = await drain(TEST_CONFIG.outboxDrainApiKey, {});
    expect(drainCredential.status).toBe(200);
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
              to_address, to_name, to_recipients, tags, reply_to_address,
              parent_message_id, in_reply_to_internet_message_id,
              reference_internet_message_ids
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
      to_recipients: [
        { address: 'person@example.com', name: 'External Person' },
        { address: 'second@example.com', name: 'Second Person' },
      ],
      tags: [{ name: 'category', value: 'confirm_email' }],
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
        to: [
          'External Person <person@example.com>',
          'Second Person <second@example.com>',
        ],
        subject: 'Verify your email',
        text: 'Use the verification link.',
        html: '<p>Use the verification link.</p>',
        tags: [{ name: 'category', value: 'confirm_email' }],
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

  it('atomically enqueues and drains direct email without synchronous recovery', async () => {
    await allowAddress('system@example.com', 'FROM');
    const payload = {
      to: [
        { address: ' Person@Example.com ', name: 'External Person' },
        { address: ' Second@Example.com ', name: 'Second Person' },
      ],
      tags: [{ name: 'category', value: 'queued_verification' }],
    };

    const queued = await enqueue('direct-outbox-success', payload);
    const queuedBody = await queued.json();
    expect(queued.status).toBe(202);
    expect(queuedBody.email).toMatchObject({
      state: 'pending',
      resendEmailId: null,
    });
    expect(resendServer.sends).toHaveLength(0);
    expect(resendServer.batches).toHaveLength(0);

    const stored = await database.query(
      `SELECT message.kind, message.conversation_id, message.state,
              message.reply_to_address, message.in_reply_to_internet_message_id,
              entry.message_id
       FROM email_messages AS message
       INNER JOIN email_outbox_entries AS entry ON entry.message_id = message.id
       WHERE message.idempotency_key = $1`,
      ['direct-outbox-success'],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      kind: 'DIRECT',
      conversation_id: null,
      state: 'PENDING',
      reply_to_address: null,
      in_reply_to_internet_message_id: null,
      message_id: queuedBody.email.id,
    });

    const pendingReplay = await enqueue('direct-outbox-success', payload);
    expect(pendingReplay.status).toBe(202);
    expect((await pendingReplay.json()).email.id).toBe(queuedBody.email.id);
    expect(resendServer.sends).toHaveLength(0);

    const drained = await drain(TEST_CONFIG.outboxDrainApiKey, { limit: 10 });
    const drainBody = await drained.json();
    expect(drained.status).toBe(200);
    expect(drainBody).toMatchObject({
      claimed: 1,
      accepted: 1,
      failed: 0,
      retryScheduled: 0,
      indeterminate: 0,
    });
    expect(drainBody.results[0].messageId).toBe(queuedBody.email.id);
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].inputs[0]).toMatchObject({
      from: 'System Team <system@example.com>',
      to: [
        'External Person <person@example.com>',
        'Second Person <second@example.com>',
      ],
      subject: 'Verify your email',
      tags: [{ name: 'category', value: 'queued_verification' }],
    });
    expect(resendServer.batches[0].inputs[0].reply_to).toBeUndefined();
    expect(resendServer.batches[0].inputs[0].headers).toBeUndefined();
    expect(resendServer.sentMetadataRequestCount).toBe(0);

    const acceptedReplay = await enqueue('direct-outbox-success', payload);
    expect(acceptedReplay.status).toBe(200);
    expect(await acceptedReplay.json()).toEqual({
      email: {
        id: queuedBody.email.id,
        state: 'accepted',
        resendEmailId: 'batch-1',
      },
    });

    const event = fixtures.email.delivered();
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      { ...event, data: { ...event.data, email_id: 'batch-1' } },
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
       WHERE idempotency_key = 'direct-outbox-success'`,
    );
    expect(projected.rows[0].delivery_state).toBe('DELIVERED');
  });

  it('coordinates concurrent direct enqueue retries', async () => {
    await allowAddress('system@example.com', 'FROM');
    const [first, second] = await Promise.all([
      enqueue('direct-outbox-concurrent'),
      enqueue('direct-outbox-concurrent'),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await first.json()).email.id).toBe((await second.json()).email.id);

    const stored = await database.query(
      `SELECT count(*)::int AS messages,
              count(entry.message_id)::int AS entries
       FROM email_messages AS message
       LEFT JOIN email_outbox_entries AS entry ON entry.message_id = message.id
       WHERE message.idempotency_key = 'direct-outbox-concurrent'`,
    );
    expect(stored.rows[0]).toEqual({ messages: 1, entries: 1 });
    const changed = await enqueue('direct-outbox-concurrent', {
      subject: 'Changed queued subject',
    });
    expect(changed.status).toBe(409);
    expect(resendServer.batches).toHaveLength(0);
  });

  it('keeps synchronous and queued direct email idempotency distinct', async () => {
    await allowAddress('system@example.com', 'FROM');
    const queued = await enqueue('direct-mode-conflict');
    expect(queued.status).toBe(202);
    const synchronousConflict = await send('direct-mode-conflict');
    expect(synchronousConflict.status).toBe(409);

    const synchronous = await send('direct-mode-conflict-reverse');
    expect(synchronous.status).toBe(201);
    const queuedConflict = await enqueue('direct-mode-conflict-reverse');
    expect(queuedConflict.status).toBe(409);
    expect(resendServer.sends).toHaveLength(1);
  });

  it('freezes direct outbox authorization and supports existing drain aliases', async () => {
    await allowAddress('system@example.com', 'FROM');
    const queued = await enqueue('direct-revoked-outbox');
    expect(queued.status).toBe(202);

    await database.query(
      `DELETE FROM email_address_allowlist_entries
       WHERE address = 'system@example.com' AND role = 'FROM'`,
    );
    const replay = await enqueue('direct-revoked-outbox');
    expect(replay.status).toBe(202);
    const deniedNewIntent = await enqueue('direct-revoked-outbox-new');
    expect(deniedNewIntent.status).toBe(400);

    const drained = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/conversations/v2/outbox/drain`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.outboxDrainApiKey}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(drained.status).toBe(200);
    expect((await drained.json()).accepted).toBe(1);
    expect(resendServer.batches[0].inputs[0].reply_to).toBeUndefined();
  });

  it('drains direct and conversation intent in one ordered email batch', async () => {
    await allowAddress('system@example.com', 'FROM');
    await allowAddress(TEST_CONFIG.replyToBaseAddress, 'REPLY_TO');
    const conversation = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/conversations/v2/outbox`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
          'content-type': 'application/json',
          'idempotency-key': 'mixed-conversation-outbox',
        },
        body: JSON.stringify({
          topic: {
            type: 'account',
            externalId: 'mixed-outbox',
            title: 'Mixed outbox',
          },
          participant: { email: 'conversation@example.com' },
          message: {
            text: 'Conversation email',
            from: { address: 'system@example.com' },
            replyTo: { address: TEST_CONFIG.replyToBaseAddress },
          },
        }),
      },
    );
    expect(conversation.status).toBe(202);
    const direct = await enqueue('mixed-direct-outbox');
    expect(direct.status).toBe(202);

    const drained = await drain(TEST_CONFIG.outboxDrainApiKey, { limit: 2 });
    expect(drained.status).toBe(200);
    expect((await drained.json()).accepted).toBe(2);
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].inputs).toHaveLength(2);
    expect(resendServer.batches[0].inputs[0].to).toEqual([
      'conversation@example.com',
    ]);
    expect(resendServer.batches[0].inputs[0].reply_to).toBeDefined();
    expect(resendServer.batches[0].inputs[1].to).toEqual([
      'External Person <person@example.com>',
    ]);
    expect(resendServer.batches[0].inputs[1].reply_to).toBeUndefined();
  });

  it('returns terminal direct outbox state on enqueue replay', async () => {
    await allowAddress('system@example.com', 'FROM');
    const queued = await enqueue('direct-outbox-failed');
    expect(queued.status).toBe(202);
    resendServer.failNextBatchStatus = 422;

    const drained = await drain(TEST_CONFIG.outboxDrainApiKey, {});
    expect(drained.status).toBe(200);
    expect((await drained.json()).failed).toBe(1);

    const replay = await enqueue('direct-outbox-failed');
    expect(replay.status).toBe(502);
    expect(await replay.json()).toMatchObject({
      error: 'Email was not confirmed as sent',
      email: { state: 'failed', resendEmailId: null },
    });
  });

  it('retries direct intent through another shared drain alias', async () => {
    await allowAddress('system@example.com', 'FROM');
    const queued = await enqueue('direct-outbox-retry');
    expect(queued.status).toBe(202);
    resendServer.disconnectAfterNextBatch = true;

    const firstDrain = await drain(TEST_CONFIG.outboxDrainApiKey, {});
    expect(firstDrain.status).toBe(200);
    const firstResult = await firstDrain.json();
    expect(firstResult.retryScheduled).toBe(1);
    expect(resendServer.batches).toHaveLength(1);
    const providerKey = resendServer.batches[0].idempotencyKey;
    const providerPayload = resendServer.batches[0].inputs;

    await database.query(
      'UPDATE email_outbox_batches SET next_attempt_at = now()',
    );
    const retry = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/conversations/v2/outbox/drain`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.outboxDrainApiKey}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).accepted).toBe(1);
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].idempotencyKey).toBe(providerKey);
    expect(resendServer.batches[0].inputs).toEqual(providerPayload);
  });

  it('keeps direct and conversation operations in one idempotency namespace', async () => {
    await allowAddress('system@example.com', 'FROM');
    const direct = await send('cross-operation-key');
    expect(direct.status).toBe(201);

    await allowAddress(TEST_CONFIG.replyToBaseAddress, 'REPLY_TO');
    const conversation = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/conversations/v2`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
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
          message: {
            text: 'Conversation message',
            from: { address: 'system@example.com' },
            replyTo: { address: TEST_CONFIG.replyToBaseAddress },
          },
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
      authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
  }

  function send(
    idempotencyKey: string,
    overrides: Record<string, unknown> = {},
  ) {
    return fetch(baseUrl, {
      method: 'POST',
      headers: headers(idempotencyKey),
      body: JSON.stringify(directBody(idempotencyKey, overrides)),
    });
  }

  function enqueue(
    idempotencyKey: string,
    overrides: Record<string, unknown> = {},
  ) {
    return fetch(outboxUrl, {
      method: 'POST',
      headers: headers(idempotencyKey),
      body: JSON.stringify(directBody(idempotencyKey, overrides)),
    });
  }

  function drain(credential: string, body: Record<string, unknown>) {
    return fetch(drainUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  function directBody(
    idempotencyKey: string,
    overrides: Record<string, unknown>,
  ) {
    return {
      from: { address: ' System@Example.com ', name: 'System Team' },
      to: { address: ' Person@Example.com ', name: 'External Person' },
      subject: 'Verify your email',
      text: 'Use the verification link.',
      html: '<p>Use the verification link.</p>',
      ...(idempotencyKey === 'direct-success'
        ? {
            to: [
              { address: ' Person@Example.com ', name: 'External Person' },
              { address: ' Second@Example.com ', name: 'Second Person' },
            ],
            tags: [{ name: 'category', value: 'confirm_email' }],
          }
        : {}),
      ...overrides,
    };
  }
});
