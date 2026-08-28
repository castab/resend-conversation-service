# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/). See
[docs/releasing.md](docs/releasing.md) for how versions are chosen.

## [Unreleased]

## [0.7.0-rc.4] - 2026-08-28

### Added

- Added an optional built-in cron scheduler that drains the shared email outbox
  from inside the service. It is disabled unless
  `OUTBOX_DRAIN_SCHEDULE_ENABLED` is `true`, is configured with
  `OUTBOX_DRAIN_SCHEDULE`, `OUTBOX_DRAIN_SCHEDULE_TIMEZONE`,
  `OUTBOX_DRAIN_SCHEDULE_BATCH_SIZE`, and `OUTBOX_DRAIN_SCHEDULE_MAX_BATCHES`,
  and supplements rather than replaces `POST /api/emails/v2/outbox/drain`.
  Deployments driven by an external trigger are unaffected.

### Changed

- Retuned the checked-in JetStream provisioning config to lightweight defaults
  and documented every field as an operator-tunable suggestion in
  `infra/nats/streams/README.md`.
- Corrected the `CONVERSATION_EVENTS_NATS_STREAM` example so it matches the
  `name` in the checked-in stream config.

### Removed

- Removed the Kafka conversation event sink. NATS JetStream is now the only
  supported transport: the `kafkajs` dependency, every
  `CONVERSATION_EVENTS_KAFKA_*` variable, the `KAFKA` value of the
  `ConversationEventSink` enum, and the Kafka server, channel, operation, and
  message bindings in `public/asyncapi.json` are gone. Kafka may return in a
  later version; the sink abstraction and the plural `CONVERSATION_EVENTS_SINKS`
  variable were kept for that.

### Breaking

- The `20260820000000_add_conversation_events` migration was rewritten in place
  to create `ConversationEventSink` with `NATS` only. A database that already
  applied it will fail `prisma migrate deploy` on a checksum mismatch and must
  be recreated with `npx prisma migrate reset --force` rather than migrated
  forward. This is acceptable only because the migration has shipped solely in
  `0.7.0` release candidates.

## [0.7.0-rc.3] - 2026-08-20

### Added

- Added an AsyncAPI 3.1 contract for all seven conversation lifecycle event
  types and exposed it at the unauthenticated `/asyncapi.json` documentation
  endpoint.

### Changed

- Expanded API validation, release metadata checks, consumer documentation,
  and the repository API integration skill to keep HTTP and broker contracts
  synchronized.
- Defaulted destructive integration tests to the dedicated local Docker
  Compose `resend_test` database when `TEST_DATABASE_URL` is not provided,
  without falling back to `DATABASE_URL`.

## [0.7.0-rc.2] - 2026-08-20

### Fixed

- Included the underlying conversation event sink startup error in the
  diagnostic log without logging credentials.

## [0.7.0-rc.1] - 2026-08-20

### Added

- Added an optional durable conversation event feed that publishes compact,
  versioned lifecycle events to NATS JetStream, Kafka, or both concurrently.
- Added per-sink delivery tracking, leases, retries, per-conversation ordering,
  and aggregate readiness reporting while enabled sinks are unhealthy.
- Added configuration validation and startup connectivity checks for the NATS
  and Kafka conversation event sinks. The feature remains disabled when no sink
  is configured.

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
