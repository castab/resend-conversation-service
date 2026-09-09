-- CreateEnum
CREATE TYPE "EmailAttachmentState" AS ENUM ('PENDING', 'STORED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailAttachmentSource" AS ENUM ('INBOUND', 'UPLOAD');

-- CreateEnum
CREATE TYPE "EmailAttachmentDisposition" AS ENUM ('ATTACHMENT', 'INLINE');

-- CreateTable
CREATE TABLE "email_attachments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID,
    "source" "EmailAttachmentSource" NOT NULL,
    "state" "EmailAttachmentState" NOT NULL DEFAULT 'PENDING',
    "state_detail" TEXT,
    "filename" VARCHAR(512) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "content_disposition" "EmailAttachmentDisposition" NOT NULL DEFAULT 'ATTACHMENT',
    "content_id" VARCHAR(255),
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64),
    "storage_key" VARCHAR(1024) NOT NULL,
    "resend_email_id" TEXT,
    "resend_attachment_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_attachment_outbox_entries" (
    "message_id" UUID NOT NULL,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "first_attempt_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_attachment_outbox_entries_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "stored_object_tombstones" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "storage_key" VARCHAR(1024) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "stored_object_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_attachments_storage_key_key" ON "email_attachments"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "email_attachments_resend_attachment_key" ON "email_attachments"("resend_email_id", "resend_attachment_id");

-- CreateIndex
CREATE INDEX "idx_email_attachments_message" ON "email_attachments"("message_id", "id");

-- CreateIndex
CREATE INDEX "idx_email_attachments_ready" ON "email_attachments"("state", "next_attempt_at", "lease_until", "id");

-- CreateIndex
CREATE INDEX "idx_email_attachments_unreferenced" ON "email_attachments"("source", "message_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_attachment_outbox_entries_ready" ON "email_attachment_outbox_entries"("next_attempt_at", "lease_until", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "stored_object_tombstones_storage_key_key" ON "stored_object_tombstones"("storage_key");

-- CreateIndex
CREATE INDEX "idx_stored_object_tombstones_ready" ON "stored_object_tombstones"("next_attempt_at", "lease_until", "id");

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachment_outbox_entries" ADD CONSTRAINT "email_attachment_outbox_entries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Stored objects outlive their database rows. Every delete path for an
-- attachment row -- including the ON DELETE CASCADE that runs inside PostgreSQL
-- when a conversation is removed -- must leave behind a tombstone so the
-- reaper can remove the object from S3. A trigger is the only place that sees
-- every one of those paths; no application call site observes a cascade.
CREATE FUNCTION email_attachments_tombstone() RETURNS trigger AS $$
BEGIN
  INSERT INTO stored_object_tombstones ("storage_key")
  VALUES (OLD."storage_key")
  ON CONFLICT ("storage_key") DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_attachments_tombstone_before_delete
BEFORE DELETE ON "email_attachments"
FOR EACH ROW EXECUTE FUNCTION email_attachments_tombstone();
