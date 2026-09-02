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

  it('accepts explicitly configured OTLP signal endpoints and resource tags', () => {
    initializeTelemetry({
      TELEMETRY_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        'http://prometheus:9090/api/v1/otlp/v1/metrics',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://loki:3100/otlp/v1/logs',
      OTEL_DEPLOYMENT_ENVIRONMENT: 'test',
      OTEL_RESOURCE_ATTRIBUTES:
        'service.group=resend,vcs.revision=0123456789abcdef',
      HOSTNAME: 'test-instance',
    });

    expect(telemetryEnabled()).toBe(true);
  });

  it('accepts one generic OTLP base endpoint for both signals', () => {
    initializeTelemetry({
      TELEMETRY_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/custom',
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

  it('rejects a non-HTTP(S) OTLP logs endpoint', () => {
    expect(() =>
      initializeTelemetry({
        TELEMETRY_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'file:///tmp/logs',
      }),
    ).toThrow('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT must be an http(s) URL');
  });

  it('rejects malformed resource attributes', () => {
    expect(() =>
      initializeTelemetry({
        TELEMETRY_ENABLED: 'true',
        OTEL_RESOURCE_ATTRIBUTES: 'service.group',
      }),
    ).toThrow('comma-separated key=value pairs');
  });

  it('requires equals signs in resource values to be percent-encoded', () => {
    expect(() =>
      initializeTelemetry({
        TELEMETRY_ENABLED: 'true',
        OTEL_RESOURCE_ATTRIBUTES: 'service.group=resend=conversation',
      }),
    ).toThrow('comma-separated key=value pairs');
  });
});
