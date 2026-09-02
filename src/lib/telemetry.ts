import { type Meter, metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
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
let provider: MeterProvider | null = null;

export function telemetryEnabled() {
  return provider !== null;
}

export function getTelemetryMeter() {
  return meter;
}

/**
 * Enables metric export only after an operator explicitly opts in. The rest of
 * the application uses the OpenTelemetry no-op meter while it is disabled.
 */
export function initializeTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.TELEMETRY_ENABLED?.trim().toLowerCase() !== 'true') {
    return;
  }
  if (provider) {
    return;
  }

  const endpoint = requiredMetricsEndpoint(
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
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

  const reader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: endpoint }),
    exportIntervalMillis,
    exportTimeoutMillis,
  });
  provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': METER_NAME,
      'service.version': packageJson.version,
      'service.instance.id': safeInstanceId(environment.HOSTNAME),
      'deployment.environment.name': safeEnvironment(
        environment.OTEL_DEPLOYMENT_ENVIRONMENT,
      ),
    }),
    readers: [reader],
  });
  meter = provider.getMeter(METER_NAME, packageJson.version);
}

export async function shutdownTelemetry() {
  const current = provider;
  provider = null;
  meter = metrics.getMeter(METER_NAME, packageJson.version);
  if (!current) {
    return;
  }

  const shutdown = current.shutdown();
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref();
  });
  await Promise.race([shutdown, timeout]);
}

function requiredMetricsEndpoint(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) {
    throw new Error(
      'Missing OTEL_EXPORTER_OTLP_METRICS_ENDPOINT for enabled telemetry',
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT must be a valid URL');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.pathname !== '/v1/metrics' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT must be an http(s) OTLP /v1/metrics URL',
    );
  }
  return endpoint.toString();
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

function safeInstanceId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[a-zA-Z0-9._-]{1,128}$/.test(normalized)
    ? normalized
    : 'unknown';
}

function safeEnvironment(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[a-zA-Z0-9._-]{1,64}$/.test(normalized)
    ? normalized
    : 'unspecified';
}
