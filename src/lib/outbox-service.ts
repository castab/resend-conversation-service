import { randomUUID } from 'node:crypto';
import { type EmailMessage, Prisma, type PrismaClient } from '@/lib/database';
import {
  getConfiguredResendClient,
  ResendApiError,
  reconcileOutboundDeliveryState,
} from '@/lib/email';
import { buildSendEmailInput } from './conversation-service';

const OUTBOX_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_IDEMPOTENCY_SAFETY_MS = 23 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const;

type BatchRow = { id: string };
type MessageIdRow = { message_id: string };

interface ClaimedBatch {
  id: string;
  leaseToken: string;
  attemptCount: number;
  firstAttemptAt: Date;
  messages: EmailMessage[];
}

export interface OutboxDrainResult {
  batchId: string | null;
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

export async function drainEmailOutbox(
  client: PrismaClient,
  limit: number,
): Promise<OutboxDrainResult> {
  const claimed = await claimOutboxBatch(client, limit);
  if (!claimed) {
    return emptyDrainResult();
  }
  if (claimed.attemptCount > 1 && hasProviderWindowExpired(claimed)) {
    return finalizeIndeterminateBatch(
      client,
      claimed,
      'Outbox batch exceeded the provider idempotency window',
    );
  }

  try {
    const response = await getConfiguredResendClient().sendBatch(
      // This lane never carries attachments; those are queued separately
      // because Resend's batch endpoint cannot send them.
      claimed.messages.map((message) => buildSendEmailInput(message)),
      `conversation-outbox/${claimed.id}`,
    );
    if (
      response.data.length !== claimed.messages.length ||
      response.data.some(
        (item) => typeof item.id !== 'string' || item.id.length === 0,
      )
    ) {
      return scheduleBatchRetry(client, claimed, 'invalid_batch_response');
    }
    return finalizeAcceptedBatch(
      client,
      claimed,
      response.data.map(({ id }) => id),
    );
  } catch (error) {
    if (
      error instanceof ResendApiError &&
      error.status === 409 &&
      error.code === 'invalid_idempotent_request'
    ) {
      return finalizeIndeterminateBatch(
        client,
        claimed,
        'Resend rejected a changed payload for the persisted batch key',
      );
    }
    if (isRetryableBatchError(error)) {
      return scheduleBatchRetry(client, claimed, getErrorCode(error));
    }
    return finalizeFailedBatch(client, claimed, getErrorCode(error));
  }
}

async function claimOutboxBatch(
  client: PrismaClient,
  limit: number,
): Promise<ClaimedBatch | null> {
  const leaseToken = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);

  const batch = await client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      DELETE FROM email_outbox_entries AS entry
      USING email_messages AS message
      WHERE entry.message_id = message.id
        AND entry.batch_id IS NULL
        AND message.state <> 'PENDING'
    `;

    const retryable = await transaction.$queryRaw<BatchRow[]>`
      SELECT id
      FROM email_outbox_batches
      WHERE next_attempt_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now})
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    let batchId = retryable[0]?.id;

    if (!batchId) {
      const entries = await transaction.$queryRaw<MessageIdRow[]>`
        SELECT entry.message_id
        FROM email_outbox_entries AS entry
        INNER JOIN email_messages AS message ON message.id = entry.message_id
        WHERE entry.batch_id IS NULL
          AND message.state = 'PENDING'
        ORDER BY entry.queued_at, entry.message_id
        FOR UPDATE OF entry SKIP LOCKED
        LIMIT ${limit}
      `;
      if (!entries.length) {
        return null;
      }

      const created = await transaction.emailOutboxBatch.create({
        data: {
          leaseToken,
          leaseUntil,
          firstAttemptAt: now,
          attemptCount: 1,
        },
      });
      batchId = created.id;
      const assignments = Prisma.join(
        entries.map(
          (entry, position) =>
            Prisma.sql`(${entry.message_id}::uuid, ${position}::integer)`,
        ),
      );
      await transaction.$executeRaw`
        UPDATE email_outbox_entries AS entry
        SET batch_id = ${batchId}::uuid,
            batch_position = assignment.position
        FROM (VALUES ${assignments}) AS assignment(message_id, position)
        WHERE entry.message_id = assignment.message_id
          AND entry.batch_id IS NULL
      `;
    } else {
      await transaction.emailOutboxBatch.update({
        where: { id: batchId },
        data: {
          leaseToken,
          leaseUntil,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
        },
      });
    }

    return transaction.emailOutboxBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: {
        entries: {
          orderBy: { batchPosition: 'asc' },
          include: { message: true },
        },
      },
    });
  });

  if (!batch) {
    return null;
  }
  if (
    !batch.firstAttemptAt ||
    batch.entries.some((entry) => entry.message.state !== 'PENDING')
  ) {
    throw new Error('Claimed outbox batch contains invalid message state');
  }

  return {
    id: batch.id,
    leaseToken,
    attemptCount: batch.attemptCount,
    firstAttemptAt: batch.firstAttemptAt,
    messages: batch.entries.map((entry) => entry.message),
  };
}

async function finalizeAcceptedBatch(
  client: PrismaClient,
  batch: ClaimedBatch,
  resendEmailIds: string[],
): Promise<OutboxDrainResult> {
  await client.$transaction(async (transaction) => {
    await assertLeaseOwner(transaction, batch);
    const accepted = Prisma.join(
      batch.messages.map(
        (message, position) =>
          Prisma.sql`(${message.id}::uuid, ${resendEmailIds[position]}::text)`,
      ),
    );
    const updated = await transaction.$executeRaw`
      UPDATE email_messages AS message
      SET state = 'ACCEPTED',
          state_detail = NULL,
          delivery_state = 'UNKNOWN',
          resend_email_id = accepted.resend_email_id,
          updated_at = now()
      FROM (VALUES ${accepted}) AS accepted(message_id, resend_email_id)
      WHERE message.id = accepted.message_id
        AND message.state = 'PENDING'
    `;
    if (updated !== batch.messages.length) {
      throw new Error('Outbox message changed before batch completion');
    }
    for (const resendEmailId of resendEmailIds) {
      await reconcileOutboundDeliveryState(transaction, resendEmailId);
    }
    await deleteOwnedBatch(transaction, batch);
  });

  return {
    batchId: batch.id,
    claimed: batch.messages.length,
    accepted: batch.messages.length,
    failed: 0,
    retryScheduled: 0,
    indeterminate: 0,
    results: batch.messages.map((message, position) => ({
      messageId: message.id,
      state: 'accepted',
      resendEmailId: resendEmailIds[position],
    })),
  };
}

async function finalizeFailedBatch(
  client: PrismaClient,
  batch: ClaimedBatch,
  errorCode: string,
): Promise<OutboxDrainResult> {
  await client.$transaction(async (transaction) => {
    await assertLeaseOwner(transaction, batch);
    await transaction.emailMessage.updateMany({
      where: {
        id: { in: batch.messages.map(({ id }) => id) },
        state: 'PENDING',
      },
      data: {
        state: 'FAILED',
        stateDetail: `Resend batch request failed (${errorCode})`,
      },
    });
    await deleteOwnedBatch(transaction, batch);
  });

  return terminalDrainResult(batch, 'failed');
}

async function scheduleBatchRetry(
  client: PrismaClient,
  batch: ClaimedBatch,
  errorCode: string,
): Promise<OutboxDrainResult> {
  if (hasProviderWindowExpired(batch)) {
    return finalizeIndeterminateBatch(
      client,
      batch,
      'Outbox batch exceeded the provider idempotency window',
    );
  }

  const delay =
    RETRY_DELAYS_MS[
      Math.min(batch.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ];
  const updated = await client.emailOutboxBatch.updateMany({
    where: { id: batch.id, leaseToken: batch.leaseToken },
    data: {
      nextAttemptAt: new Date(Date.now() + delay),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode.slice(0, 64),
    },
  });
  if (updated.count !== 1) {
    throw new Error('Outbox batch lease was lost before retry scheduling');
  }

  return {
    batchId: batch.id,
    claimed: batch.messages.length,
    accepted: 0,
    failed: 0,
    retryScheduled: batch.messages.length,
    indeterminate: 0,
    results: batch.messages.map((message) => ({
      messageId: message.id,
      state: 'pending',
      resendEmailId: null,
    })),
  };
}

async function finalizeIndeterminateBatch(
  client: PrismaClient,
  batch: ClaimedBatch,
  detail: string,
): Promise<OutboxDrainResult> {
  await client.$transaction(async (transaction) => {
    await assertLeaseOwner(transaction, batch);
    await transaction.emailMessage.updateMany({
      where: {
        id: { in: batch.messages.map(({ id }) => id) },
        state: 'PENDING',
      },
      data: { state: 'INDETERMINATE', stateDetail: detail },
    });
    await deleteOwnedBatch(transaction, batch);
  });
  return terminalDrainResult(batch, 'indeterminate');
}

function terminalDrainResult(
  batch: ClaimedBatch,
  state: 'failed' | 'indeterminate',
): OutboxDrainResult {
  return {
    batchId: batch.id,
    claimed: batch.messages.length,
    accepted: 0,
    failed: state === 'failed' ? batch.messages.length : 0,
    retryScheduled: 0,
    indeterminate: state === 'indeterminate' ? batch.messages.length : 0,
    results: batch.messages.map((message) => ({
      messageId: message.id,
      state,
      resendEmailId: null,
    })),
  };
}

async function assertLeaseOwner(
  transaction: Prisma.TransactionClient,
  batch: ClaimedBatch,
) {
  const owned = await transaction.emailOutboxBatch.findFirst({
    where: { id: batch.id, leaseToken: batch.leaseToken },
    select: { id: true },
  });
  if (!owned) {
    throw new Error('Outbox batch lease was lost before completion');
  }
}

async function deleteOwnedBatch(
  transaction: Prisma.TransactionClient,
  batch: ClaimedBatch,
) {
  const deleted = await transaction.emailOutboxBatch.deleteMany({
    where: { id: batch.id, leaseToken: batch.leaseToken },
  });
  if (deleted.count !== 1) {
    throw new Error('Outbox batch lease was lost before cleanup');
  }
}

function isRetryableBatchError(error: unknown): boolean {
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

function hasProviderWindowExpired(batch: ClaimedBatch): boolean {
  return (
    Date.now() - batch.firstAttemptAt.getTime() >=
    PROVIDER_IDEMPOTENCY_SAFETY_MS
  );
}

function getErrorCode(error: unknown): string {
  if (error instanceof ResendApiError) {
    return error.code ?? `http_${error.status}`;
  }
  return error instanceof Error ? error.name : 'unknown_error';
}

function emptyDrainResult(): OutboxDrainResult {
  return {
    batchId: null,
    claimed: 0,
    accepted: 0,
    failed: 0,
    retryScheduled: 0,
    indeterminate: 0,
    results: [],
  };
}
