# resend-service

[![Docker Hub](https://img.shields.io/docker/pulls/castab/resend-service?label=Docker%20Hub)](https://hub.docker.com/r/castab/resend-service) [![Docker Image Version](https://img.shields.io/docker/v/castab/resend-service?sort=semver&label=version)](https://hub.docker.com/r/castab/resend-service/tags)

`resend-service` is one PostgreSQL-backed Express application for receiving
Resend webhooks, managing topic-centered email conversations, and sending
direct non-conversation email. An external
API gateway controls which paths are publicly reachable; authentication and
signature verification remain enforced by the application.

## Architecture

```text
Resend
  -> API gateway
  -> POST /api/webhooks/resend/v1
  -> Svix verification
  -> webhook ledger and inbound conversation projection

Authorized callers
  -> API gateway or private service address
  -> POST /api/emails/v2 (synchronous direct email)
     or /api/conversations/v1 (frozen legacy contract)
     or /api/conversations/v2 (forward contract)
  -> version-specific bearer authentication
  -> durable PostgreSQL send intent
  -> synchronous Resend send or conversation transactional outbox
```

The single process shares one Prisma client, deployment lifecycle, health
check, OpenAPI contract, Docker image, and Railway service configuration.

## Repository Layout

```text
prisma/                 # Prisma schema and immutable migration history
public/openapi.json     # Unified OpenAPI contract
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
GET   /api/health/v1
POST  /api/webhooks/resend/v1
POST  /api/emails/v2
POST  /api/conversations/v1
GET   /api/conversations/v1?assignment=unassigned
POST  /api/conversations/v1/outbox
POST  /api/conversations/v1/outbox/drain
GET   /api/conversations/v1/{conversationId}
PATCH /api/conversations/v1/{conversationId}
POST  /api/conversations/v1/{conversationId}/messages
POST  /api/conversations/v1/{conversationId}/messages/outbox
GET   /api/conversations/v1/topics/{topicType}/{externalTopicId}
POST  /api/conversations/v2
GET   /api/conversations/v2?assignment=unassigned
POST  /api/conversations/v2/outbox
POST  /api/conversations/v2/outbox/drain
GET   /api/conversations/v2/{conversationId}
PATCH /api/conversations/v2/{conversationId}
POST  /api/conversations/v2/{conversationId}/messages
POST  /api/conversations/v2/{conversationId}/messages/outbox
GET   /api/conversations/v2/topics/{topicType}/{externalTopicId}
GET   /docs
GET   /openapi.json
```

The health endpoint is available at both `/api/health/v2` and
`/api/health/v1`; `v1` remains as a compatibility alias for deployment
readiness checks. The webhook requires a valid signature over the exact raw
body and all three Svix headers. V1 conversation operations require
`CONVERSATION_API_KEY`; V2 conversation operations and direct email require the
separate `EMAIL_v2_API_KEY`. Both outbox drain routes use
`OUTBOX_DRAIN_API_KEY`. Sending and enqueueing operations also require
`Idempotency-Key`.

`POST /api/webhooks/resend/v1` remains the supported long-term Resend webhook
ingress. Unlike the frozen legacy conversation API, this webhook path is not
part of a V1-to-V2 migration and will remain active for the foreseeable future.

### API versions

V1 is the frozen legacy API. Its outbound From and Reply-To identities come
only from `RESEND_FROM` and `RESEND_REPLY_TO`; callers may supply a Reply-To
display name but cannot select either mailbox address. V1 has no planned sunset
and remains available for existing integrations and V1 conversations, but new
identity-selection behavior belongs in V2.

V2 is the forward API. Every create, reply, and corresponding outbox request
must provide structured `from` and `replyTo` objects with an `address` and an
optional `name`. Both addresses are canonicalized to lowercase and must match
separate, role-specific database allowlist entries before new send intent is
persisted. Display names are validated header text, not allowlisted identities.

`POST /api/emails/v2` is V2-only and synchronously sends one direct email
without creating a conversation or outbox entry. It requires structured `from`
and `to` identities, a subject, and at least one of `text` or `html`. Only the
normalized From address requires an exact `FROM` allowlist row. The endpoint
does not accept `replyTo` and emits no Reply-To or RFC threading headers. Mail
clients normally fall back to the From address when a recipient chooses Reply.

A V2 reply promotes a V1 conversation when the V2 send intent is successfully
persisted, before any synchronous provider call. Promotion therefore remains
committed even if that provider call subsequently returns `502`; provider
acceptance is not required. The supplied Reply-To base must match the base
already fixed on the conversation. Promotion is one-way: later V1 reply and
assignment writes return `409` with `Conversation requires API v2`; reads remain
available through both versions.

## Conversation Model

A caller-owned `(topicType, externalTopicId)` pair identifies a conversation.
Each conversation currently has one external participant. V1 uses the
environment-configured sender and Reply-To base; V2 records the selected sender
on each message and fixes the selected Reply-To base on the conversation. Each
conversation also has an opaque routing token. Outbound Reply-To addresses are
always generated from the fixed base as `<local>+c_<token>@<domain>`, and each
message may add a display name without changing that address. Messages retain
provider and RFC identifiers, ordered reply ancestry, send state, projected
outbound delivery state, content, and timestamps.

Asynchronous sends persist the same pending message rows used by synchronous
sends. Outbox rows coordinate fixed, ordered Resend batches and bounded retries
without duplicating message content. Inbound messages are attached through RFC
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
RESEND_FROM=Mailbox <mailbox@example.com>
RESEND_REPLY_TO=mailbox@replies.example.com
CONVERSATION_API_KEY=replace-with-a-long-random-secret
EMAIL_v2_API_KEY=replace-with-a-different-long-random-secret
OUTBOX_DRAIN_API_KEY=replace-with-another-long-random-secret
```

`RESEND_FROM`, `RESEND_REPLY_TO`, and `CONVERSATION_API_KEY` define the frozen
V1 identity and credential. V2 callers use `EMAIL_v2_API_KEY` and select
only database-allowlisted identities in each request.

Every Reply-To base, whether supplied by V1 configuration or a V2 caller, must
be a plain mailbox on a Resend Receiving domain, without a display name or an
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
RESEND_FROM=Test Mailbox <mailbox@example.com>
RESEND_REPLY_TO=mailbox@replies.example.com
CONVERSATION_API_KEY=test-conversation-api-key
EMAIL_v2_API_KEY=test-conversation-v2-api-key
OUTBOX_DRAIN_API_KEY=test-outbox-drain-api-key
APP_BASE_URL=http://localhost:3000
```

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
docker build -t resend-service .
docker run --rm -e DATABASE_URL="$DATABASE_URL" resend-service npm run db:migrate:deploy
docker run --rm -p 3000:3000 --env-file .env resend-service
```

The image contains Prisma migration tooling, schema, migrations, public assets,
and the standalone Express server. When started with the default
`node dist/server.js` command, the container now fails fast if required runtime
environment variables are missing or if `RESEND_REPLY_TO` is not a valid
untagged base mailbox address.

Published releases are also available on Docker Hub as
`castab/resend-service`.

```bash
docker pull castab/resend-service:0.3.0
docker run --rm -e DATABASE_URL="$DATABASE_URL" castab/resend-service:0.3.0 npm run db:migrate:deploy
docker run --rm -p 3000:3000 --env-file .env castab/resend-service:0.3.0
```

Stable releases publish one immutable exact tag, plus moving convenience tags:

- `x.y.z`
- `x.y`
- `x`
- `latest`

Run migrations before starting a newly pulled image. Docker Hub publication is
currently limited to `linux/amd64` images.

## Releases

- Repository metadata, OpenAPI metadata, and consumer documentation use the
  same SemVer value.
- `CHANGELOG.md` is the source of release notes.
- Release pull requests prepare the version bump and changelog entry.
- After the release PR merges to `main`, push the matching annotated `vX.Y.Z`
  tag to publish Docker images.

Detailed release steps live in `docs/releasing.md`.

## Railway

Create one service from this repository and use `/railway.json`. Configure all
runtime variables before deployment because `/api/health/v2` and the retained
`/api/health/v1` alias both check the complete configuration. The pre-deploy
command applies pending Prisma migrations.

Route public and private traffic through the API gateway as needed. Keep bearer
authentication enabled even when conversation routes are gateway-restricted.
Configure Resend to deliver signed events to
`https://<webhook-host>/api/webhooks/resend/v1`.

Invoke either versioned `POST /api/conversations/{version}/outbox/drain` route at
least once per minute when using asynchronous sends. Both routes use the same
persisted outbox and drain credential; each request handles one bounded batch
and does not poll internally.

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
