import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeTelemetry,
  shutdownTelemetry,
  telemetryEnabled,
} from '@/lib/telemetry';

afterEach(async () => {
  await shutdownTelemetry();
});

describe('telemetry configuration', () => {
  it('is disabled by default without creating an exporter', () => {
    initializeTelemetry({});

    expect(telemetryEnabled()).toBe(false);
  });

  it('requires an endpoint after telemetry is explicitly enabled', () => {
    expect(() => initializeTelemetry({ TELEMETRY_ENABLED: 'true' })).toThrow(
      'Missing OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    );
  });

  it('rejects endpoints that are not exact OTLP metrics paths', () => {
    expect(() =>
      initializeTelemetry({
        TELEMETRY_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://alloy:4318',
      }),
    ).toThrow('OTLP /v1/metrics URL');
  });

  it('enables metrics for a valid private collector endpoint', () => {
    initializeTelemetry({
      TELEMETRY_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://alloy:4318/v1/metrics',
      OTEL_DEPLOYMENT_ENVIRONMENT: 'test',
      HOSTNAME: 'test-instance',
    });

    expect(telemetryEnabled()).toBe(true);
  });
});
