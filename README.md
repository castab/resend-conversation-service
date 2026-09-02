# resend-conversation-service

[![Docker Hub](https://img.shields.io/docker/pulls/castab/resend-conversation-service?label=Docker%20Hub)](https://hub.docker.com/r/castab/resend-conversation-service) [![Docker Image Version](https://img.shields.io/docker/v/castab/resend-conversation-service?sort=semver&label=version)](https://hub.docker.com/r/castab/resend-conversation-service/tags)

`resend-conversation-service` is one PostgreSQL-backed Express application for receiving
Resend webhooks, managing topic-centered email conversations, and sending
direct non-conversation email. An external
API gateway controls which paths are publicly reachable; authentication and
signature verification remain enforced by the application.

When enabled, the application also writes compact conversation lifecycle events
to a durable PostgreSQL outbox and publishes them from an internal worker to
NATS JetStream. Events never contain email addresses, content,
or raw provider payloads; consumers use their normal authorized conversation
read requests for that data.

## Architecture

```text
Resend
  -> API gateway
  -> POST /api/webhooks/resend/v1
  -> Svix verification
  -> webhook ledger and inbound conversation projection

Authorized callers
  -> API gateway or private service address
  -> /api/emails/v2 (synchronous or queued direct email)
     or /api/conversations/v2 (conversation contract)
  -> purpose-specific bearer authentication
  -> durable PostgreSQL send intent
  -> synchronous Resend send or shared transactional outbox
```

The single process shares one Prisma client, deployment lifecycle, health
check, OpenAPI and AsyncAPI contracts, Docker image, and Railway service
configuration.

## Repository Layout

```text
.github/                # CI workflows and the pull request template
infra/nats/streams/     # JetStream stream configs (nats stream add --config)
prisma/                 # Prisma schema and immutable migration history
public/openapi.json     # Unified OpenAPI contract
public/asyncapi.json    # NATS conversation event contract
src/routes/                # Express routes and Swagger UI
src/lib/database/       # Prisma client construction and exports
src/lib/email/          # Resend client, webhook types, projection, threading
src/lib/                # HTTP authentication, validation, and services
tests/                  # PostgreSQL integration tests and fake Resend server
Dockerfile              # Standalone production image
railway.json            # Railway build and deployment configuration
```

## API Routes

```text
GET   /api/health/v2
POST  /api/webhooks/resend/v1
POST  /api/emails/v2
POST  /api/emails/v2/outbox
POST  /api/emails/v2/outbox/drain
POST  /api/conversations/v2
GET   /api/conversations/v2?assignment=unassigned
GET   /api/conversations/v2/summary
POST  /api/conversations/v2/outbox
GET   /api/conversations/v2/{conversationId}
PATCH /api/conversations/v2/{conversationId}
POST  /api/conversations/v2/{conversationId}/state
POST  /api/conversations/v2/{conversationId}/messages
POST  /api/conversations/v2/{conversationId}/messages/outbox
GET   /api/conversations/v2/topics/{topicType}/{externalTopicId}
GET   /docs
GET   /openapi.json
GET   /asyncapi.json
```

The unauthenticated readiness endpoint is `/api/health/v2`.
`/api/health/v1` is retired and returns `404`. The webhook requires a valid
signature over the exact raw body and all three Svix headers. Conversation
operations and direct email require `EMAIL_v2_API_KEY` (or `EMAIL_V2_API_KEY`
as a fallback). The shared outbox drain route uses `OUTBOX_DRAIN_API_KEY`. Sending
and enqueueing operations also require `Idempotency-Key`.

`POST /api/webhooks/resend/v1` remains the supported long-term Resend webhook
ingress. Its `v1` path is unrelated to the retired conversation API and will
remain active for the foreseeable future.

### API versions

Conversation API V1 was retired in 0.5.0. Its routes are no longer registered,
so `/api/conversations/v1` and everything under it return
`404 {"error":"Not found"}`, and `CONVERSATION_API_KEY` and `RESEND_FROM` are no
longer read. Conversations it created are unaffected: they are still served by
V2 and are promoted to V2 on the first authorized V2 write.

V2 is the only conversation API. Every create, reply, and corresponding outbox request
must provide structured `from` and `replyTo` objects with an `address` and an
optional `name`. Both addresses are canonicalized to lowercase and must match
separate, role-specific database allowlist entries before new send intent is
persisted. Display names are validated header text, not allowlisted identities.

`POST /api/emails/v2` synchronously sends direct email, while
`POST /api/emails/v2/outbox` atomically queues the same request in the shared
outbox. Neither creates a conversation. Both require structured `from` and
one-or-more `to` identities, a subject, and at least one of `text` or `html`.
Only the normalized From address requires an exact `FROM` allowlist row. Direct
email does not accept `replyTo` and emits no Reply-To or RFC threading headers.
Mail clients normally fall back to the From address when a recipient chooses
Reply.

A V2 reply promotes a surviving `V1`-tagged conversation when the V2 send intent
is successfully persisted, before any synchronous provider call. Promotion
therefore remains committed even if that provider call subsequently returns
`502`; provider acceptance is not required. The supplied Reply-To base must
match the base already fixed on the conversation. Promotion is one-way: a
conversation is never demoted to `V1`.

## Conversation Model

A caller-owned `(topicType, externalTopicId)` pair identifies a conversation.
Each conversation currently has one external participant. V2 records the
selected sender on each message and fixes the selected Reply-To base on the
conversation. Each
conversation also has an opaque routing token. Outbound Reply-To addresses are
always generated from the fixed base as `<local>+c_<token>@<domain>`, and each
message may add a display name without changing that address. Messages retain
provider and RFC identifiers, ordered reply ancestry, send state, projected
outbound delivery state, content, and timestamps.

Asynchronous sends persist the same pending message rows used by synchronous
sends. Direct and conversation outbox rows share fixed, ordered Resend batches,
capacity, retries, and batch-level terminal outcomes without duplicating
message content. Inbound messages are attached through RFC
headers, including repair when children arrive before their parent. If eligible
RFC ancestry does not resolve a conversation, the service falls back to the
conversation token in a `to` or `received_for` address. Token routing still
requires the inbound sender to match the conversation participant. When
out-of-order rows are reconciled into one conversation, the merge preserves
one-way V2 promotion and historical routing-token/base aliases so replies sent
to earlier generated addresses can still resolve.

Outbound `accepted` state means Resend accepted the send API request. A message
is only marked delivered after a matching `email.delivered` webhook is projected.
Opened and clicked events are ingested into the webhook ledger when enabled in
Resend, but they do not change delivery status.

### Conversation state

Each conversation records whose turn it is as `awaiting_us`,
`awaiting_participant`, `concluded`, or `terminated`, alongside `stateChangedAt`
and a derived `awaitingReply` boolean. Inbound mail sets `awaiting_us`; persisting
outbound reply intent, whether sent synchronously or enqueued, sets
`awaiting_participant`; a bounce, complaint, or suppression on an outbound
conversation message sets `terminated`. A send-side `email.failed` says nothing
about the participant and is not terminal.

`stateChangedAt` only moves when the state itself changes, so a conversation
waiting on us keeps the timestamp of the message that started the wait. Automatic
transitions never move a `terminated` conversation, while inbound mail reopens a
`concluded` one.

`GET /api/conversations/v2/summary` returns counts for every state plus a
filterable page of conversation metadata, oldest state change first, which makes
`?state=awaiting_us` a reply queue. It carries no message payload; read messages
from the conversation endpoint. `POST /api/conversations/v2/{conversationId}/state`
is the operator override, most often used to mark a conversation `concluded` when
a message such as a bare acknowledgement needs no follow-up. Every transition is
permitted and repeating one is a successful no-op. Transitions are driven by
mail flow rather than by the route that triggered them, so they apply equally to
conversations created before the V1 retirement.

Direct email intent uses the same durable message and provider-idempotency
state machine, but has no conversation relationship. Direct responses expose
only the internal ID, send state, and Resend email ID. Matching lifecycle
webhooks still project delivery state in PostgreSQL.

Attachments are not retrieved or persisted. Returned HTML is untrusted and
must be sanitized before browser rendering.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL 18 or newer for native `uuidv7()`
- A Resend API key and webhook signing secret
- A verified Resend sender and receiving configuration

## Configuration

Create an ignored `.env` for local development:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resend_test
RESEND_API_KEY=re_xxxxxxxxx
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxxx
RESEND_REPLY_TO=mailbox@replies.example.com
EMAIL_v2_API_KEY=replace-with-a-long-random-secret
OUTBOX_DRAIN_API_KEY=replace-with-another-long-random-secret

# Optional: leave unset to disable conversation event publishing.
# The sink must connect at startup when enabled.
CONVERSATION_EVENTS_SINKS=

# Optional: leave unset to keep the built-in drain scheduler disabled.
OUTBOX_DRAIN_SCHEDULE_ENABLED=
```

Callers use `EMAIL_v2_API_KEY` and select only database-allowlisted identities
in each request. Deployments may use `EMAIL_V2_API_KEY` as an interchangeable
fallback; when both variables are nonempty, `EMAIL_v2_API_KEY` takes precedence.
`RESEND_REPLY_TO` remains required: it is the Reply-To base used for inbound
routing-token validation.

### Conversation event feed

Set `CONVERSATION_EVENTS_SINKS=nats` to enable the internal dispatcher. NATS is
the only supported sink; it requires `CONVERSATION_EVENTS_NATS_SERVERS`,
`CONVERSATION_EVENTS_NATS_STREAM`, and `CONVERSATION_EVENTS_NATS_SUBJECT`.
The process validates and connects to the sink before listening; it expects the
NATS stream to already exist. Provision it with
`nats stream add --config infra/nats/streams/CONVERSATION_EVENTS.json`, and
set `CONVERSATION_EVENTS_NATS_STREAM` to match the config's `name`. The
checked-in limits in that file are conservative suggestions meant to be tuned
per deployment; [infra/nats/streams/README.md](infra/nats/streams/README.md)
explains each field and what to weigh when changing it.

Events are at-least-once and must be deduplicated by their `id`. Their compact
payload contains a schema version, event type, conversation ID, per-conversation
sequence, time, topic when assigned, and non-sensitive cause metadata. The
initial event types are conversation creation, inbound and outbound message
lifecycle, state changes, assignment, delivery updates, and merges. Enabling a
sink starts delivery only for events committed after that sink becomes active.

The complete event contract is the AsyncAPI 3.1 document at
`GET /asyncapi.json`. It defines all seven closed `schemaVersion: 1` payloads,
their headers and examples, and the NATS JetStream message-ID behavior.
Consumers should dispatch on `type`, reject unsupported schema versions,
deduplicate by `id`, and order work within each `conversationId` by `sequence`.
A newly enabled sink may begin after earlier sequence values and does not
receive a backfill.

Every Reply-To base must be a plain mailbox on a Resend Receiving domain, without a display name or an
existing `+` tag. Resend must accept every generated
`mailbox+c_<token>@domain` address. Keep a conversation's base stable while its
messages can still receive replies.

`RESEND_API_BASE_URL` is optional and intended for a Resend-compatible test
endpoint. The health route requires every variable above and database access;
it returns `503` if any application capability is not configured.

### V2 identity allowlist

There is intentionally no allowlist management API. Administrators manage
`email_address_allowlist_entries` directly in PostgreSQL. Addresses must be
trimmed canonical lowercase values and matching is exact for both address and
role. Domain wildcards are not supported. Display names are not allowlisted;
distinct mailbox aliases are distinct addresses and each alias must have its
own row.

Allow a From address and a Reply-To base:

```sql
INSERT INTO email_address_allowlist_entries (address, role)
VALUES
  ('booking@example.com', 'FROM'::"EmailAddressRole"),
  ('booking-replies@replies.example.com', 'REPLY_TO'::"EmailAddressRole")
ON CONFLICT (address, role) DO NOTHING;
```

Revoke either role with an exact delete:

```sql
DELETE FROM email_address_allowlist_entries
WHERE address = 'booking@example.com'
  AND role = 'FROM'::"EmailAddressRole";

DELETE FROM email_address_allowlist_entries
WHERE address = 'booking-replies@replies.example.com'
  AND role = 'REPLY_TO'::"EmailAddressRole";
```

Revocation blocks new V2 send or enqueue intent that requests the address,
including a direct email using a revoked From address. It
does not cancel or alter an outbox message already persisted after a successful
allowlist check; the drain sends that frozen payload.

Prisma CLI commands load `.env` through `prisma.config.ts`. Values stored only
in `.env.local` are not available to Prisma.

## Local Development

```bash
npm ci
docker compose up -d postgresql
npm run db:setup
npm run dev
```

The application listens on port 3000. Swagger UI is available at
`http://localhost:3000/docs`.

The optional application Compose profile builds the production image:

```bash
docker compose --profile apps up --build
```

## Observability

Metrics and log shipping are off by default. The application emits no telemetry
unless `TELEMETRY_ENABLED=true`; when enabled it requires the exact private
OTLP/HTTP metrics endpoint in `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (for
example `http://alloy:4318/v1/metrics`). A missing or malformed endpoint for an
explicitly enabled configuration fails startup. Telemetry is never part of the
readiness check.

Application logs are JSON written to stdout. They contain only fixed event
names and safe operational fields; they never include email addresses, message
or conversation IDs, subjects, bodies, headers, credentials, provider payloads,
raw URLs, or error messages. `LOG_LEVEL` defaults to `info`.

Start the optional local demo after creating the usual `.env` file:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile apps up --build
```

It starts Grafana Alloy, Prometheus, Loki, and Grafana alongside the app.
Grafana is available at `http://localhost:3001`; Prometheus and Loki are on
ports 9090 and 3100. The demo provisions a service dashboard and alert rules,
but intentionally does not configure an alert receiver.

Alloy receives the application's OTLP metrics and remote-writes them to
Prometheus. Prometheus therefore has one Alloy scrape target for agent health,
not an application scrape target for every service. Alloy also reads stdout
only from Docker containers carrying `observability.logs=true`, decodes the JSON
events, and writes them to Loki. This keeps application-specific receiver setup
out of the shared Prometheus and Loki instances.

For production Docker hosts, run one Alloy agent per host on the private
application network and point every opted-in application at that agent. Mount
the Docker socket read-only, persist Alloy's data directory so log positions
survive restarts, and expose OTLP only on the private network. Configure remote
Prometheus/Loki URLs and credentials as Alloy secrets; do not pass backend
credentials into the application. The included local Alloy configuration is a
reference for the unauthenticated demo stack, not a production credential
template.

The first metric set covers HTTP traffic and duration, Resend provider calls,
webhook outcomes, outbox drain outcomes/backlog age, conversation state counts,
scheduled drain runs, and NATS delivery backlog. Attributes are intentionally
limited to finite route templates, operation, outcome, state, event type, and
sink values. The Grafana dashboard includes HTTP traffic/latency, outbox panels,
and the application log stream; starter alerts cover missing telemetry, HTTP
5xxs, stale or indeterminate outbox work, and stale NATS deliveries.

## Database Changes

`prisma/schema.prisma` and `prisma/migrations` are the database sources of
truth. Never edit an already deployed migration.

```bash
npm run db:validate
npm run db:generate
npm run db:migrate:deploy
```

Generated Prisma files live under `src/generated/prisma`, are ignored by Git,
and must not be edited manually.

## Testing

Integration tests use one application process, a local fake Resend server, and
a disposable PostgreSQL database. They truncate application tables.

Create an ignored `.env.test`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resend_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resend_test
RESEND_WEBHOOK_SECRET=whsec_dGVzdF9zZWNyZXRfa2V5X2Zvcl90ZXN0aW5nXzEyMzQ=
RESEND_API_KEY=test-resend-api-key
RESEND_API_BASE_URL=http://localhost:4010
RESEND_REPLY_TO=mailbox@replies.example.com
EMAIL_v2_API_KEY=test-conversation-v2-api-key
OUTBOX_DRAIN_API_KEY=test-outbox-drain-api-key
APP_BASE_URL=http://localhost:3000
```

`TEST_DATABASE_URL` may be omitted for local tests. The test harness defaults
to the disposable `resend_test` database exposed by `docker-compose.yml` at
`postgresql://postgres:postgres@localhost:5432/resend_test`. An explicit value
still takes precedence, including in CI. The test harness never falls back to
`DATABASE_URL` because integration tests truncate application tables.

Prepare the database and start the test application:

```bash
npm run db:setup
npm run dev:test
```

Run the suite from another terminal:

```bash
npm run test:postgresql
```

`TEST_DATABASE_URL` is deliberately separate from `DATABASE_URL` so tests never
fall back to an application or production database for destructive cleanup.

## Docker

```bash
docker build -t resend-conversation-service .
docker run --rm -e DATABASE_URL="$DATABASE_URL" resend-conversation-service npm run db:migrate:deploy
docker run --rm -p 3000:3000 --env-file .env resend-conversation-service
```

The image contains Prisma migration tooling, schema, migrations, public assets,
and the standalone Express server. When started with the default
`node dist/server.js` command, the container now fails fast if required runtime
environment variables are missing or if `RESEND_REPLY_TO` is not a valid
untagged base mailbox address.

Published releases are also available on Docker Hub as
`castab/resend-conversation-service`.

```bash
docker pull castab/resend-conversation-service:0.5.0
docker run --rm -e DATABASE_URL="$DATABASE_URL" castab/resend-conversation-service:0.5.0 npm run db:migrate:deploy
docker run --rm -p 3000:3000 --env-file .env castab/resend-conversation-service:0.5.0
```

Historical tags through `0.5.0` are available under both image names after the
one-time registry migration. Releases beginning with the next version publish
only to `castab/resend-conversation-service`. The legacy
`castab/resend-service` repository remains available with its final tags for
existing deployments, but receives no new releases.

Stable releases publish one immutable exact tag, plus moving convenience tags:

- `x.y.z`
- `x.y`
- `x`
- `latest`

Run migrations before starting a newly pulled image. Docker Hub publication is
currently limited to `linux/amd64` images.

## Releases

- This project follows [Semantic Versioning 2.0.0](https://semver.org/).
- Repository metadata, OpenAPI metadata, and consumer documentation use the
  same SemVer value.
- `CHANGELOG.md` is the source of release notes.
- Release pull requests prepare the version bump and changelog entry.
- After the release PR merges to `main`, push the matching annotated `vX.Y.Z`
  tag to publish Docker images.

Detailed release steps and the versioning policy live in
[docs/releasing.md](docs/releasing.md).

## Railway

Create one service from this repository and use `/railway.json`. Configure all
runtime variables before deployment because `/api/health/v2` checks the
complete configuration. The pre-deploy command applies pending Prisma
migrations.

Route public and private traffic through the API gateway as needed. Keep bearer
authentication enabled even when conversation routes are gateway-restricted.
Configure Resend to deliver signed events to
`https://<webhook-host>/api/webhooks/resend/v1`.

Drain the outbox at least once per minute when using asynchronous sends. There
are two ways to do it, and they can be used interchangeably.

An external caller invokes `POST /api/emails/v2/outbox/drain`, which is the only
drain route. It uses the persisted outbox and the drain credential, may process
direct and conversation intent together, handles one bounded batch per request,
and does not poll internally.

Alternatively the service can drive the same drain itself on a cron schedule.
This is **disabled by default**, so a deployment that already has an external
trigger is unaffected. Enable it with `OUTBOX_DRAIN_SCHEDULE_ENABLED=true` and a
cron expression in `OUTBOX_DRAIN_SCHEDULE`:

```bash
OUTBOX_DRAIN_SCHEDULE_ENABLED=true
OUTBOX_DRAIN_SCHEDULE=*/5 * * * *    # required when enabled; 5 or 6 fields
OUTBOX_DRAIN_SCHEDULE_TIMEZONE=UTC   # optional IANA name, defaults to UTC
OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE=100 # optional, 1-100, defaults to 100
OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES=5  # optional, 1-100, defaults to 5
```

One scheduled tick drains bounded batches until the outbox comes back empty or
`OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES` is reached, so a backlog clears instead of
trickling out one batch per tick. An invalid schedule fails startup rather than
silently never firing. A failing tick is logged and does not affect
`/api/health/v2`, because the drain already reschedules retryable provider
failures on its own.

Running the scheduler on several replicas, or alongside an external caller, is
safe: batches are claimed with row-level locks and leases, so concurrent drains
take different batches rather than colliding.

## Verification

```bash
npm run release:validate
npm run db:validate
npm run api:validate
npm run lint
npm run build
npm run test:postgresql
```

Webhook ledgers and projected conversations are retained indefinitely. Protect
PostgreSQL and every API credential because stored data can include addresses,
names, subjects, bodies, IP addresses, and user agents.
