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
  return {
    connect: vi.fn(),
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
  process.env.CONVERSATION_EVENTS_NATS_STREAM = 'CONVERSATION_EVENTS';
  process.env.CONVERSATION_EVENTS_NATS_SUBJECT = 'conversation.events.v1';
}

function configureSuccessfulNats() {
  brokerMocks.connect.mockResolvedValue(brokerMocks.natsConnection);
  brokerMocks.natsConnection.jetstreamManager.mockResolvedValue(
    brokerMocks.natsManager,
  );
  brokerMocks.natsStreams.info.mockResolvedValue({});
  brokerMocks.natsStreams.find.mockResolvedValue('CONVERSATION_EVENTS');
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
    process.env.CONVERSATION_EVENTS_NATS_USERNAME = 'nats-user-secret';
    process.env.CONVERSATION_EVENTS_NATS_PASSWORD = 'nats-password-secret';
    process.env.CONVERSATION_EVENTS_NATS_TLS_KEY_PEM =
      '-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----';
    brokerMocks.connect.mockRejectedValue(
      startupError(
        'nats://broker-user:broker-password@nats.example.test:4222 nats-user-secret nats-password-secret -----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----',
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

  it('rejects a sink other than nats', async () => {
    configureNats();
    process.env.CONVERSATION_EVENTS_SINKS = 'kafka';

    await expect(startConversationEventRuntime(emptyClient)).rejects.toThrow(
      'CONVERSATION_EVENTS_SINKS must contain only nats',
    );
    expect(brokerMocks.connect).not.toHaveBeenCalled();
  });
});
