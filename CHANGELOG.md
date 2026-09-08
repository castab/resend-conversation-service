# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). See
[docs/releasing.md](docs/releasing.md) for how versions are chosen.

## [Unreleased]

## [0.8.0] - 2026-09-08

### Added

- Added optional support for receiving and sending email attachments, stored in
  S3-compatible object storage and tracked in PostgreSQL. The whole feature sits
  behind `ATTACHMENTS_ENABLED` and is off by default.
- Added `POST /api/attachments/v2` to upload raw attachment bytes and
  `GET /api/attachments/v2/{attachmentId}` to stream them back, both under
  `EMAIL_v2_API_KEY`. Uploading separately from the send keeps the JSON body
  limit on every existing route unchanged. Downloads stream through the service,
  so storage credentials and pre-signed links are never exposed to callers.
- Added an optional `attachments` array to send bodies
  (`[{ id, contentId? }]`), referencing prior uploads. An attachment can be
  claimed by exactly one message, atomically with the send intent.
- Added an `attachments` array to serialized messages and to the direct email
  response, carrying filename, media type, disposition, content ID, size, state,
  and a download path.
- Added asynchronous inbound attachment ingest. The webhook projects attachment
  metadata inside its existing transaction, and a background runtime with
  per-row leases and retry backoff copies the bytes into object storage. An
  attachment therefore reports `pending` until its bytes are stored.
- Added a separate outbox lane for attachment-carrying intent, drained through
  the existing `POST /api/emails/v2/outbox/drain` route and reported as an
  additive `attachments` object on its result. Resend cannot send attachments
  through its batch endpoint, so that lane sends one message at a time.
- Added lifecycle-tied deletion. A `BEFORE DELETE` trigger on
  `email_attachments` records every removed row's object as a tombstone, and a
  reaper deletes it from storage with retries. Deleting a conversation cascades
  inside PostgreSQL, so the trigger is what guarantees its objects are removed.
  Uploads never referenced by a send are collected after 24 hours.
- Added an optional `attachmentCount` to the `conversation.message.received`
  event. The event schema version stays `1`.

### Changed

- `POST /api/emails/v2/outbox/drain` now also drains the attachment lane and
  returns an additional `attachments` object when attachments are enabled. All
  existing top-level fields keep their exact meaning, and the property is absent
  when the feature is disabled.
- The built-in drain scheduler now drains both lanes per tick.
- `GET /api/health/v2` now also reports unhealthy when attachments are enabled
  but storage is unconfigured or the ingest runtime is failing. With the feature
  disabled the check is unchanged.
- Attachment filenames, storage keys, and download URLs are redacted from logs
  alongside the existing email fields.
- CI now runs the unit suites, which it previously never did, via a new
  `npm run test:unit` script.

### Upgrade notes

- Request hashing is unchanged for every request shape that existed at 0.7.1.
  `attachments` enters the hashed value only when a caller supplies it, so
  idempotency records written before the upgrade still match on retry, whether
  or not the feature is enabled. `tests/send-request-hash.test.ts` pins the
  released hashes against regression.
- **No action is required to upgrade.** `ATTACHMENTS_ENABLED` defaults to off,
  and with it off every response is byte-identical to 0.7.1: no `attachments`
  property is added anywhere, the new routes fall through to the terminal
  `404`, and no new configuration is read.
- The migration is additive. It creates `email_attachments`,
  `email_attachment_outbox_entries`, and `stored_object_tombstones`, three
  enums, and one trigger function. No existing table or column is altered.
- To enable the feature, set `ATTACHMENTS_ENABLED=true` and provide
  `ATTACHMENTS_S3_BUCKET`, `ATTACHMENTS_S3_REGION`,
  `ATTACHMENTS_S3_ACCESS_KEY_ID`, and `ATTACHMENTS_S3_SECRET_ACCESS_KEY`.
  Non-AWS storage also needs `ATTACHMENTS_S3_ENDPOINT` and usually
  `ATTACHMENTS_S3_FORCE_PATH_STYLE=true`. The service refuses to start if the
  flag is on and the bucket cannot be reached; it never creates the bucket.
- Size limits default to 25 MiB per attachment and 28 MiB per message, which
  keeps a message under Resend's 40 MB ceiling once attachments are base64
  encoded. Override with `ATTACHMENTS_MAX_BYTES`,
  `ATTACHMENTS_MAX_TOTAL_BYTES`, and `ATTACHMENTS_MAX_COUNT`.
- Once enabled, a send body carrying `attachments` is accepted; while disabled
  the same body is rejected with `400` rather than silently sent without them.
- Queued sends with attachments are not batched. If you rely on the drain
  response, read the new `attachments` object to see that lane's outcome.
- Grant the service `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and
  `s3:ListBucket` on the bucket. Deletion is driven by the service, so a bucket
  lifecycle rule is not required.

## [0.7.1] - 2026-09-02

### Added

- Added `DELETE /api/conversations/v2/{conversationId}` to permanently delete a
  conversation along with its messages, outbox entries, and routing aliases.
- Added a `conversation.deleted` conversation event, published through the
  existing NATS JetStream outbox before the conversation is removed. Deleting
  a conversation also purges its earlier event history, so
  `conversation.deleted` is the last event a subscriber will see for that
  conversation.

## [0.7.0] - 2026-09-02

### Added

- Added an optional durable conversation lifecycle event feed published through
  NATS JetStream, with per-sink delivery tracking, leases, retries,
  per-conversation ordering, configuration validation, and startup connectivity
  checks. The feed remains disabled when no sink is configured.
- Added an AsyncAPI 3.1 contract for the seven conversation lifecycle event
  types and exposed it from the unauthenticated `/asyncapi.json` endpoint.
- Added an optional built-in cron scheduler that drains the shared email outbox.
  It is disabled unless `OUTBOX_DRAIN_SCHEDULE_ENABLED` is `true` and supplements
  rather than replaces `POST /api/emails/v2/outbox/drain`.
- Added opt-in OpenTelemetry metrics and direct OTLP/HTTP application log export,
  redacted structured JSON logs, and a local Grafana, Prometheus, Loki, and
  Grafana Alloy Compose overlay.

### Changed

- Made the OpenTelemetry metrics endpoint optional when telemetry is enabled and
  allowed any HTTP(S) collector URL without requiring the `/v1/metrics` path.
- Replaced the optional Alloy forwarding layer with native Prometheus OTLP
  metric ingestion and native Loki OTLP log ingestion in the local observability
  stack.
- Added curated environment, service group, version, and revision filters to
  the Grafana dashboard and documented direct OTLP operations for local Docker
  and Railway deployments.
- Retuned the checked-in JetStream provisioning config to lightweight defaults
  and documented every field as an operator-tunable suggestion.
- Expanded API validation and consumer documentation to keep HTTP and broker
  contracts synchronized.
- Defaulted destructive integration tests to the dedicated local Docker Compose
  `resend_test` database when `TEST_DATABASE_URL` is not provided, without
  falling back to `DATABASE_URL`.

### Fixed

- Included the underlying conversation event sink startup error in diagnostic
  logs without logging credentials.

### Removed

- Removed the Kafka conversation-event sink. NATS JetStream is the only
  supported transport; Kafka configuration, dependencies, and AsyncAPI bindings
  are gone.

### Upgrade notes

- The `20260820000000_add_conversation_events` migration creates
  `ConversationEventSink` with `NATS` only. This migration was revised during
  the 0.7.0 release-candidate period and has not shipped in a stable release.
- Upgrading needs no action. `prisma migrate deploy` treats the migration as
  already applied and reports no pending migrations, so an existing database
  deploys normally. A reset is not required.
- Databases initialized from an earlier 0.7.0 RC retain an unused `KAFKA` enum
  value and a stale migration checksum. Nothing can write the enum value, and
  `prisma migrate deploy` does not read the checksum. To make those databases
  match a fresh install, run this optional operation. The `DELETE` discards
  conversation events still awaiting delivery to the former Kafka sink:

  ```sql
  BEGIN;
  DELETE FROM conversation_event_deliveries WHERE sink = 'KAFKA';
  ALTER TYPE "ConversationEventSink" RENAME TO "ConversationEventSink_old";
  CREATE TYPE "ConversationEventSink" AS ENUM ('NATS');
  ALTER TABLE conversation_event_deliveries
    ALTER COLUMN sink TYPE "ConversationEventSink"
    USING sink::text::"ConversationEventSink";
  DROP TYPE "ConversationEventSink_old";
  UPDATE _prisma_migrations
    SET checksum = 'e37980013dcab8b5ea7bc52dbffad8a530ae06bf06edda2405449eddb6740fee'
    WHERE migration_name = '20260820000000_add_conversation_events';
  COMMIT;
  ```

## [0.6.0] - 2026-08-15

### Removed

- **Breaking.** Removed `GET /api/health/v1`. The endpoint now returns
  `404 {"error":"Not found"}`. Operators must repoint all readiness probes to
  `GET /api/health/v2` before deploying.

### Changed

- Renamed the project and canonical Docker Hub image from `resend-service` to
  `resend-conversation-service`. Historical Docker tags through `0.5.0` remain
  available under the legacy image name; future releases publish only to
  `castab/resend-conversation-service`.

## [0.5.0] - 2026-08-15

### Added

- Added a conversation `state` of `awaiting_us`, `awaiting_participant`,
  `concluded`, or `terminated`, exposed on the conversation response together with
  `stateChangedAt` and a derived `awaitingReply` boolean. Inbound mail moves a
  conversation to `awaiting_us`; sending or enqueuing an outbound reply moves it to
  `awaiting_participant`; a bounce, complaint, or suppression moves it to
  `terminated`. Automatic transitions never move a `terminated` conversation, and
  inbound mail reopens a `concluded` one.
- Added `GET /api/conversations/v2/summary`, returning conversation counts for every
  state and a filterable, paginated list of conversations with their participant,
  subject, and state, ordered by oldest state change first. Items carry conversation
  metadata only.
- Added `POST /api/conversations/v2/{conversationId}/state` to set a conversation
  state by hand, including marking a conversation `concluded` when it needs no
  follow-up.

### Removed

- **Breaking.** Removed conversation API V1. `POST` and `GET
  /api/conversations/v1`, `/api/conversations/v1/outbox`,
  `/api/conversations/v1/outbox/drain`,
  `/api/conversations/v1/{conversationId}`, its `/messages` and
  `/messages/outbox` routes, and
  `/api/conversations/v1/topics/{topicType}/{externalTopicId}` are no longer
  routed and return `404 {"error":"Not found"}`. Callers migrate to the
  corresponding `/api/conversations/v2` paths, which require the
  `EMAIL_v2_API_KEY` credential and structured `from` and `replyTo` identities
  authorized by exact role-specific allowlist rows; `replyToName` becomes
  `replyTo.name`.
- Removed the `CONVERSATION_API_KEY` and `RESEND_FROM` environment variables.
  Both are no longer read, and health readiness no longer requires them.
  `RESEND_REPLY_TO` is retained as the Reply-To base for inbound routing-token
  validation.
- Removed the `bearerAuth` security scheme from `public/openapi.json`.
  `emailV2Auth` is now the spec-wide default.
- **Breaking.** Removed `POST /api/conversations/v2/outbox/drain`, the
  compatibility alias deprecated in 0.4.0. `POST /api/emails/v2/outbox/drain` is
  now the only drain route. Behavior, request and response shapes, and the
  `OUTBOX_DRAIN_API_KEY` credential are unchanged.

  **Operators must repoint the scheduled drain caller before deploying.** A
  scheduler still calling the conversation-namespaced path receives `404`, and
  because nothing else reports a drain failure, queued email accumulates in the
  outbox instead of surfacing an error. Deployments provisioned before 0.4.0 are
  the most likely to still be on the old path.

`GET /api/health/v1` and `POST /api/webhooks/resend/v1` are unrelated to this
retirement and are unchanged.

### Changed

- Moved the shared outbox drain implementation to
  `POST /api/emails/v2/outbox/drain`, which previously re-exported it from the
  V1 route tree.
- Documented [Semantic Versioning 2.0.0](https://semver.org/) as the governing
  versioning guideline, with links from `README.md`, `CHANGELOG.md`, and
  `docs/releasing.md`. `docs/releasing.md` now explains why pre-`1.0.0`
  breaking changes stay in `0.x.0` and records what should be true before
  publishing `1.0.0`.

### Migration

- The conversation-state migration back-fills every conversation that existed before
  the upgrade as `awaiting_participant`, that is, **not** awaiting a reply.
  Conversations with unanswered inbound mail from before the upgrade will not appear
  under `state=awaiting_us` until they receive new inbound mail. Operators who need
  the historical backlog must re-derive it themselves.
- The V1 retirement ships no database migration. Conversations created through V1
  keep `api_version = 'V1'` and their fixed Reply-To base, remain readable and
  writable through V2, and are still promoted to `V2` on the first authorized V2
  write.

## [0.4.0] - 2026-07-29

### Added

- Added `POST /api/emails/v2/outbox` for durable asynchronous direct email and
  `POST /api/emails/v2/outbox/drain` as an alias of the shared direct and
  conversation outbox drain.

### Deprecated

- Deprecated `POST /api/conversations/v2/outbox/drain` in favor of the
  email-namespaced shared drain. The old route remains a supported alias with
  no announced sunset.

## [0.3.1] - 2026-07-28

### Changed

- Accepted `EMAIL_V2_API_KEY` as a fallback for the preferred
  `EMAIL_v2_API_KEY` V2 credential environment variable.

## [0.3.0] - 2026-07-28

### Added

- Added the forward conversation API V2 with a dedicated bearer credential,
  required structured From and Reply-To identities, and database-managed,
  role-specific exact-address authorization.
- Added authenticated synchronous `POST /api/emails/v2` sends with structured
  sender and recipient identities, exact `FROM` authorization, durable global
  idempotency, and no conversation, Reply-To, outbox, or threading behavior.
- Added multiple outbound recipients and Resend tags to V2 direct email,
  conversation send, and conversation enqueue operations.
- Added direct operator control of V2 identity authorization through the
  `email_address_allowlist_entries` table; no allowlist management API is
  exposed.
- Added `GET /api/health/v2` as an alias of the unauthenticated aggregate
  readiness endpoint.

### Changed

- Designated V1 as the frozen, environment-driven legacy API with no planned
  sunset, while preserving its existing `RESEND_FROM` and `RESEND_REPLY_TO`
  behavior.
- Consolidated V2 conversation and direct-email authentication under the
  dedicated `EMAIL_v2_API_KEY` credential.
- Added one-way V1-to-V2 conversation promotion, fixed per-conversation Reply-To
  bases with existing routing tokens, and V1 write rejection after promotion.
- Defined allowlist revocation to block new V2 intent without cancelling
  already-persisted outbox work.

## [0.2.0] - 2026-07-21

### Changed

- Migrated the application runtime from Next.js to Express 5 while preserving
  the public API contract and local Swagger UI.

## [0.1.0] - 2026-07-21

### Added

- Added outbound delivery-state projection from Resend lifecycle webhooks while
  preserving provider send acceptance as the existing message `state`.
- Added optional per-message Reply-To display names for conversation sends and
  outbox sends.

## [0.0.1] - 2026-07-21

### Added

- Initial public release process with SemVer metadata, changelog tracking, and
  tag-triggered Docker Hub publication guidance.
