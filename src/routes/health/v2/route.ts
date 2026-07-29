import { getPrismaClient } from '@/lib/database';
import { isValidReplyToBaseAddress } from '@/lib/email';

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
    !process.env.RESEND_FROM ||
    !process.env.RESEND_REPLY_TO ||
    !isValidReplyToBaseAddress(process.env.RESEND_REPLY_TO) ||
    !process.env.CONVERSATION_API_KEY ||
    !process.env.EMAIL_v2_API_KEY ||
    !process.env.OUTBOX_DRAIN_API_KEY
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
