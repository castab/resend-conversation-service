import { randomUUID } from 'node:crypto';
import { buildSendAttachments } from '@/lib/attachments';
import type { EmailMessage, Prisma, PrismaClient } from '@/lib/database';
import {
  getConfiguredResendClient,
  ResendApiError,
  reconcileOutboundDeliveryState,
} from '@/lib/email';
import { buildSendEmailInput } from './conversation-service';

const OUTBOX_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_IDEMPOTENCY_SAFETY_MS = 23 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const;

interface ClaimedEntry {
  message: EmailMessage;
  leaseToken: string;
  attemptCount: number;
  firstAttemptAt: Date;
}

export interface AttachmentOutboxDrainResult {
  claimed: number;
  accepted: number;
  failed: number;
  retryScheduled: number;
  indeterminate: number;
  results: Array<{
    messageId: string;
    state: 'accepted' | 'failed' | 'pending' | 'indeterminate';
    resendEmailId: string | null;
  }>;
}

/**
 * Drains queued intent that carries attachments. Resend's batch endpoint
 * cannot send attachments, so this lane sends one message at a time through
 * the single-send endpoint. Ordering, leasing, retry backoff, and the provider
 * idempotency safety window match the batch lane.
 */
export async function drainAttachmentOutbox(
  client: PrismaClient,
  limit: number,
): Promise<AttachmentOutboxDrainResult> {
  const result = emptyResult();
  for (let processed = 0; processed < limit; processed++) {
    const claimed = await claimEntry(client);
    if (!claimed) {
      break;
    }
    result.claimed++;
    const outcome = await deliverEntry(client, claimed);
    result.accepted += outcome.state === 'accepted' ? 1 : 0;
    result.failed += outcome.state === 'failed' ? 1 : 0;
    result.retryScheduled += outcome.state === 'pending' ? 1 : 0;
    result.indeterminate += outcome.state === 'indeterminate' ? 1 : 0;
    result.results.push(outcome);
  }
  return result;
}

async function deliverEntry(
  client: PrismaClient,
  entry: ClaimedEntry,
): Promise<AttachmentOutboxDrainResult['results'][number]> {
  const messageId = entry.message.id;
  if (entry.attemptCount > 1 && hasProviderWindowExpired(entry)) {
    await finalize(
      client,
      entry,
      'INDETERMINATE',
      'Attachment outbox entry exceeded the provider idempotency window',
    );
    return { messageId, state: 'indeterminate', resendEmailId: null };
  }

  try {
    // Bytes are resolved outside any transaction; the claim already guarantees
    // exclusive ownership of this entry for the lease duration.
    const attachments = await buildSendAttachments(client, messageId);
    const sent = await getConfiguredResendClient().send(
      buildSendEmailInput(entry.message, attachments),
      `attachment-outbox/${messageId}`,
    );
    if (typeof sent.id !== 'string' || !sent.id) {
      await scheduleRetry(client, entry, 'invalid_send_response');
      return { messageId, state: 'pending', resendEmailId: null };
    }
    await accept(client, entry, sent.id);
    return { messageId, state: 'accepted', resendEmailId: sent.id };
  } catch (error) {
    if (
      error instanceof ResendApiError &&
      error.status === 409 &&
      error.code === 'invalid_idempotent_request'
    ) {
      await finalize(
        client,
        entry,
        'INDETERMINATE',
        'Resend rejected a changed payload for the persisted entry key',
      );
      return { messageId, state: 'indeterminate', resendEmailId: null };
    }
    if (isRetryableError(error)) {
      if (hasProviderWindowExpired(entry)) {
        await finalize(
          client,
          entry,
          'INDETERMINATE',
          'Attachment outbox entry exceeded the provider idempotency window',
        );
        return { messageId, state: 'indeterminate', resendEmailId: null };
      }
      await scheduleRetry(client, entry, getErrorCode(error));
      return { messageId, state: 'pending', resendEmailId: null };
    }
    await finalize(
      client,
      entry,
      'FAILED',
      `Resend send request failed (${getErrorCode(error)})`,
    );
    return { messageId, state: 'failed', resendEmailId: null };
  }
}

async function claimEntry(client: PrismaClient): Promise<ClaimedEntry | null> {
  const leaseToken = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);

  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      DELETE FROM email_attachment_outbox_entries AS entry
      USING email_messages AS message
      WHERE entry.message_id = message.id
        AND message.state <> 'PENDING'
    `;

    const rows = await transaction.$queryRaw<Array<{ message_id: string }>>`
      SELECT entry.message_id
      FROM email_attachment_outbox_entries AS entry
      INNER JOIN email_messages AS message ON message.id = entry.message_id
      WHERE message.state = 'PENDING'
        AND entry.next_attempt_at <= ${now}
        AND (entry.lease_until IS NULL OR entry.lease_until <= ${now})
      ORDER BY entry.queued_at, entry.message_id
      FOR UPDATE OF entry SKIP LOCKED
      LIMIT 1
    `;
    const messageId = rows[0]?.message_id;
    if (!messageId) {
      return null;
    }

    const current =
      await transaction.emailAttachmentOutboxEntry.findUniqueOrThrow({
        where: { messageId },
        select: { firstAttemptAt: true },
      });
    const entry = await transaction.emailAttachmentOutboxEntry.update({
      where: { messageId },
      data: {
        leaseToken,
        leaseUntil,
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        ...(current.firstAttemptAt ? {} : { firstAttemptAt: now }),
      },
      include: { message: true },
    });
    return {
      message: entry.message,
      leaseToken,
      attemptCount: entry.attemptCount,
      firstAttemptAt: entry.firstAttemptAt ?? now,
    };
  });
}

async function accept(
  client: PrismaClient,
  entry: ClaimedEntry,
  resendEmailId: string,
) {
  await client.$transaction(async (transaction) => {
    const updated = await transaction.emailMessage.updateMany({
      where: { id: entry.message.id, state: 'PENDING' },
      data: {
        state: 'ACCEPTED',
        stateDetail: null,
        deliveryState: 'UNKNOWN',
        resendEmailId,
      },
    });
    if (updated.count !== 1) {
      throw new Error('Outbox message changed before completion');
    }
    await reconcileOutboundDeliveryState(transaction, resendEmailId);
    await deleteOwnedEntry(transaction, entry);
  });
}

async function finalize(
  client: PrismaClient,
  entry: ClaimedEntry,
  state: 'FAILED' | 'INDETERMINATE',
  detail: string,
) {
  await client.$transaction(async (transaction) => {
    await transaction.emailMessage.updateMany({
      where: { id: entry.message.id, state: 'PENDING' },
      data: { state, stateDetail: detail },
    });
    await deleteOwnedEntry(transaction, entry);
  });
}

async function scheduleRetry(
  client: PrismaClient,
  entry: ClaimedEntry,
  errorCode: string,
) {
  const delay =
    RETRY_DELAYS_MS[
      Math.min(entry.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ];
  const updated = await client.emailAttachmentOutboxEntry.updateMany({
    where: { messageId: entry.message.id, leaseToken: entry.leaseToken },
    data: {
      nextAttemptAt: new Date(Date.now() + delay),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode.slice(0, 64),
    },
  });
  if (updated.count !== 1) {
    throw new Error('Attachment outbox lease was lost before retry scheduling');
  }
}

async function deleteOwnedEntry(
  transaction: Prisma.TransactionClient,
  entry: ClaimedEntry,
) {
  const deleted = await transaction.emailAttachmentOutboxEntry.deleteMany({
    where: { messageId: entry.message.id, leaseToken: entry.leaseToken },
  });
  if (deleted.count !== 1) {
    throw new Error('Attachment outbox lease was lost before cleanup');
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ResendApiError)) {
    return true;
  }
  return (
    (error.status === 429 &&
      error.code !== 'monthly_quota_exceeded' &&
      error.code !== 'daily_quota_exceeded') ||
    error.status >= 500 ||
    (error.status === 409 && error.code === 'concurrent_idempotent_requests')
  );
}

function hasProviderWindowExpired(entry: ClaimedEntry): boolean {
  return (
    Date.now() - entry.firstAttemptAt.getTime() >=
    PROVIDER_IDEMPOTENCY_SAFETY_MS
  );
}

function getErrorCode(error: unknown): string {
  if (error instanceof ResendApiError) {
    return error.code ?? `http_${error.status}`;
  }
  return error instanceof Error ? error.name : 'unknown_error';
}

function emptyResult(): AttachmentOutboxDrainResult {
  return {
    claimed: 0,
    accepted: 0,
    failed: 0,
    retryScheduled: 0,
    indeterminate: 0,
    results: [],
  };
}
