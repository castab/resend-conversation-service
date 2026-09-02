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

  it('uses the exporter default when enabled without an endpoint', () => {
    initializeTelemetry({ TELEMETRY_ENABLED: 'true' });

    expect(telemetryEnabled()).toBe(true);
  });

  it('accepts a base collector URL without an OTLP metrics path', () => {
    initializeTelemetry({
      TELEMETRY_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://fluent-bit:4318',
      OTEL_DEPLOYMENT_ENVIRONMENT: 'test',
      HOSTNAME: 'test-instance',
    });

    expect(telemetryEnabled()).toBe(true);
  });

  it('rejects a configured endpoint that is not an HTTP(S) URL', () => {
    expect(() =>
      initializeTelemetry({
        TELEMETRY_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'file:///tmp/metrics',
      }),
    ).toThrow('must be an http(s) URL');
  });
});
