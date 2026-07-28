# Repository Rules

## Application Boundaries

- This repository contains one deployable Express application.
- Keep API routes under `src/routes` and provider-neutral email behavior under
  `src/lib/email`.
- Keep Prisma access and generated-client exports under `src/lib/database`.
- Use the API gateway to control external route exposure; do not weaken
  application-layer authentication based on network placement.
- Keep `GET /api/health/v1` unauthenticated for readiness checks and return only
  aggregate status.

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
- Keep V1 as the frozen, environment-driven legacy contract using
  `CONVERSATION_API_KEY`, `RESEND_FROM`, and `RESEND_REPLY_TO`; do not sunset or
  extend it with caller-selected identities.
- Keep V2 as the forward contract using the separate
  `CONVERSATION_V2_API_KEY`; require structured caller-supplied `from` and
  `replyTo` identities on every send or enqueue operation.
- Require the dedicated drain credential on the outbox drain operation.
- Require `Idempotency-Key` on every operation that can send or enqueue email.
- Persist send intent before calling Resend and never add unbounded retries.
- In V1, use only the server-configured `RESEND_FROM`; callers cannot choose
  senders.
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
- Permit one-way V1-to-V2 promotion through an authorized V2 write. Reject
  subsequent V1 writes to that conversation; do not demote it to V1.
- An explicit reply parent must belong to the conversation. Otherwise use the
  latest accepted or received message.
- Never send a reply without a parent RFC Message-ID.
- Build `References` from the selected parent's ancestry.
- Treat stored and returned HTML as untrusted.
- Preserve fixed ordered outbox batch membership, bounded batch size, retry
  backoff, and the provider idempotency safety window.

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

## Contracts And Tests

- Keep `public/openapi.json` aligned with every route or behavior change.
- Preserve both V1 and V2 contracts and explicit webhook and outbox-drain
  security overrides in OpenAPI.
- Integration tests require a dedicated disposable `TEST_DATABASE_URL` and
  truncate application tables.
- Keep test files serial while they share PostgreSQL and the fake Resend server.
