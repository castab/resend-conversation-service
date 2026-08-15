CREATE TYPE "ConversationState" AS ENUM (
  'AWAITING_US',
  'AWAITING_PARTICIPANT',
  'CONCLUDED',
  'TERMINATED'
);

-- Backfill: every conversation that existed before this migration is set to
-- AWAITING_PARTICIPANT, that is, not awaiting a reply from us. The column
-- default supplies that value for all pre-existing rows; only inbound mail
-- received after this migration moves a conversation to AWAITING_US.
ALTER TABLE "email_conversations"
ADD COLUMN "state" "ConversationState" NOT NULL DEFAULT 'AWAITING_PARTICIPANT',
ADD COLUMN "state_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

UPDATE "email_conversations"
SET "state_changed_at" = "last_message_at";

CREATE INDEX "idx_email_conversations_state"
ON "email_conversations" ("state", "state_changed_at", "id");
