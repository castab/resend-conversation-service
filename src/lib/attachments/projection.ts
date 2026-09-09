import { randomUUID } from 'node:crypto';
import type {
  EmailAttachmentDisposition,
  Prisma,
  PrismaClient,
} from '@/lib/database';
import type { ResendEmail } from '@/lib/email';
import { attachmentsEnabled, resolveAttachmentLimits } from './config';

type ProjectionClient = PrismaClient | Prisma.TransactionClient;

export const MAX_FILENAME_LENGTH = 512;
export const MAX_CONTENT_TYPE_LENGTH = 255;
export const MAX_CONTENT_ID_LENGTH = 255;
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_FILENAME = 'attachment';

const CONTENT_ID_REJECTED = /[\s<>]/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Records inbound attachment metadata alongside the projected message. The
 * bytes are not fetched here: Resend's download URLs expire, and the webhook
 * must stay fast enough to acknowledge within its retry contract. The ingest
 * runtime claims these PENDING rows and copies the bytes into object storage.
 */
export async function projectInboundAttachments(
  client: ProjectionClient,
  messageId: string,
  resendEmailId: string,
  email: ResendEmail,
): Promise<number> {
  if (!attachmentsEnabled()) {
    return 0;
  }
  const attachments = email.attachments ?? [];
  if (!attachments.length) {
    return 0;
  }

  const limits = resolveAttachmentLimits();
  const accepted = attachments
    .filter((attachment) => typeof attachment.id === 'string' && attachment.id)
    .slice(0, limits.maxCount);
  if (!accepted.length) {
    return 0;
  }

  const created = await client.emailAttachment.createMany({
    data: accepted.map((attachment) => ({
      messageId,
      source: 'INBOUND' as const,
      state: 'PENDING' as const,
      filename: normalizeFilename(attachment.filename),
      contentType: normalizeContentType(attachment.content_type),
      contentDisposition: normalizeDisposition(attachment.content_disposition),
      contentId: normalizeContentId(attachment.content_id),
      sizeBytes: BigInt(
        Number.isFinite(attachment.size) && attachment.size > 0
          ? Math.floor(attachment.size)
          : 0,
      ),
      storageKey: buildStorageKey(),
      resendEmailId,
      resendAttachmentId: attachment.id,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

export function buildStorageKey(): string {
  const prefix = (process.env.ATTACHMENTS_S3_KEY_PREFIX ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  const id = randomUUID();
  return prefix ? `${prefix}/${id}` : id;
}

export function normalizeFilename(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_FILENAME;
  }
  // Strip directory components and control characters so a provider-supplied
  // name can never escape a prefix or forge a response header.
  const sanitized = stripControlCharacters(
    value.replaceAll('\\', '/').split('/').pop() ?? '',
  ).trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return DEFAULT_FILENAME;
  }
  return sanitized.slice(0, MAX_FILENAME_LENGTH);
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && character !== '"') {
      result += character;
    }
  }
  return result;
}

export function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_CONTENT_TYPE;
  }
  const sanitized = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!CONTENT_TYPE_PATTERN.test(sanitized)) {
    return DEFAULT_CONTENT_TYPE;
  }
  return sanitized.slice(0, MAX_CONTENT_TYPE_LENGTH);
}

export function normalizeContentId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const sanitized = value.replace(/^</, '').replace(/>$/, '').trim();
  if (!sanitized || CONTENT_ID_REJECTED.test(sanitized)) {
    return null;
  }
  return sanitized.slice(0, MAX_CONTENT_ID_LENGTH);
}

function normalizeDisposition(value: unknown): EmailAttachmentDisposition {
  return typeof value === 'string' && value.trim().toLowerCase() === 'inline'
    ? 'INLINE'
    : 'ATTACHMENT';
}
