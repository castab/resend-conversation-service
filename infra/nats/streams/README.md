# JetStream stream configuration

[CONVERSATION_EVENTS.json](CONVERSATION_EVENTS.json) provisions the stream that
`resend-conversation-service` publishes conversation lifecycle events to when
`CONVERSATION_EVENTS_SINKS=nats` is set.

```bash
nats stream add --config infra/nats/streams/CONVERSATION_EVENTS.json
```

The service does not create the stream. It verifies at startup that the stream
exists, that the configured subject resolves to it, and that JetStream is
reachable — then refuses to start if any of that fails. Provision the stream
first.

## These values are suggestions

The limits in this file are deliberately conservative starting points for a
lightweight deployment. They are **not** requirements of the service, and they
are not tuned for your traffic, your retention policy, or your NATS instance.
Edit them — either in this file before provisioning, or with
`nats stream edit CONVERSATION_EVENTS` afterwards.

The event payload is small: a schema version, an event type, two UUIDs, a
sequence number, a timestamp, and short non-sensitive cause metadata. It never
carries addresses, subjects, bodies, or raw provider payloads. That is what
makes the defaults below viable at a fraction of a typical event stream's
footprint.

| Field | Default here | What to consider |
| --- | --- | --- |
| `max_age` | 7 days (`604800000000000` ns) | How long a consumer may be down and still catch up without a gap. Raise it if consumers can be offline for longer, or if you want a replayable history. |
| `max_bytes` | 64 MiB | Roughly 64k events at typical payload size. This is the main storage lever; raise it alongside `max_age`. |
| `max_msg_size` | 16 KiB | A hard ceiling, ~20x the largest realistic payload. It exists to catch a runaway event, not to shape normal traffic. |
| `duplicate_window` | 1 hour (`3600000000000` ns) | **Has a real lower bound.** The publisher sets `Nats-Msg-Id` to the event id and retries a failed delivery with a backoff that tops out at 300s, on a 30s lease. Anything below a few minutes lets a retried publish through as a duplicate. Costs very little memory — do not shrink this to save space. |
| `num_replicas` | 1 | Assumes a single-node NATS. On a cluster, raise it to 3 (or 5) so the stream survives a node loss. |
| `storage` | `file` | Events are meant to survive a broker restart. `memory` will lose them. |
| `discard` | `old` | Under pressure the stream drops the oldest events rather than rejecting new publishes, which would otherwise stall the service's outbox. |
| `deny_delete` / `deny_purge` | `true` | Deliberate for an append-only audit feed: no consumer or operator API call can erase history. Retention still expires messages normally through `max_age` and `max_bytes`. |
| `allow_rollup_hdrs` | `false` | There is no rollup use case here; leaving it off prevents a single message from collapsing the stream. |

## Subject

The stream captures one literal subject, `conversation.events.v1`. All seven
event types publish to it — the type is carried in the payload's `type` field
rather than in the subject — so a `>` wildcard would buy nothing and would let
unrelated publishers write into this stream.

Consumers filter and fan out on `type` from the payload. See the AsyncAPI
contract at `GET /asyncapi.json` for the full event schemas.

## Keep these aligned

- The stream's `name` must match `CONVERSATION_EVENTS_NATS_STREAM` in the
  deployment. If you rename the stream, rename it in both places.
- `subjects` must contain whatever `CONVERSATION_EVENTS_NATS_SUBJECT` is set to.
  The service resolves the configured subject through JetStream and fails
  startup if it belongs to a different stream.
- Both must stay consistent with `public/asyncapi.json`.
