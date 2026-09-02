import { Cron } from 'croner';
import type { PrismaClient } from '@/lib/database';
import { logEvent } from '@/lib/logger';
import { drainEmailOutbox } from '@/lib/outbox-service';
import {
  recordOutboxDrain,
  recordScheduledDrain,
} from '@/lib/telemetry-metrics';

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 5;

export interface OutboxDrainSchedule {
  expression: string;
  timezone: string;
  batchSize: number;
  maxBatches: number;
}

let job: Cron | null = null;
let running = false;

/**
 * Resolves the scheduled drain configuration. Returns null when the scheduler
 * is disabled, which is the default. Throws on malformed configuration so a
 * misconfigured scheduler fails startup instead of silently never firing.
 */
export function resolveOutboxDrainSchedule(
  environment: NodeJS.ProcessEnv = process.env,
): OutboxDrainSchedule | null {
  const enabled = environment.OUTBOX_DRAIN_SCHEDULE_ENABLED?.trim();
  if (!enabled) {
    return null;
  }
  if (enabled.toLowerCase() !== 'true') {
    throw new Error('OUTBOX_DRAIN_SCHEDULE_ENABLED must be true when set');
  }

  const expression = environment.OUTBOX_DRAIN_SCHEDULE?.trim();
  if (!expression) {
    throw new Error(
      'Missing OUTBOX_DRAIN_SCHEDULE for the enabled outbox drain scheduler',
    );
  }
  const timezone =
    environment.OUTBOX_DRAIN_SCHEDULE_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  const schedule: OutboxDrainSchedule = {
    expression,
    timezone,
    batchSize: boundedInteger(
      environment.OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE,
      'OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
    ),
    maxBatches: boundedInteger(
      environment.OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES,
      'OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES',
      DEFAULT_MAX_BATCHES,
    ),
  };

  // Let croner reject an unparseable expression or timezone here, at startup,
  // rather than at the first fire.
  new Cron(schedule.expression, {
    timezone: schedule.timezone,
    paused: true,
  }).stop();

  return schedule;
}

/**
 * One scheduled tick. Drains bounded batches until the outbox comes back empty
 * or the per-tick cap is reached, so a backlog clears instead of trickling out
 * one batch per fire.
 */
export async function runScheduledDrain(
  client: PrismaClient,
  schedule: OutboxDrainSchedule,
) {
  const startedAt = performance.now();
  let outcome: 'success' | 'failure' = 'failure';
  try {
    for (let batch = 0; batch < schedule.maxBatches; batch += 1) {
      const drainStartedAt = performance.now();
      const result = await drainEmailOutbox(client, schedule.batchSize);
      recordOutboxDrain((performance.now() - drainStartedAt) / 1_000, result);
      if (result.claimed === 0) {
        outcome = 'success';
        return;
      }
    }
    outcome = 'success';
  } finally {
    recordScheduledDrain((performance.now() - startedAt) / 1_000, outcome);
  }
}

export function startOutboxDrainScheduler(client: PrismaClient) {
  const schedule = resolveOutboxDrainSchedule();
  if (!schedule) {
    return;
  }
  job = new Cron(
    schedule.expression,
    { timezone: schedule.timezone, protect: true },
    async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        await runScheduledDrain(client, schedule);
      } catch (error) {
        // Readiness is deliberately not affected: drainEmailOutbox already
        // absorbs transient provider failures through its own retry
        // scheduling, and cycling the container on one bad tick would be
        // worse than skipping it. Never log message content.
        logEvent('error', 'scheduled_outbox_drain_failed', {
          error_type: error instanceof Error ? error.name : 'unknown_error',
        });
      } finally {
        running = false;
      }
    },
  );
  logEvent('info', 'scheduled_outbox_drain_enabled');
}

export async function stopOutboxDrainScheduler() {
  job?.stop();
  job = null;
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function boundedInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
) {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${name} must be an integer between 1 and 100`);
  }
  return parsed;
}
