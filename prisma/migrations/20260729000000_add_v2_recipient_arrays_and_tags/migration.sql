ALTER TABLE "email_messages"
ADD COLUMN "to_recipients" JSONB,
ADD COLUMN "tags" JSONB;

UPDATE "email_messages"
SET "to_recipients" = jsonb_build_array(
  jsonb_build_object(
    'address', "to_address",
    'name', "to_name"
  )
)
WHERE "to_recipients" IS NULL;
