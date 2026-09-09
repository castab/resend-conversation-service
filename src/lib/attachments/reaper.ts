import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@/lib/database';
import { logEvent } from '@/lib/logger';
import { recordAttachmentReap } from '@/lib/telemetry-metrics';
import { attachmentsEnabled } from './config';
import {
  type AttachmentStorage,
  AttachmentStorageError,
  getConfiguredAttachmentStorage,
} from './storage';

const POLL_INTERVAL_MS = 30_000;
const LEASE_MS = 60_000;
const BATCH_SIZE = 50;
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 900_000] as const;

/**
 * Uploads that are never referenced by a send would otherwise accumulate in
 * object storage forever. Anything still unclaimed after this window is
 * assumed abandoned.
 */
export const UNREFERENCED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

interface ClaimedTombstone {
  id: string;
  storageKey: string;
  leaseToken: string;
  attemptCount: number;
}

let runtime: AttachmentReaperRuntime | null = null;

export class AttachmentReaperRuntime {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly client: PrismaClient,
    private readonly enabled: boolean,
    private readonly storage: () => AttachmentStorage,
  ) {}

  start() {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.drain();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async drain() {
    if (this.stopped || this.running || !this.enabled) {
      return { expired: 0, deleted: 0, retryScheduled: 0 };
    }
    this.running = true;
    try {
      const expired = await expireUnreferencedUploads(this.client);
      let deleted = 0;
      let retryScheduled = 0;
      for (const tombstone of await claimTombstones(this.client)) {
        try {
          await this.storage().delete(tombstone.storageKey);
          await this.client.storedObjectTombstone.deleteMany({
            where: { id: tombstone.id, leaseToken: tombstone.leaseToken },
          });
          deleted++;
          recordAttachmentReap('deleted');
        } catch (error) {
          // A missing object means the delete already happened; the tombstone
          // has served its purpose either way.
          if (error instanceof AttachmentStorageError && error.notFound) {
            await this.client.storedObjectTombstone.deleteMany({
              where: { id: tombstone.id, leaseToken: tombstone.leaseToken },
            });
            deleted++;
            recordAttachmentReap('deleted');
            continue;
          }
          retryScheduled++;
          await retryTombstone(this.client, tombstone, error);
          recordAttachmentReap('retry_scheduled');
        }
      }
      return { expired, deleted, retryScheduled };
    } catch (error) {
      logEvent('warn', 'attachment_reaper_cycle_failed', {
        error_type: error instanceof Error ? error.name : 'unknown_error',
      });
      return { expired: 0, deleted: 0, retryScheduled: 0 };
    } finally {
      this.running = false;
    }
  }
}

export function startAttachmentReaperRuntime(client: PrismaClient) {
  runtime = new AttachmentReaperRuntime(
    client,
    attachmentsEnabled(),
    getConfiguredAttachmentStorage,
  );
  runtime.start();
  return runtime;
}

export async function stopAttachmentReaperRuntime() {
  await runtime?.stop();
  runtime = null;
}

/**
 * Records a stored object for deletion. Callers that hold the row can rely on
 * the `email_attachments` delete trigger instead; this exists for objects that
 * never had a surviving row, such as an upload abandoned mid-request.
 */
export async function deleteStoredObject(
  client: PrismaClient | Prisma.TransactionClient,
  storageKey: string,
) {
  await client.storedObjectTombstone.createMany({
    data: [{ storageKey }],
    skipDuplicates: true,
  });
}

async function expireUnreferencedUploads(
  client: PrismaClient,
): Promise<number> {
  const cutoff = new Date(Date.now() - UNREFERENCED_UPLOAD_TTL_MS);
  // Deleting the rows fires the tombstone trigger, so the objects are queued
  // for removal by the same loop on a later cycle.
  const removed = await client.emailAttachment.deleteMany({
    where: {
      source: 'UPLOAD',
      messageId: null,
      createdAt: { lt: cutoff },
    },
  });
  return removed.count;
}

async function claimTombstones(
  client: PrismaClient,
): Promise<ClaimedTombstone[]> {
  const token = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{ id: string; storage_key: string; attempt_count: number }>
    >`
      SELECT id, storage_key, attempt_count
      FROM stored_object_tombstones
      WHERE next_attempt_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now})
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    `;
    if (!rows.length) {
      return [];
    }
    await transaction.storedObjectTombstone.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { leaseToken: token, leaseUntil, attemptCount: { increment: 1 } },
    });
    return rows.map((row) => ({
      id: row.id,
      storageKey: row.storage_key,
      leaseToken: token,
      attemptCount: row.attempt_count + 1,
    }));
  });
}

async function retryTombstone(
  client: PrismaClient,
  tombstone: ClaimedTombstone,
  error: unknown,
) {
  const delay =
    RETRY_DELAYS_MS[
      Math.min(tombstone.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ];
  await client.storedObjectTombstone.updateMany({
    where: { id: tombstone.id, leaseToken: tombstone.leaseToken },
    data: {
      nextAttemptAt: new Date(Date.now() + delay),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode:
        error instanceof Error ? error.name.slice(0, 64) : 'delete_error',
    },
  });
}
