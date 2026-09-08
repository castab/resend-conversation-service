import {
  attachmentIngestRuntimeHealthy,
  attachmentsEnabled,
} from '@/lib/attachments';
import { conversationEventRuntimeHealthy } from '@/lib/conversation-event-runtime';
import { getPrismaClient } from '@/lib/database';
import { isValidReplyToBaseAddress } from '@/lib/email';
import { resolveEmailV2ApiKey } from '@/lib/environment';

function attachmentStorageConfigured() {
  if (!attachmentsEnabled()) {
    return true;
  }
  return Boolean(
    process.env.ATTACHMENTS_S3_BUCKET &&
      process.env.ATTACHMENTS_S3_REGION &&
      process.env.ATTACHMENTS_S3_ACCESS_KEY_ID &&
      process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY,
  );
}

export async function GET(request: Request) {
  if (new URL(request.url).search) {
    return Response.json(
      { error: 'Health check does not accept query parameters' },
      { status: 400 },
    );
  }
  if (
    !process.env.DATABASE_URL ||
    !process.env.RESEND_API_KEY ||
    !process.env.RESEND_WEBHOOK_SECRET ||
    !process.env.RESEND_REPLY_TO ||
    !isValidReplyToBaseAddress(process.env.RESEND_REPLY_TO) ||
    !resolveEmailV2ApiKey() ||
    !process.env.OUTBOX_DRAIN_API_KEY ||
    !conversationEventRuntimeHealthy() ||
    !attachmentStorageConfigured() ||
    !attachmentIngestRuntimeHealthy()
  ) {
    return Response.json({ status: 'unhealthy' }, { status: 503 });
  }

  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok' });
  } catch {
    return Response.json({ status: 'unhealthy' }, { status: 503 });
  }
}
