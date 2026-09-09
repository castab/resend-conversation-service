import type { EmailAttachment, Prisma, PrismaClient } from '@/lib/database';
import type { SendEmailAttachmentInput } from '@/lib/email';
import type { EmailAttachmentRefInput } from '@/lib/send-validation';
import { attachmentsEnabled, resolveAttachmentLimits } from './config';
import { getConfiguredAttachmentStorage } from './storage';

type ClaimClient = PrismaClient | Prisma.TransactionClient;

export class AttachmentClaimError extends Error {
  override name = 'AttachmentClaimError';
}

/**
 * Binds previously uploaded attachments to a message in the same transaction
 * that persists the send intent. Claiming is a conditional update, so two
 * concurrent sends can never reference the same upload and an already-consumed
 * or unstored ID is rejected before any provider call.
 */
export async function claimAttachmentsForMessage(
  client: ClaimClient,
  messageId: string,
  refs: EmailAttachmentRefInput[] | undefined,
): Promise<number> {
  if (!refs?.length) {
    return 0;
  }
  if (!attachmentsEnabled()) {
    throw new AttachmentClaimError('Attachments are disabled');
  }

  const ids = refs.map((ref) => ref.id);
  const claimed = await client.emailAttachment.updateMany({
    where: {
      id: { in: ids },
      messageId: null,
      source: 'UPLOAD',
      state: 'STORED',
    },
    data: { messageId },
  });
  if (claimed.count !== ids.length) {
    throw new AttachmentClaimError(
      'One or more attachments are unknown, already used, or not stored',
    );
  }

  const withContentId = refs.filter((ref) => ref.contentId);
  for (const ref of withContentId) {
    await client.emailAttachment.updateMany({
      where: { id: ref.id, messageId },
      data: {
        contentId: ref.contentId ?? null,
        contentDisposition: 'INLINE',
      },
    });
  }

  const limits = resolveAttachmentLimits();
  const total = await client.emailAttachment.aggregate({
    where: { messageId },
    _sum: { sizeBytes: true },
  });
  if (Number(total._sum.sizeBytes ?? 0n) > limits.maxTotalBytes) {
    throw new AttachmentClaimError(
      `Attachments exceed the ${limits.maxTotalBytes} byte total for one message`,
    );
  }
  return claimed.count;
}

export async function listMessageAttachments(
  client: ClaimClient,
  messageId: string,
): Promise<EmailAttachment[]> {
  return client.emailAttachment.findMany({
    where: { messageId },
    orderBy: { id: 'asc' },
  });
}

/**
 * Materializes a message's attachments for a provider send. Resolved outside
 * any database transaction: the objects can be tens of megabytes and must not
 * hold a transaction open while they download.
 */
export async function buildSendAttachments(
  client: PrismaClient,
  messageId: string,
): Promise<SendEmailAttachmentInput[]> {
  if (!attachmentsEnabled()) {
    return [];
  }
  const attachments = await listMessageAttachments(client, messageId);
  if (!attachments.length) {
    return [];
  }

  const storage = getConfiguredAttachmentStorage();
  const prepared: SendEmailAttachmentInput[] = [];
  for (const attachment of attachments) {
    if (attachment.state !== 'STORED') {
      throw new AttachmentClaimError(
        `Attachment ${attachment.id} is not stored`,
      );
    }
    const body = await storage.getBuffer(attachment.storageKey);
    prepared.push({
      filename: attachment.filename,
      content: body.toString('base64'),
      content_type: attachment.contentType,
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    });
  }
  return prepared;
}

/**
 * Selects the outbox lane for queued intent. Resend's batch endpoint cannot
 * carry attachments, so messages that have them go to a lane that is drained
 * one message at a time through the single-send endpoint.
 */
export function outboxRelationData(queued: boolean, hasAttachments: boolean) {
  if (!queued) {
    return {};
  }
  return hasAttachments
    ? { attachmentOutboxEntry: { create: {} } }
    : { outboxEntry: { create: {} } };
}
