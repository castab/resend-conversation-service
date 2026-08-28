# API Consumer Guide

Contract version: `0.7.0-rc.3`

## Service purpose

`resend-conversation-service` owns topic-centered email conversations for one external participant per conversation and supports synchronous and queued direct email that is not attached to a conversation. It persists outbound send intent before contacting Resend, projects inbound and delivery webhooks, and preserves parent relationships plus RFC `Message-ID` ancestry for conversations.

The service is authoritative for:

- Conversation identity by `(topicType, externalTopicId)`
- One external participant per conversation
- Message threading, send state, and outbound delivery state
- Idempotent synchronous and outbox send intent
- Stable per-conversation Reply-To routing
- Idempotent synchronous and queued direct-email acceptance without conversation threading
- Signed Resend webhook ingestion and inbound projection

The service does not provide browser authentication, contact management, attachment retrieval, allowlist administration, or a general engagement analytics API. Returned HTML is untrusted and must be sanitized before browser rendering.

## Version choice

Conversation API V2 is the only conversation contract. It is available under `/api/conversations/v2` and requires explicit authorized sender and Reply-To identities. Use `POST /api/emails/v2` or `POST /api/emails/v2/outbox` for synchronous or queued notification and system email that does not need a conversation.

Conversation API V1 was retired in 0.5.0. `/api/conversations/v1` and everything under it are no longer routed and return `404 {"error":"Not found"}`. Conversations it created are unaffected and continue to be served by V2.

The unauthenticated health route is `/api/health/v2`. `/api/health/v1` was
removed in 0.6.0 and returns `404 {"error":"Not found"}`. Resend webhook
ingress remains `/api/webhooks/resend/v1`; its V1 path is unrelated to the
conversation API retirement.

Use the deployed `/openapi.json` contract for HTTP and `/asyncapi.json` for the
optional NATS conversation event feed. Both contracts carry the same
service package version. The event payload schema version is a separate field
and is currently `1`.

## Authentication

### Conversation API V2

- Send `Authorization: Bearer <EMAIL_v2_API_KEY>`.
- The V2 credential is separate from the drain credential.
- Operators may configure the credential with `EMAIL_v2_API_KEY` or the
  `EMAIL_V2_API_KEY` fallback. The mixed-case name takes precedence when both
  are nonempty.
- Missing or invalid credentials return `401` with `WWW-Authenticate: Bearer`.
- Missing server-side credential configuration returns `500 {"error":"Server misconfiguration"}`.
- The same credential authorizes both direct-email routes.

### Outbox drain

- Send `Authorization: Bearer <OUTBOX_DRAIN_API_KEY>`.
- The conversation credential is not accepted.
- `/api/emails/v2/outbox/drain` is the only drain path. The conversation-namespaced alias was removed in 0.5.0.

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

Leading and trailing address whitespace is trimmed before lowercase normalization; whitespace within an address is invalid. Authorization requires exact database matches:

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

When a `V1`-tagged conversation is promoted, its existing persisted Reply-To base remains fixed. The promoting V2 request must provide that exact normalized base and it must be currently allowlisted for `REPLY_TO`.

## V2 endpoints

| Method | Path | Purpose | Success | Main errors |
| --- | --- | --- | --- | --- |
| `POST` | `/api/emails/v2` | Synchronously send one email without a conversation or Reply-To header | `201`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `POST` | `/api/emails/v2/outbox` | Persist and enqueue direct email without a conversation | `202`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `POST` | `/api/emails/v2/outbox/drain` | Deliver one shared direct/conversation outbox batch | `200` | `400`, `401`, `413`, `415`, `500` |
| `POST` | `/api/conversations/v2` | Create and synchronously send an opening message | `201`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `GET` | `/api/conversations/v2?assignment=unassigned` | List unassigned inbound conversations | `200` | `400`, `401`, `500` |
| `GET` | `/api/conversations/v2/summary` | Count conversations per state and list those in the selected states | `200` | `400`, `401`, `500` |
| `POST` | `/api/conversations/v2/outbox` | Persist and enqueue an opening message | `202`, replay `200`/`202` | `400`, `401`, `409`, `413`, `415`, `500`, `502` |
| `GET` | `/api/conversations/v2/{conversationId}` | Read a conversation by service ID | `200` | `400`, `401`, `404`, `500` |
| `PATCH` | `/api/conversations/v2/{conversationId}` | Assign an unassigned null-version or V2 conversation and mark it V2 | `200` | `400`, `401`, `404`, `409`, `413`, `415`, `500` |
| `POST` | `/api/conversations/v2/{conversationId}/state` | Set the conversation state by hand | `200` | `400`, `401`, `404`, `413`, `415`, `500` |
| `POST` | `/api/conversations/v2/{conversationId}/messages` | Synchronously send a reply | `201`, replay `200`/`202` | `400`, `401`, `404`, `409`, `413`, `415`, `500`, `502`, `503` |
| `POST` | `/api/conversations/v2/{conversationId}/messages/outbox` | Persist and enqueue a reply | `202`, replay `200`/`202` | `400`, `401`, `404`, `409`, `413`, `415`, `500`, `502`, `503` |
| `GET` | `/api/conversations/v2/topics/{topicType}/{externalTopicId}` | Read by external topic | `200` | `400`, `401`, `404`, `500` |

All authenticated direct-email and conversation V2 routes use `EMAIL_v2_API_KEY`. `/api/health/v2` is unauthenticated. Drain uses only `OUTBOX_DRAIN_API_KEY`.

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

At least one recipient and a subject are required, and at least one of `text` or `html` must be nonempty. `to` may remain the legacy single identity object or may be an array of up to 50 identities. Optional `tags` are forwarded to Resend and are limited to 10 nonblank `{name,value}` pairs. `replyTo` is rejected. Direct email creates no conversation, parent, routing token, Reply-To header, or RFC threading headers. The synchronous route creates no outbox entry; the queued route atomically creates one. Because standard mail clients fall back to the From mailbox when Reply-To is absent, select an appropriate monitored or no-reply From identity.

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

Use `POST /api/emails/v2/outbox` with the same body and a different globally unique idempotency key to queue delivery. A new enqueue returns `202` with `state: "pending"` and `resendEmailId: null` without calling Resend. Replay the same normalized queued request and key to reconcile state: pending remains `202`, accepted returns `200`, and failed or indeterminate returns `502`. A synchronous and queued request cannot share one idempotency key.

There is no direct-email GET operation. Lifecycle webhooks continue to update persisted direct intent, but later delivery state is not exposed by a read endpoint.

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

At least one nonempty `message.text` or `message.html` value is required. Each body is limited to 1 MiB. Optional `message.to` may be one recipient identity or an array of up to 50 recipient identities; if omitted, the opening email is sent to `participant`. Optional `message.tags` are forwarded to Resend and are limited to 10 nonblank `{name,value}` pairs. The retired `message.replyToName` property is rejected; use `message.replyTo.name`.

The service creates one conversation per topic. If all messages in an existing topic conversation are `failed`, V2 may reopen it with a new idempotency key. Reopening a failed `V1`-tagged conversation promotes it to V2 only when its fixed Reply-To base is absent or equals the requested base.

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

A V2 reply to a `V1`-tagged conversation atomically promotes the conversation when the send intent is successfully persisted. This applies to synchronous and enqueue replies. For a synchronous reply, promotion is committed before the provider call and remains in effect if that call subsequently returns `502`; provider acceptance is not required. A request that fails before send-intent persistence does not promote state.

### Enqueue and drain

Use `POST /api/emails/v2/outbox` for direct email, `POST /api/conversations/v2/outbox` for an opening message, or `POST /api/conversations/v2/{conversationId}/messages/outbox` for a reply. Request bodies match the corresponding synchronous operation.

Enqueue returns `202` after atomically persisting intent and its outbox entry. An idempotent replay also returns `202` while that stored message remains pending; it returns `200` after acceptance or `502` after a failed or indeterminate outcome. A trusted scheduler calls the shared drain route with the dedicated drain credential:

```json
{
  "limit": 100
}
```

The scheduler path is `POST /api/emails/v2/outbox/drain`, the only drain route. The drain processes at most one persistent batch per request. The service can alternatively run this same drain internally on a cron schedule, which the operator enables with `OUTBOX_DRAIN_SCHEDULE_ENABLED` and `OUTBOX_DRAIN_SCHEDULE`; it is disabled by default and does not change this HTTP contract. Direct and conversation intent share global ordering and may occupy one fixed batch, including shared retry and batch-level terminal outcomes. A drain response can return `200` while reporting failed, retried, or indeterminate item state.

### Read and assign

Use the V2 GET routes with optional `limit` from 1 through 100 and `before=<message UUID>`. Messages are chronological within each returned page. `page.before` points to older messages.

Reads are not filtered by conversation API version. Reading a `V1`-tagged conversation through V2 does not promote it.

List unassigned inbound conversations with `GET /api/conversations/v2?assignment=unassigned`. Assign one with `PATCH /api/conversations/v2/{conversationId}` and body `{"topic":{...}}`. V2 assignment succeeds only while the conversation is unassigned and its API version is null or already V2; a successfully persisted assignment marks or preserves it as V2.

### Track and clear replies

Every conversation read includes `state`, `stateChangedAt`, and a derived `awaitingReply` boolean that is true exactly when `state` is `awaiting_us`.

| State | Meaning | Set by |
| --- | --- | --- |
| `awaiting_us` | The participant wrote last and is waiting on a reply | Inbound mail |
| `awaiting_participant` | We replied and are waiting on the participant | Persisting outbound reply intent, sent or enqueued |
| `concluded` | The exchange is finished and needs no follow-up | Operators, through the state route |
| `terminated` | The participant is unreachable, or an operator ended the thread | A bounced, complained, or suppressed outbound delivery, or the state route |

Automatic mail-flow transitions move `stateChangedAt` only when the state value changes, so a conversation waiting on a reply keeps the timestamp of the message that started the wait however many further messages arrive. Every successful manual state write currently resets `stateChangedAt`, including a repeated state value. Automatic transitions never move a `terminated` conversation; inbound mail reopens a `concluded` one. A send-side `email.failed` is not terminal, since it says nothing about whether the participant can be reached.

`GET /api/conversations/v2/summary` returns `counts` for all four states regardless of any filter, `count` for the selected states, and a page of conversations ordered by oldest `stateChangedAt` first. Filter with `state`, repeated or comma-separated and matched case-insensitively; omit it to list every state. `?state=awaiting_us` is therefore a reply queue with the longest wait at the top. Paginate with `limit` from 1 through 100 and the opaque `page.before` cursor.

Summary items carry conversation metadata only. There is deliberately no message payload; read messages from `GET /api/conversations/v2/{conversationId}`.

Clear a conversation that needs no follow-up, such as a bare acknowledgement, with `POST /api/conversations/v2/{conversationId}/state` and body `{"state":"concluded"}`. Every state is settable and every transition is permitted, including reopening a `terminated` conversation. Setting the state a conversation already holds succeeds and leaves the state value unchanged, but currently resets `stateChangedAt`. No email is sent, so this route takes no `Idempotency-Key`.

State transitions are driven by mail flow rather than by the route that triggered them, so they apply equally to conversations created before the V1 retirement.

## Retired conversation API V1

Conversation API V1 was removed in 0.5.0. These paths are no longer routed and return `404 {"error":"Not found"}`:

| Method | Retired path |
| --- | --- |
| `POST`, `GET` | `/api/conversations/v1` |
| `POST` | `/api/conversations/v1/outbox` |
| `POST` | `/api/conversations/v1/outbox/drain` |
| `GET`, `PATCH` | `/api/conversations/v1/{conversationId}` |
| `POST` | `/api/conversations/v1/{conversationId}/messages` |
| `POST` | `/api/conversations/v1/{conversationId}/messages/outbox` |
| `GET` | `/api/conversations/v1/topics/{topicType}/{externalTopicId}` |

`CONVERSATION_API_KEY` and `RESEND_FROM` are no longer read. `GET /api/health/v1`
was later removed in 0.6.0; `POST /api/webhooks/resend/v1` remains available.

To migrate, move each call to the corresponding `/api/conversations/v2` path, swap the credential for `EMAIL_v2_API_KEY`, add structured `from` and `replyTo` identities to every send and enqueue request, and replace `replyToName` with `replyTo.name`. Both addresses must hold exact role-specific allowlist rows.

### Conversations created before the retirement

Existing conversations stored with `apiVersion = V1` are fully readable and writable through V2. Their fixed Reply-To base is preserved, so a V2 write must supply that exact base and it must be currently allowlisted for `REPLY_TO`.

Promotion to V2 is one-way:

- Successfully persisting a synchronous or queued V2 reply intent promotes the conversation; provider acceptance is not required.
- Reopening an all-failed `V1`-tagged topic through V2 promotes it when the new V2 intent is persisted.
- V2 assignment accepts an unassigned null-version or already-V2 conversation and persists it as V2.
- A later `502` from a synchronous provider call does not roll back a promotion already committed with the V2 intent.
- V2 reads do not promote.
- No operation demotes a conversation to `V1`.

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
| `401` | Invalid credential or Svix signature | Correct credentials or signature |
| `404` | Conversation, topic conversation, or reply parent missing | Retry only after state or identifier changes |
| `409` | Idempotency conflict, topic/assignment conflict, or missing parent RFC ID | Reconcile state or change the logical request |
| `413` | Raw JSON body exceeds the 2100 KB transport limit | Reduce the request; do not retry unchanged |
| `415` | Compressed request body | Remove `Content-Encoding` compression and resend uncompressed JSON |
| `500` | Misconfiguration, persistence, projection, retrieval, or uncaught infrastructure failure | Retry only when safe and idempotent |
| `502` | Provider rejection or indeterminate send outcome after persistence | Reuse the same key; never immediately create a new logical send |
| `503` | Parent threading metadata retrieval failed | Retry later with backoff and the same logical request |

For every synchronous or enqueue retry, reuse the original `Idempotency-Key` and the same normalized request. Keys are globally unique across direct email, conversation, synchronous, and outbox operations and are retained indefinitely. The operation kind is included in normalized request hashing, so a key is not portable between route families, versions, or delivery modes.

Same key plus the same normalized request returns stored state. Same key plus a different normalized request returns `409`. The service persists intent before provider calls. Do not generate a new key merely because the client timed out or received `502`.

Outbox retries are server-managed. Observed behavior uses a 2-minute lease, then 1-minute, 2-minute, and 5-minute retry delays, bounded by a 23-hour provider idempotency safety window. No formal consumer timeout is published.

## Webhook behavior

`POST /api/webhooks/resend/v1` verifies the exact raw body before JSON transformation. Completed duplicate deliveries are idempotent by `(event family, svix-id)` and return `200`. Missing required Svix headers are `400`; an invalid supplied signature is `401`.

For `email.received`, the service retrieves body and header metadata but never attachments. RFC ancestry is authoritative for conversation membership. When ancestry cannot resolve a conversation, a generated address token in `to` or `received_for` is a fallback only when the sender matches the conversation participant and, for V2-managed routing, the candidate base matches the persisted base.

Out-of-order inbound reconciliation can merge rows later discovered to represent one conversation. The surviving conversation preserves one-way V2 promotion if any merged source was V2 and retains historical routing-token/base pairs as aliases, so replies to previously emitted routing addresses remain resolvable.

Inbound retrieval or projection failure returns `500` so Resend can retry. Outbound delivery state is projected by Resend email ID.

## Conversation event feed

When enabled by the service operator, the service publishes compact
conversation lifecycle events to NATS JetStream. Direct email
does not emit these events. The feed contains identifiers and lifecycle
metadata only: it does not contain addresses, names, subjects, message bodies,
headers from email, or raw Resend payloads. Use an authorized conversation GET
operation when an event consumer needs current conversation or message data.

The machine-readable contract is the AsyncAPI 3.1 document at
`GET /asyncapi.json`. Broker endpoints, subscriber credentials, NATS stream
names, and final subject or topic names are deployment-owned. Values shown as
AsyncAPI server, subject, or topic defaults are substitution examples only;
the service has no runtime fallback when an enabled sink omits its required
configuration.

Every event has these required payload fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer payload contract version; currently exactly `1` |
| `id` | UUIDv7 event ID and consumer deduplication key |
| `type` | Discriminator for one of the seven event schemas |
| `occurredAt` | Time the represented state change or intent occurred, not publication time |
| `conversationId` | UUIDv7 conversation ID used for reads and ordering |
| `sequence` | Monotonic integer within one conversation |
| `topic` | `{type, externalId}` when assigned, otherwise null |
| `actor` | `participant`, `service`, `operator`, or `system`, as constrained by the event schema |
| `cause` | Closed event-specific reason code |

Event-specific fields and causes are:

| `type` | Additional field | Actor and cause |
| --- | --- | --- |
| `conversation.created` | None | `participant` / `inbound_email` or `service` / `outbound_intent` |
| `conversation.message.received` | `messageId` | `participant` / `inbound_email` |
| `conversation.message.outbound.intended` | `messageId` | `service` / `synchronous_send` or `outbox_enqueue` |
| `conversation.state.changed` | `state: {from, to}` | `participant` / `inbound_email`, `service` / `outbound_intent`, `operator` / `manual_override`, or `system` / `unreachable_delivery` |
| `conversation.assigned` | Non-null `topic` | `operator` / `topic_assignment` |
| `conversation.message.delivery.updated` | `messageId`, `deliveryState` | `system` / `resend_delivery_webhook` |
| `conversation.merged` | Source events include `mergedIntoConversationId`; the survivor event omits it | `system` / `thread_reconciliation` |

`state.from` may be null and state values are `awaiting_us`,
`awaiting_participant`, `concluded`, or `terminated`. `deliveryState` is one of
`delivered`, `delivery_delayed`, `bounced`, `complained`, `suppressed`, or
`failed`.

Published messages carry application headers
`x-conversation-event-id` and
`x-conversation-event-schema-version`. The event-ID header equals payload `id`;
the schema-version header is the string `"1"`. NATS JetStream
sets the protocol-defined `Nats-Msg-Id` to the event ID, which JetStream uses
for publish deduplication inside the stream's configured duplicate window.

Publication failures are retried from persisted per-sink delivery records
without a terminal attempt limit. A failed event blocks later sequence values
for the same conversation. Delivery is at least once. Consumers must:

1. Reject or quarantine an unsupported `schemaVersion` before dispatching on
   `type`.
2. Deduplicate globally by `id`, including duplicates observed after a retry.
3. Process one conversation by ascending `sequence`; do not infer ordering
   between different conversations from broker or publication time.
4. Tolerate a stream beginning above sequence 1 and apparent gaps. Events are
   created only while the sink is enabled, and enabling it does not backfill
   events committed while it was disabled.
5. Treat an unknown event type or extra field as a contract mismatch under the
   closed schema-v1 contract rather than silently guessing its meaning.
6. Make handlers idempotent because the event and downstream side effects may
   be replayed.

Creation does not include an initial state field, and thread reconciliation can
change the survivor's state without a separate `conversation.state.changed`
event. Treat the feed as a lifecycle notification stream rather than a complete
state-reconstruction log; fetch the current authorized HTTP representation when
state convergence matters.

An incompatible field, value, or event-kind change requires a future payload
schema version and a new versioned subject or topic. Consumers should not treat
the service package version as the event payload schema version.

## Integration setup

Consumers need the deployed base URL and the credential for their route family. Operators of the service configure:

- `DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `RESEND_REPLY_TO` as the Reply-To base for inbound routing-token validation
- `EMAIL_v2_API_KEY`, or `EMAIL_V2_API_KEY` as a fallback
- `OUTBOX_DRAIN_API_KEY` for the shared drain

Event consumers additionally need deployment-provided NATS connection
details and subscriber credentials. Those credentials are independent of the
HTTP bearer credentials and are not defined by this service contract.

V2 additionally requires database allowlist rows for each approved canonical address and role. Keep allowlist changes in controlled database administration; no application management API exists.

Direct email requires only a `FROM` row for its sender. It does not require or consult a recipient or `REPLY_TO` row.

## Consumer example

Direct email:

```bash
curl -i \
  -X POST https://resend-conversation-service.example/api/emails/v2 \
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
  -X POST https://resend-conversation-service.example/api/conversations/v2 \
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

- Current conversation API: V2. Conversation API V1 was retired in 0.5.0 and its paths return `404`.
- OpenAPI version: `3.1.1`.
- AsyncAPI version: `3.1.0`; conversation event payload schema version: `1`.
- Contract/package version observed in repository: `0.7.0-rc.3`.
- No browser-safe authentication or correlation/request ID is defined.
- Gateway exposure policy is deployment-owned and not included in this contract.
- Topic lookup does not enforce the documented 255-character `externalTopicId` limit although create and assignment do; consumers must follow the stricter contract.
- Runtime webhook family validation accepts signed `email.*`, `contact.*`, and `domain.*` types when their payload can be projected, while the OpenAPI event enums remain the strict supported contract. Consumers should send only documented Resend event types.
- Health readiness requires `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, a valid `RESEND_REPLY_TO` base, an EMAIL V2 credential, `OUTBOX_DRAIN_API_KEY`, and PostgreSQL connectivity.
- Runtime accepts trimmed, case-insensitive state values for the manual state route; use the lowercase OpenAPI enum values as the supported contract.
- Current runtime and OpenAPI reset `stateChangedAt` after every successful manual state write, including a repeated value. This conflicts with the service lifecycle invariant that the timestamp should change only with the state value; avoid no-op state writes and do not depend on the reset while the discrepancy remains unresolved.
- Conversation send validators may ignore an explicitly empty `text` or `html` when the other body format is nonempty. The strict contract requires every supplied body field to be nonempty.
- `PATCH /api/conversations/v2/{conversationId}` and the manual state route do not support pagination query parameters. Current runtime can commit the mutation and then return `400` if an undocumented invalid `before` query is supplied during response hydration; do not attach read-pagination parameters to mutation requests.
- Event publishing has no application-level dead-letter or terminal attempt limit. A poison or persistently unavailable event can block later sequence values for that conversation.
- Event production and successful broker publication, headers, ordering, retry, and no-backfill behavior do not yet have end-to-end conformance tests against AsyncAPI.
- Integration coverage confirms credential separation, structured identity validation, role separation, generic rejection, alias preservation, promotion of `V1`-tagged conversations, allowlist revocation behavior, fixed Reply-To base behavior, and token-based inbound routing.
