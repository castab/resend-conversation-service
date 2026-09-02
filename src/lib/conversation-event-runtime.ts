import { randomUUID } from 'node:crypto';
import {
  connect,
  headers,
  type JetStreamClient,
  type NatsConnection,
  StringCodec,
} from 'nats';
import type { PrismaClient } from '@/lib/database';
import { recordConversationEventDelivery } from '@/lib/telemetry-metrics';
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
            recordConversationEventDelivery('published');
          } catch (error) {
            cycleHealthy = false;
            await retryDelivery(this.client, sink.name, delivery, error);
            recordConversationEventDelivery('retry_scheduled');
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
  const results = await Promise.allSettled(names.map(() => createNatsSink()));
  const sinks = results
    .filter(
      (result): result is PromiseFulfilledResult<ConversationEventSink> =>
        result.status === 'fulfilled',
    )
    .map((result) => result.value);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    await Promise.all(sinks.map((sink) => sink.close().catch(() => undefined)));
    throw failure.reason;
  }
  return sinks;
}

async function createNatsSink(): Promise<ConversationEventSink> {
  let servers: string[];
  let stream: string;
  let subject: string;
  let token: string | undefined;
  let user: string | undefined;
  let pass: string | undefined;
  let tlsOptions: ReturnType<typeof natsTlsOptions>;
  try {
    servers = requiredList('CONVERSATION_EVENTS_NATS_SERVERS');
    stream = required('CONVERSATION_EVENTS_NATS_STREAM');
    subject = required('CONVERSATION_EVENTS_NATS_SUBJECT');
    token = optional('CONVERSATION_EVENTS_NATS_TOKEN');
    user = optional('CONVERSATION_EVENTS_NATS_USERNAME');
    pass = optional('CONVERSATION_EVENTS_NATS_PASSWORD');
    if (token && (user || pass)) {
      throw new Error('NATS token and username/password cannot be combined');
    }
    if ((user && !pass) || (!user && pass)) {
      throw new Error('NATS username and password must be provided together');
    }
    tlsOptions = natsTlsOptions();
  } catch (error) {
    throw startupFailure(
      'NATS',
      'validate configuration',
      natsStartupContext(),
      error,
      'Verify the NATS connection, authentication, and TLS environment variables.',
    );
  }
  const context = natsStartupContext({ servers, stream, subject, token, user });
  let nc: NatsConnection | undefined;
  try {
    try {
      nc = await connect({
        servers,
        ...(token ? { token } : {}),
        ...(user ? { user, pass } : {}),
        ...tlsOptions,
      });
    } catch (error) {
      throw startupFailure(
        'NATS',
        'connect',
        context,
        error,
        'Verify that the configured NATS endpoints are reachable and accept the configured authentication and TLS settings.',
      );
    }
    let manager: Awaited<ReturnType<NatsConnection['jetstreamManager']>>;
    try {
      manager = await nc.jetstreamManager();
    } catch (error) {
      throw startupFailure(
        'NATS',
        'access JetStream manager',
        context,
        error,
        'Verify that JetStream is enabled and that the configured identity can access its management API.',
      );
    }
    try {
      await manager.streams.info(stream);
    } catch (error) {
      throw startupFailure(
        'NATS',
        'verify configured stream',
        context,
        error,
        'Verify that the configured JetStream stream exists in the configured account.',
      );
    }
    let subjectStream: string;
    try {
      subjectStream = await manager.streams.find(subject);
    } catch (error) {
      throw startupFailure(
        'NATS',
        'resolve configured subject',
        context,
        error,
        'Verify that the configured subject is captured by a JetStream stream.',
      );
    }
    if (subjectStream !== stream) {
      throw startupFailure(
        'NATS',
        'verify configured subject',
        context,
        new Error(`Configured subject resolves to stream "${subjectStream}"`),
        'Configure a subject captured by the configured JetStream stream.',
      );
    }
    const js = nc.jetstream();
    return new NatsConversationEventSink(nc, js, subject);
  } catch (error) {
    await nc?.close().catch(() => undefined);
    throw error;
  }
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

interface NatsStartupContextInput {
  servers?: string[];
  stream?: string;
  subject?: string;
  token?: string;
  user?: string;
}

function natsStartupContext(input: NatsStartupContextInput = {}) {
  const servers =
    input.servers ?? optionalList('CONVERSATION_EVENTS_NATS_SERVERS');
  const stream = input.stream ?? optional('CONVERSATION_EVENTS_NATS_STREAM');
  const subject = input.subject ?? optional('CONVERSATION_EVENTS_NATS_SUBJECT');
  const token = input.token ?? optional('CONVERSATION_EVENTS_NATS_TOKEN');
  const user = input.user ?? optional('CONVERSATION_EVENTS_NATS_USERNAME');
  const tls = optional('CONVERSATION_EVENTS_NATS_TLS_MODE') ?? 'disabled';
  return `stream="${stream ?? '<unset>'}", subject="${subject ?? '<unset>'}", endpoints=[${sanitizeEndpoints(servers, 4222)}], auth=${token ? 'token' : user ? 'username_password' : 'none'}, tls=${tls}`;
}

function optionalList(name: string) {
  const value = optional(name);
  return value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function sanitizeEndpoints(endpoints: string[], defaultPort: number) {
  return endpoints
    .map((endpoint) => sanitizeEndpoint(endpoint, defaultPort))
    .join(',');
}

function sanitizeEndpoint(endpoint: string, defaultPort: number) {
  try {
    const url = new URL(
      endpoint.includes('://') ? endpoint : `tcp://${endpoint}`,
    );
    return `${url.hostname}:${url.port || defaultPort}`;
  } catch {
    const authority = endpoint
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
      .replace(/^[^@/\s]+@/, '')
      .split(/[/?#]/, 1)[0];
    return authority || '<invalid>';
  }
}

function startupFailure(
  sink: ConversationEventSinkName,
  operation: string,
  context: string,
  error: unknown,
  remediation: string,
) {
  const wrapped = new Error(
    `Conversation event sink ${sink} failed to ${operation} (${context}): ${safeErrorDetails(error)}. ${remediation}`,
  );
  wrapped.name = 'ConversationEventSinkStartupError';
  return wrapped;
}

function safeErrorDetails(error: unknown) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const details =
    error instanceof Error
      ? `${error.name}${code ? ` [${String(code)}]` : ''}: ${error.message}`
      : String(error);
  return redactConfiguredSecrets(details)
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      '[redacted PEM]',
    )
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, '$1[redacted]@')
    .replace(
      /((?:["']?(?:password|passwd|token|secret|authorization|username|user|key|cert|ca)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+))/gi,
      '$1[redacted]',
    );
}

function redactConfiguredSecrets(value: string) {
  return configuredSecretValues().reduce(
    (redacted, secret) => redacted.replaceAll(secret, '[redacted]'),
    value,
  );
}

function configuredSecretValues() {
  return [
    'CONVERSATION_EVENTS_NATS_TOKEN',
    'CONVERSATION_EVENTS_NATS_USERNAME',
    'CONVERSATION_EVENTS_NATS_PASSWORD',
    'CONVERSATION_EVENTS_NATS_TLS_CA_PEM',
    'CONVERSATION_EVENTS_NATS_TLS_CERT_PEM',
    'CONVERSATION_EVENTS_NATS_TLS_KEY_PEM',
  ]
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
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
