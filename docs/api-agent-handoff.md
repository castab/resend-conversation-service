# API Agent Handoff

Contract version: `0.3.0`

## Sources

Use the upstream `openapi.json`, consumer guide, release notes, and versioned service artifact as the integration sources of truth. This handoff is portable and assumes no access to the service repository, its scripts, or local agent configuration.

## Version selection

- Build new conversation integrations against `/api/conversations/v2`.
- Use `POST /api/emails/v2` for synchronous email that must not create a conversation.
- Treat `/api/conversations/v1` as deprecated and frozen. It has no announced sunset.
- V1 uses server-configured `RESEND_FROM` and `RESEND_REPLY_TO`; callers cannot select identities.
- V2 requires explicit structured identities on every send and enqueue request.

## Authentication

| Scope | Credential |
| --- | --- |
| Conversation V2 and direct email | `Authorization: Bearer <EMAIL_v2_API_KEY>` |
| Deprecated conversation V1 | `Authorization: Bearer <CONVERSATION_API_KEY>` |
| Either outbox drain path | `Authorization: Bearer <OUTBOX_DRAIN_API_KEY>` |
| Resend webhook | Exact-body `svix-id`, `svix-timestamp`, `svix-signature` |

Credentials are not interchangeable and are never browser-safe.

## V2 request rules

For opening send/enqueue operations, put identities under `message`:

```json
{
  "message": {
    "text": "Opening message",
    "from": { "address": "booking@mail.example.com", "name": "Booking Team" },
    "replyTo": { "address": "booking-replies@mail.example.com", "name": "Booking Team" }
  }
}
```

For existing-conversation send/enqueue operations, put `from` and `replyTo` at the request top level. `address` is required and `name` is optional. Do not send V1 `replyToName` fields to V2.

For direct email, send structured `from` and singular `to` identities plus `subject` and at least one of `text` or `html` to `POST /api/emails/v2`. Do not send `replyTo`; the endpoint emits neither Reply-To nor threading headers. Only the normalized From address is allowlisted. A mail client can still direct a reply to the From mailbox.

Addresses containing whitespace are invalid; accepted addresses are normalized to lowercase. The database must contain an exact `(address, FROM)` row for `from.address` and an exact `(address, REPLY_TO)` row for `replyTo.address`. Roles are not interchangeable; wildcard, domain, alias, and display-name authorization do not exist. Allowlist administration is database-only.

Identity denial and fixed Reply-To base mismatch both return generic `400`:

```json
{"error":"The requested email identity is not allowed. Contact the administrator."}
```

Do not infer which policy check failed.

## Primary routes

V2 mirrors the complete V1 conversation layout:

| Method | V2 path | Purpose |
| --- | --- | --- |
| `POST` | `/api/emails/v2` | Send one direct email without conversation, outbox, Reply-To, or threading headers |
| `POST`, `GET` | `/api/conversations/v2` | Create/send; list unassigned with `assignment=unassigned` |
| `POST` | `/api/conversations/v2/outbox` | Enqueue opening message; pending idempotent replay also returns `202` |
| `POST` | `/api/conversations/v2/outbox/drain` | Drain shared outbox with dedicated credential |
| `GET`, `PATCH` | `/api/conversations/v2/{conversationId}` | Read; assign an unassigned null-version or already-V2 conversation |
| `POST` | `/api/conversations/v2/{conversationId}/messages` | Send reply |
| `POST` | `/api/conversations/v2/{conversationId}/messages/outbox` | Enqueue reply; pending idempotent replay also returns `202` |
| `GET` | `/api/conversations/v2/topics/{topicType}/{externalTopicId}` | Read by topic |

`GET /api/health/v2` and `GET /api/health/v1` are both unauthenticated and have identical readiness behavior. `POST /api/webhooks/resend/v1` is Svix-authenticated.

## Critical invariants

1. One conversation exists per `(topicType, externalTopicId)` and has one external participant.
2. Every send/enqueue operation requires a stable `Idempotency-Key` of at most 256 characters.
3. Keys are retained indefinitely and globally unique across versions and send modes.
4. Direct email requires structured `from` and `to`, exact `FROM` authorization, a subject, and `text` or `html`; it rejects `replyTo` and does not authorize recipients.
5. The first conversation outbound intent fixes the Reply-To base. The service appends and preserves `+c_<32 lowercase hex routing token>`.
6. Later V2 conversation requests must submit that same untagged base even when another base is allowlisted.
7. Allowlist revocation blocks new intent but does not mutate or block already-persisted intent.
8. Conversation replies require a parent in the same conversation and never send without a parent RFC `Message-ID`.
9. `References` preserves the selected parent's ancestry.
10. Returned HTML is untrusted.
11. `accepted` is provider API acceptance, not final delivery. Direct email has no read endpoint for later projected delivery state.
12. Out-of-order row reconciliation preserves one-way V2 promotion and historical routing-token/base aliases when conversations merge.

## Promotion

- Successfully persisting a synchronous or queued V2 reply intent promotes a V1 conversation to V2 before any provider call; provider acceptance is not required, and a subsequent `502` does not roll it back.
- V2 reopening of an all-failed V1 topic promotes it when the fixed Reply-To base is compatible and the new intent is persisted, even if a later synchronous provider call returns `502`.
- V2 assignment accepts an unassigned null-version or already-V2 conversation and persists it as V2; it does not accept V1.
- Reads never promote or demote.
- After promotion, new V1 reply and enqueue-reply intents plus V1 assignment return `409 Conversation requires API v2`; existing idempotent intent replay can still return stored state.
- A new V1 opening intent cannot reopen an all-failed V2 conversation.
- Promotion is one-way.

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

1. Select V2 and store the V2 credential separately from V1 and drain credentials.
2. Choose `/api/emails/v2` only when the send needs no conversation, Reply-To, outbox, or later service read.
3. Provision exact lowercase `FROM` and `REPLY_TO` allowlist rows for conversations; direct email needs only `FROM`.
4. Keep the base `replyTo.address` stable for every conversation; never send the generated tagged address back as input.
5. Persist one idempotency key per logical send or enqueue and reuse it on retries.
6. Handle `200`, `201`, and `202` as state-bearing success responses.
7. Reconcile `502` using the same key; do not create a replacement direct send with a new key.
8. Sanitize response HTML.
9. Validate request and response models against upstream OpenAPI contract `0.3.0`.

## Known concerns

- Runtime GET `limit` parsing is more lenient than the contract. Send integers from 1 through 100.
- Topic lookup is more lenient than create/assignment for `externalTopicId` length. Keep it at 255 characters or fewer.
- Some uncaught infrastructure failures may not return the standard JSON error envelope.
- No formal client timeout, request correlation ID, or gateway exposure contract is published.
- Health readiness requires both V1 and V2 credentials.
- Dedicated tests cover central V2 identity, promotion, revocation, and routing behavior; not every mirrored read/mutation route has a separate V2 integration case.
