import {
  type ProviderOperation,
  recordProviderRequest,
} from '@/lib/telemetry-metrics';

const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface SendEmailAttachmentInput {
  filename: string;
  content: string;
  content_type?: string;
  content_id?: string;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  attachments?: SendEmailAttachmentInput[];
}

export interface ResendReceivedAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_disposition?: string;
  content_id?: string | null;
  download_url?: string;
  expires_at?: string;
}

export interface ResendEmail {
  id: string;
  message_id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  text: string | null;
  html: string | null;
  headers?: Record<string, string>;
  reply_to?: string[];
  received_for?: string[];
  attachments?: ResendReceivedAttachment[];
}

export interface ResendEmailClient {
  send(input: SendEmailInput, idempotencyKey: string): Promise<{ id: string }>;
  sendBatch(
    input: SendEmailInput[],
    idempotencyKey: string,
  ): Promise<{ data: Array<{ id: string }> }>;
  getSent(id: string): Promise<ResendEmail>;
  getReceived(id: string): Promise<ResendEmail>;
  listReceivedAttachments(
    emailId: string,
  ): Promise<{ data: ResendReceivedAttachment[]; has_more: boolean }>;
  getReceivedAttachment(
    emailId: string,
    attachmentId: string,
  ): Promise<ResendReceivedAttachment>;
  downloadAttachment(downloadUrl: string): Promise<Buffer>;
}

export class ResendApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ResendApiError';
  }
}

export function createResendEmailClient({
  apiKey,
  baseUrl = 'https://api.resend.com',
}: {
  apiKey: string;
  baseUrl?: string;
}): ResendEmailClient {
  async function request<T>(
    operation: ProviderOperation,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const startedAt = performance.now();
    let outcome: 'success' | 'failure' = 'failure';
    let statusClass: 'none' | '2xx' | '4xx' | '5xx' = 'none';
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'resend-conversation-service/2.0',
          ...init?.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
      statusClass = responseStatusClass(response.status);

      if (!response.ok) {
        const responseBody = await response.text();
        let code: string | null = null;
        try {
          const body = JSON.parse(responseBody) as {
            name?: unknown;
            code?: unknown;
          };
          code =
            typeof body.name === 'string'
              ? body.name
              : typeof body.code === 'string'
                ? body.code
                : null;
        } catch {
          // Non-JSON errors still retain their status for retry classification.
        }
        throw new ResendApiError(
          `Resend API request failed with status ${response.status}`,
          response.status,
          responseBody,
          code,
        );
      }

      outcome = 'success';
      return (await response.json()) as T;
    } finally {
      recordProviderRequest(
        (performance.now() - startedAt) / 1_000,
        operation,
        outcome,
        statusClass,
      );
    }
  }

  return {
    async send(input, idempotencyKey) {
      const result = await request<unknown>('send', '/emails', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(input),
      });
      if (
        typeof result !== 'object' ||
        result === null ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !result.id
      ) {
        throw new Error('Resend API returned an invalid email ID');
      }
      return { id: result.id };
    },
    sendBatch(input, idempotencyKey) {
      return request<{ data: Array<{ id: string }> }>(
        'send_batch',
        '/emails/batch',
        {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify(input),
        },
      );
    },
    getSent(id) {
      return request<ResendEmail>(
        'get_sent',
        `/emails/${encodeURIComponent(id)}`,
      );
    },
    getReceived(id) {
      return request<ResendEmail>(
        'get_received',
        `/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,
      );
    },
    listReceivedAttachments(emailId) {
      return request<{ data: ResendReceivedAttachment[]; has_more: boolean }>(
        'list_received_attachments',
        `/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=100`,
      );
    },
    getReceivedAttachment(emailId, attachmentId) {
      return request<ResendReceivedAttachment>(
        'get_received_attachment',
        `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
    },
    // Signed download URLs are pre-authorized and short lived, so they are
    // fetched without the API credential and never persisted.
    async downloadAttachment(downloadUrl) {
      const startedAt = performance.now();
      let outcome: 'success' | 'failure' = 'failure';
      let statusClass: 'none' | '2xx' | '4xx' | '5xx' = 'none';
      try {
        const response = await fetch(downloadUrl, {
          signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
        });
        statusClass = responseStatusClass(response.status);
        if (!response.ok) {
          throw new ResendApiError(
            `Attachment download failed with status ${response.status}`,
            response.status,
            '',
          );
        }
        const body = Buffer.from(await response.arrayBuffer());
        outcome = 'success';
        return body;
      } finally {
        recordProviderRequest(
          (performance.now() - startedAt) / 1_000,
          'download_attachment',
          outcome,
          statusClass,
        );
      }
    },
  };
}

function responseStatusClass(status: number): 'none' | '2xx' | '4xx' | '5xx' {
  if (status >= 200 && status < 300) {
    return '2xx';
  }
  if (status >= 400 && status < 500) {
    return '4xx';
  }
  if (status >= 500 && status < 600) {
    return '5xx';
  }
  return 'none';
}

export function getConfiguredResendClient(): ResendEmailClient {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('Missing RESEND_API_KEY environment variable');
  }

  return createResendEmailClient({
    apiKey,
    baseUrl: process.env.RESEND_API_BASE_URL,
  });
}
