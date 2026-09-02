import type { PrismaClient } from '@/lib/database';
import { logEvent } from './logger';
import { getTelemetryMeter } from './telemetry';

type Attributes = Record<string, string | number | boolean>;

const meter = () => getTelemetryMeter();

let instruments: ReturnType<typeof createInstruments> | null = null;

function getInstruments() {
  instruments ??= createInstruments();
  return instruments;
}

function createInstruments() {
  const telemetryMeter = meter();
  return {
    httpRequests: telemetryMeter.createCounter('http.server.request.count', {
      description: 'Number of completed HTTP server requests',
      unit: '{request}',
    }),
    httpDuration: telemetryMeter.createHistogram(
      'http.server.request.duration',
      {
        description: 'Duration of completed HTTP server requests',
        unit: 's',
      },
    ),
    httpActive: telemetryMeter.createUpDownCounter(
      'http.server.active_requests',
      {
        description: 'Number of active HTTP server requests',
        unit: '{request}',
      },
    ),
    providerRequests: telemetryMeter.createCounter(
      'resend_conversation.email.provider.request.count',
      { description: 'Resend provider requests', unit: '{request}' },
    ),
    providerDuration: telemetryMeter.createHistogram(
      'resend_conversation.email.provider.request.duration',
      { description: 'Resend provider request duration', unit: 's' },
    ),
    webhookEvents: telemetryMeter.createCounter(
      'resend_conversation.webhook.event.count',
      {
        description: 'Webhook events handled by outcome',
        unit: '{event}',
      },
    ),
    emailIntents: telemetryMeter.createCounter(
      'resend_conversation.email.intent.count',
      { description: 'Persisted outbound email intents', unit: '{message}' },
    ),
    outboxMessages: telemetryMeter.createCounter(
      'resend_conversation.outbox.message.count',
      {
        description: 'Outbox messages processed by terminal outcome',
        unit: '{message}',
      },
    ),
    outboxDrainDuration: telemetryMeter.createHistogram(
      'resend_conversation.outbox.drain.duration',
      { description: 'Outbox drain duration', unit: 's' },
    ),
    schedulerRuns: telemetryMeter.createCounter(
      'resend_conversation.scheduler.run.count',
      {
        description: 'Scheduled outbox drain runs',
        unit: '{run}',
      },
    ),
    schedulerDuration: telemetryMeter.createHistogram(
      'resend_conversation.scheduler.run.duration',
      { description: 'Scheduled outbox drain duration', unit: 's' },
    ),
    eventDeliveries: telemetryMeter.createCounter(
      'resend_conversation.conversation_event.delivery.count',
      { description: 'Conversation event delivery attempts', unit: '{event}' },
    ),
  };
}

export function recordHttpRequest(
  durationSeconds: number,
  attributes: Attributes,
) {
  const current = getInstruments();
  current.httpRequests.add(1, attributes);
  current.httpDuration.record(durationSeconds, attributes);
}

export function changeHttpActive(delta: number, attributes: Attributes) {
  getInstruments().httpActive.add(delta, attributes);
}

export function recordProviderRequest(
  durationSeconds: number,
  operation: 'send' | 'send_batch' | 'get_sent' | 'get_received',
  outcome: 'success' | 'failure',
  statusClass: 'none' | '2xx' | '4xx' | '5xx',
) {
  const attributes = {
    operation,
    outcome,
    'http.response.status_class': statusClass,
  };
  const current = getInstruments();
  current.providerRequests.add(1, attributes);
  current.providerDuration.record(durationSeconds, attributes);
}

export function recordWebhookEvent(
  eventType: 'email' | 'contact' | 'domain' | 'unknown',
  outcome: 'accepted' | 'rejected' | 'failed',
) {
  getInstruments().webhookEvents.add(1, { event_type: eventType, outcome });
}

export function recordEmailIntent(
  kind: 'conversation' | 'direct',
  deliveryMode: 'synchronous' | 'outbox',
) {
  getInstruments().emailIntents.add(1, { kind, delivery_mode: deliveryMode });
}

export function recordOutboxDrain(
  durationSeconds: number,
  result: {
    accepted: number;
    failed: number;
    retryScheduled: number;
    indeterminate: number;
  },
) {
  const current = getInstruments();
  current.outboxDrainDuration.record(durationSeconds);
  for (const [outcome, count] of Object.entries({
    accepted: result.accepted,
    failed: result.failed,
    retry_scheduled: result.retryScheduled,
    indeterminate: result.indeterminate,
  })) {
    if (count > 0) {
      current.outboxMessages.add(count, { outcome });
    }
  }
}

export function recordScheduledDrain(
  durationSeconds: number,
  outcome: 'success' | 'failure',
) {
  const current = getInstruments();
  current.schedulerRuns.add(1, { outcome });
  current.schedulerDuration.record(durationSeconds, { outcome });
}

export function recordConversationEventDelivery(
  outcome: 'published' | 'retry_scheduled' | 'failed',
) {
  getInstruments().eventDeliveries.add(1, { sink: 'nats', outcome });
}

/** Register lightweight read-only business gauges once telemetry is enabled. */
export function registerDatabaseGauges(client: PrismaClient) {
  const telemetryMeter = meter();
  const outboxPending = telemetryMeter.createObservableGauge(
    'resend_conversation.outbox.pending',
    { description: 'Pending outbox messages', unit: '{message}' },
  );
  const outboxOldest = telemetryMeter.createObservableGauge(
    'resend_conversation.outbox.oldest_pending.age',
    { description: 'Age of the oldest pending outbox message', unit: 's' },
  );
  const conversations = telemetryMeter.createObservableGauge(
    'resend_conversation.conversation.current',
    { description: 'Conversations by current state', unit: '{conversation}' },
  );
  const eventBacklog = telemetryMeter.createObservableGauge(
    'resend_conversation.conversation_event.delivery.pending',
    {
      description: 'Pending NATS conversation event deliveries',
      unit: '{event}',
    },
  );
  const eventOldest = telemetryMeter.createObservableGauge(
    'resend_conversation.conversation_event.delivery.oldest_pending.age',
    { description: 'Age of the oldest pending NATS delivery', unit: 's' },
  );
  const runtime = telemetryMeter.createObservableGauge(
    'resend_conversation.runtime.info',
    { description: 'Service runtime presence', unit: '{service}' },
  );
  const runtimeUptime = telemetryMeter.createObservableGauge(
    'resend_conversation.runtime.uptime',
    { description: 'Process uptime', unit: 's' },
  );
  const runtimeMemory = telemetryMeter.createObservableGauge(
    'resend_conversation.runtime.memory.rss',
    { description: 'Process resident memory', unit: 'By' },
  );

  telemetryMeter.addBatchObservableCallback(
    async (observableResult) => {
      try {
        const [outbox, conversationStates, deliveries] = await Promise.all([
          client.$queryRaw<
            Array<{ count: bigint; oldest_age_seconds: number | null }>
          >`
        SELECT COUNT(*)::bigint AS count,
          EXTRACT(EPOCH FROM (now() - MIN(entry.queued_at))) AS oldest_age_seconds
        FROM email_outbox_entries AS entry
        INNER JOIN email_messages AS message ON message.id = entry.message_id
        WHERE message.state = 'PENDING'
      `,
          client.$queryRaw<Array<{ state: string; count: bigint }>>`
        SELECT state::text, COUNT(*)::bigint AS count
        FROM email_conversations
        GROUP BY state
      `,
          client.$queryRaw<
            Array<{ count: bigint; oldest_age_seconds: number | null }>
          >`
        SELECT COUNT(*)::bigint AS count,
          EXTRACT(EPOCH FROM (now() - MIN(delivery.created_at))) AS oldest_age_seconds
        FROM conversation_event_deliveries AS delivery
        WHERE delivery.sink = 'NATS'::"ConversationEventSink"
          AND delivery.published_at IS NULL
      `,
        ]);
        const pending = Number(outbox[0]?.count ?? 0);
        observableResult.observe(outboxPending, pending);
        if (
          outbox[0]?.oldest_age_seconds !== null &&
          outbox[0]?.oldest_age_seconds !== undefined
        ) {
          observableResult.observe(outboxOldest, outbox[0].oldest_age_seconds);
        }
        for (const row of conversationStates) {
          observableResult.observe(conversations, Number(row.count), {
            state: row.state.toLowerCase(),
          });
        }
        observableResult.observe(
          eventBacklog,
          Number(deliveries[0]?.count ?? 0),
          {
            sink: 'nats',
          },
        );
        if (
          deliveries[0]?.oldest_age_seconds !== null &&
          deliveries[0]?.oldest_age_seconds !== undefined
        ) {
          observableResult.observe(
            eventOldest,
            deliveries[0].oldest_age_seconds,
            {
              sink: 'nats',
            },
          );
        }
        observableResult.observe(runtime, 1, { runtime: 'nodejs' });
        observableResult.observe(runtimeUptime, process.uptime());
        observableResult.observe(runtimeMemory, process.memoryUsage().rss);
      } catch (error) {
        logEvent('error', 'database_telemetry_gauge_collection_failed', {
          error_type: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    },
    [
      outboxPending,
      outboxOldest,
      conversations,
      eventBacklog,
      eventOldest,
      runtime,
      runtimeUptime,
      runtimeMemory,
    ],
  );
}
