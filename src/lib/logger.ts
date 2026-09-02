import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogValue = boolean | number | string | undefined;
type SafeLogAttributeName =
  | 'credential'
  | 'duration_ms'
  | 'error_type'
  | 'method'
  | 'operation'
  | 'port'
  | 'route'
  | 'status_code';
type SafeLogAttributes = Partial<Record<SafeLogAttributeName, LogValue>>;

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const level: LogLevel =
  configuredLevel === 'debug' ||
  configuredLevel === 'info' ||
  configuredLevel === 'warn' ||
  configuredLevel === 'error'
    ? configuredLevel
    : 'info';

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: undefined,
      redact: {
        paths: [
          'address',
          'authorization',
          'body',
          'email',
          'from',
          'headers',
          'html',
          'idempotencyKey',
          'messageId',
          'replyTo',
          'resendEmailId',
          'subject',
          'text',
          'to',
          '*.address',
          '*.authorization',
          '*.body',
          '*.email',
          '*.headers',
          '*.html',
          '*.subject',
          '*.text',
        ],
        remove: true,
      },
      mixin() {
        const context = requestContext.getStore();
        const spanContext = trace.getActiveSpan()?.spanContext();
        return {
          ...(context ? { request_id: context.requestId } : {}),
          ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
          ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
        };
      },
    },
    destination,
  );
}

const logger = createLogger();

/**
 * Runs work with a server-generated ID that is safe to include in logs. Incoming
 * request IDs are deliberately not trusted or copied into the log stream.
 */
export function runWithRequestContext<T>(callback: () => T): T {
  return requestContext.run({ requestId: randomUUID() }, callback);
}

/**
 * Log only fixed event names and caller-supplied scalar operational metadata.
 * Callers must never pass request payloads, addresses, identifiers, or errors.
 */
export function logEvent(
  level: LogLevel,
  event: string,
  attributes: SafeLogAttributes = {},
) {
  logger[level]({ event, ...attributes }, event);
}
