CREATE TYPE "ConversationEventType" AS ENUM (
  'CREATED', 'MESSAGE_RECEIVED', 'MESSAGE_OUTBOUND_INTENDED',
  'STATE_CHANGED', 'ASSIGNED', 'MESSAGE_DELIVERY_UPDATED', 'MERGED'
);

CREATE TYPE "ConversationEventSink" AS ENUM ('NATS');

ALTER TABLE "email_conversations"
  ADD COLUMN "event_sequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "conversation_events" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "conversation_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "ConversationEventType" NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_event_deliveries" (
  "event_id" UUID NOT NULL,
  "sink" "ConversationEventSink" NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_until" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_event_deliveries_pkey" PRIMARY KEY ("event_id", "sink"),
  CONSTRAINT "conversation_event_deliveries_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "conversation_events"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "conversation_events_conversation_sequence_key"
  ON "conversation_events"("conversation_id", "sequence");
CREATE INDEX "idx_conversation_events_created"
  ON "conversation_events"("created_at", "id");
CREATE INDEX "idx_conversation_event_deliveries_ready"
  ON "conversation_event_deliveries"("sink", "next_attempt_at", "lease_until", "event_id");
