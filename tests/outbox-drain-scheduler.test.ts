import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outboxMocks = vi.hoisted(() => ({
  drainEmailOutbox: vi.fn(),
}));

vi.mock('@/lib/outbox-service', () => ({
  drainEmailOutbox: outboxMocks.drainEmailOutbox,
}));

import {
  type OutboxDrainSchedule,
  resolveOutboxDrainSchedule,
  runScheduledDrain,
} from '@/lib/outbox-drain-scheduler';

const client = {} as never;

function environment(overrides: Record<string, string> = {}) {
  return {
    OUTBOX_DRAIN_SCHEDULE_ENABLED: 'true',
    OUTBOX_DRAIN_SCHEDULE: '*/5 * * * *',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function drainResult(claimed: number) {
  return {
    batchId: claimed ? 'batch' : null,
    claimed,
    accepted: claimed,
    failed: 0,
    retryScheduled: 0,
    indeterminate: 0,
    results: [],
  };
}

function schedule(
  overrides: Partial<OutboxDrainSchedule> = {},
): OutboxDrainSchedule {
  return {
    expression: '*/5 * * * *',
    timezone: 'UTC',
    batchSize: 100,
    maxBatches: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveOutboxDrainSchedule', () => {
  it('is disabled by default', () => {
    expect(resolveOutboxDrainSchedule({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveOutboxDrainSchedule({
        OUTBOX_DRAIN_SCHEDULE: '*/5 * * * *',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('applies defaults when only the expression is configured', () => {
    expect(resolveOutboxDrainSchedule(environment())).toEqual({
      expression: '*/5 * * * *',
      timezone: 'UTC',
      batchSize: 100,
      maxBatches: 5,
    });
  });

  it('reads the configured timezone and bounds', () => {
    expect(
      resolveOutboxDrainSchedule(
        environment({
          OUTBOX_DRAIN_SCHEDULE: '0 9 * * 1-5',
          OUTBOX_DRAIN_SCHEDULE_TIMEZONE: 'America/Los_Angeles',
          OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE: '25',
          OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES: '2',
        }),
      ),
    ).toEqual({
      expression: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      batchSize: 25,
      maxBatches: 2,
    });
  });

  it('rejects an enabled flag that is not true', () => {
    expect(() =>
      resolveOutboxDrainSchedule(
        environment({ OUTBOX_DRAIN_SCHEDULE_ENABLED: 'yes' }),
      ),
    ).toThrow('OUTBOX_DRAIN_SCHEDULE_ENABLED must be true when set');
  });

  it('requires an expression when enabled', () => {
    expect(() =>
      resolveOutboxDrainSchedule({
        OUTBOX_DRAIN_SCHEDULE_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow('Missing OUTBOX_DRAIN_SCHEDULE');
  });

  it('rejects an unparseable cron expression', () => {
    expect(() =>
      resolveOutboxDrainSchedule(
        environment({ OUTBOX_DRAIN_SCHEDULE: 'not-a-cron' }),
      ),
    ).toThrow();
  });

  it('rejects out-of-range batch and cap values', () => {
    expect(() =>
      resolveOutboxDrainSchedule(
        environment({ OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE: '101' }),
      ),
    ).toThrow('OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE must be an integer between');
    expect(() =>
      resolveOutboxDrainSchedule(
        environment({ OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES: '0' }),
      ),
    ).toThrow('OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES must be an integer between');
    expect(() =>
      resolveOutboxDrainSchedule(
        environment({ OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE: '10.5' }),
      ),
    ).toThrow('OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE must be an integer between');
  });
});

describe('runScheduledDrain', () => {
  it('stops as soon as the outbox comes back empty', async () => {
    outboxMocks.drainEmailOutbox
      .mockResolvedValueOnce(drainResult(3))
      .mockResolvedValueOnce(drainResult(0));

    await runScheduledDrain(client, schedule());

    expect(outboxMocks.drainEmailOutbox).toHaveBeenCalledTimes(2);
  });

  it('stops at the per-tick batch cap while the outbox stays full', async () => {
    outboxMocks.drainEmailOutbox.mockResolvedValue(drainResult(100));

    await runScheduledDrain(client, schedule({ maxBatches: 3 }));

    expect(outboxMocks.drainEmailOutbox).toHaveBeenCalledTimes(3);
  });

  it('passes the configured batch size to each drain', async () => {
    outboxMocks.drainEmailOutbox.mockResolvedValue(drainResult(0));

    await runScheduledDrain(client, schedule({ batchSize: 25 }));

    expect(outboxMocks.drainEmailOutbox).toHaveBeenCalledWith(client, 25);
  });

  it('propagates a drain failure to the caller', async () => {
    outboxMocks.drainEmailOutbox.mockRejectedValue(new Error('database down'));

    await expect(runScheduledDrain(client, schedule())).rejects.toThrow(
      'database down',
    );
  });
});
