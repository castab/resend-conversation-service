# API Consumer Guide

Contract version: `0.3.1`

## Service purpose

`resend-service` owns topic-centered email conversations for one external participant per conversation and supports synchronous direct email that is not attached to a conversation. It persists outbound send intent before contacting Resend, projects inbound and delivery webhooks, and preserves parent relationships plus RFC `Message-ID` ancestry for conversations.

The service is authoritative for:

- Conversation identity by `(topicType, externalTopicId)`
- One external participant per conversation
- Message threading, send state, and outbound delivery state
- Idempotent synchronous and outbox send intent
- Stable per-conversation Reply-To routing
- Idempotent direct-email acceptance without conversation threading
- Signed Resend webhook ingestion and inbound projection

The service does not provide browser authentication, contact management, attachment retrieval, allowlist administration, or a general engagement analytics API. Returned HTML is untrusted and must be sanitized before browser rendering.

## Version choice

Use conversation API V2 for new conversation integrations. V2 is available under `/api/conversations/v2` and requires explicit authorized sender and Reply-To identities. Use `POST /api/emails/v2` for synchronous notification or system email that does not need a conversation.

Conversation API V1 remains available under `/api/conversations/v1` as a deprecated, frozen compatibility contract. There is no announced sunset. V1 continues to use only the server-configured `RESEND_FROM` and `RESEND_REPLY_TO`; callers cannot select V1 identities. New features belong in V2.

The health route is available at both `/api/health/v2` and `/api/health/v1`.
`/api/health/v2` is the current path; `/api/health/v1` remains as a
compatibility alias for existing readiness checks. Resend webhook ingress
remains V1.

## Authentication

### Conversation API V2

- Send `Authorization: Bearer <EMAIL_v2_API_KEY>`.
- The V2 credential is separate from V1 and from the drain credential.
- Operators may configure the credential with `EMAIL_v2_API_KEY` or the
  `EMAIL_V2_API_KEY` fallback. The mixed-case name takes precedence when both
  are nonempty.
- Missing or invalid credentials return `401` with `WWW-Authenticate: Bearer`.
- Missing server-side credential configuration returns `500 {"error":"Server misconfiguration"}`.
- The same credential authorizes `POST /api/emails/v2`.

### Deprecated conversation API V1

- Send `Authorization: Bearer <CONVERSATION_API_KEY>`.
- The V1 credential is not accepted by V2.
- V1 remains authenticated even when deployed behind a private gateway.

### Outbox drain

- Send `Authorization: Bearer <OUTBOX_DRAIN_API_KEY>`.
- Neither conversation credential is accepted.
- Both `/api/conversations/v1/outbox/drain` and `/api/conversations/v2/outbox/drain` invoke the same shared drain behavior and use this dedicated credential.

### Webhooks

- `POST /api/webhooks/resend/v1` requires `svix-id`, `svix-timestamp`, and `svix-signature` for the exact raw body.
- It does not use bearer authentication.

Never embed any bearer credential in browser code.

## V2 identity authorization

Every V2 conversation send or enqueue request requires structured `from` and `replyTo` identities:

```json
{
  "from": {
    "address": "booking@mail.example.com",
    "name": "Booking Team"
  },
  "replyTo": {
    "address": "booking-replies@mail.example.com",
    "name": "Booking Team"
  }
}
```

`address` is required. `name` is optional and may be omitted or null. Blank names normalize to null. Names are limited to 256 JavaScript characters, must be header-safe, and cannot contain `<` or `>`.

Addresses containing whitespace are invalid. After validation, the service trims and lowercases each address before authorization. Authorization requires exact database matches:

| Request field | Required allowlist role |
| --- | --- |
| `from.address` | `FROM` |
| `replyTo.address` | `REPLY_TO` |

The key is the exact `(address, role)` pair. A row for the same address under the other role does not authorize it. There are no wildcard, domain, alias, display-name, or case-insensitive database lookup rules beyond request normalization to canonical lowercase. Allowlist administration is database-only; no management endpoint is exposed.

For a new send intent, both rows must exist. Removing a row blocks later new V2 sends and enqueues. It does not alter or block an already-persisted outbox intent, and a replay of an already-persisted idempotent request is reconciled from stored state before a new authorization check.

Direct email instead requires a structured `from` identity and either one structured `to` identity or a nonempty `to` array of structured identities. Only `from.address` requires an exact `FROM` row; recipients are not allowlisted. Direct-email sender revocation blocks new intent but does not change replay of intent already persisted under the same idempotency key.

Conversation V2 send and enqueue requests may also include outbound `to` recipients. These recipients are not allowlisted and do not replace the canonical single conversation participant used for ownership, routing, and inbound matching. When `to` is omitted, conversation emails are sent to the participant.

Authorization-policy failures deliberately return the same generic response and do not reveal which identity failed:

```http
HTTP/1.1 400 Bad Request

{"error":"The requested email identity is not allowed. Contact the administrator."}
```

The same generic `400` is used when a request tries to change a conversation's fixed Reply-To base.

## Reply-To routing

`replyTo.address` must be an untagged base mailbox. It cannot already contain a plus tag and must leave enough local-part and total-address capacity for the routing suffix.

The first outbound intent fixes the normalized Reply-To base for the conversation. The service generates and preserves one routing token, producing addresses such as:

```text
booking-replies+c_8f2a1b9d4f8c4fd2a7319df35a6c041e@mail.example.com
```

Later V2 sends must provide the same base address, even if another `REPLY_TO` address is allowlisted. Callers provide only the base, never the generated tagged address. `replyTo.name` remains per-message and may change.

When a V1 conversation is promoted, its existing persisted `RESEND_REPLY_TO` base remains fixed. The promoting V2 request must provide that exact normalized base and it must be currently allowlisted for `REPLY_TO`.

## V2 endpoints

| Method | Path | Purpose | Success | Main errors |
| --- | --- | --- | --- | --- |
| `POST` | `/api/emails/v2` | Synchronously send one email without a conversation or Reply-To header | `201`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `POST` | `/api/conversations/v2` | Create and synchronously send an opening message | `201`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `GET` | `/api/conversations/v2?assignment=unassigned` | List unassigned inbound conversations | `200` | `400`, `401`, `500` |
| `POST` | `/api/conversations/v2/outbox` | Persist and enqueue an opening message | `202`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `POST` | `/api/conversations/v2/outbox/drain` | Deliver one shared bounded outbox batch | `200` | `400`, `401`, `413`, `415`, `500` |
| `GET` | `/api/conversations/v2/{conversationId}` | Read a conversation by service ID | `200` | `400`, `401`, `404`, `500` |
| `PATCH` | `/api/conversations/v2/{conversationId}` | Assign an unassigned null-version or V2 conversation and mark it V2 | `200` | `400`, `401`, `404`, `409`, `413`, `415`, `500` |
| `POST` | `/api/conversations/v2/{conversationId}/messages` | Synchronously send a reply | `201`, replay `200`/`202` | `400`, `401`, `404`, `409`, `413`, `415`, `500`, `502`, `503` |
| `POST` | `/api/conversations/v2/{conversationId}/messages/outbox` | Persist and enqueue a reply | `202`, replay `200`/`202` | `400`, `401`, `404`, `409`, `413`, `415`, `500`, `502`, `503` |
| `GET` | `/api/conversations/v2/topics/{topicType}/{externalTopicId}` | Read by external topic | `200` | `400`, `401`, `404`, `500` |

All V2 routes except drain use `EMAIL_v2_API_KEY`. Drain uses only `OUTBOX_DRAIN_API_KEY`.

## Direct email workflow

Send `POST /api/emails/v2` with a globally unique `Idempotency-Key`:

```json
{
  "from": {
    "address": "notifications@example.com",
    "name": "Example"
  },
  "to": [
    {
      "address": "person@example.com",
      "name": "Person"
    },
    {
      "address": "second@example.com",
      "name": "Second Person"
    }
  ],
  "subject": "Verify your email",
  "text": "Use the verification link.",
  "html": "<p>Use the verification link.</p>",
  "tags": [
    {
      "name": "category",
      "value": "confirm_email"
    }
  ]
}
```

At least one recipient and a subject are required, and at least one of `text` or `html` must be nonempty. `to` may remain the legacy single identity object or may be an array of up to 50 identities. Optional `tags` are forwarded to Resend and are limited to 10 nonblank `{name,value}` pairs. `replyTo` is rejected. The service creates no conversation, parent, routing token, outbox entry, Reply-To header, or RFC threading headers. Because standard mail clients fall back to the From mailbox when Reply-To is absent, select an appropriate monitored or no-reply From identity.

New provider acceptance returns `201`:

```json
{
  "email": {
    "id": "0198409b-7c01-7def-8ad2-8b94ad8e8987",
    "state": "accepted",
    "resendEmailId": "4f8f0f13-8d5a-4e79-b32a-70f39d0a3f18"
  }
}
```

There is no V1 or outbox equivalent and no direct-email GET operation. Lifecycle webhooks continue to update the persisted direct intent, but that later delivery state is not exposed by this endpoint.

## V2 workflows

### Create and send an opening message

Send `POST /api/conversations/v2` with a unique `Idempotency-Key`:

```json
{
  "topic": {
    "type": "booking",
    "externalId": "4821",
    "title": "Booking 4821"
  },
  "participant": {
    "email": "person@example.com",
    "name": "Person"
  },
  "subject": "Booking 4821",
  "message": {
    "text": "Your booking request was received.",
    "from": {
      "address": "booking@mail.example.com",
      "name": "Booking Team"
    },
    "to": [
      {
        "address": "person@example.com",
        "name": "Person"
      },
      {
        "address": "backup@example.com",
        "name": "Backup Person"
      }
    ],
    "replyTo": {
      "address": "booking-replies@mail.example.com",
      "name": "Booking Team"
    },
    "tags": [
      {
        "name": "category",
        "value": "booking_update"
      }
    ]
  }
}
```

At least one nonempty `message.text` or `message.html` value is required. Each body is limited to 1 MiB. Optional `message.to` may be one recipient identity or an array of up to 50 recipient identities; if omitted, the opening email is sent to `participant`. Optional `message.tags` are forwarded to Resend and are limited to 10 nonblank `{name,value}` pairs. V2 rejects the V1 `message.replyToName` property; use `message.replyTo.name`.

The service creates one conversation per topic. If all messages in an existing topic conversation are `failed`, V2 may reopen it with a new idempotency key. Reopening a failed V1 conversation promotes it to V2 only when its fixed Reply-To base is absent or equals the requested base.

### Send a reply

Send `POST /api/conversations/v2/{conversationId}/messages`:

```json
{
  "text": "Here is the requested update.",
  "replyToMessageId": "019808b9-37c4-7ed7-93c5-8960f0b690ab",
  "from": {
    "address": "booking@mail.example.com",
    "name": "Booking Team"
  },
  "to": [
    {
      "address": "person@example.com",
      "name": "Person"
    },
    {
      "address": "backup@example.com",
      "name": "Backup Person"
    }
  ],
  "replyTo": {
    "address": "booking-replies@mail.example.com",
    "name": "Booking Team"
  },
  "tags": [
    {
      "name": "category",
      "value": "conversation_reply"
    }
  ]
}
```

`replyToMessageId` is optional. When omitted, the service selects the latest `accepted` or `received` message. Optional `to` recipients override the outbound recipient list for that reply only; if omitted, the reply is sent to the conversation participant. Optional `tags` are forwarded to Resend and have the same limits as opening-message tags. An explicit parent must belong to the conversation. A reply is never sent without a parent RFC `Message-ID`; `In-Reply-To` uses that ID and `References` uses the parent's stored ancestry followed by the parent ID.

A V2 reply to a V1 conversation atomically promotes the conversation when the send intent is successfully persisted. This applies to synchronous and enqueue replies. For a synchronous reply, promotion is committed before the provider call and remains in effect if that call subsequently returns `502`; provider acceptance is not required. A request that fails before send-intent persistence does not promote state.

### Enqueue and drain

Use `POST /api/conversations/v2/outbox` for an opening message or `POST /api/conversations/v2/{conversationId}/messages/outbox` for a reply. Request bodies match the corresponding V2 synchronous operation.

Enqueue returns `202` after atomically persisting the conversation/message changes and outbox entry. An idempotent replay also returns `202` while that stored message remains pending; it returns `200` after acceptance or `502` after a failed or indeterminate outcome. A trusted scheduler then calls either versioned drain route with the dedicated drain credential:

```json
{
  "limit": 100
}
```

The drain processes at most one persistent batch per request. V1 and V2 intents share the outbox. A drain response can return `200` while reporting failed, retried, or indeterminate item state.

### Read and assign

Use the V2 GET routes with optional `limit` from 1 through 100 and `before=<message UUID>`. Messages are chronological within each returned page. `page.before` points to older messages.

Reads are not filtered by conversation API version. Reading a V1 conversation through V2 does not promote it, and reading a V2 conversation through deprecated V1 does not demote it.

List unassigned inbound conversations with `GET /api/conversations/v2?assignment=unassigned`. Assign one with `PATCH /api/conversations/v2/{conversationId}` and body `{"topic":{...}}`. V2 assignment succeeds only while the conversation is unassigned and its API version is null or already V2; a successfully persisted assignment marks or preserves it as V2. A V1 conversation cannot be assigned through V2.

## V1 compatibility and promotion

V1 mirrors the same route layout and response models but remains frozen around environment-selected identities:

| Method | V1 path |
| --- | --- |
| `POST`, `GET` | `/api/conversations/v1` |
| `POST` | `/api/conversations/v1/outbox` |
| `POST` | `/api/conversations/v1/outbox/drain` |
| `GET`, `PATCH` | `/api/conversations/v1/{conversationId}` |
| `POST` | `/api/conversations/v1/{conversationId}/messages` |
| `POST` | `/api/conversations/v1/{conversationId}/messages/outbox` |
| `GET` | `/api/conversations/v1/topics/{topicType}/{externalTopicId}` |

V1 opening messages accept `message.replyToName`; V1 replies accept top-level `replyToName`. V1 does not accept caller-selected `from` or `replyTo` behavior as part of its contract.

Promotion is one-way:

- Successfully persisting a synchronous or queued V2 reply intent promotes an existing V1 conversation; provider acceptance is not required.
- Reopening an all-failed V1 topic through V2 promotes it when the new V2 intent is persisted.
- V2 assignment accepts an unassigned null-version or already-V2 conversation and persists it as V2.
- A later `502` from a synchronous provider call does not roll back a promotion already committed with the V2 intent.
- V2 reads do not promote.
- V1 reads remain available after promotion.
- New V1 synchronous and outbox reply intents after promotion return `409 {"error":"Conversation requires API v2"}`; replay of an already-persisted idempotent V1 intent can still return its stored state.
- V1 assignment of a V2 conversation returns the same `409` error.
- A new V1 opening intent cannot reopen an all-failed conversation already marked V2; replay of an existing stored intent remains idempotent.
- No operation demotes V2 to V1.

There is no sunset date for V1. Consumers should migrate writes to V2 rather than depend on future V1 extensions.

## Request conventions

- Send JSON with `Content-Type: application/json` even though runtime parsing does not enforce the header.
- Send raw JSON bodies uncompressed. Every JSON mutation and the webhook route rejects compressed request bodies with controlled `415 {"error":"Compressed request bodies are not supported"}` and rejects bodies over the 2100 KB transport limit with controlled `413 {"error":"Request body is too large"}`.
- Every operation that sends or enqueues email requires `Idempotency-Key` with 1 through 256 characters.
- `conversationId`, message IDs, and `replyToMessageId` are UUIDs.
- `topic.type` matches `^[a-z][a-z0-9_-]{0,63}$`.
- `topic.externalId` is nonempty and contractually limited to 255 characters.
- Topic titles and subjects reject ASCII control characters and are limited to 255 characters.
- Participant names and identity display names reject ASCII control characters and are limited to 256 characters.
- Unknown request object properties are ignored by runtime validators and do not participate in idempotency comparison.
- Conversation subject normalization strips leading `Re:`, `Fw:`, and `Fwd:` prefixes case-insensitively. Direct-email subjects are trimmed but otherwise preserved.
- Health checks reject any query string with `400`.

The implementation parses invalid or out-of-range GET `limit` values leniently, but that behavior is not part of the public contract. Send an integer from 1 through 100.

## Response conventions

Successful send and enqueue operations return:

```json
{
  "conversationId": "019808b9-37c4-7ed7-93c5-8960f0b690aa",
  "message": {
    "id": "019808b9-37c4-7ed7-93c5-8960f0b690ab",
    "direction": "outbound",
    "state": "accepted",
    "deliveryState": "unknown",
    "from": {
      "address": "booking@mail.example.com",
      "name": "Booking Team"
    },
    "replyTo": "booking-replies+c_8f2a1b9d4f8c4fd2a7319df35a6c041e@mail.example.com",
    "replyToName": "Booking Team"
  }
}
```

Conversation reads return the conversation directly. Controlled errors use `{"error":"Human-readable message"}` without a separate machine code. Some uncaught infrastructure failures may not preserve that JSON shape.

Direct email uses the compact `email` response shown above and does not echo identities, subject, or bodies.

Message state meanings:

| State | Meaning |
| --- | --- |
| `received` | Inbound email projected |
| `pending` | Persisted outbound intent awaiting send or confirmation |
| `accepted` | Resend accepted the send API request; not final delivery |
| `failed` | Terminal known send failure |
| `indeterminate` | Terminal ambiguous outcome that cannot be retried safely |

Outbound `deliveryState` is projected later from Resend lifecycle webhooks. `delivered` means a matching `email.delivered` event was projected. Inbound messages return null. Open and click events do not confirm delivery.

## Errors and retries

| Status | Meaning | Retry guidance |
| --- | --- | --- |
| `400` | Invalid JSON, headers, IDs, filters, payload, V2 identity authorization, or fixed Reply-To mismatch | Change the request; do not probe identity policy |
| `401` | Missing or invalid credential/signature | Correct credentials or signature |
| `404` | Conversation, topic conversation, or reply parent missing | Retry only after state or identifier changes |
| `409` | Idempotency conflict, topic/assignment conflict, missing parent RFC ID, or V1 write after promotion | Reconcile state or change the logical request |
| `413` | Raw JSON body exceeds the 2100 KB transport limit | Reduce the request; do not retry unchanged |
| `415` | Compressed request body | Remove `Content-Encoding` compression and resend uncompressed JSON |
| `500` | Misconfiguration, persistence, projection, retrieval, or uncaught infrastructure failure | Retry only when safe and idempotent |
| `502` | Provider rejection or indeterminate send outcome after persistence | Reuse the same key; never immediately create a new logical send |
| `503` | Parent threading metadata retrieval failed | Retry later with backoff and the same logical request |

For every synchronous or enqueue retry, reuse the original `Idempotency-Key` and the same normalized request. Keys are globally unique across direct email, V1, V2, synchronous, and outbox operations and are retained indefinitely. The operation kind is included in normalized request hashing, so a key is not portable between route families, versions, or delivery modes.

Same key plus the same normalized request returns stored state. Same key plus a different normalized request returns `409`. The service persists intent before provider calls. Do not generate a new key merely because the client timed out or received `502`.

Outbox retries are server-managed. Observed behavior uses a 2-minute lease, then 1-minute, 2-minute, and 5-minute retry delays, bounded by a 23-hour provider idempotency safety window. No formal consumer timeout is published.

## Webhook behavior

`POST /api/webhooks/resend/v1` verifies the exact raw body before JSON transformation. Completed duplicate deliveries are idempotent by `svix-id` and return `200`.

For `email.received`, the service retrieves body and header metadata but never attachments. RFC ancestry is authoritative for conversation membership. When ancestry cannot resolve a conversation, a generated address token in `to` or `received_for` is a fallback only when the sender matches the conversation participant and, for V2-managed routing, the candidate base matches the persisted base.

Out-of-order inbound reconciliation can merge rows later discovered to represent one conversation. The surviving conversation preserves one-way V2 promotion if any merged source was V2 and retains historical routing-token/base pairs as aliases, so replies to previously emitted routing addresses remain resolvable.

Inbound retrieval or projection failure returns `500` so Resend can retry. Outbound delivery state is projected by Resend email ID.

## Integration setup

Consumers need the deployed base URL and the credential for their route family. Operators of the service configure:

- `DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `RESEND_FROM` and `RESEND_REPLY_TO` for frozen V1 behavior
- `CONVERSATION_API_KEY` for V1
- `EMAIL_v2_API_KEY` for V2, or `EMAIL_V2_API_KEY` as a fallback
- `OUTBOX_DRAIN_API_KEY` for the shared drain

V2 additionally requires database allowlist rows for each approved canonical address and role. Keep allowlist changes in controlled database administration; no application management API exists.

Direct email requires only a `FROM` row for its sender. It does not require or consult a recipient or `REPLY_TO` row.

## Consumer example

Direct email:

```bash
curl -i \
  -X POST https://resend-service.example/api/emails/v2 \
  -H "Authorization: Bearer <EMAIL_v2_API_KEY>" \
  -H "Idempotency-Key: verification-user-4821" \
  -H "Content-Type: application/json" \
  -d '{
    "from":{"address":"notifications@example.com","name":"Example"},
    "to":{"address":"person@example.com","name":"Person"},
    "subject":"Verify your email",
    "html":"<p>Use the verification link.</p>"
  }'
```

Conversation opening:

```bash
curl -i \
  -X POST https://resend-service.example/api/conversations/v2 \
  -H "Authorization: Bearer <EMAIL_v2_API_KEY>" \
  -H "Idempotency-Key: booking-4821-opening" \
  -H "Content-Type: application/json" \
  -d '{
    "topic":{"type":"booking","externalId":"4821","title":"Booking 4821"},
    "participant":{"email":"person@example.com","name":"Person"},
    "message":{
      "text":"Your booking request was received.",
      "from":{"address":"booking@mail.example.com","name":"Booking Team"},
      "replyTo":{"address":"booking-replies@mail.example.com","name":"Booking Team"}
    }
  }'
```

## Compatibility and known gaps

- Current conversation API: V2; deprecated frozen compatibility API: V1 with no announced sunset.
- OpenAPI version: `3.1.1`.
- Contract/package version observed in repository: `0.3.1`.
- No browser-safe authentication or correlation/request ID is defined.
- Gateway exposure policy is deployment-owned and not included in this contract.
- Topic lookup does not enforce the documented 255-character `externalTopicId` limit although create and assignment do; consumers must follow the stricter contract.
- Runtime webhook family validation is broader than the documented event enums; only documented events are supported.
- Health readiness now depends on both V1 and V2 credentials, even for deployments whose consumers use only one conversation version.
- V2 integration coverage confirms credential separation, structured identity validation, role separation, generic rejection, alias preservation, V1 reply promotion, post-promotion V1 write rejection, allowlist revocation behavior, fixed Reply-To base behavior, and V2 token-based inbound routing. Full V2 route-by-route parity is primarily established by direct route mirroring rather than distinct tests for every mirror endpoint.
