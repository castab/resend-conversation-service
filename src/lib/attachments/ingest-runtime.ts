import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@/lib/database';
import { getConfiguredResendClient, type ResendEmailClient } from '@/lib/email';
import { logEvent } from '@/lib/logger';
import { recordAttachmentIngest } from '@/lib/telemetry-metrics';
import { attachmentsEnabled, resolveAttachmentLimits } from './config';
import { deleteStoredObject } from './reaper';
import {
  type AttachmentStorage,
  getConfiguredAttachmentStorage,
} from './storage';

const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 60_000;
const BATCH_SIZE = 10;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

interface ClaimedAttachment {
  id: string;
  resendEmailId: string;
  resendAttachmentId: string;
  storageKey: string;
  contentType: string;
  leaseToken: string;
  attemptCount: number;
}

let runtime: AttachmentIngestRuntime | null = null;

export class AttachmentIngestRuntime {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private healthy = true;

  constructor(
    private readonly client: PrismaClient,
    private readonly enabled: boolean,
    private readonly storage: () => AttachmentStorage,
    private readonly resend: () => ResendEmailClient,
  ) {}

  start() {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.drain();
  }

  wake() {
    if (!this.stopped) {
      void this.drain();
    }
  }

  isHealthy() {
    return !this.enabled || this.healthy;
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

  private async drain() {
    if (this.stopped || this.running || !this.enabled) {
      return;
    }
    this.running = true;
    try {
      let cycleHealthy = true;
      const claimed = await claimPendingAttachments(this.client);
      for (const attachment of claimed) {
        try {
          await this.ingest(attachment);
          recordAttachmentIngest('stored');
        } catch (error) {
          cycleHealthy = false;
          const outcome = await failAttachment(this.client, attachment, error);
          recordAttachmentIngest(outcome);
        }
      }
      this.healthy = cycleHealthy;
    } catch {
      this.healthy = false;
    } finally {
      this.running = false;
    }
  }

  private async ingest(attachment: ClaimedAttachment) {
    // The signed URL is fetched fresh on every attempt. Resend expires it, so
    // persisting it at projection time would guarantee stale links on retry.
    const metadata = await this.resend().getReceivedAttachment(
      attachment.resendEmailId,
      attachment.resendAttachmentId,
    );
    if (!metadata.download_url) {
      throw new Error('Resend attachment is missing a download URL');
    }

    const limits = resolveAttachmentLimits();
    const body = await this.resend().downloadAttachment(metadata.download_url);
    if (body.byteLength > limits.maxBytes) {
      throw new AttachmentTooLargeError(
        `Attachment exceeds ${limits.maxBytes} bytes`,
      );
    }

    const storage = this.storage();
    await storage.put(attachment.storageKey, body, attachment.contentType);

    const updated = await this.client.emailAttachment.updateMany({
      where: { id: attachment.id, leaseToken: attachment.leaseToken },
      data: {
        state: 'STORED',
        stateDetail: null,
        sizeBytes: BigInt(body.byteLength),
        checksumSha256: createHash('sha256').update(body).digest('hex'),
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: null,
      },
    });
    if (updated.count !== 1) {
      // The lease was lost mid-flight, so another worker owns this row and
      // will write its own object. Remove the one this attempt uploaded.
      await deleteStoredObject(this.client, attachment.storageKey);
      throw new Error('Attachment lease was lost before completion');
    }
  }
}

class AttachmentTooLargeError extends Error {
  override name = 'AttachmentTooLargeError';
}

export function startAttachmentIngestRuntime(client: PrismaClient) {
  const enabled = attachmentsEnabled();
  runtime = new AttachmentIngestRuntime(
    client,
    enabled,
    getConfiguredAttachmentStorage,
    getConfiguredResendClient,
  );
  runtime.start();
  return runtime;
}

export function wakeAttachmentIngestRuntime() {
  runtime?.wake();
}

export function attachmentIngestRuntimeHealthy() {
  return runtime?.isHealthy() ?? true;
}

export async function stopAttachmentIngestRuntime() {
  await runtime?.stop();
  runtime = null;
}

async function claimPendingAttachments(
  client: PrismaClient,
): Promise<ClaimedAttachment[]> {
  const token = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{
        id: string;
        resend_email_id: string;
        resend_attachment_id: string;
        storage_key: string;
        content_type: string;
        attempt_count: number;
      }>
    >`
      SELECT id, resend_email_id, resend_attachment_id, storage_key, content_type, attempt_count
      FROM email_attachments
      WHERE state = 'PENDING'
        AND source = 'INBOUND'
        AND resend_email_id IS NOT NULL
        AND resend_attachment_id IS NOT NULL
        AND next_attempt_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now})
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    `;
    if (!rows.length) {
      return [];
    }
    await transaction.emailAttachment.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { leaseToken: token, leaseUntil, attemptCount: { increment: 1 } },
    });
    return rows.map((row) => ({
      id: row.id,
      resendEmailId: row.resend_email_id,
      resendAttachmentId: row.resend_attachment_id,
      storageKey: row.storage_key,
      contentType: row.content_type,
      leaseToken: token,
      attemptCount: row.attempt_count + 1,
    }));
  });
}

async function failAttachment(
  client: PrismaClient,
  attachment: ClaimedAttachment,
  error: unknown,
): Promise<'failed' | 'retry_scheduled'> {
  const errorCode =
    error instanceof Error ? error.name.slice(0, 64) : 'ingest_error';
  const terminal =
    error instanceof AttachmentTooLargeError ||
    attachment.attemptCount >= MAX_ATTEMPTS;

  logEvent('warn', 'attachment_ingest_attempt_failed', {
    error_type: errorCode,
    attempt: attachment.attemptCount,
    terminal,
  });

  if (terminal) {
    await client.emailAttachment.updateMany({
      where: { id: attachment.id, leaseToken: attachment.leaseToken },
      data: {
        state: 'FAILED',
        stateDetail:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : 'Unknown ingest error',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: errorCode,
      },
    });
    return 'failed';
  }

  const delay =
    RETRY_DELAYS_MS[
      Math.min(attachment.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ];
  await client.emailAttachment.updateMany({
    where: { id: attachment.id, leaseToken: attachment.leaseToken },
    data: {
      nextAttemptAt: new Date(Date.now() + delay),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
    },
  });
  return 'retry_scheduled';
}
