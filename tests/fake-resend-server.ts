import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResendEmail, SendEmailInput } from '@/lib/email';

export class FakeResendServer {
  private server: Server | null = null;
  private sequence = 0;
  private readonly idempotentResponses = new Map<string, string>();
  private readonly idempotentBatchResponses = new Map<
    string,
    { body: string; ids: string[] }
  >();
  private nextSendPause: {
    arrived: () => void;
    resumed: Promise<void>;
    release: () => void;
  } | null = null;
  failNextSendStatus: number | null = null;
  failNextBatchStatus: number | null = null;
  failNextBatchCode = 'application_error';
  disconnectAfterNextBatch = false;
  disconnectAfterNextSend = false;
  malformedNextBatchResponse = false;
  malformedNextSendResponse = false;
  sentMetadataFailuresRemaining = 0;
  sentMetadataRequestCount = 0;
  readonly sends: Array<{
    id: string;
    idempotencyKey: string | undefined;
    input: SendEmailInput;
  }> = [];
  readonly batches: Array<{
    idempotencyKey: string | undefined;
    inputs: SendEmailInput[];
    ids: string[];
  }> = [];
  readonly received = new Map<string, ResendEmail>();

  pauseNextSend() {
    let arrived = () => {};
    let release = () => {};
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextSendPause = { arrived, resumed, release };
    return { arrival, release };
  }

  async start(url: string) {
    const target = new URL(url);
    this.server = createServer(async (request, response) => {
      try {
        await this.handle(request, response);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(Number(target.port), target.hostname, () =>
        resolve(),
      );
    });
    const address = this.server.address() as AddressInfo;
    if (address.port !== Number(target.port)) {
      throw new Error('Fake Resend server started on an unexpected port');
    }
  }

  reset() {
    this.nextSendPause?.release();
    this.nextSendPause = null;
    this.sequence = 0;
    this.sends.length = 0;
    this.batches.length = 0;
    this.idempotentResponses.clear();
    this.idempotentBatchResponses.clear();
    this.failNextSendStatus = null;
    this.failNextBatchStatus = null;
    this.failNextBatchCode = 'application_error';
    this.disconnectAfterNextBatch = false;
    this.disconnectAfterNextSend = false;
    this.malformedNextBatchResponse = false;
    this.malformedNextSendResponse = false;
    this.sentMetadataFailuresRemaining = 0;
    this.sentMetadataRequestCount = 0;
    this.received.clear();
    this.received.set('em_received123', {
      id: 'em_received123',
      message_id: '<received123@example.com>',
      from: 'external@example.com',
      to: ['inbox@example.com'],
      subject: 'Received Email',
      created_at: '2026-07-19T03:52:03.099Z',
      text: 'Inbound test body',
      html: '<p>Inbound test body</p>',
      headers: { from: 'External Person <external@example.com>' },
      reply_to: [],
    });
  }

  async close() {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/emails/batch') {
      const body = await readBody(request);
      const inputs = JSON.parse(body) as SendEmailInput[];
      if (this.failNextBatchStatus) {
        const status = this.failNextBatchStatus;
        const code = this.failNextBatchCode;
        this.failNextBatchStatus = null;
        this.failNextBatchCode = 'application_error';
        return json(response, status, {
          name: code,
          message: 'simulated_batch_failure',
        });
      }
      const idempotencyKey = request.headers['idempotency-key'] as
        | string
        | undefined;
      const existing = idempotencyKey
        ? this.idempotentBatchResponses.get(idempotencyKey)
        : undefined;
      if (existing && existing.body !== body) {
        return json(response, 409, {
          name: 'invalid_idempotent_request',
          message: 'batch payload changed',
        });
      }

      const ids = existing?.ids ?? inputs.map(() => `batch-${++this.sequence}`);
      if (!existing) {
        this.batches.push({ idempotencyKey, inputs, ids });
        for (const [index, input] of inputs.entries()) {
          this.sends.push({ id: ids[index], idempotencyKey, input });
        }
        if (idempotencyKey) {
          this.idempotentBatchResponses.set(idempotencyKey, { body, ids });
        }
      }
      if (this.disconnectAfterNextBatch) {
        this.disconnectAfterNextBatch = false;
        response.destroy();
        return;
      }
      if (this.malformedNextBatchResponse) {
        this.malformedNextBatchResponse = false;
        return json(response, 200, { data: ids.map(() => ({})) });
      }
      return json(response, 200, { data: ids.map((id) => ({ id })) });
    }

    if (request.method === 'POST' && url.pathname === '/emails') {
      const body = await readBody(request);
      const input = JSON.parse(body) as SendEmailInput;
      if (this.failNextSendStatus) {
        const status = this.failNextSendStatus;
        this.failNextSendStatus = null;
        return json(response, status, { error: 'simulated_send_failure' });
      }
      const idempotencyKey = request.headers['idempotency-key'] as
        | string
        | undefined;
      const existingId = idempotencyKey
        ? this.idempotentResponses.get(idempotencyKey)
        : undefined;
      const id = existingId ?? `sent-${++this.sequence}`;
      if (!existingId) {
        this.sends.push({ id, idempotencyKey, input });
        if (idempotencyKey) {
          this.idempotentResponses.set(idempotencyKey, id);
        }
      }
      if (this.nextSendPause) {
        const pause = this.nextSendPause;
        this.nextSendPause = null;
        pause.arrived();
        await pause.resumed;
      }
      if (this.disconnectAfterNextSend) {
        this.disconnectAfterNextSend = false;
        response.destroy();
        return;
      }
      if (this.malformedNextSendResponse) {
        this.malformedNextSendResponse = false;
        return json(response, 200, {});
      }
      return json(response, 200, { id });
    }

    const receivedMatch = url.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (request.method === 'GET' && receivedMatch) {
      const email = this.received.get(decodeURIComponent(receivedMatch[1]));
      return email
        ? json(response, 200, email)
        : json(response, 404, { error: 'not_found' });
    }

    const sentMatch = url.pathname.match(/^\/emails\/([^/]+)$/);
    if (request.method === 'GET' && sentMatch) {
      this.sentMetadataRequestCount++;
      if (this.sentMetadataFailuresRemaining > 0) {
        this.sentMetadataFailuresRemaining--;
        return json(response, 404, { error: 'not_ready' });
      }
      const id = decodeURIComponent(sentMatch[1]);
      const sent = this.sends.find((entry) => entry.id === id);
      return sent
        ? json(response, 200, {
            id,
            message_id: `<${id}@resend.test>`,
            from: sent.input.from,
            to: sent.input.to,
            subject: sent.input.subject,
            created_at: new Date().toISOString(),
            text: sent.input.text ?? null,
            html: sent.input.html ?? null,
          })
        : json(response, 404, { error: 'not_found' });
    }

    return json(response, 404, { error: 'not_found' });
  }
}

function json(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(
  request: import('node:http').IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
