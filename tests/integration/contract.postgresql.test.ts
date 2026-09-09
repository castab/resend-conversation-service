import { readFileSync } from 'node:fs';
import { FakeResendServer } from '@test-support/fake-resend-server';
import { assertAttachmentsMode } from '@test-support/helpers/app-mode';
import { TEST_CONFIG } from '@test-support/setup';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Validates live responses against public/openapi.json. The other suites assert
 * on fields they already know about, so a schema that drifts from the runtime
 * stays green there; only validating against the published contract catches it.
 *
 * Runs against whichever application is under test, so it covers the contract
 * with attachments both disabled and enabled.
 */
describe('OpenAPI conformance', () => {
  const resendServer = new FakeResendServer();
  const database = new Client({ connectionString: TEST_CONFIG.postgresql.url });
  const spec = JSON.parse(readFileSync('public/openapi.json', 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...spec, $id: 'openapi' });

  const attachmentsEnabled =
    (process.env.ATTACHMENTS_ENABLED ?? '').toLowerCase() === 'true';

  function conform(schema: string, value: unknown) {
    const validate = ajv.compile({
      $ref: `openapi#/components/schemas/${schema}`,
    });
    if (!validate(value)) {
      const detail = (validate.errors ?? [])
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      throw new Error(`response does not match ${schema}: ${detail}`);
    }
  }

  beforeAll(async () => {
    await assertAttachmentsMode();
    await database.connect();
    resendServer.reset();
    await resendServer.start(TEST_CONFIG.resendApiBaseUrl);
  });

  afterAll(async () => {
    await database.end();
    await resendServer.close();
  });

  beforeEach(async () => {
    await database.query('TRUNCATE TABLE email_messages CASCADE');
    await database.query('TRUNCATE TABLE email_conversations CASCADE');
    await database.query('TRUNCATE TABLE email_address_allowlist_entries');
    await database.query(
      `INSERT INTO email_address_allowlist_entries (address, role)
       VALUES ('system@example.com', 'FROM'), ($1, 'REPLY_TO')`,
      [TEST_CONFIG.replyToBaseAddress],
    );
    resendServer.reset();
  });

  it('serves conversation reads and send results that match the contract', async () => {
    const created = await post(
      '/api/conversations/v2',
      `contract-${Date.now()}`,
      conversationBody(),
    );
    expect(created.status).toBe(201);
    conform('SendResult', created.body);

    const conversationId = (created.body as { conversationId: string })
      .conversationId;
    const read = await get(`/api/conversations/v2/${conversationId}`);
    expect(read.status).toBe(200);
    conform('Conversation', read.body);

    conform(
      'ConversationStateSummary',
      (await get('/api/conversations/v2/summary')).body,
    );
    conform(
      'UnassignedConversationList',
      (await get('/api/conversations/v2?assignment=unassigned')).body,
    );
    conform('HealthResponse', (await get('/api/health/v2')).body);
  });

  it('serves direct email results that match the contract', async () => {
    const sent = await post('/api/emails/v2', `contract-direct-${Date.now()}`, {
      from: { address: 'system@example.com', name: 'System' },
      to: { address: 'person@example.com' },
      subject: 'Contract check',
      text: 'body',
    });
    expect(sent.status).toBe(201);
    conform('DirectEmailSendResult', sent.body);
  });

  it('serves a drain result that matches the contract', async () => {
    const response = await fetch(
      `${TEST_CONFIG.appBaseUrl}/api/emails/v2/outbox/drain`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CONFIG.outboxDrainApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as object;
    conform('DrainOutboxResult', body);
    // The attachment lane is additive: present only when the feature is on.
    expect(Object.hasOwn(body, 'attachments')).toBe(attachmentsEnabled);
  });

  it('omits attachment metadata from messages unless the feature is enabled', async () => {
    const created = await post(
      '/api/conversations/v2',
      `contract-flag-${Date.now()}`,
      conversationBody(),
    );
    expect(created.status).toBe(201);
    const conversationId = (created.body as { conversationId: string })
      .conversationId;
    const read = await get(`/api/conversations/v2/${conversationId}`);
    for (const message of (read.body as { messages: object[] }).messages) {
      expect(Object.hasOwn(message, 'attachments')).toBe(attachmentsEnabled);
    }
  });

  it.runIf(attachmentsEnabled)(
    'serves attachment metadata that matches the contract',
    async () => {
      const uploaded = await fetch(
        `${TEST_CONFIG.appBaseUrl}/api/attachments/v2`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
            'content-type': 'application/pdf',
            'x-attachment-filename': 'contract.pdf',
          },
          body: new Uint8Array(Buffer.from('%PDF-1.4 contract')),
        },
      );
      expect(uploaded.status).toBe(201);
      const attachment = (await uploaded.json()) as { id: string };
      conform('Attachment', attachment);

      const sent = await post(
        '/api/emails/v2',
        `contract-attach-${Date.now()}`,
        {
          from: { address: 'system@example.com', name: 'System' },
          to: { address: 'person@example.com' },
          subject: 'Contract check',
          text: 'body',
          attachments: [{ id: attachment.id }],
        },
      );
      expect(sent.status).toBe(201);
      conform('DirectEmailSendResult', sent.body);
      expect(
        (sent.body as { email: { attachments: unknown[] } }).email.attachments,
      ).toHaveLength(1);
    },
  );

  function conversationBody() {
    return {
      topic: {
        type: 'contract',
        externalId: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: 'Contract check',
      },
      participant: { email: 'person@example.com', name: 'Person' },
      message: {
        text: 'hello',
        from: { address: 'system@example.com', name: 'System' },
        replyTo: { address: TEST_CONFIG.replyToBaseAddress },
      },
    };
  }

  async function get(path: string) {
    const response = await fetch(`${TEST_CONFIG.appBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    return { status: response.status, body: await response.json() };
  }

  async function post(path: string, idempotencyKey: string, body: unknown) {
    const response = await fetch(`${TEST_CONFIG.appBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
});
