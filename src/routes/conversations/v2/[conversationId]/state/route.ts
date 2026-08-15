import {
  authorizeEmailV2,
  getConversationResponse,
  isRecord,
  isUuid,
  readJson,
} from '@/lib/api';
import { type ConversationState, getPrismaClient } from '@/lib/database';
import { CONVERSATION_STATE_ERROR, parseConversationState } from '@/lib/email';

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const parsed = await readJson(request);
  if ('response' in parsed) {
    return parsed.response;
  }
  const state = validateState(parsed.value);
  if (!state) {
    return Response.json({ error: CONVERSATION_STATE_ERROR }, { status: 400 });
  }

  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();
  const client = getPrismaClient();

  const updated = await client.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text
    `;
    return transaction.emailConversation.updateMany({
      where: { id: conversationId },
      data: { state, stateChangedAt: new Date() },
    });
  });
  if (updated.count === 0) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return getConversationResponse(request, { id: conversationId });
}

function validateState(value: unknown): ConversationState | null {
  if (!isRecord(value)) {
    return null;
  }
  return parseConversationState(value.state);
}
