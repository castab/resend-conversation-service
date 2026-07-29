import { createMessageV2 } from '@/lib/conversation-v2';

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  return createMessageV2(request, context, false);
}
