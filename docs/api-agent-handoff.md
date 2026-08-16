# API Agent Handoff

Contract version: `0.6.0`

## Sources

Use the upstream `openapi.json`, consumer guide, release notes, and versioned service artifact as the integration sources of truth. This handoff is portable and assumes no access to the service repository, its scripts, or local agent configuration.

## Version selection

- Build new conversation integrations against `/api/conversations/v2`.
- Use `POST /api/emails/v2` for synchronous direct email and
  `POST /api/emails/v2/outbox` for queued direct email. Neither creates a
  conversation.
- Conversation API V1 was retired in 0.5.0. `/api/conversations/v1` and everything under it return `404 {"error":"Not found"}`. `CONVERSATION_API_KEY` and `RESEND_FROM` are no longer read.
- V2 requires explicit structured identities on every send and enqueue request.

## Authentication

| Scope | Credential |
| --- | --- |
| Conversation V2 and direct email | `Authorization: Bearer <EMAIL_v2_API_KEY>` |
| Any shared outbox drain alias | `Authorization: Bearer <OUTBOX_DRAIN_API_KEY>` |
| Resend webhook | Exact-body `svix-id`, `svix-timestamp`, `svix-signature` |

Credentials are not interchangeable and are never browser-safe.
The service operator may supply the V2 credential through `EMAIL_v2_API_KEY`
or `EMAIL_V2_API_KEY`; the mixed-case name takes precedence when both are set.

## V2 request rules

For opening send/enqueue operations, put identities under `message`:

```json
{
  "message": {
    "text": "Opening message",
    "from": { "address": "booking@mail.example.com", "name": "Booking Team" },
    "to": [
      { "address": "person@example.com", "name": "Person" },
      { "address": "backup@example.com", "name": "Backup Person" }
    ],
    "replyTo": { "address": "booking-replies@mail.example.com", "name": "Booking Team" },
    "tags": [{ "name": "category", "value": "booking_update" }]
  }
}
```

For existing-conversation send/enqueue operations, put `from`, `replyTo`, and optional `to` and `tags` at the request top level. `address` is required and `name` is optional. The retired `replyToName` field is rejected with `message.replyToName is not supported in API v2`.

For direct email, send structured `from`, one structured `to` identity or a nonempty `to` identity array, `subject`, and at least one of `text` or `html` to the synchronous or outbox route. Optional `tags` are forwarded to Resend. Do not send `replyTo`; neither route emits Reply-To or threading headers. Only the normalized From address is allowlisted. A mail client can still direct a reply to the From mailbox.

V2 `to` supports up to 50 recipients. Conversation `to` recipients are outbound-only and do not replace the single conversation participant; when omitted, conversation sends target the participant. V2 tags are limited to 10 nonblank `{name,value}` pairs with each string at most 256 characters.

Addresses containing whitespace are invalid; accepted addresses are normalized to lowercase. The database must contain an exact `(address, FROM)` row for `from.address` and an exact `(address, REPLY_TO)` row for `replyTo.address`. Roles are not interchangeable; wildcard, domain, alias, and display-name authorization do not exist. Allowlist administration is database-only.

Identity denial and fixed Reply-To base mismatch both return generic `400`:

```json
{"error":"The requested email identity is not allowed. Contact the administrator."}
```

Do not infer which policy check failed.

## Primary routes

The complete route layout:

| Method | V2 path | Purpose |
| --- | --- | --- |
| `POST` | `/api/emails/v2` | Synchronously send direct email without conversation, Reply-To, or threading headers |
| `POST` | `/api/emails/v2/outbox` | Persist and enqueue direct email in the shared outbox |
| `POST` | `/api/emails/v2/outbox/drain` | Preferred alias for draining one shared direct/conversation batch |
| `POST`, `GET` | `/api/conversations/v2` | Create/send; list unassigned with `assignment=unassigned` |
| `GET` | `/api/conversations/v2/summary` | Counts per conversation state plus a filterable page of conversation metadata |
| `POST` | `/api/conversations/v2/outbox` | Enqueue opening message; pending idempotent replay also returns `202` |
| `GET`, `PATCH` | `/api/conversations/v2/{conversationId}` | Read; assign an unassigned null-version or already-V2 conversation |
| `POST` | `/api/conversations/v2/{conversationId}/state` | Set conversation state by hand; no `Idempotency-Key` |
| `POST` | `/api/conversations/v2/{conversationId}/messages` | Send reply |
| `POST` | `/api/conversations/v2/{conversationId}/messages/outbox` | Enqueue reply; pending idempotent replay also returns `202` |
| `GET` | `/api/conversations/v2/topics/{topicType}/{externalTopicId}` | Read by topic |

`GET /api/health/v2` is unauthenticated and provides readiness behavior.
`GET /api/health/v1` was removed in 0.6.0 and returns `404 {"error":"Not found"}`.
`POST /api/webhooks/resend/v1` is Svix-authenticated.

## Critical invariants

1. One conversation exists per `(topicType, externalTopicId)` and has one external participant.
2. Every send/enqueue operation requires a stable `Idempotency-Key` of at most 256 characters.
3. Keys are retained indefinitely and globally unique across versions and send modes.
4. Direct email requires structured `from` and `to`, exact `FROM` authorization, a subject, and `text` or `html`; `to` may be one identity or an array, and recipients are not authorized.
5. Direct synchronous and queued operations use distinct idempotency modes. A queued replay never sends synchronously.
6. Direct and conversation intent share global outbox ordering, fixed batches, retries, capacity, and batch-level terminal outcomes.
7. The first conversation outbound intent fixes the Reply-To base. The service appends and preserves `+c_<32 lowercase hex routing token>`.
8. Later V2 conversation requests must submit that same untagged base even when another base is allowlisted.
9. Allowlist revocation blocks new intent but does not mutate or block already-persisted intent.
10. Conversation replies require a parent in the same conversation and never send without a parent RFC `Message-ID`.
11. `References` preserves the selected parent's ancestry.
12. Returned HTML is untrusted.
13. `accepted` is provider API acceptance, not final delivery. Direct email has no read endpoint for later projected delivery state.
14. Out-of-order row reconciliation preserves one-way V2 promotion and historical routing-token/base aliases when conversations merge.
15. Conversation `state` is one of `awaiting_us`, `awaiting_participant`, `concluded`, `terminated`, with `stateChangedAt` and a derived `awaitingReply` boolean. Inbound sets `awaiting_us`; persisted outbound reply intent sets `awaiting_participant`; a bounced, complained, or suppressed outbound delivery sets `terminated`. `email.failed` is not terminal.
16. `stateChangedAt` moves only when the state value changes, so `awaiting_us` records when the wait began.
17. Automatic transitions never move `terminated`; inbound mail reopens `concluded`. Merges take `terminated` > `awaiting_us` > `awaiting_participant` > `concluded` with the earliest timestamp of the winning state.
18. State transitions are driven by mail flow rather than by the route that triggered them, so they apply equally to conversations created before the V1 retirement. The state route permits every transition and repeating one succeeds.

## Promotion

Conversations created before the V1 retirement are still stored with `apiVersion = V1` and remain fully readable and writable through V2.

- Successfully persisting a synchronous or queued V2 reply intent promotes such a conversation to V2 before any provider call; provider acceptance is not required, and a subsequent `502` does not roll it back.
- V2 reopening of an all-failed `V1`-tagged topic promotes it when the fixed Reply-To base is compatible and the new intent is persisted, even if a later synchronous provider call returns `502`.
- V2 assignment accepts an unassigned null-version or already-V2 conversation and persists it as V2.
- Reads never promote or demote.
- Promotion is one-way; a conversation is never demoted to `V1`.

## Retry rules

- Reuse the same idempotency key and normalized request for the same logical action.
- Treat `202` from an outbox idempotent replay as stored intent that is still pending.
- Never retry a `502` with a new key until stored state is reconciled.
- Retry `503` parent-metadata failures later with backoff.
- Drain is repeatable and uses persisted ordered batches plus provider idempotency.
- Webhooks are at-least-once; completed duplicate `svix-id` deliveries return `200`.
- A replay of already-persisted V2 intent can return stored state after allowlist revocation; revocation applies to new intent.
- Send all JSON mutations and webhooks as uncompressed JSON. Controlled transport failures are `413` for a body over 2100 KB and `415` for a compressed body; fix the request rather than retrying it unchanged.

## Integration checklist

1. Store the V2 credential separately from the drain credential.
2. Choose `/api/emails/v2` or `/api/emails/v2/outbox` when the send needs no conversation, Reply-To, or later service read.
3. Provision exact lowercase `FROM` and `REPLY_TO` allowlist rows for conversations; direct email needs only `FROM`.
4. Keep the base `replyTo.address` stable for every conversation; never send the generated tagged address back as input.
5. Persist one idempotency key per logical send or enqueue and reuse it on retries.
6. Handle `200`, `201`, and `202` as state-bearing success responses.
7. Reconcile queued direct state by replaying the enqueue operation with the same key and normalized request; do not create a replacement send with a new key.
8. Schedule the shared drain with the dedicated credential at `/api/emails/v2/outbox/drain`. It is the only drain route.
9. Sanitize response HTML.
10. Validate request and response models against upstream OpenAPI contract `0.6.0`.

## Known concerns

- Runtime GET `limit` parsing is more lenient than the contract. Send integers from 1 through 100.
- Topic lookup is more lenient than create/assignment for `externalTopicId` length. Keep it at 255 characters or fewer.
- Some uncaught infrastructure failures may not return the standard JSON error envelope.
- No formal client timeout, request correlation ID, or gateway exposure contract is published.
- Health readiness requires the V2 and drain credentials plus `RESEND_REPLY_TO`.
- Dedicated tests cover central V2 identity, promotion, revocation, and routing behavior; not every mirrored read/mutation route has a separate V2 integration case.
