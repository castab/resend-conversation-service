import { createConversationV2 } from '@/lib/conversation-v2';

export async function POST(request: Request) {
  return createConversationV2(request, true);
}
