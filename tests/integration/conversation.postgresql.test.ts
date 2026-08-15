import { FakeResendServer } from '@test-support/fake-resend-server';
import { TEST_CONFIG } from '@test-support/setup';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveEmailV2ApiKey } from '@/lib/environment';
import { fixtures } from '../helpers/fixtures';
import { generateSvixId, signPayload } from '../helpers/svix';

describe('Private conversation API', () => {
  const resendServer = new FakeResendServer();
  const database = new Client({ connectionString: TEST_CONFIG.postgresql.url });
  const baseUrl = `${TEST_CONFIG.appBaseUrl}/api/conversations/v1`;
  const baseUrlV2 = `${TEST_CONFIG.appBaseUrl}/api/conversations/v2`;
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

  it('requires bearer authentication', async () => {
    const response = await fetch(`${baseUrl}?assignment=unassigned`);
    expect(response.status).toBe(401);
  });

  it('resolves the V2 API key alias with mixed-case precedence', () => {
    expect(resolveEmailV2ApiKey({ EMAIL_V2_API_KEY: 'fallback' })).toBe(
      'fallback',
    );
    expect(
      resolveEmailV2ApiKey({
        EMAIL_v2_API_KEY: 'preferred',
        EMAIL_V2_API_KEY: 'fallback',
      }),
    ).toBe('preferred');
    expect(
      resolveEmailV2ApiKey({
        EMAIL_v2_API_KEY: '',
        EMAIL_V2_API_KEY: 'fallback',
      }),
    ).toBe('fallback');
  });

  it('checks authentication and idempotency before malformed JSON', async () => {
    const unauthorized = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(unauthorized.status).toBe(401);

    const missingKey = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.conversationApiKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toEqual({
      error: 'A valid Idempotency-Key header is required',
    });

    const malformed = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('malformed-json'),
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: 'Request body must be valid JSON',
    });
  });

  it('serves local API documentation and transport fallbacks', async () => {
    const docs = await fetch(`${TEST_CONFIG.appBaseUrl}/docs`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('/docs/assets/swagger-ui-bundle.js');

    const asset = await fetch(
      `${TEST_CONFIG.appBaseUrl}/docs/assets/swagger-ui-bundle.js`,
    );
    expect(asset.status).toBe(200);
    const contract = await fetch(`${TEST_CONFIG.appBaseUrl}/openapi.json`);
    expect(contract.status).toBe(200);
    expect((await contract.json()).openapi).toBe('3.1.1');

    const unsupported = await fetch(`${baseUrl}/outbox`, {
      method: 'GET',
      headers: headers(),
    });
    expect(unsupported.status).toBe(404);
  });

  it('starts, continues, and hydrates a topic conversation', async () => {
    const created = await createConversation('create-booking-4821');
    expect(created.response.status).toBe(201);
    expect(created.body.message.deliveryState).toBe('unknown');
    expect(created.body.message.deliveredAt).toBeNull();
    expect(created.body.message.internetMessageId).toBe('<sent-1@resend.test>');
    expectRoutingAddress(created.body.message.replyTo);
    expect(resendServer.sends[0].input.reply_to).toBe(
      created.body.message.replyTo,
    );
    expect(created.body.message.replyToName).toBeNull();

    const replyResponse = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages`,
      {
        method: 'POST',
        headers: headers('reply-booking-4821'),
        body: JSON.stringify({ text: 'This is the reply.' }),
      },
    );
    const reply = await replyResponse.json();
    expect(replyResponse.status).toBe(201);
    expect(reply.message.parentMessageId).toBe(created.body.message.id);
    expect(reply.message.replyTo).toBe(created.body.message.replyTo);
    expect(reply.message.replyToName).toBeNull();
    expect(resendServer.sends[1].input.reply_to).toBe(
      created.body.message.replyTo,
    );
    expect(resendServer.sends[1].input.headers).toEqual({
      'In-Reply-To': '<sent-1@resend.test>',
      References: '<sent-1@resend.test>',
    });

    const hydratedResponse = await fetch(`${baseUrl}/topics/booking/4821`, {
      headers: headers(),
    });
    const hydrated = await hydratedResponse.json();
    expect(hydratedResponse.status).toBe(200);
    expect(hydrated.topic).toEqual({
      type: 'booking',
      externalId: '4821',
      title: 'Booking 4821',
    });
    expect(hydrated.messages).toHaveLength(2);
    expect(hydrated.replyToAddress).toBe(created.body.message.replyTo);
    expect(hydrated.messages[1].parentMessageId).toBe(hydrated.messages[0].id);
  });

  it('formats per-message Reply-To aliases for Resend', async () => {
    const created = await createConversation(
      'reply-to-alias-opening',
      createBody('Booking 4821', { replyToName: 'Brayan "Bookings"' }),
    );

    expect(created.response.status).toBe(201);
    expect(created.body.message.replyToName).toBe('Brayan "Bookings"');
    expect(created.body.message.replyTo).toMatch(/@replies\.example\.com$/);
    expect(resendServer.sends[0].input.reply_to).toBe(
      `"Brayan \\"Bookings\\"" <${created.body.message.replyTo}>`,
    );

    const replyResponse = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages`,
      {
        method: 'POST',
        headers: headers('reply-to-alias-reply'),
        body: JSON.stringify({
          text: 'This is the reply.',
          replyToName: 'Support Team',
        }),
      },
    );
    const reply = await replyResponse.json();

    expect(replyResponse.status).toBe(201);
    expect(reply.message.replyTo).toBe(created.body.message.replyTo);
    expect(reply.message.replyToName).toBe('Support Team');
    expect(resendServer.sends[1].input.reply_to).toBe(
      `Support Team <${created.body.message.replyTo}>`,
    );
  });

  it('rejects unsafe Reply-To aliases', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('unsafe-reply-to-alias'),
      body: JSON.stringify(
        createBody('Booking 4821', { replyToName: 'Brayan\r\nBcc: x@y.test' }),
      ),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'message.replyToName must be a header-safe string of at most 256 characters',
    );
  });

  it('requires the dedicated V2 credential and structured identities', async () => {
    const legacyCredential = await fetch(baseUrlV2, {
      method: 'POST',
      headers: headers('v2-legacy-credential'),
      body: JSON.stringify(v2CreateBody('v2-auth')),
    });
    expect(legacyCredential.status).toBe(401);

    const missingIdentity = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-missing-identity'),
      body: JSON.stringify(createBodyForTopic('v2-missing-identity')),
    });
    expect(missingIdentity.status).toBe(400);
    await expect(missingIdentity.json()).resolves.toEqual({
      error: 'message.from.address must be a valid email address',
    });
  });

  it('authorizes V2 addresses by role and preserves display aliases', async () => {
    const input = v2CreateBody('v2-identities');
    const denied = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-identities-denied'),
      body: JSON.stringify(input),
    });
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toEqual({
      error:
        'The requested email identity is not allowed. Contact the administrator.',
    });
    expect(resendServer.sends).toHaveLength(0);

    await allowAddress(V2_FROM, 'REPLY_TO');
    await allowAddress(V2_REPLY_TO, 'FROM');
    const wrongRoles = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-identities-wrong-roles'),
      body: JSON.stringify(input),
    });
    expect(wrongRoles.status).toBe(400);

    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(V2_REPLY_TO, 'REPLY_TO');
    const response = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-identities-allowed'),
      body: JSON.stringify(input),
    });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.message.from).toEqual({
      address: V2_FROM,
      name: "Fiona's Ice Cream",
    });
    expect(body.message.replyToName).toBe('Booking Team');
    expect(body.message.replyTo).toMatch(
      /^booking-replies\+c_[0-9a-f]{32}@mail-dev\.fionasicecream\.com$/,
    );
    expect(resendServer.sends[0].input.from).toBe(
      `Fiona's Ice Cream <${V2_FROM}>`,
    );
    expect(resendServer.sends[0].input.to).toEqual([
      'Person <person@example.com>',
      'Backup Person <backup@example.com>',
    ]);
    expect(resendServer.sends[0].input.reply_to).toBe(
      `Booking Team <${body.message.replyTo}>`,
    );
    expect(resendServer.sends[0].input.tags).toEqual([
      { name: 'category', value: 'booking_update' },
    ]);
  });

  it('promotes a V1 conversation on V2 reply and blocks later V1 writes', async () => {
    const created = await createConversation('v1-before-promotion');
    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(TEST_CONFIG.replyToBaseAddress, 'REPLY_TO');

    const promotedResponse = await fetch(
      `${baseUrlV2}/${created.body.conversationId.toUpperCase()}/messages`,
      {
        method: 'POST',
        headers: v2Headers('promote-v1-conversation'),
        body: JSON.stringify({
          text: 'Continue through V2.',
          from: { address: V2_FROM, name: 'Booking Team' },
          to: [
            { address: 'person@example.com', name: 'Person' },
            { address: 'backup@example.com', name: 'Backup Person' },
          ],
          replyTo: { address: TEST_CONFIG.replyToBaseAddress },
          tags: [{ name: 'category', value: 'conversation_reply' }],
        }),
      },
    );
    expect(promotedResponse.status).toBe(201);
    expect(resendServer.sends[1].input.to).toEqual([
      'Person <person@example.com>',
      'Backup Person <backup@example.com>',
    ]);
    expect(resendServer.sends[1].input.tags).toEqual([
      { name: 'category', value: 'conversation_reply' },
    ]);
    const { rows } = await database.query(
      'SELECT api_version, reply_to_requires_allowlist FROM email_conversations WHERE id = $1',
      [created.body.conversationId],
    );
    expect(rows[0]).toMatchObject({
      api_version: 'V2',
      reply_to_requires_allowlist: true,
    });

    const legacyReply = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages`,
      {
        method: 'POST',
        headers: headers('legacy-after-promotion'),
        body: JSON.stringify({ text: 'Legacy reply.' }),
      },
    );
    expect(legacyReply.status).toBe(409);
    await expect(legacyReply.json()).resolves.toEqual({
      error: 'Conversation requires API v2',
    });

    await database.query(
      'DELETE FROM email_address_allowlist_entries WHERE address = $1 AND role = $2',
      [TEST_CONFIG.replyToBaseAddress, 'REPLY_TO'],
    );
    const revokedReply = await fetch(
      `${baseUrlV2}/${created.body.conversationId}/messages`,
      {
        method: 'POST',
        headers: v2Headers('reply-after-revocation'),
        body: JSON.stringify({
          text: 'Should not send.',
          from: { address: V2_FROM },
          replyTo: { address: TEST_CONFIG.replyToBaseAddress },
        }),
      },
    );
    expect(revokedReply.status).toBe(400);
    expect(resendServer.sends).toHaveLength(2);
  });

  it('keeps an authorized V2 outbox intent frozen after revocation', async () => {
    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(V2_REPLY_TO, 'REPLY_TO');
    const queued = await fetch(`${baseUrlV2}/outbox`, {
      method: 'POST',
      headers: v2Headers('v2-frozen-outbox'),
      body: JSON.stringify(v2CreateBody('v2-frozen-outbox')),
    });
    expect(queued.status).toBe(202);

    await database.query('TRUNCATE TABLE email_address_allowlist_entries');
    const drained = await fetch(`${baseUrlV2}/outbox/drain`, {
      method: 'POST',
      headers: drainHeaders(),
      body: JSON.stringify({ limit: 100 }),
    });
    expect(drained.status).toBe(200);
    await expect(drained.json()).resolves.toMatchObject({ accepted: 1 });
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].inputs[0].from).toBe(
      `Fiona's Ice Cream <${V2_FROM}>`,
    );
    expect(resendServer.batches[0].inputs[0].to).toEqual([
      'Person <person@example.com>',
      'Backup Person <backup@example.com>',
    ]);
    expect(resendServer.batches[0].inputs[0].tags).toEqual([
      { name: 'category', value: 'booking_update' },
    ]);
  });

  it('rejects a different allowed Reply-To base for a V2 conversation', async () => {
    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(V2_REPLY_TO, 'REPLY_TO');
    await allowAddress('support@mail-dev.fionasicecream.com', 'REPLY_TO');
    const createdResponse = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-fixed-base-opening'),
      body: JSON.stringify(v2CreateBody('v2-fixed-base')),
    });
    const created = await createdResponse.json();

    const reply = await fetch(
      `${baseUrlV2}/${created.conversationId}/messages`,
      {
        method: 'POST',
        headers: v2Headers('v2-different-base'),
        body: JSON.stringify({
          text: 'Wrong base.',
          from: { address: V2_FROM },
          replyTo: { address: 'support@mail-dev.fionasicecream.com' },
        }),
      },
    );
    expect(reply.status).toBe(400);
  });

  it('routes ancestry-free inbound mail through a persisted V2 Reply-To base', async () => {
    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(V2_REPLY_TO, 'REPLY_TO');
    const createdResponse = await fetch(baseUrlV2, {
      method: 'POST',
      headers: v2Headers('v2-custom-routing-opening'),
      body: JSON.stringify(v2CreateBody('v2-custom-routing')),
    });
    const created = await createdResponse.json();
    const event = fixtures.email.received({
      data: {
        email_id: 'em_v2_custom_routing',
        message_id: '<v2-custom-routing@example.com>',
        from: 'person@example.com',
        to: [created.message.replyTo],
        subject: 'Re: V2 custom routing',
        created_at: '2026-07-28T15:00:00.000Z',
      },
    });
    resendServer.received.set(event.data.email_id, {
      id: event.data.email_id,
      message_id: event.data.message_id as string,
      from: event.data.from,
      to: event.data.to,
      subject: event.data.subject,
      created_at: event.data.created_at,
      text: 'Inbound through custom base',
      html: null,
      headers: {},
      reply_to: [],
    });
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      event,
      generateSvixId(),
    );
    const webhook = await fetch(webhookUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    expect(webhook.status).toBe(200);
    const { rows } = await database.query(
      'SELECT conversation_id FROM email_messages WHERE resend_email_id = $1',
      [event.data.email_id],
    );
    expect(rows[0].conversation_id).toBe(created.conversationId);

    const alias = await database.query<{ routing_token: string }>(
      `INSERT INTO email_conversation_routing_aliases
        (conversation_id, routing_token, base_address)
       VALUES ($1, gen_random_uuid(), 'legacy-replies@mail-dev.fionasicecream.com')
       RETURNING routing_token`,
      [created.conversationId],
    );
    await database.query(
      `INSERT INTO email_conversation_routing_aliases
        (conversation_id, routing_token, base_address)
       VALUES ($1, $2, 'older-replies@mail-dev.fionasicecream.com')`,
      [created.conversationId, alias.rows[0].routing_token],
    );
    for (const [index, local] of [
      'legacy-replies',
      'older-replies',
    ].entries()) {
      const token = alias.rows[0].routing_token.replaceAll('-', '');
      const replyTo = `${local}+c_${token}@mail-dev.fionasicecream.com`;
      const aliasEvent = fixtures.email.received({
        data: {
          email_id: `em_v2_routing_alias_${index}`,
          message_id: `<v2-routing-alias-${index}@example.com>`,
          from: 'person@example.com',
          to: [replyTo],
          subject: 'Re: V2 routing alias',
          created_at: `2026-07-28T15:0${index + 1}:00.000Z`,
        },
      });
      resendServer.received.set(aliasEvent.data.email_id, {
        id: aliasEvent.data.email_id,
        message_id: aliasEvent.data.message_id as string,
        from: aliasEvent.data.from,
        to: aliasEvent.data.to,
        subject: aliasEvent.data.subject,
        created_at: aliasEvent.data.created_at,
        text: 'Inbound through routing alias',
        html: null,
        headers: {},
        reply_to: [],
      });
      const aliasSigned = signPayload(
        TEST_CONFIG.webhookSecret,
        aliasEvent,
        generateSvixId(),
      );
      const aliasWebhook = await fetch(webhookUrl, {
        method: 'POST',
        headers: aliasSigned.headers,
        body: aliasSigned.body,
      });
      expect(aliasWebhook.status).toBe(200);
      const aliasMessage = await database.query(
        'SELECT conversation_id FROM email_messages WHERE resend_email_id = $1',
        [aliasEvent.data.email_id],
      );
      expect(aliasMessage.rows[0].conversation_id).toBe(created.conversationId);
    }
  });

  it('claims an unassigned conversation through the mirrored V2 API', async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO email_conversations
        (title, subject, participant_address, last_message_at, updated_at)
       VALUES ('V2 inbound question', 'V2 inbound question', 'person@example.com', now(), now())
       RETURNING id`,
    );
    const assigned = await fetch(`${baseUrlV2}/${rows[0].id}`, {
      method: 'PATCH',
      headers: v2Headers(),
      body: JSON.stringify({
        topic: {
          type: 'booking',
          externalId: 'v2-assignment',
          title: 'V2 assignment',
        },
      }),
    });
    expect(assigned.status).toBe(200);

    const byTopic = await fetch(`${baseUrlV2}/topics/booking/v2-assignment`, {
      headers: v2Headers(),
    });
    expect(byTopic.status).toBe(200);

    const legacyMutation = await fetch(`${baseUrl}/${rows[0].id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        topic: {
          type: 'booking',
          externalId: 'legacy-assignment',
          title: 'Legacy assignment',
        },
      }),
    });
    expect(legacyMutation.status).toBe(409);
    await expect(legacyMutation.json()).resolves.toEqual({
      error: 'Conversation requires API v2',
    });

    const alreadyV2 = await database.query<{ id: string }>(
      `INSERT INTO email_conversations
        (api_version, title, subject, participant_address, last_message_at, updated_at)
       VALUES ('V2', 'V2 reply first', 'V2 reply first', 'person@example.com', now(), now())
       RETURNING id`,
    );
    const assignAfterV2Reply = await fetch(
      `${baseUrlV2}/${alreadyV2.rows[0].id}`,
      {
        method: 'PATCH',
        headers: v2Headers(),
        body: JSON.stringify({
          topic: {
            type: 'booking',
            externalId: 'v2-reply-before-assignment',
            title: 'V2 reply before assignment',
          },
        }),
      },
    );
    expect(assignAfterV2Reply.status).toBe(200);
  });

  it('reconciles delivery webhooks that arrive before send acceptance', async () => {
    const eventCreatedAt = '2026-07-21T11:00:00.000Z';
    const event = fixtures.email.delivered();
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      {
        ...event,
        created_at: eventCreatedAt,
        data: { ...event.data, email_id: 'sent-1' },
      },
      generateSvixId(),
    );
    const webhook = await fetch(webhookUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });

    const created = await createConversation('early-delivered');
    const hydratedResponse = await fetch(`${baseUrl}/topics/booking/4821`, {
      headers: headers(),
    });
    const hydrated = await hydratedResponse.json();

    expect(webhook.status).toBe(200);
    expect(created.response.status).toBe(201);
    expect(created.body.message.state).toBe('accepted');
    expect(created.body.message.deliveryState).toBe('delivered');
    expect(created.body.message.deliveredAt).toBe(eventCreatedAt);
    expect(hydrated.messages[0].deliveryState).toBe('delivered');
  });

  it('retries temporarily unavailable sent threading metadata', async () => {
    resendServer.sentMetadataFailuresRemaining = 2;

    const created = await createConversation('metadata-retry');

    expect(created.response.status).toBe(201);
    expect(created.body.message.internetMessageId).toBe('<sent-1@resend.test>');
    expect(resendServer.sentMetadataRequestCount).toBe(3);
  });

  it('does not send twice when an idempotency key is retried', async () => {
    const first = await createConversation('same-request');
    const second = await createConversation('same-request');

    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(200);
    expect(resendServer.sends).toHaveLength(1);
    expect(second.body.message.id).toBe(first.body.message.id);
  });

  it('coordinates concurrent requests with the same idempotency key', async () => {
    const [first, second] = await Promise.all([
      createConversation('concurrent-request'),
      createConversation('concurrent-request'),
    ]);

    expect([first.response.status, second.response.status].sort()).toEqual([
      200, 201,
    ]);
    expect(first.body.message.id).toBe(second.body.message.id);
    expect(resendServer.sends).toHaveLength(1);
  });

  it('keeps failed idempotent requests failed on retry', async () => {
    resendServer.failNextSendStatus = 422;
    const first = await createConversation('failed-request');
    const second = await createConversation('failed-request');

    expect(first.response.status).toBe(502);
    expect(second.response.status).toBe(502);
    expect(first.body.message.state).toBe('failed');
    expect(second.body.message.id).toBe(first.body.message.id);
  });

  it('re-opens a topic conversation after its opening send failed', async () => {
    resendServer.failNextSendStatus = 422;
    const failed = await createConversation('reopen-original');
    expect(failed.response.status).toBe(502);
    expect(failed.body.message.state).toBe('failed');

    const reopenedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('reopen-retry'),
      body: JSON.stringify({
        topic: { type: 'booking', externalId: '4821', title: 'Booking 4821' },
        participant: { email: 'corrected@example.com', name: 'Person' },
        message: { text: 'Opening message' },
      }),
    });
    const reopened = await reopenedResponse.json();
    expect(reopenedResponse.status).toBe(201);
    expect(reopened.conversationId).toBe(failed.body.conversationId);
    expect(reopened.message.state).toBe('accepted');
    expect(reopened.message.replyTo).toBe(failed.body.message.replyTo);
    expect(resendServer.sends).toHaveLength(1);
    expect(resendServer.sends[0].input.to).toEqual(['corrected@example.com']);

    const conflict = await createConversation('reopen-conflict');
    expect(conflict.response.status).toBe(409);
  });

  it('rejects header-unsafe and oversized topic titles', async () => {
    const crlfResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('crlf-title'),
      body: JSON.stringify(
        createBody('Booking 4821\r\nBcc: victim@example.com'),
      ),
    });
    expect(crlfResponse.status).toBe(400);

    const oversizedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('oversized-title'),
      body: JSON.stringify(createBody('x'.repeat(256))),
    });
    expect(oversizedResponse.status).toBe(400);
    expect(resendServer.sends).toHaveLength(0);
  });

  it('rejects reuse of an idempotency key with another payload', async () => {
    await createConversation('conflicting-request');
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('conflicting-request'),
      body: JSON.stringify(createBody('Different title')),
    });
    expect(response.status).toBe(409);
  });

  it('queues an opening message without calling Resend', async () => {
    const queued = await queueConversation('queued-opening', 'queued-1');

    expect(queued.response.status).toBe(202);
    expect(queued.body.message).toMatchObject({
      direction: 'outbound',
      state: 'pending',
      resendEmailId: null,
      replyTo: expect.any(String),
      text: 'Opening message',
    });
    expect(resendServer.sends).toHaveLength(0);
    expectRoutingAddress(queued.body.message.replyTo);
    const { rows } = await database.query(
      `SELECT message.state, entry.message_id
       FROM email_outbox_entries AS entry
       INNER JOIN email_messages AS message ON message.id = entry.message_id`,
    );
    expect(rows).toEqual([
      { state: 'PENDING', message_id: queued.body.message.id },
    ]);

    const duplicate = await queueConversation('queued-opening', 'queued-1');
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.body.message.id).toBe(queued.body.message.id);
    expect(resendServer.sends).toHaveLength(0);
  });

  it('keeps synchronous and outbox idempotency operations distinct', async () => {
    await queueConversation('delivery-mode-key', 'mode-1');

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers('delivery-mode-key'),
      body: JSON.stringify(createBodyForTopic('mode-1')),
    });

    expect(response.status).toBe(409);
    expect(resendServer.sends).toHaveLength(0);
  });

  it('requires the dedicated key and validates the drain limit', async () => {
    const unauthorized = await fetch(`${baseUrl}/outbox/drain`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ limit: 100 }),
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await fetch(`${baseUrl}/outbox/drain`, {
      method: 'POST',
      headers: drainHeaders(),
      body: JSON.stringify({ limit: 101 }),
    });
    expect(invalid.status).toBe(400);
  });

  it('drains queued messages through one ordered Resend batch', async () => {
    const first = await queueConversation('batch-first', 'batch-1', {
      replyToName: 'Batch One',
    });
    const second = await queueConversation('batch-second', 'batch-2');

    const drained = await drainOutbox(100);

    expect(drained.response.status).toBe(200);
    expect(drained.body).toMatchObject({
      claimed: 2,
      accepted: 2,
      failed: 0,
      retryScheduled: 0,
    });
    expect(
      drained.body.results.map(
        (result: { messageId: string }) => result.messageId,
      ),
    ).toEqual([first.body.message.id, second.body.message.id]);
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].inputs.map(({ to }) => to[0])).toEqual([
      'person@example.com',
      'person@example.com',
    ]);
    expect(
      resendServer.batches[0].inputs.map(({ reply_to }) => reply_to),
    ).toEqual([
      `Batch One <${first.body.message.replyTo}>`,
      second.body.message.replyTo,
    ]);
    const { rows } = await database.query(
      `SELECT state, resend_email_id
       FROM email_messages
       ORDER BY email_created_at, id`,
    );
    expect(rows).toEqual([
      { state: 'ACCEPTED', resend_email_id: 'batch-1' },
      { state: 'ACCEPTED', resend_email_id: 'batch-2' },
    ]);
    expect(
      Number(
        (
          await database.query(
            'SELECT COUNT(*) AS count FROM email_outbox_entries',
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  });

  it('queues and batch-sends a reply with frozen threading headers', async () => {
    const created = await createConversation('reply-parent');
    const response = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages/outbox`,
      {
        method: 'POST',
        headers: headers('queued-reply'),
        body: JSON.stringify({ text: 'Queued reply' }),
      },
    );
    const queued = await response.json();

    expect(response.status).toBe(202);
    expect(queued.message.state).toBe('pending');
    expect(resendServer.sends).toHaveLength(1);

    const drained = await drainOutbox(100);
    expect(drained.body.accepted).toBe(1);
    expect(resendServer.batches[0].inputs[0].headers).toEqual({
      'In-Reply-To': '<sent-1@resend.test>',
      References: '<sent-1@resend.test>',
    });
    expect(resendServer.batches[0].inputs[0].reply_to).toBe(
      created.body.message.replyTo,
    );
  });

  it('retries the exact batch after acceptance followed by disconnect', async () => {
    const queued = await queueConversation('ambiguous-batch', 'ambiguous-1');
    resendServer.disconnectAfterNextBatch = true;

    const first = await drainOutbox(100);
    expect(first.body).toMatchObject({ claimed: 1, retryScheduled: 1 });
    expect(resendServer.batches).toHaveLength(1);
    await database.query(
      `UPDATE email_outbox_batches
       SET next_attempt_at = now() - interval '1 second',
           lease_token = uuidv7(),
           lease_until = now() - interval '1 second'`,
    );

    const second = await drainOutbox(100);
    expect(second.body).toMatchObject({ claimed: 1, accepted: 1 });
    expect(second.body.results[0]).toMatchObject({
      messageId: queued.body.message.id,
      resendEmailId: 'batch-1',
    });
    expect(resendServer.batches).toHaveLength(1);
  });

  it('does not resend a retry batch after the idempotency safety window', async () => {
    await queueConversation('expired-batch', 'expired-batch');
    resendServer.disconnectAfterNextBatch = true;
    expect((await drainOutbox(100)).body.retryScheduled).toBe(1);
    await database.query(
      `UPDATE email_outbox_batches
       SET first_attempt_at = now() - interval '24 hours',
           next_attempt_at = now() - interval '1 second'`,
    );

    const drained = await drainOutbox(100);

    expect(drained.body).toMatchObject({ claimed: 1, indeterminate: 1 });
    expect(resendServer.batches).toHaveLength(1);
  });

  it('treats a provider batch payload mismatch as indeterminate', async () => {
    await queueConversation('mismatch-batch', 'mismatch-batch');
    resendServer.failNextBatchStatus = 500;
    expect((await drainOutbox(100)).body.retryScheduled).toBe(1);
    await database.query(
      "UPDATE email_outbox_batches SET next_attempt_at = now() - interval '1 second'",
    );
    resendServer.failNextBatchStatus = 409;
    resendServer.failNextBatchCode = 'invalid_idempotent_request';

    const drained = await drainOutbox(100);

    expect(drained.body).toMatchObject({ claimed: 1, indeterminate: 1 });
  });

  it('rejects malformed successful batch metadata without accepting messages', async () => {
    await queueConversation('malformed-batch', 'malformed-batch');
    resendServer.malformedNextBatchResponse = true;

    const first = await drainOutbox(100);
    expect(first.body.retryScheduled).toBe(1);
    const pending = await database.query(
      'SELECT state, resend_email_id FROM email_messages',
    );
    expect(pending.rows).toEqual([{ state: 'PENDING', resend_email_id: null }]);
    await database.query(
      "UPDATE email_outbox_batches SET next_attempt_at = now() - interval '1 second'",
    );

    expect((await drainOutbox(100)).body.accepted).toBe(1);
    expect(resendServer.batches).toHaveLength(1);
  });

  it('treats quota rejection as terminal rather than retryable', async () => {
    await queueConversation('quota-batch', 'quota-batch');
    resendServer.failNextBatchStatus = 429;
    resendServer.failNextBatchCode = 'monthly_quota_exceeded';

    const drained = await drainOutbox(100);

    expect(drained.body).toMatchObject({ claimed: 1, failed: 1 });
    const { rows } = await database.query(
      'SELECT COUNT(*)::int AS count FROM email_outbox_batches',
    );
    expect(rows[0].count).toBe(0);
  });

  it('marks every message failed after a permanent batch error', async () => {
    await queueConversation('failed-batch-1', 'failed-batch-1');
    await queueConversation('failed-batch-2', 'failed-batch-2');
    resendServer.failNextBatchStatus = 422;
    resendServer.failNextBatchCode = 'validation_error';

    const drained = await drainOutbox(100);

    expect(drained.body).toMatchObject({ claimed: 2, failed: 2 });
    const { rows } = await database.query(
      'SELECT DISTINCT state FROM email_messages',
    );
    expect(rows).toEqual([{ state: 'FAILED' }]);
  });

  it('lets concurrent drains claim disjoint batches', async () => {
    await Promise.all([
      queueConversation('concurrent-batch-1', 'concurrent-batch-1'),
      queueConversation('concurrent-batch-2', 'concurrent-batch-2'),
      queueConversation('concurrent-batch-3', 'concurrent-batch-3'),
      queueConversation('concurrent-batch-4', 'concurrent-batch-4'),
    ]);

    const [first, second] = await Promise.all([drainOutbox(2), drainOutbox(2)]);

    expect(first.body.claimed + second.body.claimed).toBe(4);
    expect(resendServer.batches).toHaveLength(2);
    expect(new Set(resendServer.sends.map(({ id }) => id)).size).toBe(4);
  });

  it('claims and finalizes the maximum batch size', async () => {
    await database.query(
      `WITH conversation AS (
         INSERT INTO email_conversations
           (topic_type, external_topic_id, title, subject,
            participant_address, last_message_at, updated_at)
         VALUES
           ('bulk', 'maximum', 'Maximum batch', 'Maximum batch',
            'bulk@example.com', now(), now())
         RETURNING id
       ), messages AS (
         INSERT INTO email_messages
           (conversation_id, direction, state,
            reference_internet_message_ids, from_address, to_address, subject,
            text_body, email_created_at, idempotency_key, request_hash,
            updated_at)
         SELECT conversation.id, 'OUTBOUND', 'PENDING', '{}',
                'mailbox@example.com', 'bulk@example.com', 'Maximum batch',
                'Bulk message ' || item, now(), 'bulk-message-' || item,
                repeat('a', 64), now()
         FROM conversation CROSS JOIN generate_series(1, 100) AS item
         RETURNING id
       )
       INSERT INTO email_outbox_entries (message_id)
       SELECT id FROM messages`,
    );

    const drained = await drainOutbox(100);

    expect(drained.body).toMatchObject({ claimed: 100, accepted: 100 });
    expect(resendServer.batches).toHaveLength(1);
    expect(resendServer.batches[0].inputs).toHaveLength(100);
  });

  it('assigns an unassigned conversation to a topic', async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO email_conversations
        (title, subject, participant_address, last_message_at, updated_at)
       VALUES ('Inbound question', 'Inbound question', 'person@example.com', now(), now())
       RETURNING id`,
    );
    const response = await fetch(`${baseUrl}/${rows[0].id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        topic: { type: 'booking', externalId: '9911', title: 'Booking 9911' },
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.topic.externalId).toBe('9911');
  });

  it('assigns an unassigned conversation only once under concurrency', async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO email_conversations
        (title, subject, participant_address, last_message_at, updated_at)
       VALUES ('Concurrent assignment', 'Concurrent assignment', 'person@example.com', now(), now())
       RETURNING id`,
    );
    const assign = (externalId: string) =>
      fetch(`${baseUrl}/${rows[0].id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({
          topic: {
            type: 'booking',
            externalId,
            title: `Booking ${externalId}`,
          },
        }),
      });
    const [first, second] = await Promise.all([assign('one'), assign('two')]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it('opens a conversation awaiting the participant', async () => {
    const created = await createConversation('state-open');
    const response = await fetch(`${baseUrl}/${created.body.conversationId}`, {
      headers: headers(),
    });
    const body = await response.json();
    expect(body.state).toBe('awaiting_participant');
    expect(body.awaitingReply).toBe(false);
    expect(typeof body.stateChangedAt).toBe('string');
  });

  it('awaits us on inbound mail and keeps the first waiting timestamp', async () => {
    const created = await createConversation('state-inbound');
    await sendInbound(created.body.message.replyTo, 'state-inbound-1');
    const first = await readState(created.body.conversationId);
    expect(first.state).toBe('awaiting_us');
    expect(first.awaitingReply).toBe(true);

    await sendInbound(created.body.message.replyTo, 'state-inbound-2');
    const second = await readState(created.body.conversationId);
    expect(second.state).toBe('awaiting_us');
    expect(second.stateChangedAt).toBe(first.stateChangedAt);
  });

  it('reopens a concluded conversation on inbound mail', async () => {
    const created = await createConversation('state-reopen');
    await setState(created.body.conversationId, 'concluded');
    expect((await readState(created.body.conversationId)).state).toBe(
      'concluded',
    );

    await sendInbound(created.body.message.replyTo, 'state-reopen-inbound');
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_us',
    );
  });

  it('returns the turn to the participant on a V1 reply', async () => {
    const created = await createConversation('state-v1-reply');
    await sendInbound(created.body.message.replyTo, 'state-v1-reply-inbound');
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_us',
    );

    const reply = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages`,
      {
        method: 'POST',
        headers: headers('state-v1-reply-send'),
        body: JSON.stringify({ text: 'Replying now.' }),
      },
    );
    expect(reply.status).toBe(201);
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_participant',
    );
  });

  it('returns the turn to the participant on a V1 enqueued reply', async () => {
    const created = await createConversation('state-v1-enqueue');
    await sendInbound(created.body.message.replyTo, 'state-v1-enqueue-inbound');
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_us',
    );

    const reply = await fetch(
      `${baseUrl}/${created.body.conversationId}/messages/outbox`,
      {
        method: 'POST',
        headers: headers('state-v1-enqueue-send'),
        body: JSON.stringify({ text: 'Queued reply.' }),
      },
    );
    expect(reply.status).toBe(202);
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_participant',
    );
  });

  it('returns the turn to the participant on V2 replies', async () => {
    await allowAddress(V2_FROM, 'FROM');
    await allowAddress(V2_REPLY_TO, 'REPLY_TO');
    for (const [index, path] of ['messages', 'messages/outbox'].entries()) {
      const createdResponse = await fetch(baseUrlV2, {
        method: 'POST',
        headers: v2Headers(`state-v2-open-${index}`),
        body: JSON.stringify(v2CreateBody(`state-v2-${index}`)),
      });
      const created = await createdResponse.json();
      await sendInbound(created.message.replyTo, `state-v2-inbound-${index}`);
      expect((await readState(created.conversationId, true)).state).toBe(
        'awaiting_us',
      );

      const reply = await fetch(
        `${baseUrlV2}/${created.conversationId}/${path}`,
        {
          method: 'POST',
          headers: v2Headers(`state-v2-reply-${index}`),
          body: JSON.stringify({
            text: 'Replying now.',
            from: { address: V2_FROM },
            replyTo: { address: V2_REPLY_TO },
          }),
        },
      );
      expect([201, 202]).toContain(reply.status);
      expect((await readState(created.conversationId, true)).state).toBe(
        'awaiting_participant',
      );
    }
  });

  it('terminates a conversation when its outbound message bounces', async () => {
    const created = await createConversation('state-bounce');
    const bounce = fixtures.email.bounced({
      data: {
        email_id: created.body.message.resendEmailId,
        from: 'mailbox@example.com',
        to: ['person@example.com'],
        subject: 'Booking 4821',
        created_at: '2026-08-15T09:00:00.000Z',
        bounce: {
          type: 'hard',
          subType: 'permanent',
          message: 'Mailbox not found',
          diagnosticCode: ['550 5.1.1 User unknown'],
        },
      },
    });
    await postWebhook(bounce);
    expect((await readState(created.body.conversationId)).state).toBe(
      'terminated',
    );
  });

  it('keeps a terminated conversation terminated through inbound mail', async () => {
    const created = await createConversation('state-sticky');
    await setState(created.body.conversationId, 'terminated');

    await sendInbound(created.body.message.replyTo, 'state-sticky-inbound');
    expect((await readState(created.body.conversationId)).state).toBe(
      'terminated',
    );

    await setState(created.body.conversationId, 'awaiting_us');
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_us',
    );
  });

  it('leaves conversations untouched when a direct email bounces', async () => {
    const created = await createConversation('state-direct-bounce');
    // A DIRECT message carries no conversation, so the bounce must terminate
    // nothing even though a conversation exists alongside it.
    await database.query(
      `INSERT INTO email_messages
        (kind, direction, state, delivery_state, resend_email_id,
         from_address, to_address, subject, email_created_at, updated_at)
       VALUES ('DIRECT', 'OUTBOUND', 'ACCEPTED', 'UNKNOWN', 'em_direct_only_bounce',
               'mailbox@example.com', 'person@example.com', 'Direct', now(), now())`,
    );
    const bounce = fixtures.email.bounced({
      data: {
        email_id: 'em_direct_only_bounce',
        from: 'mailbox@example.com',
        to: ['person@example.com'],
        subject: 'Direct',
        created_at: '2026-08-15T09:05:00.000Z',
        bounce: { type: 'hard', subType: 'permanent', message: 'Nope' },
      },
    });
    await postWebhook(bounce);

    const direct = await database.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM email_messages WHERE resend_email_id = $1',
      ['em_direct_only_bounce'],
    );
    expect(direct.rows[0].delivery_state).toBe('BOUNCED');
    expect((await readState(created.body.conversationId)).state).toBe(
      'awaiting_participant',
    );
  });

  it('summarizes conversation counts and filters by state', async () => {
    const waiting = await createConversation('state-summary-waiting');
    await sendInbound(waiting.body.message.replyTo, 'state-summary-inbound');
    const settled = await createConversation(
      'state-summary-settled',
      createBodyForTopic('summary-settled'),
    );

    const all = await readSummary();
    expect(all.counts).toEqual({
      awaiting_us: 1,
      awaiting_participant: 1,
      concluded: 0,
      terminated: 0,
    });
    expect(all.count).toBe(2);
    expect(all.conversations).toHaveLength(2);

    const queue = await readSummary('?state=awaiting_us');
    expect(queue.count).toBe(queue.counts.awaiting_us);
    expect(queue.conversations).toHaveLength(1);
    expect(queue.conversations[0].id).toBe(waiting.body.conversationId);
    expect(queue.conversations[0].awaitingReply).toBe(true);
    expect(queue.conversations[0].participant.address).toBe(
      'person@example.com',
    );
    expect(queue.conversations[0].subject).toBe('Booking 4821');
    // The summary is metadata only; message payloads stay on the conversation read.
    expect(queue.conversations[0]).not.toHaveProperty('lastMessage');
    expect(queue.conversations[0]).not.toHaveProperty('text');
    expect(queue.conversations[0]).not.toHaveProperty('html');

    const combined = await readSummary(
      '?state=awaiting_us,awaiting_participant',
    );
    expect(combined.count).toBe(2);
    const repeated = await readSummary(
      '?state=awaiting_us&state=awaiting_participant',
    );
    expect(repeated.count).toBe(2);
    const uppercase = await readSummary('?state=AWAITING_US');
    expect(uppercase.count).toBe(1);

    expect(settled.body.conversationId).toBeDefined();
  });

  it('orders the summary by oldest state change and paginates', async () => {
    const first = await createConversation('state-page-1');
    const second = await createConversation(
      'state-page-2',
      createBodyForTopic('page-2'),
    );
    const third = await createConversation(
      'state-page-3',
      createBodyForTopic('page-3'),
    );
    const expected = [
      first.body.conversationId,
      second.body.conversationId,
      third.body.conversationId,
    ];

    const page = await readSummary('?limit=2');
    expect(page.conversations.map((entry: { id: string }) => entry.id)).toEqual(
      expected.slice(0, 2),
    );
    expect(page.page.hasMore).toBe(true);

    const next = await readSummary(
      `?limit=2&before=${encodeURIComponent(page.page.before)}`,
    );
    expect(next.conversations.map((entry: { id: string }) => entry.id)).toEqual(
      expected.slice(2),
    );
    expect(next.page.hasMore).toBe(false);
  });

  it('rejects an unknown summary state and cursor', async () => {
    const unknownState = await fetch(`${baseUrlV2}/summary?state=nonsense`, {
      headers: v2Headers(),
    });
    expect(unknownState.status).toBe(400);
    const badCursor = await fetch(`${baseUrlV2}/summary?before=not-a-cursor`, {
      headers: v2Headers(),
    });
    expect(badCursor.status).toBe(400);
  });

  it('sets conversation state by hand and stays idempotent', async () => {
    const created = await createConversation('state-manual');
    await sendInbound(created.body.message.replyTo, 'state-manual-inbound');
    expect((await readSummary('?state=awaiting_us')).count).toBe(1);

    const first = await setState(created.body.conversationId, 'concluded');
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('concluded');
    expect(first.body.awaitingReply).toBe(false);
    expect((await readSummary('?state=awaiting_us')).count).toBe(0);

    const repeat = await setState(created.body.conversationId, 'CONCLUDED');
    expect(repeat.status).toBe(200);
    expect(repeat.body.state).toBe('concluded');
  });

  it('validates the conversation state request', async () => {
    const created = await createConversation('state-validation');
    const invalid = await setState(created.body.conversationId, 'nonsense');
    expect(invalid.status).toBe(400);

    const empty = await fetch(
      `${baseUrlV2}/${created.body.conversationId}/state`,
      { method: 'POST', headers: v2Headers(), body: JSON.stringify({}) },
    );
    expect(empty.status).toBe(400);

    const missing = await fetch(
      `${baseUrlV2}/01a00428-22f0-7e98-8881-097423751599/state`,
      {
        method: 'POST',
        headers: v2Headers(),
        body: JSON.stringify({ state: 'concluded' }),
      },
    );
    expect(missing.status).toBe(404);
  });

  it('requires the V2 credential on the state routes', async () => {
    const created = await createConversation('state-auth');
    for (const request of [
      fetch(`${baseUrlV2}/summary`),
      fetch(`${baseUrlV2}/summary`, { headers: headers() }),
      fetch(`${baseUrlV2}/${created.body.conversationId}/state`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ state: 'concluded' }),
      }),
    ]) {
      expect((await request).status).toBe(401);
    }
  });

  async function postWebhook(event: unknown) {
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      event,
      generateSvixId(),
    );
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    expect(response.status).toBe(200);
    return response;
  }

  async function sendInbound(replyTo: string, id: string) {
    const event = fixtures.email.received({
      data: {
        email_id: `em_${id}`,
        message_id: `<${id}@example.com>`,
        from: 'person@example.com',
        to: [replyTo],
        subject: 'Re: Booking 4821',
        created_at: new Date().toISOString(),
      },
    });
    resendServer.received.set(event.data.email_id, {
      id: event.data.email_id,
      message_id: event.data.message_id as string,
      from: event.data.from,
      to: event.data.to,
      subject: event.data.subject,
      created_at: event.data.created_at,
      text: 'Inbound message',
      html: null,
      headers: {},
      reply_to: [],
    });
    return postWebhook(event);
  }

  async function readState(conversationId: string, v2 = false) {
    const response = await fetch(
      `${v2 ? baseUrlV2 : baseUrl}/${conversationId}`,
      { headers: v2 ? v2Headers() : headers() },
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  async function readSummary(query = '') {
    const response = await fetch(`${baseUrlV2}/summary${query}`, {
      headers: v2Headers(),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function setState(conversationId: string, state: string) {
    const response = await fetch(`${baseUrlV2}/${conversationId}/state`, {
      method: 'POST',
      headers: v2Headers(),
      body: JSON.stringify({ state }),
    });
    return { status: response.status, body: await response.json() };
  }

  async function createConversation(
    idempotencyKey: string,
    body = createBody(),
  ) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(idempotencyKey),
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  }

  async function queueConversation(
    idempotencyKey: string,
    externalId: string,
    messageOverrides: Record<string, string> = {},
  ) {
    const response = await fetch(`${baseUrl}/outbox`, {
      method: 'POST',
      headers: headers(idempotencyKey),
      body: JSON.stringify(createBodyForTopic(externalId, messageOverrides)),
    });
    return { response, body: await response.json() };
  }

  async function drainOutbox(limit: number) {
    const response = await fetch(`${baseUrl}/outbox/drain`, {
      method: 'POST',
      headers: drainHeaders(),
      body: JSON.stringify({ limit }),
    });
    return { response, body: await response.json() };
  }

  async function allowAddress(address: string, role: 'FROM' | 'REPLY_TO') {
    await database.query(
      `INSERT INTO email_address_allowlist_entries (address, role)
       VALUES (lower($1), $2::"EmailAddressRole")
       ON CONFLICT (address, role) DO NOTHING`,
      [address, role],
    );
  }
});

const V2_FROM = 'booking@mail-dev.fionasicecream.com';
const V2_REPLY_TO = 'booking-replies@mail-dev.fionasicecream.com';

function headers(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_CONFIG.conversationApiKey}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

function drainHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_CONFIG.outboxDrainApiKey}`,
    'content-type': 'application/json',
  };
}

function v2Headers(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

function expectRoutingAddress(value: string) {
  const [local, domain] = TEST_CONFIG.replyToBaseAddress.split('@');
  const escapeRegex = (part: string) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(value).toMatch(
    new RegExp(
      `^${escapeRegex(local)}\\+c_[0-9a-f]{32}@${escapeRegex(domain)}$`,
    ),
  );
}

function createBody(
  title = 'Booking 4821',
  messageOverrides: Record<string, string> = {},
) {
  return {
    topic: { type: 'booking', externalId: '4821', title },
    participant: { email: 'person@example.com', name: 'Person' },
    message: { text: 'Opening message', ...messageOverrides },
  };
}

function createBodyForTopic(
  externalId: string,
  messageOverrides: Record<string, string> = {},
) {
  return {
    topic: {
      type: 'booking',
      externalId,
      title: `Booking ${externalId}`,
    },
    participant: { email: 'person@example.com', name: 'Person' },
    message: { text: 'Opening message', ...messageOverrides },
  };
}

function v2CreateBody(externalId: string) {
  return {
    topic: {
      type: 'booking',
      externalId,
      title: `Booking ${externalId}`,
    },
    participant: { email: 'person@example.com', name: 'Person' },
    message: {
      text: 'Opening message',
      from: { address: V2_FROM, name: "Fiona's Ice Cream" },
      to: [
        { address: 'person@example.com', name: 'Person' },
        { address: 'backup@example.com', name: 'Backup Person' },
      ],
      replyTo: { address: V2_REPLY_TO, name: 'Booking Team' },
      tags: [{ name: 'category', value: 'booking_update' }],
    },
  };
}
