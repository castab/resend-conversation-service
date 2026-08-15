# ADR-0001: Per-conversation Reply-To routing tokens

- **Status:** Accepted
- **Date:** 2026-07-24
- **Amended:** 2026-07-28
- **Applies to:** inbound email → conversation association (threading)

## TL;DR

Outbound conversation emails are sent with a Reply-To address that looks like a
mailbox with a random key in it:

```
bookings+c_cb208a4f1e5e46c39f50d1f84d8b5867@mail-dev.fionasicecream.com
```

That `+c_<32 hex>` suffix is **not a mailbox** — it is a per-conversation *routing
token* carried by [plus-addressing (subaddressing)](https://en.wikipedia.org/wiki/Email_address#Subaddressing).
It exists as a **fallback** so we can still attach an inbound reply to the correct
conversation when standard RFC 5322 header threading fails. We keep it because the
alternative that would remove it — assigning our own RFC `Message-ID` — **does not
work with Resend**, as proven by a live test (see [Rejected alternative](#rejected-alternative-self-assigned-message-id)).

## Context

This service threads a conversation between the business and a single external
participant (the customer). When an inbound email arrives via the Resend webhook, we
must decide **which existing conversation it belongs to**, or start a new one.

We resolve that with a precedence chain in
[`projectInboundEmail`](../src/lib/email/conversations.ts):

1. **RFC header threading (primary).** Match the inbound `In-Reply-To` / `References`
   ancestry against the `internetMessageId` of messages we have already stored,
   scoped to the same participant address, preferring a conversation that is already
   assigned to a topic.
2. **Waiting-children recovery.** Handle the race where a reply arrives before we have
   learned our own outbound `Message-ID` (see below).
3. **Routing token (fallback).** If nothing above matched, look up the conversation by
   the `+c_<token>` value parsed out of the inbound `To` / `received_for` addresses —
   but only if it resolves to exactly one conversation **and** the participant address
   matches (a guard so a leaked/guessed token cannot cross-link another sender).
4. **New conversation.** Otherwise create one, keyed on normalized subject + sender.

The routing token is deliberately the **third** choice, not the first. Header threading
is the primary mechanism and matches Resend's own recommendation.

### Why header threading is not sufficient on its own

Reliable header threading requires that, when a customer replies, their mail client's
`In-Reply-To` points at the `Message-ID` of a message **we sent and recorded**. Two
things break that:

- **Some clients strip or mangle** `In-Reply-To` / `References`.
- **We do not know our outbound `Message-ID` at send time.** Resend's send API returns
  only its own internal `id`, not the RFC `Message-ID`. We learn the real `Message-ID`
  only *after* the fact by calling `getSent()` and back-filling it — the "hydration"
  logic in [`conversation-service.ts`](../src/lib/conversation-service.ts) and
  [`conversations.ts`](../src/lib/email/conversations.ts). A reply can arrive during
  that window, referencing a `Message-ID` we have not stored yet.

The routing token is immune to both: it is chosen by us, embedded in the address the
customer replies *to*, and echoed back verbatim by every mail client regardless of how
they treat threading headers.

## Decision

Keep a per-conversation routing token, embedded via plus-addressing in the outbound
Reply-To, as a fallback matcher behind RFC header threading.

### Amendment: V1 and V2 identity selection

The routing-token decision now applies to two conversation API contracts:

- **V1 was the frozen legacy contract.** The Reply-To base came from
  `RESEND_REPLY_TO`, and the From identity came from `RESEND_FROM`. Superseded
  by the 0.5.0 amendment below.
- **V2 is the forward contract.** Each send or enqueue request supplies
  structured `from` and `replyTo` identities. Their addresses are canonicalized
  to lowercase and must exactly match role-specific `FROM` and `REPLY_TO` rows
  in the database allowlist. Display names do not grant address authority, and
  a distinct mailbox alias requires its own exact allowlist row. There is no
  allowlist management API.

The first outbound intent fixes `EmailConversation.replyToBaseAddress`. Every
outbound message for that conversation combines this fixed base with the
existing `routingToken`; V2 cannot rotate the base by supplying a different
allowed address. This preserves one stable routing address for replies.

An authorized V2 reply can promote a `V1`-tagged conversation when it supplies
the same fixed Reply-To base. Promotion occurs when the V2 intent is
successfully persisted, before a synchronous provider call; provider acceptance
is not required, and a subsequent `502` does not roll promotion back. Promotion
is one-way: a conversation is never demoted to `V1`.

### Amendment: V1 retirement (0.5.0, 2026-08-15)

The V1 conversation API was removed. `/api/conversations/v1` and everything
under it are no longer routed, and `CONVERSATION_API_KEY` and `RESEND_FROM` are
no longer read. This does not change the routing-token decision itself.

`RESEND_REPLY_TO` is retained, and its role is now narrower: it is the Reply-To
base used to validate inbound routing tokens, not a source of outbound identity.
Outbound identities come exclusively from allowlisted caller-supplied `from` and
`replyTo` values.

Conversations created by V1 keep `apiVersion = V1` and their fixed Reply-To
base. They remain readable and writable through V2, and the one-way promotion
described above still applies to them. No migration back-fills their
`apiVersion`, because the fixed base — not the version tag — is what governs
routing.

Inbound out-of-order recovery can discover that multiple conversation rows
represent one conversation. Reconciliation never loses one-way V2 promotion:
if a merged source is V2, the surviving row remains or becomes V2. The
surviving row keeps its already-fixed base. Historical
`(routingToken, replyToBaseAddress)` pairs from merged source rows are retained
as routing aliases so replies to previously emitted addresses continue to
resolve.

The allowlist is checked before new V2 send intent is persisted. Removing a row
therefore blocks later sends and enqueues but does not invalidate an outbox
payload that was already authorized and persisted. Draining that payload does
not re-evaluate the allowlist.

### How it works

- **Generation:** a UUID per conversation, stored as
  `EmailConversation.routingToken` (see [`prisma/schema.prisma`](../prisma/schema.prisma)),
  defaulting to `gen_random_uuid()`.
- **Encoding:** [`buildConversationReplyTo`](../src/lib/email/routing.ts) renders it as
  `<local>+c_<32 hex>@<domain>` (UUID lowercased, dashes stripped). The `c_` tag prefix
  namespaces it; the fixed base mailbox is validated so the generated local-part stays
  within RFC length limits.
- **Parsing:** [`extractRoutingCandidates`](../src/lib/email/routing.ts) pulls the token
  and base mailbox out of inbound recipient addresses, re-inserts the token dashes, and
  matches both values against the conversation's `routingToken` and fixed base.
- **Requirement:** the receiving domain must accept plus-addressed mail to the base
  mailbox (Resend inbound does).

## Rejected alternative: self-assigned Message-ID

The obvious way to delete both the routing token *and* the Message-ID hydration would be
to **generate our own RFC `Message-ID` at send time** (`<uuid@our-domain>`), store it
immediately, and set it via the `headers` param. Then the outbound `Message-ID` would be
known instantly, header threading would be fully reliable, and the token would be
redundant.

**This does not work with Resend.** Resend sends through Amazon SES, and SES **overwrites
the `Message-ID`**. Verified with a live test on 2026-07-24:

- Sent from `booking@mail-dev.fionasicecream.com` with
  `headers: { "Message-ID": "<verify-840afca1-...@mail-dev.fionasicecream.com>" }`.
- The Resend API (`get-email`) reported the sent `message_id` as
  `<0100019f91f4e4c6-...@email.amazonses.com>` — an SES value, **not ours**.
- The customer's Gmail reply carried:

  ```
  In-Reply-To: <0100019f91f4e4c6-...@email.amazonses.com>
  References:  <0100019f91f4e4c6-...@email.amazonses.com>
  ```

  i.e. it referenced the **SES-assigned** id, not the one we set.

Had we stored our self-generated value, every inbound reply would reference an id we
never recorded, and header matching would miss every time. Because SES owns the
`Message-ID` and it is only knowable *after* send, the hydration subsystem is
**required**, and the routing token remains worthwhile as a header-independent fallback.

## Consequences

**Positive**
- Replies still route correctly even when threading headers are absent/mangled or when a
  reply wins the race against Message-ID hydration.
- The token match is guarded (unique + participant-address check), so it cannot be used
  to hijack another participant's conversation.

**Negative / trade-offs**
- Reply-To addresses are opaque and per-conversation, which can look odd to humans and
  must not be treated as real mailboxes.
- The base receiving domain must support plus-addressing.
- It is extra machinery on top of header threading; it is intentionally a fallback, not
  the primary path.

**If Resend ever supports Message-ID passthrough**, revisit this: self-assigned
Message-IDs would let us drop both the token and the hydration logic. Until then, do not
attempt that simplification.

## References

- Code: [`src/lib/email/routing.ts`](../src/lib/email/routing.ts),
  [`src/lib/email/conversations.ts`](../src/lib/email/conversations.ts),
  [`src/lib/conversation-service.ts`](../src/lib/conversation-service.ts)
- Schema: [`prisma/schema.prisma`](../prisma/schema.prisma) (`EmailConversation.routingToken`)
- V2 identity and promotion behavior:
  [`src/lib/conversation-v2.ts`](../src/lib/conversation-v2.ts),
  [`src/lib/database/email-address-allowlist.ts`](../src/lib/database/email-address-allowlist.ts)
- Resend guidance on replying to inbound email:
  https://resend.com/docs/dashboard/receiving/reply-to-emails
