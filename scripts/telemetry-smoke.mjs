const appUrl = process.env.TELEMETRY_SMOKE_APP_URL || 'http://localhost:3000';
const prometheusUrl =
  process.env.TELEMETRY_SMOKE_PROMETHEUS_URL || 'http://localhost:9090';
const lokiUrl = process.env.TELEMETRY_SMOKE_LOKI_URL || 'http://localhost:3100';
const grafanaUrl =
  process.env.TELEMETRY_SMOKE_GRAFANA_URL || 'http://localhost:3001';

const health = await fetch(`${appUrl}/api/health/v2`);
if (!health.ok) {
  throw new Error('Application health request failed');
}

await waitFor('Prometheus application metric', async () => {
  const response = await fetch(
    `${prometheusUrl}/api/v1/query?query=${encodeURIComponent('http_server_request_duration_seconds_count{service_name="resend-conversation-service",deployment_environment_name="local",service_group="resend-conversation-service",vcs_revision="local"}')}`,
  );
  if (!response.ok) {
    return false;
  }
  const body = await response.json();
  return Array.isArray(body.data?.result) && body.data.result.length > 0;
});

await waitFor('Loki application log', async () => {
  const end = Date.now() * 1_000_000;
  const start = end - 120_000_000_000;
  const response = await fetch(
    `${lokiUrl}/loki/api/v1/query_range?query=${encodeURIComponent('{service_name="resend-conversation-service",deployment_environment_name="local",service_group="resend-conversation-service",vcs_revision="local"}')}&start=${start}&end=${end}&limit=100`,
  );
  if (!response.ok) {
    return false;
  }
  const body = await response.json();
  return body.data?.result?.some((stream) =>
    stream.values?.some(([, line]) => line.includes('http_request_completed')),
  );
});

const grafana = await fetch(`${grafanaUrl}/api/health`);
if (!grafana.ok) {
  throw new Error('Grafana health request failed');
}

console.info('Telemetry smoke test passed');

async function waitFor(name, check) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${name} did not arrive before the timeout`);
}
