# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project uses Semantic
Versioning.

## [Unreleased]

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

`GET /api/health/v1` and `POST /api/webhooks/resend/v1` are unrelated to this
retirement and are unchanged.

### Changed

- Moved the shared outbox drain implementation to
  `POST /api/emails/v2/outbox/drain`, which previously re-exported it from the
  V1 route tree. `POST /api/conversations/v2/outbox/drain` remains a deprecated
  compatibility alias with no announced sunset, and drain behavior and its
  credential are unchanged.

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
