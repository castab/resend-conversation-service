import { type Meter, metrics } from '@opentelemetry/api';
import {
  type Logger as OpenTelemetryLogger,
  SeverityNumber,
} from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import packageJson from '../../package.json';

const METER_NAME = 'resend-conversation-service';
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

let meter: Meter = metrics.getMeter(METER_NAME, packageJson.version);
let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;
let telemetryLogger: OpenTelemetryLogger | null = null;

export function telemetryEnabled() {
  return meterProvider !== null;
}

export function getTelemetryMeter() {
  return meter;
}

/**
 * Enables telemetry only after an operator explicitly opts in. The rest of the
 * application uses no-op OpenTelemetry objects while telemetry is disabled.
 */
export function initializeTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.TELEMETRY_ENABLED?.trim().toLowerCase() !== 'true') {
    return;
  }
  if (meterProvider) {
    return;
  }

  const baseEndpoint = optionalHttpEndpoint(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  );
  const metricsEndpoint = signalEndpoint(
    optionalHttpEndpoint(
      environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    ),
    baseEndpoint,
    'v1/metrics',
  );
  const logsEndpoint = signalEndpoint(
    optionalHttpEndpoint(
      environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ),
    baseEndpoint,
    'v1/logs',
  );
  const exportIntervalMillis = positiveInteger(
    environment.OTEL_METRIC_EXPORT_INTERVAL,
    'OTEL_METRIC_EXPORT_INTERVAL',
    DEFAULT_EXPORT_INTERVAL_MS,
  );
  const exportTimeoutMillis = positiveInteger(
    environment.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT',
    DEFAULT_EXPORT_TIMEOUT_MS,
  );
  if (exportTimeoutMillis > exportIntervalMillis) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT must not exceed OTEL_METRIC_EXPORT_INTERVAL',
    );
  }

  const resource = telemetryResource(environment);
  const reader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(
      metricsEndpoint ? { url: metricsEndpoint } : {},
    ),
    exportIntervalMillis,
    exportTimeoutMillis,
  });
  meterProvider = new MeterProvider({
    resource,
    readers: [reader],
  });
  meter = meterProvider.getMeter(METER_NAME, packageJson.version);

  if (logsEndpoint) {
    loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: logsEndpoint }),
        }),
      ],
    });
    telemetryLogger = loggerProvider.getLogger(METER_NAME, packageJson.version);
  }
}

export async function shutdownTelemetry() {
  const currentMeterProvider = meterProvider;
  const currentLoggerProvider = loggerProvider;
  meterProvider = null;
  loggerProvider = null;
  telemetryLogger = null;
  meter = metrics.getMeter(METER_NAME, packageJson.version);
  if (!currentMeterProvider && !currentLoggerProvider) {
    return;
  }

  const shutdown = Promise.all([
    currentLoggerProvider?.shutdown(),
    currentMeterProvider?.shutdown(),
  ]).then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref();
  });
  await Promise.race([shutdown, timeout]);
}

export function emitTelemetryLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  attributes: Record<string, boolean | number | string>,
) {
  telemetryLogger?.emit({
    eventName: event,
    severityNumber: severityNumber(level),
    severityText: level.toUpperCase(),
    body: event,
    attributes,
  });
}

function optionalHttpEndpoint(value: string | undefined, name: string) {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return raw;
}

function signalEndpoint(
  signalEndpoint: string | undefined,
  baseEndpoint: string | undefined,
  signalPath: string,
) {
  if (signalEndpoint || !baseEndpoint) {
    return signalEndpoint;
  }
  return new URL(signalPath, `${baseEndpoint.replace(/\/$/, '')}/`).toString();
}

function telemetryResource(environment: NodeJS.ProcessEnv): Resource {
  const configured = parseResourceAttributes(
    environment.OTEL_RESOURCE_ATTRIBUTES,
  );
  return resourceFromAttributes({
    ...configured,
    'service.name': METER_NAME,
    'service.version': packageJson.version,
    'service.instance.id': safeInstanceId(
      environment.HOSTNAME ?? configured['service.instance.id'],
    ),
    'deployment.environment.name': safeEnvironment(
      environment.OTEL_DEPLOYMENT_ENVIRONMENT ??
        configured['deployment.environment.name'],
    ),
  });
}

function parseResourceAttributes(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) {
    return {};
  }

  const attributes: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    if (
      separator < 1 ||
      separator === entry.length - 1 ||
      entry.indexOf('=', separator + 1) !== -1
    ) {
      throw new Error(
        'OTEL_RESOURCE_ATTRIBUTES must contain comma-separated key=value pairs',
      );
    }
    let key: string;
    let attributeValue: string;
    try {
      key = decodeURIComponent(entry.slice(0, separator).trim());
      attributeValue = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      throw new Error(
        'OTEL_RESOURCE_ATTRIBUTES contains invalid percent-encoding',
      );
    }
    if (!key || !attributeValue) {
      throw new Error(
        'OTEL_RESOURCE_ATTRIBUTES keys and values must not be empty',
      );
    }
    attributes[key] = attributeValue;
  }
  return attributes;
}

function severityNumber(level: 'debug' | 'info' | 'warn' | 'error') {
  return {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  }[level];
}

function positiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
) {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600_000) {
    throw new Error(`${name} must be an integer between 1 and 3600000`);
  }
  return parsed;
}

function safeInstanceId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : undefined;
  return normalized && /^[a-zA-Z0-9._-]{1,128}$/.test(normalized)
    ? normalized
    : 'unknown';
}

function safeEnvironment(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : undefined;
  return normalized && /^[a-zA-Z0-9._-]{1,64}$/.test(normalized)
    ? normalized
    : 'unspecified';
}
