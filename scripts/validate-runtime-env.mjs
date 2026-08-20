const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_REPLY_TO',
  'OUTBOX_DRAIN_API_KEY',
];

function resolveEmailV2ApiKey(environment = process.env) {
  return environment.EMAIL_v2_API_KEY || environment.EMAIL_V2_API_KEY;
}

function isValidReplyToBaseAddress(address) {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (
    at <= 0 ||
    at === normalized.length - 1 ||
    normalized.includes('<') ||
    normalized.includes('>') ||
    normalized.slice(0, at).includes('+')
  ) {
    return false;
  }

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const generatedLocalLength = local.length + 1 + 2 + 32;
  const domainLabels = domain.split('.');
  return (
    /^[a-z0-9.!#$%&'*/=?^_`{|}~-]+$/.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    generatedLocalLength <= 64 &&
    domain.length <= 253 &&
    domainLabels.length >= 2 &&
    domainLabels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) &&
    generatedLocalLength + domain.length + 1 <= 254
  );
}

const missing = REQUIRED_ENV_VARS.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.length === 0;
});

if (!resolveEmailV2ApiKey()) {
  missing.push('EMAIL_v2_API_KEY or EMAIL_V2_API_KEY');
}

if (missing.length > 0) {
  console.error(
    `Missing required runtime environment variables: ${missing.join(', ')}`,
  );
  process.exit(1);
}

if (!isValidReplyToBaseAddress(process.env.RESEND_REPLY_TO)) {
  console.error(
    'Invalid RESEND_REPLY_TO runtime environment variable: expected an untagged mailbox address on a receiving domain',
  );
  process.exit(1);
}

const eventSinks = (process.env.CONVERSATION_EVENTS_SINKS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
if (eventSinks.some((sink) => sink !== 'nats' && sink !== 'kafka')) {
  console.error(
    'CONVERSATION_EVENTS_SINKS must contain only nats and/or kafka',
  );
  process.exit(1);
}
if (eventSinks.includes('nats')) {
  for (const name of [
    'CONVERSATION_EVENTS_NATS_SERVERS',
    'CONVERSATION_EVENTS_NATS_STREAM',
    'CONVERSATION_EVENTS_NATS_SUBJECT',
  ]) {
    if (!process.env[name]) {
      console.error(`Missing ${name} for enabled NATS conversation events`);
      process.exit(1);
    }
  }
}
if (eventSinks.includes('kafka')) {
  for (const name of [
    'CONVERSATION_EVENTS_KAFKA_BROKERS',
    'CONVERSATION_EVENTS_KAFKA_CLIENT_ID',
    'CONVERSATION_EVENTS_KAFKA_TOPIC',
  ]) {
    if (!process.env[name]) {
      console.error(`Missing ${name} for enabled Kafka conversation events`);
      process.exit(1);
    }
  }
}
