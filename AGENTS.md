# Repository Rules

## Application Boundaries

- This repository contains one deployable Express application.
- Keep API routes under `src/routes` and provider-neutral email behavior under
  `src/lib/email`.
- Keep Prisma access and generated-client exports under `src/lib/database`.
- Use the API gateway to control external route exposure; do not weaken
  application-layer authentication based on network placement.
- Keep `GET /api/health/v2` unauthenticated for readiness checks and return only
  aggregate status. `/api/health/v1` is retired and must fall through to the
  terminal `404` handler.

## Webhook Ingress

- Keep the route exactly `POST /api/webhooks/resend/v1`.
- Verify the exact raw request body before JSON transformation.
- Require `svix-id`, `svix-timestamp`, and `svix-signature`.
- Keep duplicate deliveries idempotent through the database `svix_id`
  constraints and acknowledge completed duplicates with `200`.
- Return `500` when required inbound retrieval or projection fails so Resend can
  retry. Do not acknowledge incomplete projection work.
- Do not fetch attachments.

## Conversation API

- Require bearer authentication on every conversation operation.
- Conversation API V1 was retired in 0.5.0. Do not reintroduce
  `/api/conversations/v1`, `CONVERSATION_API_KEY`, or `RESEND_FROM`; retired
  paths fall through to the terminal `404` handler and must not be tombstoned
  with a dedicated route.
- Keep V2 as the only conversation contract, using `EMAIL_v2_API_KEY`; require
  structured caller-supplied `from` and `replyTo` identities on every
  conversation send or enqueue operation.
- Require the dedicated drain credential on the outbox drain operation.
- Keep `POST /api/emails/v2/outbox/drain` as the single drain route. Do not
  reintroduce a conversation-namespaced drain alias.
- Keep the built-in cron drain scheduler disabled unless
  `OUTBOX_DRAIN_SCHEDULE_ENABLED` is exactly `true`. It must call the shared
  `drainEmailOutbox` implementation directly rather than adding a route or
  duplicating drain logic, must fail startup on invalid schedule configuration,
  and must not gate `GET /api/health/v2`.
- Require `Idempotency-Key` on every operation that can send or enqueue email.
- Persist send intent before calling Resend and never add unbounded retries.
- In V2, authorize canonical lowercase addresses by exact `(address, role)`
  matches in `email_address_allowlist_entries`. Keep `FROM` and `REPLY_TO`
  authorization separate; do not add wildcard, domain, alias, or display-name
  authorization.
- Keep allowlist administration database-only. Do not add an allowlist
  management API.
- Treat allowlist checks as authorization for new intent. Revocation must block
  later V2 sends and enqueues, but must not mutate or block already-persisted
  outbox intent.
- Preserve one conversation per `(topicType, externalTopicId)` and one external
  participant per conversation.
- Fix the Reply-To base on first outbound intent and preserve the
  per-conversation routing token. A V2 request must not change an existing
  conversation's Reply-To base.
- Promote surviving `V1`-tagged conversations to `V2` on the first authorized V2
  write. Promotion stays one-way; never demote a conversation to `V1`.
- Maintain conversation state from mail flow: inbound projection sets
  `AWAITING_US`, persisted outbound reply intent sets `AWAITING_PARTICIPANT`, and
  a bounced, complained, or suppressed outbound delivery sets `TERMINATED`. Only
  stamp `state_changed_at` when the state value actually changes.
- Keep `TERMINATED` sticky against automatic transitions and keep the state
  endpoint the only way out of it. Inbound mail reopens `CONCLUDED`.
- Drive conversation state from mail flow rather than from the route that
  triggered it, so transitions stay correct for promoted legacy conversations.
- An explicit reply parent must belong to the conversation. Otherwise use the
  latest accepted or received message.
- Never send a reply without a parent RFC Message-ID.
- Build `References` from the selected parent's ancestry.
- Treat stored and returned HTML as untrusted.
- Preserve fixed ordered outbox batch membership, bounded batch size, retry
  backoff, and the provider idempotency safety window.

## Direct Email API

- Keep direct email V2-only at `POST /api/emails/v2` and
  `POST /api/emails/v2/outbox`; do not add a V1 equivalent.
- Require `EMAIL_v2_API_KEY`, `Idempotency-Key`, structured caller-supplied
  `from` and one-or-more `to` identities, a subject, and at least one body
  format.
- Authorize only the canonical From address with an exact `FROM` allowlist row.
  Do not allowlist recipients.
- Reject `replyTo` and do not create a conversation, parent, routing token,
  Reply-To header, or RFC threading headers.
- Persist direct intent before Resend and keep it separate from conversation
  projection while preserving global message idempotency and delivery events.
- Atomically persist queued direct intent with its outbox entry. Replaying a
  queued operation must never invoke synchronous pending-message recovery.
- Keep the shared drain implementation in
  `src/routes/emails/v2/outbox/drain/route.ts` and authorize it with
  `OUTBOX_DRAIN_API_KEY`. Direct and conversation intent may share one ordered
  batch and its retry or terminal outcome.

## Database

- Treat `prisma/schema.prisma` and checked-in migrations as authoritative.
- Add migrations; never edit deployed migration history.
- Preserve UUIDv7 primary keys and all webhook, message, and outbox idempotency
  constraints.
- Never edit or commit `src/generated/prisma`.
- Run `npm run db:validate` and `npm run db:generate` after schema changes.
- Treat all email-related columns as sensitive and avoid logging values.

## Email Behavior

- Keep RFC Message-ID parsing provider-neutral.
- Preserve ordered References ancestry and selected-parent semantics.
- Expect missing, malformed, duplicated, and out-of-order webhook metadata.
- Keep projection idempotent by Resend email ID and RFC Message-ID.
- Never infer thread membership from subject alone when RFC ancestry exists.
- Keep Resend calls bounded with an abort timeout.
- Do not log message bodies, addresses, subjects, headers, or credentials.
- Keep the per-conversation Reply-To routing token and Message-ID hydration as
  designed; see [docs/adr-0001-reply-to-routing-tokens.md](docs/adr-0001-reply-to-routing-tokens.md)
  for why (Resend/SES overwrites caller-supplied Message-IDs).

## Conversation Events

- Keep NATS JetStream the only conversation event sink. Kafka was removed in
  0.7.0; do not reintroduce `kafkajs`, `CONVERSATION_EVENTS_KAFKA_*`, a `KAFKA`
  value in `ConversationEventSink`, or Kafka servers, channels, operations, or
  bindings in `public/asyncapi.json`.
- Keep `CONVERSATION_EVENTS_SINKS` plural and keep the `ConversationEventSink`
  interface and per-sink delivery records intact so another transport can be
  added later without reshaping the outbox.
- Expect the stream to already exist. Verify it and its subject at startup and
  fail fast; never create or mutate a stream from the service.

## Contracts And Tests

- Keep `public/openapi.json` aligned with every HTTP route or behavior change
  and `public/asyncapi.json` aligned with every conversation event or transport
  change.
- Treat OpenAPI and AsyncAPI as one consumer-facing interface suite. Keep their
  `info.version` values aligned with the repository version.
- Preserve the V2 contract and the explicit webhook and outbox-drain security
  overrides in OpenAPI. `emailV2Auth` is the spec-wide default; do not
  reintroduce a `bearerAuth` scheme.
- Integration tests use an explicit `TEST_DATABASE_URL` when provided;
  otherwise they use the dedicated local Docker Compose `resend_test` database
  at `postgresql://postgres:postgres@localhost:5432/resend_test`. They truncate
  application tables and must never fall back to `DATABASE_URL`.
- Keep test files serial while they share PostgreSQL and the fake Resend server.
- Describe pull requests with the sections in
  [.github/pull_request_template.md](.github/pull_request_template.md), dropping
  the ones that do not apply.
- Keep the checked-in JetStream provisioning config at
  [infra/nats/streams/CONVERSATION_EVENTS.json](infra/nats/streams/CONVERSATION_EVENTS.json)
  aligned with `public/asyncapi.json` and with whatever
  `CONVERSATION_EVENTS_NATS_STREAM` is set to in deployment; its `name` field
  is the stream name operators must provision under.
