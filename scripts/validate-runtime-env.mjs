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
if (eventSinks.some((sink) => sink !== 'nats')) {
  console.error('CONVERSATION_EVENTS_SINKS must contain only nats');
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
const drainScheduleEnabled = (
  process.env.OUTBOX_DRAIN_SCHEDULE_ENABLED ?? ''
).trim();
if (drainScheduleEnabled && drainScheduleEnabled.toLowerCase() !== 'true') {
  console.error('OUTBOX_DRAIN_SCHEDULE_ENABLED must be true when set');
  process.exit(1);
}
if (drainScheduleEnabled) {
  const expression = (process.env.OUTBOX_DRAIN_SCHEDULE ?? '').trim();
  if (!expression) {
    console.error(
      'Missing OUTBOX_DRAIN_SCHEDULE for the enabled outbox drain scheduler',
    );
    process.exit(1);
  }
  const fields = expression.split(/\s+/).length;
  if (fields !== 5 && fields !== 6) {
    console.error(
      'OUTBOX_DRAIN_SCHEDULE must be a cron expression with 5 or 6 fields',
    );
    process.exit(1);
  }
  const bounded = [
    ['OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE', 1, 100],
    ['OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES', 1, 100],
  ];
  for (const [name, minimum, maximum] of bounded) {
    const raw = (process.env[name] ?? '').trim();
    if (!raw) {
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      console.error(
        `${name} must be an integer between ${minimum} and ${maximum}`,
      );
      process.exit(1);
    }
  }
}
