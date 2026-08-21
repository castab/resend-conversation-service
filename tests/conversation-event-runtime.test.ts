import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const brokerMocks = vi.hoisted(() => {
  const natsConnection = {
    close: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
    jetstream: vi.fn(() => ({})),
    jetstreamManager: vi.fn(),
  };
  const natsStreams = {
    find: vi.fn(),
    info: vi.fn(),
  };
  const natsManager = { streams: natsStreams };
  const kafkaAdmin = {
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchTopicMetadata: vi.fn(),
  };
  const kafkaProducer = {
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const kafka = {
    admin: vi.fn(() => kafkaAdmin),
    producer: vi.fn(() => kafkaProducer),
  };
  return {
    connect: vi.fn(),
    kafka,
    kafkaAdmin,
    kafkaProducer,
    natsConnection,
    natsManager,
    natsStreams,
  };
});

vi.mock('nats', () => ({
  StringCodec: () => ({ encode: vi.fn() }),
  connect: brokerMocks.connect,
  headers: vi.fn(),
}));

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(function KafkaMock() {
    return brokerMocks.kafka;
  }),
  logLevel: { NOTHING: 0 },
}));

import {
  startConversationEventRuntime,
  stopConversationEventRuntime,
} from '@/lib/conversation-event-runtime';

const originalEnvironment = { ...process.env };
const emptyClient = {
  $transaction: async (
    callback: (transaction: { $queryRaw: () => [] }) => unknown,
  ) => callback({ $queryRaw: () => [] }),
} as never;

function startupError(message: string, code?: string) {
  return Object.assign(new Error(message), ...(code ? [{ code }] : []));
}

function configureNats() {
  process.env.CONVERSATION_EVENTS_SINKS = 'nats';
  process.env.CONVERSATION_EVENTS_NATS_SERVERS =
    'nats://broker-user:broker-password@nats.example.test:4222';
  process.env.CONVERSATION_EVENTS_NATS_STREAM = 'conversation-events';
  process.env.CONVERSATION_EVENTS_NATS_SUBJECT = 'conversation.events.v1';
}

function configureKafka() {
  process.env.CONVERSATION_EVENTS_SINKS = 'kafka';
  process.env.CONVERSATION_EVENTS_KAFKA_BROKERS = 'kafka.example.test:9092';
  process.env.CONVERSATION_EVENTS_KAFKA_TOPIC = 'conversation-events';
  process.env.CONVERSATION_EVENTS_KAFKA_CLIENT_ID = 'conversation-service';
}

function configureSuccessfulNats() {
  brokerMocks.connect.mockResolvedValue(brokerMocks.natsConnection);
  brokerMocks.natsConnection.jetstreamManager.mockResolvedValue(
    brokerMocks.natsManager,
  );
  brokerMocks.natsStreams.info.mockResolvedValue({});
  brokerMocks.natsStreams.find.mockResolvedValue('conversation-events');
}

function configureSuccessfulKafka() {
  brokerMocks.kafkaAdmin.connect.mockResolvedValue(undefined);
  brokerMocks.kafkaAdmin.fetchTopicMetadata.mockResolvedValue(undefined);
  brokerMocks.kafkaProducer.connect.mockResolvedValue(undefined);
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONVERSATION_EVENTS_')) {
      delete process.env[name];
    }
  }
  vi.clearAllMocks();
  brokerMocks.natsConnection.close.mockResolvedValue(undefined);
  brokerMocks.natsConnection.drain.mockResolvedValue(undefined);
  brokerMocks.kafkaAdmin.disconnect.mockResolvedValue(undefined);
  brokerMocks.kafkaProducer.disconnect.mockResolvedValue(undefined);
});

afterEach(async () => {
  await stopConversationEventRuntime();
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, originalEnvironment);
});

describe('conversation event broker startup', () => {
  it('reports a redacted NATS connection failure with safe endpoint context', async () => {
    configureNats();
    process.env.CONVERSATION_EVENTS_NATS_TOKEN = 'nats-token-secret';
    process.env.CONVERSATION_EVENTS_KAFKA_SASL_USERNAME = 'nats-user-secret';
    process.env.CONVERSATION_EVENTS_KAFKA_SASL_PASSWORD =
      'nats-password-secret';
    process.env.CONVERSATION_EVENTS_NATS_TLS_KEY_PEM =
      '-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----';
    brokerMocks.connect.mockRejectedValue(
      startupError(
        'authorization=nats-token-secret nats://broker-user:broker-password@nats.example.test:4222 nats-user-secret nats-password-secret -----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----',
        'AUTHORIZATION_VIOLATION',
      ),
    );

    await expect(startConversationEventRuntime(emptyClient)).rejects.toSatisfy(
      (error: Error) => {
        expect(error.name).toBe('ConversationEventSinkStartupError');
        expect(error.cause).toBeUndefined();
        expect(error.message).toContain('failed to connect');
        expect(error.message).toContain('nats.example.test:4222');
        expect(error.message).toContain('AUTHORIZATION_VIOLATION');
        expect(error.message).not.toContain('nats-token-secret');
        expect(error.message).not.toContain('nats-user-secret');
        expect(error.message).not.toContain('nats-password-secret');
        expect(error.message).not.toContain('broker-user');
        expect(error.message).not.toContain('broker-password');
        expect(error.message).not.toContain('private-key-secret');
        return true;
      },
    );
  });

  it('closes NATS after a missing configured stream', async () => {
    configureNats();
    configureSuccessfulNats();
    brokerMocks.natsStreams.info.mockRejectedValue(
      startupError('stream not found', 'STREAM_NOT_FOUND'),
    );

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to verify configured stream',
    );
    expect(brokerMocks.natsConnection.close).toHaveBeenCalledOnce();
    expect(brokerMocks.natsStreams.find).not.toHaveBeenCalled();
  });

  it('rejects a NATS subject resolved to a different stream and closes the connection', async () => {
    configureNats();
    configureSuccessfulNats();
    brokerMocks.natsStreams.find.mockResolvedValue('other-stream');

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to verify configured subject',
    );
    expect(brokerMocks.natsConnection.close).toHaveBeenCalledOnce();
  });

  it('distinguishes Kafka admin connection and topic metadata failures', async () => {
    configureKafka();
    brokerMocks.kafkaAdmin.connect.mockRejectedValue(
      startupError('connection refused', 'ECONNREFUSED'),
    );

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to connect admin client',
    );
    expect(brokerMocks.kafkaAdmin.disconnect).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    configureKafka();
    brokerMocks.kafkaAdmin.connect.mockResolvedValue(undefined);
    brokerMocks.kafkaAdmin.fetchTopicMetadata.mockRejectedValue(
      startupError('unknown topic', 'UNKNOWN_TOPIC_OR_PARTITION'),
    );

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to verify topic metadata',
    );
    expect(brokerMocks.kafkaAdmin.disconnect).toHaveBeenCalledOnce();
  });

  it('closes the Kafka producer after a failed producer connection', async () => {
    configureKafka();
    configureSuccessfulKafka();
    brokerMocks.kafkaProducer.connect.mockRejectedValue(
      startupError('SASL authentication failed', 'SASL_AUTHENTICATION_FAILED'),
    );

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to connect producer',
    );
    expect(brokerMocks.kafkaAdmin.disconnect).toHaveBeenCalledOnce();
    expect(brokerMocks.kafkaProducer.disconnect).toHaveBeenCalledOnce();
  });

  it('closes a successfully created sink when another configured sink fails', async () => {
    configureNats();
    process.env.CONVERSATION_EVENTS_SINKS = 'nats,kafka';
    process.env.CONVERSATION_EVENTS_KAFKA_BROKERS = 'kafka.example.test:9092';
    process.env.CONVERSATION_EVENTS_KAFKA_TOPIC = 'conversation-events';
    process.env.CONVERSATION_EVENTS_KAFKA_CLIENT_ID = 'conversation-service';
    brokerMocks.connect.mockRejectedValue(startupError('NATS unavailable'));
    configureSuccessfulKafka();

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'failed to connect',
    );
    expect(brokerMocks.kafkaProducer.disconnect).toHaveBeenCalledOnce();
  });
});
