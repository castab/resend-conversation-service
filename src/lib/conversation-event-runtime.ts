import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import {
  connect,
  headers,
  type JetStreamClient,
  type NatsConnection,
  StringCodec,
} from 'nats';
import type { PrismaClient } from '@/lib/database';
import {
  type ConversationEventSinkName,
  getEnabledConversationEventSinks,
} from './conversation-events';

const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 50;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const;
const codec = StringCodec();

export interface ConversationEventSink {
  readonly name: ConversationEventSinkName;
  publish(event: PublishedConversationEvent): Promise<void>;
  close(): Promise<void>;
}

interface PublishedConversationEvent {
  id: string;
  conversationId: string;
  sequence: number;
  payload: unknown;
}

interface ClaimedDelivery extends PublishedConversationEvent {
  leaseToken: string;
  attemptCount: number;
}

let runtime: ConversationEventRuntime | null = null;

export class ConversationEventRuntime {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private healthy = true;

  constructor(
    private readonly client: PrismaClient,
    private readonly sinks: ConversationEventSink[],
  ) {}

  start() {
    if (!this.sinks.length) {
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
    return this.sinks.length === 0 || this.healthy;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await Promise.all(this.sinks.map((sink) => sink.close()));
  }

  private async drain() {
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      let cycleHealthy = true;
      for (const sink of this.sinks) {
        const deliveries = await claimDeliveries(this.client, sink.name);
        for (const delivery of deliveries) {
          try {
            await sink.publish(delivery);
            await acknowledgeDelivery(this.client, sink.name, delivery);
          } catch (error) {
            cycleHealthy = false;
            await retryDelivery(this.client, sink.name, delivery, error);
          }
        }
      }
      if (this.sinks.length) {
        this.healthy = cycleHealthy;
      }
    } catch {
      this.healthy = false;
    } finally {
      this.running = false;
    }
  }
}

export async function startConversationEventRuntime(client: PrismaClient) {
  const sinks = await createConfiguredSinks();
  runtime = new ConversationEventRuntime(client, sinks);
  runtime.start();
  return runtime;
}

export function wakeConversationEventRuntime() {
  runtime?.wake();
}

export function conversationEventRuntimeHealthy() {
  return runtime?.isHealthy() ?? true;
}

export async function stopConversationEventRuntime() {
  await runtime?.stop();
  runtime = null;
}

async function createConfiguredSinks(): Promise<ConversationEventSink[]> {
  const names = getEnabledConversationEventSinks();
  return Promise.all(
    names.map((name) =>
      name === 'NATS' ? createNatsSink() : createKafkaSink(),
    ),
  );
}

async function createNatsSink(): Promise<ConversationEventSink> {
  const servers = requiredList('CONVERSATION_EVENTS_NATS_SERVERS');
  const stream = required('CONVERSATION_EVENTS_NATS_STREAM');
  const subject = required('CONVERSATION_EVENTS_NATS_SUBJECT');
  const token = optional('CONVERSATION_EVENTS_NATS_TOKEN');
  const user = optional('CONVERSATION_EVENTS_NATS_USERNAME');
  const pass = optional('CONVERSATION_EVENTS_NATS_PASSWORD');
  if (token && (user || pass)) {
    throw new Error('NATS token and username/password cannot be combined');
  }
  if ((user && !pass) || (!user && pass)) {
    throw new Error('NATS username and password must be provided together');
  }
  const nc = await connect({
    servers,
    ...(token ? { token } : {}),
    ...(user ? { user, pass } : {}),
    ...natsTlsOptions(),
  });
  const manager = await nc.jetstreamManager();
  await manager.streams.info(stream);
  const js = nc.jetstream();
  return new NatsConversationEventSink(nc, js, subject);
}

class NatsConversationEventSink implements ConversationEventSink {
  readonly name = 'NATS' as const;
  constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly subject: string,
  ) {}
  async publish(event: PublishedConversationEvent) {
    const eventHeaders = headers();
    eventHeaders.set('x-conversation-event-id', event.id);
    eventHeaders.set('x-conversation-event-schema-version', '1');
    await this.js.publish(
      this.subject,
      codec.encode(JSON.stringify(event.payload)),
      {
        msgID: event.id,
        headers: eventHeaders,
      },
    );
  }
  async close() {
    await this.nc.drain();
  }
}

async function createKafkaSink(): Promise<ConversationEventSink> {
  const brokers = requiredList('CONVERSATION_EVENTS_KAFKA_BROKERS');
  const topic = required('CONVERSATION_EVENTS_KAFKA_TOPIC');
  const clientId = required('CONVERSATION_EVENTS_KAFKA_CLIENT_ID');
  const kafka = new Kafka({
    brokers,
    clientId,
    logLevel: logLevel.NOTHING,
    ...kafkaSecurityOptions(),
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.fetchTopicMetadata({ topics: [topic] });
  } finally {
    await admin.disconnect();
  }
  const producer = kafka.producer();
  await producer.connect();
  return new KafkaConversationEventSink(producer, topic);
}

class KafkaConversationEventSink implements ConversationEventSink {
  readonly name = 'KAFKA' as const;
  constructor(
    private readonly producer: Producer,
    private readonly topic: string,
  ) {}
  async publish(event: PublishedConversationEvent) {
    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: event.conversationId,
          value: JSON.stringify(event.payload),
          headers: {
            'x-conversation-event-id': event.id,
            'x-conversation-event-schema-version': '1',
          },
        },
      ],
    });
  }
  async close() {
    await this.producer.disconnect();
  }
}

async function claimDeliveries(
  client: PrismaClient,
  sink: ConversationEventSinkName,
): Promise<ClaimedDelivery[]> {
  const token = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{
        event_id: string;
        conversation_id: string;
        sequence: number;
        payload: unknown;
        attempt_count: number;
      }>
    >`
      SELECT delivery.event_id, event.conversation_id, event.sequence, event.payload, delivery.attempt_count
      FROM conversation_event_deliveries AS delivery
      INNER JOIN conversation_events AS event ON event.id = delivery.event_id
      WHERE delivery.sink = ${sink}::"ConversationEventSink"
        AND delivery.published_at IS NULL
        AND delivery.next_attempt_at <= ${now}
        AND (delivery.lease_until IS NULL OR delivery.lease_until <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM conversation_event_deliveries older_delivery
          INNER JOIN conversation_events older_event ON older_event.id = older_delivery.event_id
          WHERE older_delivery.sink = delivery.sink
            AND older_event.conversation_id = event.conversation_id
            AND older_event.sequence < event.sequence
            AND older_delivery.published_at IS NULL
        )
      ORDER BY event.created_at, event.id
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    `;
    for (const row of rows) {
      await transaction.conversationEventDelivery.update({
        where: { eventId_sink: { eventId: row.event_id, sink } },
        data: { leaseToken: token, leaseUntil, attemptCount: { increment: 1 } },
      });
    }
    return rows.map((row) => ({
      id: row.event_id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      payload: row.payload,
      leaseToken: token,
      attemptCount: row.attempt_count + 1,
    }));
  });
}

async function acknowledgeDelivery(
  client: PrismaClient,
  sink: ConversationEventSinkName,
  delivery: ClaimedDelivery,
) {
  await client.conversationEventDelivery.updateMany({
    where: { eventId: delivery.id, sink, leaseToken: delivery.leaseToken },
    data: {
      publishedAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: null,
    },
  });
}

async function retryDelivery(
  client: PrismaClient,
  sink: ConversationEventSinkName,
  delivery: ClaimedDelivery,
  error: unknown,
) {
  const delay =
    RETRY_DELAYS_MS[
      Math.min(delivery.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ];
  await client.conversationEventDelivery.updateMany({
    where: { eventId: delivery.id, sink, leaseToken: delivery.leaseToken },
    data: {
      nextAttemptAt: new Date(Date.now() + delay),
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode:
        error instanceof Error ? error.name.slice(0, 64) : 'publish_error',
    },
  });
}

function required(name: string) {
  const value = optional(name);
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}
function requiredList(name: string) {
  return required(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
function optional(name: string) {
  const value = process.env[name];
  return value?.trim() || undefined;
}

function natsTlsOptions() {
  const mode = optional('CONVERSATION_EVENTS_NATS_TLS_MODE') ?? 'disabled';
  if (mode === 'disabled') {
    return {};
  }
  if (mode === 'system') {
    return { tls: {} };
  }
  if (mode !== 'custom') {
    throw new Error(
      'CONVERSATION_EVENTS_NATS_TLS_MODE must be disabled, system, or custom',
    );
  }
  const cert = optional('CONVERSATION_EVENTS_NATS_TLS_CERT_PEM');
  const key = optional('CONVERSATION_EVENTS_NATS_TLS_KEY_PEM');
  if ((cert && !key) || (!cert && key)) {
    throw new Error('NATS TLS certificate and key must be provided together');
  }
  return {
    tls: {
      ...(optional('CONVERSATION_EVENTS_NATS_TLS_CA_PEM')
        ? { ca: optional('CONVERSATION_EVENTS_NATS_TLS_CA_PEM') }
        : {}),
      ...(cert && key ? { cert, key } : {}),
    },
  };
}

function kafkaSecurityOptions() {
  const protocol = (
    optional('CONVERSATION_EVENTS_KAFKA_SECURITY_PROTOCOL') ?? 'PLAINTEXT'
  ).toUpperCase();
  if (!['PLAINTEXT', 'SSL', 'SASL_SSL'].includes(protocol)) {
    throw new Error('Invalid CONVERSATION_EVENTS_KAFKA_SECURITY_PROTOCOL');
  }
  const mechanism = optional(
    'CONVERSATION_EVENTS_KAFKA_SASL_MECHANISM',
  )?.toUpperCase();
  const username = optional('CONVERSATION_EVENTS_KAFKA_SASL_USERNAME');
  const password = optional('CONVERSATION_EVENTS_KAFKA_SASL_PASSWORD');
  if (protocol === 'SASL_SSL' && (!mechanism || !username || !password)) {
    throw new Error(
      'Kafka SASL_SSL requires mechanism, username, and password',
    );
  }
  if (
    mechanism &&
    !['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'].includes(mechanism)
  ) {
    throw new Error('Invalid CONVERSATION_EVENTS_KAFKA_SASL_MECHANISM');
  }
  const ssl = protocol === 'PLAINTEXT' ? undefined : kafkaTlsOptions();
  const sasl = kafkaSasl(mechanism, username, password);
  return { ...(ssl ? { ssl } : {}), ...(sasl ? { sasl } : {}) };
}

function kafkaTlsOptions() {
  const ca = optional('CONVERSATION_EVENTS_KAFKA_TLS_CA_PEM');
  const cert = optional('CONVERSATION_EVENTS_KAFKA_TLS_CERT_PEM');
  const key = optional('CONVERSATION_EVENTS_KAFKA_TLS_KEY_PEM');
  if ((cert && !key) || (!cert && key)) {
    throw new Error('Kafka TLS certificate and key must be provided together');
  }
  return ca || cert
    ? { ...(ca ? { ca } : {}), ...(cert && key ? { cert, key } : {}) }
    : true;
}

function kafkaSasl(
  mechanism: string | undefined,
  username: string | undefined,
  password: string | undefined,
) {
  if (!mechanism || !username || !password) {
    return undefined;
  }
  if (mechanism === 'PLAIN') {
    return { mechanism: 'plain' as const, username, password };
  }
  if (mechanism === 'SCRAM-SHA-256') {
    return { mechanism: 'scram-sha-256' as const, username, password };
  }
  return { mechanism: 'scram-sha-512' as const, username, password };
}
