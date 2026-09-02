# Observability

`resend-conversation-service` can send metrics and application logs directly to
OTLP/HTTP ingestion endpoints. The recommended simple deployment sends metrics
to Prometheus and logs to Loki without Grafana Alloy or another collector.

```text
resend-conversation-service
  |-- OTLP/HTTP metrics --> Prometheus /api/v1/otlp/v1/metrics
  |-- OTLP/HTTP logs ----> Loki /otlp/v1/logs
  `-- JSON logs ---------> stdout

Grafana --> Prometheus and Loki
```

Telemetry is optional and does not affect `GET /api/health/v2`. Logs always
remain available as redacted JSON on stdout, including when OTLP export is
enabled.

## Application configuration

Set `TELEMETRY_ENABLED=true`, then configure complete signal-specific OTLP/HTTP
URLs:

```env
TELEMETRY_ENABLED=true
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://prometheus:9090/api/v1/otlp/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://loki:3100/otlp/v1/logs
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_RESOURCE_ATTRIBUTES=service.group=resend-conversation-service,vcs.revision=0123456789abcdef
```

`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` are used exactly as written. The application
does not append `/v1/metrics` or `/v1/logs` to signal-specific endpoints. If the
metrics endpoint is omitted and no generic endpoint is set, the OpenTelemetry
metrics exporter retains its standard `http://localhost:4318/v1/metrics`
default. OTLP log export is enabled when either a logs endpoint or a generic
endpoint is present.

When both signals use one OTLP receiver, set `OTEL_EXPORTER_OTLP_ENDPOINT` to a
base URL instead. The application appends `/v1/metrics` and `/v1/logs` according
to the OTLP specification:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
```

Signal-specific endpoints take precedence over the generic endpoint. Use them
for the recommended direct Prometheus and Loki setup because the signals have
different backend URLs.

The remaining supported tuning variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Generic OTLP base URL used for any signal without a signal-specific endpoint |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds between metric exports |
| `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` | `10000` | Metric export timeout in milliseconds; it must not exceed the interval |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Generic OTLP/HTTP headers merged into both signals |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | unset | Comma-separated OTLP/HTTP headers for the metrics destination |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | unset | Comma-separated OTLP/HTTP headers for the logs destination |
| `OTEL_EXPORTER_OTLP_METRICS_COMPRESSION` | unset | Set to `gzip` when supported by the destination |
| `OTEL_EXPORTER_OTLP_LOGS_COMPRESSION` | unset | Set to `gzip` when supported by the destination |
| `LOG_LEVEL` | `info` | Minimum application log level: `debug`, `info`, `warn`, or `error` |

Header values use the standard OTLP encoding. Percent-encode commas, equals
signs, spaces, and other reserved characters inside a value:

```env
OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer%20metrics-token
OTEL_EXPORTER_OTLP_LOGS_HEADERS=Authorization=Bearer%20logs-token,X-Scope-OrgID=resend
```

Generic and signal-specific header sets are merged. A signal-specific value
overrides a generic value with the same header name, while every other generic
header is still sent. Do not put a credential in `OTEL_EXPORTER_OTLP_HEADERS`
unless it is safe to disclose to both destinations.

Keep endpoints on a private network when possible. Otherwise require TLS and
authentication at the backend or a reverse proxy. Treat header variables as
secrets. Prometheus's OTLP receiver has no application-specific authentication
of its own unless Prometheus web authentication or an authenticating proxy is
configured.

## Resource tags

Resource attributes identify one service deployment and are attached to every
exported metric and OTLP log. The application always supplies:

| OTLP resource attribute | Source | Grafana label |
| --- | --- | --- |
| `service.name` | Fixed to `resend-conversation-service` | `service_name` |
| `service.version` | `package.json` version | `service_version` |
| `service.instance.id` | `HOSTNAME`, or `unknown` | `instance` in Prometheus; structured metadata in the included Loki config |
| `deployment.environment.name` | `OTEL_DEPLOYMENT_ENVIRONMENT`, then the same key in `OTEL_RESOURCE_ATTRIBUTES`, or `unspecified` | `deployment_environment_name` |

Add deployment-specific tags with the standard `OTEL_RESOURCE_ATTRIBUTES`
format:

```env
OTEL_RESOURCE_ATTRIBUTES=service.group=resend-conversation-service,vcs.revision=0123456789abcdef,cloud.region=us-west2
```

Entries are comma-separated `key=value` pairs. Percent-encode a comma or equals
sign that belongs inside a key or value. Invalid input fails startup so a
deployment does not silently lose its identifying tags. User attributes cannot
override `service.name` or `service.version`. `HOSTNAME` takes precedence over
a configured `service.instance.id` when it is present.

The included Prometheus and Loki configurations index this deliberately small
set of deployment dimensions:

- `service.name`
- `service.version`
- `deployment.environment.name`
- `service.group`
- `vcs.revision`

`vcs.revision` and `service.version` change with deployments and therefore
create bounded series and stream churn. Keep them only when deployment-level
filtering is worth that cost, and use an appropriate backend retention period.
The other recommended labels should have very few values.

Other attributes still reach both backends. Prometheus places unpromoted
resource attributes on `target_info`; Loki stores them as structured metadata.
They are not automatically indexed labels. This prevents an accidental
high-cardinality attribute, such as a request ID, from creating an unbounded
number of time series or Loki streams.

To make another stable resource attribute an indexed label, add its exact key
to both:

1. `otlp.promote_resource_attributes` in the Prometheus configuration.
2. `limits_config.otlp_config.resource_attributes.attributes_config` in the Loki configuration.

Restart the affected backend after changing its configuration. Never promote
request IDs, message IDs, full URLs, timestamps, replica IDs, or other values
that can be unique per operation. Request IDs remain searchable OTLP log
metadata instead.

## Prometheus setup

Prometheus disables OTLP ingestion by default. Start it with:

```text
--web.enable-otlp-receiver
```

The receiver then accepts OTLP/HTTP metrics at:

```text
http://<prometheus-host>:9090/api/v1/otlp/v1/metrics
```

Prometheus does not promote resource attributes to labels unless configured.
Use the repository's
[`infra/observability/prometheus/prometheus.yml`](../infra/observability/prometheus/prometheus.yml)
as a starting point. It includes the curated label list and a 30-minute
out-of-order window recommended for batched OTLP delivery. The application uses
cumulative metric temporality, which Prometheus accepts without its experimental
delta-to-cumulative feature.

Verify ingestion in Prometheus:

```promql
resend_conversation_runtime_info{
  service_name="resend-conversation-service",
  deployment_environment_name="production"
}
```

## Loki setup

Loki accepts OTLP/HTTP logs at:

```text
http://<loki-host>:3100/otlp/v1/logs
```

OTLP logs require structured metadata. Configure:

```yaml
limits_config:
  allow_structured_metadata: true
```

Use the repository's
[`infra/observability/loki/config.yml`](../infra/observability/loki/config.yml)
as a single-binary example. Its OTLP mapping ignores Loki's broad default label
list and indexes only the curated resource attributes above. Dots in OTLP names
become underscores in LogQL.

Find logs for one deployment:

```logql
{service_name="resend-conversation-service", deployment_environment_name="production"}
```

Filter the safe event metadata stored on each log record:

```logql
{service_name="resend-conversation-service"} | event="http_request_completed"
```

The log body is the fixed event name. Safe fields such as `route`, `method`,
`status_code`, `duration_ms`, and `request_id` are structured metadata. The
application does not export addresses, subjects, bodies, headers, credentials,
provider payloads, raw URLs, or raw error messages.

## Local stack

Create the normal ignored `.env`, then start the application and observability
overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile apps up --build
```

The overlay starts only Prometheus, Loki, and Grafana. There is no Alloy service,
Docker socket mount, log-tailing label, or remote-write hop. Open:

- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`
- Loki: `http://localhost:3100`

The provisioned dashboard has filters for service, environment, service group,
and revision. Generate one request and verify all three components:

```bash
curl http://localhost:3000/api/health/v2
npm run telemetry:smoke
```

The local stack is intentionally unauthenticated and must not be exposed to an
untrusted network.

## Railway example

Railway provides deployment metadata for GitHub-triggered deployments. Add
these service variables, using Railway's `${{...}}` reference syntax in the
dashboard:

```env
TELEMETRY_ENABLED=true
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://<prometheus-host>/api/v1/otlp/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://<loki-host>/otlp/v1/logs
OTEL_DEPLOYMENT_ENVIRONMENT=${{RAILWAY_ENVIRONMENT_NAME}}
OTEL_RESOURCE_ATTRIBUTES=service.group=resend-conversation-service,vcs.revision=${{RAILWAY_GIT_COMMIT_SHA}}
```

The Railway variable is `RAILWAY_GIT_COMMIT_SHA`. A value such as
`${RAILWAY_COMMIT_SHA}` is neither the correct name nor Railway's variable
reference syntax. Add destination-specific header variables when the endpoints
require authentication.

Do not use the per-replica `RAILWAY_REPLICA_ID` as an indexed custom tag. The
application already derives `service.instance.id` from `HOSTNAME`, and the
included Loki configuration deliberately keeps that high-cardinality value out
of its stream index.

## Direct export tradeoffs

Direct OTLP is the recommended path for this application because it removes an
agent, a Docker socket mount, and two forwarding pipelines. It is a good fit
when the application can reach one metrics backend and one logs backend.

The exporters batch in application memory. Metrics and unsent log batches can
be lost if the process crashes, and the application does not provide durable
telemetry queues. Use an OpenTelemetry Collector or another agent instead when
you need durable buffering, fan-out to several destinations, backend-independent
credentials, host/container log discovery, sampling, or complex transformations.
That collector remains compatible with the same OTLP endpoints and resource
attributes; it is no longer required by the included deployment.

## References

- [Prometheus: using Prometheus as an OpenTelemetry backend](https://prometheus.io/docs/guides/opentelemetry/)
- [Grafana Loki: ingesting OpenTelemetry logs](https://grafana.com/docs/loki/latest/send-data/otel/)
- [OpenTelemetry OTLP exporter endpoint rules](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)
- [OpenTelemetry resource environment variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)
- [Railway variables reference](https://docs.railway.com/reference/variables)
