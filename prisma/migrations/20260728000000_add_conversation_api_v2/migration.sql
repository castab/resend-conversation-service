CREATE TYPE "EmailApiVersion" AS ENUM ('V1', 'V2');
CREATE TYPE "EmailAddressRole" AS ENUM ('FROM', 'REPLY_TO');

ALTER TABLE "email_conversations"
ADD COLUMN "api_version" "EmailApiVersion",
ADD COLUMN "reply_to_base_address" VARCHAR(320),
ADD COLUMN "reply_to_requires_allowlist" BOOLEAN NOT NULL DEFAULT false;

UPDATE "email_conversations"
SET "api_version" = 'V1'
WHERE "topic_type" IS NOT NULL
  AND "external_topic_id" IS NOT NULL;

WITH "first_outbound" AS (
  SELECT DISTINCT ON ("conversation_id")
    "conversation_id",
    "reply_to_address"
  FROM "email_messages"
  WHERE "direction" = 'OUTBOUND'
    AND "reply_to_address" IS NOT NULL
  ORDER BY "conversation_id", "email_created_at", "id"
)
UPDATE "email_conversations" AS "conversation"
SET "reply_to_base_address" = replace(
  "first_outbound"."reply_to_address",
  '+c_' || replace("conversation"."routing_token"::text, '-', ''),
  ''
)
FROM "first_outbound"
WHERE "first_outbound"."conversation_id" = "conversation"."id";

ALTER TABLE "email_conversations"
ADD CONSTRAINT "email_conversations_allowlisted_reply_to_check"
CHECK (
  NOT "reply_to_requires_allowlist"
  OR "reply_to_base_address" IS NOT NULL
);

CREATE TABLE "email_address_allowlist_entries" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "address" VARCHAR(320) NOT NULL,
  "role" "EmailAddressRole" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_address_allowlist_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_address_allowlist_entries_address_check" CHECK (
    "address" = lower(btrim("address"))
    AND length("address") BETWEEN 3 AND 320
    AND "address" !~ '[[:space:]<>]'
    AND "address" ~ '^[^@]+@[^@]+\.[^@]+$'
  )
);

CREATE UNIQUE INDEX "email_address_allowlist_entries_address_role_key"
ON "email_address_allowlist_entries"("address", "role");

CREATE TABLE "email_conversation_routing_aliases" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "conversation_id" UUID NOT NULL,
  "routing_token" UUID NOT NULL,
  "base_address" VARCHAR(320) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_conversation_routing_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_conversation_routing_aliases_conversation_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "email_conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "email_conversation_routing_aliases_token_base_key"
ON "email_conversation_routing_aliases"("routing_token", "base_address");

CREATE INDEX "idx_email_conversation_routing_aliases_conversation"
ON "email_conversation_routing_aliases"("conversation_id");
