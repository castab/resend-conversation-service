import { authorizeEmailV2, getConversationResponse } from '@/lib/api';

export async function GET(
  request: Request,
  context: {
    params: Promise<{ topicType: string; externalTopicId: string }>;
  },
) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { topicType, externalTopicId } = await context.params;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(topicType) || !externalTopicId) {
    return Response.json({ error: 'Invalid topic identity' }, { status: 400 });
  }
  return getConversationResponse(request, {
    topicType_externalTopicId: { topicType, externalTopicId },
  });
}
