import { authorizeV2, getPageLimit, isUuid } from '@/lib/api';
import { createConversationV2 } from '@/lib/conversation-v2';
import { getPrismaClient } from '@/lib/database';

export async function POST(request: Request) {
  return createConversationV2(request, false);
}

export async function GET(request: Request) {
  const unauthorized = authorizeV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const url = new URL(request.url);
  if (url.searchParams.get('assignment') !== 'unassigned') {
    return Response.json(
      { error: 'Only assignment=unassigned is supported' },
      { status: 400 },
    );
  }
  const limit = getPageLimit(request);
  const beforeValue = url.searchParams.get('before');
  const before = beforeValue ? decodeConversationCursor(beforeValue) : null;
  if (beforeValue && !before) {
    return Response.json(
      { error: 'Invalid conversation cursor' },
      { status: 400 },
    );
  }
  const conversations = await getPrismaClient().emailConversation.findMany({
    where: {
      topicType: null,
      externalTopicId: null,
      ...(before
        ? {
            OR: [
              { lastMessageAt: { lt: before.lastMessageAt } },
              { lastMessageAt: before.lastMessageAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = conversations.length > limit;
  const page = conversations.slice(0, limit);
  return Response.json({
    conversations: page.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      participant: {
        address: conversation.participantAddress,
        name: conversation.participantName,
      },
      lastMessageAt: conversation.lastMessageAt.toISOString(),
    })),
    page: {
      hasMore,
      before:
        hasMore && page.at(-1) ? encodeConversationCursor(page.at(-1)!) : null,
    },
  });
}

function encodeConversationCursor(conversation: {
  id: string;
  lastMessageAt: Date;
}) {
  return Buffer.from(
    JSON.stringify([conversation.lastMessageAt.toISOString(), conversation.id]),
  ).toString('base64url');
}

function decodeConversationCursor(value: string): {
  id: string;
  lastMessageAt: Date;
} | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !isUuid(parsed[1])
    ) {
      return null;
    }
    const lastMessageAt = new Date(parsed[0]);
    return Number.isNaN(lastMessageAt.getTime())
      ? null
      : { lastMessageAt, id: parsed[1] };
  } catch {
    return null;
  }
}
