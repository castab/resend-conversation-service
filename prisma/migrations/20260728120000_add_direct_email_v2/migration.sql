CREATE TYPE "EmailMessageKind" AS ENUM ('CONVERSATION', 'DIRECT');

ALTER TABLE "email_messages"
ADD COLUMN "kind" "EmailMessageKind" NOT NULL DEFAULT 'CONVERSATION',
ADD COLUMN "to_name" TEXT,
ALTER COLUMN "conversation_id" DROP NOT NULL;

ALTER TABLE "email_messages"
ADD CONSTRAINT "email_messages_kind_shape_check"
CHECK (
  (
    "kind" = 'CONVERSATION'
    AND "conversation_id" IS NOT NULL
  )
  OR
  (
    "kind" = 'DIRECT'
    AND "conversation_id" IS NULL
    AND "direction" = 'OUTBOUND'
    AND "state" <> 'RECEIVED'
    AND "parent_message_id" IS NULL
    AND "internet_message_id" IS NULL
    AND "in_reply_to_internet_message_id" IS NULL
    AND COALESCE(cardinality("reference_internet_message_ids"), 0) = 0
    AND "reply_to_address" IS NULL
    AND "reply_to_name" IS NULL
  )
) NOT VALID;
