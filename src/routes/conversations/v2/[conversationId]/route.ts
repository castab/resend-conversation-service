import {
  authorizeEmailV2,
  getConversationResponse,
  isHeaderSafeText,
  isRecord,
  isUuid,
  MAX_TITLE_LENGTH,
  readJson,
} from '@/lib/api';
import { appendConversationEvent } from '@/lib/conversation-events';
import { getPrismaClient, Prisma } from '@/lib/database';

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();
  return getConversationResponse(request, { id: conversationId });
}

export async function PATCH(
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
  const topic = validateTopic(parsed.value);
  if ('error' in topic) {
    return Response.json({ error: topic.error }, { status: 400 });
  }
  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();
  const client = getPrismaClient();
  try {
    const assigned = await client.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text
      `;
      const current = await transaction.emailConversation.findUnique({
        where: { id: conversationId },
        select: { topicType: true, externalTopicId: true, apiVersion: true },
      });
      if (
        !current ||
        current.topicType !== null ||
        current.externalTopicId !== null ||
        current.apiVersion === 'V1'
      ) {
        return 0;
      }
      const result = await transaction.emailConversation.updateMany({
        where: {
          id: conversationId,
          topicType: null,
          externalTopicId: null,
          OR: [{ apiVersion: null }, { apiVersion: 'V2' }],
        },
        data: {
          apiVersion: 'V2',
          topicType: topic.value.type,
          externalTopicId: topic.value.externalId,
          title: topic.value.title,
        },
      });
      if (result.count) {
        await appendConversationEvent(transaction, {
          conversationId,
          type: 'ASSIGNED',
          occurredAt: new Date(),
          actor: 'operator',
          cause: 'topic_assignment',
        });
      }
      return result.count;
    });
    if (assigned === 0) {
      const existing = await client.emailConversation.findUnique({
        where: { id: conversationId },
      });
      return Response.json(
        {
          error: existing
            ? 'Conversation is already assigned to a topic'
            : 'Conversation not found',
        },
        { status: existing ? 409 : 404 },
      );
    }
    return getConversationResponse(request, { id: conversationId });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return Response.json(
        { error: 'A conversation already exists for this topic' },
        { status: 409 },
      );
    }
    throw error;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();
  const client = getPrismaClient();

  const deleted = await client.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text
    `;
    const current = await transaction.emailConversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!current) {
      return false;
    }

    const event = await appendConversationEvent(transaction, {
      conversationId,
      type: 'DELETED',
      occurredAt: new Date(),
      actor: 'operator',
      cause: 'manual_delete',
    });
    await transaction.conversationEvent.deleteMany({
      where: {
        conversationId,
        ...(event ? { id: { not: event.id } } : {}),
      },
    });
    await transaction.emailConversation.delete({
      where: { id: conversationId },
    });
    return true;
  });

  if (!deleted) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

function validateTopic(
  value: unknown,
):
  | { value: { type: string; externalId: string; title: string } }
  | { error: string } {
  if (!isRecord(value) || !isRecord(value.topic)) {
    return { error: 'topic is required' };
  }
  const topic = value.topic;
  if (
    typeof topic.type !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(topic.type) ||
    typeof topic.externalId !== 'string' ||
    !topic.externalId ||
    topic.externalId.length > 255 ||
    !isHeaderSafeText(topic.title, MAX_TITLE_LENGTH) ||
    !topic.title.trim()
  ) {
    return { error: 'topic type, externalId, and title are invalid' };
  }
  return {
    value: {
      type: topic.type,
      externalId: topic.externalId,
      title: topic.title.trim(),
    },
  };
}
