export interface SendEmailInput {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
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
}

export interface ResendEmailClient {
  send(input: SendEmailInput, idempotencyKey: string): Promise<{ id: string }>;
  sendBatch(
    input: SendEmailInput[],
    idempotencyKey: string,
  ): Promise<{ data: Array<{ id: string }> }>;
  getSent(id: string): Promise<ResendEmail>;
  getReceived(id: string): Promise<ResendEmail>;
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
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'resend-service/2.0',
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });

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

    return (await response.json()) as T;
  }

  return {
    async send(input, idempotencyKey) {
      const result = await request<unknown>('/emails', {
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
      return request<{ data: Array<{ id: string }> }>('/emails/batch', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(input),
      });
    },
    getSent(id) {
      return request<ResendEmail>(`/emails/${encodeURIComponent(id)}`);
    },
    getReceived(id) {
      return request<ResendEmail>(
        `/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,
      );
    },
  };
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
