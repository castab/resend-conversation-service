import { FakeResendServer } from '@test-support/fake-resend-server';
import { assertAttachmentsMode } from '@test-support/helpers/app-mode';
import { TEST_CONFIG } from '@test-support/setup';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtures } from '../helpers/fixtures';
import { generateSvixId, signPayload } from '../helpers/svix';

/**
 * These cases require the service to run with ATTACHMENTS_ENABLED=true and an
 * S3-compatible endpoint (MinIO in docker-compose and CI). The flag-off
 * behavior is asserted in the conversation and direct-email suites, which run
 * against a service started without the flag.
 */
describe('Attachments API v2', () => {
  const resendServer = new FakeResendServer();
  const database = new Client({ connectionString: TEST_CONFIG.postgresql.url });
  const attachmentsUrl = `${TEST_CONFIG.appBaseUrl}/api/attachments/v2`;
  const conversationsUrl = `${TEST_CONFIG.appBaseUrl}/api/conversations/v2`;
  const emailsUrl = `${TEST_CONFIG.appBaseUrl}/api/emails/v2`;
  const drainUrl = `${emailsUrl}/outbox/drain`;
  const webhookUrl = `${TEST_CONFIG.appBaseUrl}/api/webhooks/resend/v1`;

  const PDF_BYTES = Buffer.from('%PDF-1.4 fake attachment payload', 'utf8');

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
    await database.query('TRUNCATE TABLE resend_wh_emails');
    await database.query(
      'TRUNCATE TABLE conversation_event_deliveries CASCADE',
    );
    await database.query('TRUNCATE TABLE conversation_events CASCADE');
    await database.query('TRUNCATE TABLE email_outbox_batches CASCADE');
    await database.query(
      'TRUNCATE TABLE email_attachment_outbox_entries CASCADE',
    );
    await database.query('TRUNCATE TABLE email_attachments CASCADE');
    await database.query('TRUNCATE TABLE email_messages CASCADE');
    await database.query('TRUNCATE TABLE email_conversations CASCADE');
    await database.query('TRUNCATE TABLE email_address_allowlist_entries');
    await database.query('TRUNCATE TABLE stored_object_tombstones');
    resendServer.reset();
  });

  it('rejects unauthenticated and malformed uploads', async () => {
    const unauthorized = await fetch(attachmentsUrl, {
      method: 'POST',
      headers: { 'x-attachment-filename': 'a.pdf' },
      body: PDF_BYTES,
    });
    expect(unauthorized.status).toBe(401);

    const missingFilename = await fetch(attachmentsUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
        'content-type': 'application/pdf',
      },
      body: PDF_BYTES,
    });
    expect(missingFilename.status).toBe(400);

    const emptyBody = await fetch(attachmentsUrl, {
      method: 'POST',
      headers: uploadHeaders('empty.pdf'),
    });
    expect(emptyBody.status).toBe(400);
  });

  it('stores an upload and streams the exact bytes back', async () => {
    const uploaded = await upload('report.pdf', PDF_BYTES);
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json()) as Record<string, unknown>;
    expect(attachment.filename).toBe('report.pdf');
    expect(attachment.contentType).toBe('application/pdf');
    expect(attachment.sizeBytes).toBe(PDF_BYTES.byteLength);
    expect(attachment.state).toBe('stored');
    expect(attachment.downloadPath).toBe(
      `/api/attachments/v2/${attachment.id}`,
    );

    const download = await fetch(`${attachmentsUrl}/${attachment.id}`, {
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toContain(
      'filename="report.pdf"',
    );
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it('requires authentication to download and 404s unknown attachments', async () => {
    const uploaded = await upload('secret.pdf', PDF_BYTES);
    const { id } = (await uploaded.json()) as { id: string };

    const unauthenticated = await fetch(`${attachmentsUrl}/${id}`);
    expect(unauthenticated.status).toBe(401);

    const missing = await fetch(
      `${attachmentsUrl}/00000000-0000-7000-8000-00000000dead`,
      { headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` } },
    );
    expect(missing.status).toBe(404);

    const invalid = await fetch(`${attachmentsUrl}/not-a-uuid`, {
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    expect(invalid.status).toBe(400);
  });

  it('sanitizes a hostile filename before storing it', async () => {
    const uploaded = await upload('../../etc/passwd"; rm -rf /', PDF_BYTES);
    expect(uploaded.status).toBe(201);
    const { filename } = (await uploaded.json()) as { filename: string };
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('"');
  });

  it('sends a direct email with an attachment and reports it on the message', async () => {
    await allowAddress('system@example.com', 'FROM');
    const uploaded = await upload('invoice.pdf', PDF_BYTES);
    const { id: attachmentId } = (await uploaded.json()) as { id: string };

    const response = await fetch(emailsUrl, {
      method: 'POST',
      headers: sendHeaders('direct-with-attachment'),
      body: JSON.stringify({
        from: { address: 'system@example.com', name: 'System' },
        to: { address: 'person@example.com' },
        subject: 'Your invoice',
        text: 'Attached.',
        attachments: [{ id: attachmentId }],
      }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      email: { attachments: Array<{ id: string; state: string }> };
    };
    expect(payload.email.attachments).toHaveLength(1);
    expect(payload.email.attachments[0].id).toBe(attachmentId);

    const sent = resendServer.sends.at(-1);
    expect(sent?.input.attachments).toHaveLength(1);
    expect(sent?.input.attachments?.[0].filename).toBe('invoice.pdf');
    expect(sent?.input.attachments?.[0].content).toBe(
      PDF_BYTES.toString('base64'),
    );
    expect(sent?.input.attachments?.[0].content_type).toBe('application/pdf');
  });

  it('refuses to reuse an attachment across two messages', async () => {
    await allowAddress('system@example.com', 'FROM');
    const uploaded = await upload('once.pdf', PDF_BYTES);
    const { id: attachmentId } = (await uploaded.json()) as { id: string };

    const first = await sendDirect('reuse-first', attachmentId);
    expect(first.status).toBe(201);

    const second = await sendDirect('reuse-second', attachmentId);
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toEqual({
      error: 'One or more attachments are unknown, already used, or not stored',
    });
  });

  it('rejects an unknown attachment id without calling Resend', async () => {
    await allowAddress('system@example.com', 'FROM');
    const before = resendServer.sends.length;

    const response = await sendDirect(
      'unknown-attachment',
      '00000000-0000-7000-8000-0000000000ff',
    );
    expect(response.status).toBe(400);
    expect(resendServer.sends.length).toBe(before);
  });

  it('routes queued attachment intent to its own lane and drains it', async () => {
    await allowAddress('system@example.com', 'FROM');
    const uploaded = await upload('queued.pdf', PDF_BYTES);
    const { id: attachmentId } = (await uploaded.json()) as { id: string };

    const enqueued = await fetch(`${emailsUrl}/outbox`, {
      method: 'POST',
      headers: sendHeaders('queued-with-attachment'),
      body: JSON.stringify({
        from: { address: 'system@example.com', name: 'System' },
        to: { address: 'person@example.com' },
        subject: 'Queued invoice',
        text: 'Attached.',
        attachments: [{ id: attachmentId }],
      }),
    });
    expect(enqueued.status).toBe(202);

    // The batch lane must stay empty: Resend cannot batch attachments.
    const batchEntries = await database.query(
      'SELECT count(*)::int AS count FROM email_outbox_entries',
    );
    expect(batchEntries.rows[0].count).toBe(0);
    const attachmentEntries = await database.query(
      'SELECT count(*)::int AS count FROM email_attachment_outbox_entries',
    );
    expect(attachmentEntries.rows[0].count).toBe(1);

    const batchesBefore = resendServer.batches.length;
    const drained = await fetch(drainUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CONFIG.outboxDrainApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(drained.status).toBe(200);
    const result = (await drained.json()) as {
      claimed: number;
      attachments: { claimed: number; accepted: number };
    };
    expect(result.claimed).toBe(0);
    expect(result.attachments.claimed).toBe(1);
    expect(result.attachments.accepted).toBe(1);
    expect(resendServer.batches.length).toBe(batchesBefore);

    const sent = resendServer.sends.at(-1);
    expect(sent?.idempotencyKey).toMatch(/^attachment-outbox\//);
    expect(sent?.input.attachments).toHaveLength(1);
  });

  it('projects inbound attachments and stores them through the ingest runtime', async () => {
    resendServer.addReceivedAttachment(
      'em_received123',
      {
        id: 'att_inbound_1',
        filename: 'scan.png',
        content_type: 'image/png',
        content_disposition: 'inline',
        content_id: 'img001',
      },
      PDF_BYTES,
    );

    await deliverReceivedWebhook();

    const attachment = await waitForAttachmentState('att_inbound_1', 'STORED');
    expect(attachment.filename).toBe('scan.png');
    expect(attachment.content_type).toBe('image/png');
    expect(attachment.content_disposition).toBe('INLINE');
    expect(attachment.content_id).toBe('img001');
    expect(Number(attachment.size_bytes)).toBe(PDF_BYTES.byteLength);

    const download = await fetch(`${attachmentsUrl}/${attachment.id}`, {
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    expect(download.status).toBe(200);
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);
  });

  it('exposes inbound attachments on the conversation read model', async () => {
    resendServer.addReceivedAttachment(
      'em_received123',
      {
        id: 'att_inbound_read',
        filename: 'contract.pdf',
        content_type: 'application/pdf',
      },
      PDF_BYTES,
    );
    await deliverReceivedWebhook();
    const stored = await waitForAttachmentState('att_inbound_read', 'STORED');

    const conversations = await database.query(
      'SELECT id FROM email_conversations LIMIT 1',
    );
    const conversationId = conversations.rows[0].id as string;
    const response = await fetch(`${conversationsUrl}/${conversationId}`, {
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    expect(response.status).toBe(200);
    const conversation = (await response.json()) as {
      messages: Array<{
        attachments: Array<{
          id: string;
          filename: string;
          state: string;
          downloadPath: string | null;
        }>;
      }>;
    };
    const attachments = conversation.messages.flatMap(
      (message) => message.attachments,
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe(stored.id);
    expect(attachments[0].filename).toBe('contract.pdf');
    expect(attachments[0].state).toBe('stored');
    expect(attachments[0].downloadPath).toBe(
      `/api/attachments/v2/${stored.id}`,
    );
  });

  it('retries a failed download and does not duplicate rows on webhook replay', async () => {
    resendServer.addReceivedAttachment(
      'em_received123',
      {
        id: 'att_retry_1',
        filename: 'retry.bin',
        content_type: 'application/octet-stream',
      },
      PDF_BYTES,
    );
    resendServer.attachmentDownloadFailuresRemaining = 1;

    const svixId = generateSvixId();
    await deliverReceivedWebhook(svixId);
    await deliverReceivedWebhook(svixId);

    const rows = await database.query(
      'SELECT count(*)::int AS count FROM email_attachments WHERE resend_attachment_id = $1',
      ['att_retry_1'],
    );
    expect(rows.rows[0].count).toBe(1);

    const attachment = await waitForAttachmentState(
      'att_retry_1',
      'STORED',
      30_000,
    );
    expect(attachment.attempt_count).toBeGreaterThan(1);
  });

  it('tombstones stored objects when a conversation is deleted', async () => {
    resendServer.addReceivedAttachment(
      'em_received123',
      {
        id: 'att_delete_1',
        filename: 'doomed.pdf',
        content_type: 'application/pdf',
      },
      PDF_BYTES,
    );
    await deliverReceivedWebhook();
    const stored = await waitForAttachmentState('att_delete_1', 'STORED');

    const conversations = await database.query(
      'SELECT id FROM email_conversations LIMIT 1',
    );
    const conversationId = conversations.rows[0].id as string;

    const deleted = await fetch(`${conversationsUrl}/${conversationId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}` },
    });
    expect(deleted.status).toBe(204);

    // The attachment row is removed by the PostgreSQL cascade, so only the
    // trigger can have recorded the object for deletion.
    const remaining = await database.query(
      'SELECT count(*)::int AS count FROM email_attachments WHERE id = $1',
      [stored.id],
    );
    expect(remaining.rows[0].count).toBe(0);

    const tombstones = await database.query(
      'SELECT count(*)::int AS count FROM stored_object_tombstones WHERE storage_key = $1',
      [stored.storage_key],
    );
    expect(tombstones.rows[0].count).toBe(1);
  });

  async function deliverReceivedWebhook(svixId = generateSvixId()) {
    const signed = signPayload(
      TEST_CONFIG.webhookSecret,
      fixtures.email.received(),
      svixId,
    );
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    expect(response.status).toBe(200);
  }

  async function waitForAttachmentState(
    resendAttachmentId: string,
    state: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const { rows } = await database.query(
        'SELECT * FROM email_attachments WHERE resend_attachment_id = $1',
        [resendAttachmentId],
      );
      last = rows[0];
      if (last?.state === state) {
        return last as Record<string, string>;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Attachment ${resendAttachmentId} never reached ${state}; last state ${String(last?.state)}`,
    );
  }

  async function allowAddress(address: string, role: 'FROM' | 'REPLY_TO') {
    await database.query(
      'INSERT INTO email_address_allowlist_entries (address, role) VALUES ($1, $2::"EmailAddressRole") ON CONFLICT DO NOTHING',
      [address, role],
    );
  }

  function uploadHeaders(filename: string) {
    return {
      authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
      'content-type': 'application/pdf',
      'x-attachment-filename': filename,
    };
  }

  function sendHeaders(idempotencyKey: string) {
    return {
      authorization: `Bearer ${TEST_CONFIG.emailV2ApiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
  }

  function upload(filename: string, body: Buffer) {
    return fetch(attachmentsUrl, {
      method: 'POST',
      headers: uploadHeaders(filename),
      body: new Uint8Array(body),
    });
  }

  function sendDirect(idempotencyKey: string, attachmentId: string) {
    return fetch(emailsUrl, {
      method: 'POST',
      headers: sendHeaders(idempotencyKey),
      body: JSON.stringify({
        from: { address: 'system@example.com', name: 'System' },
        to: { address: 'person@example.com' },
        subject: 'Invoice',
        text: 'Attached.',
        attachments: [{ id: attachmentId }],
      }),
    });
  }
});
