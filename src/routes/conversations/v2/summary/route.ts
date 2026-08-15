import { authorizeEmailV2, getPageLimit, isUuid } from '@/lib/api';
import { type ConversationState, getPrismaClient } from '@/lib/database';
import {
  CONVERSATION_STATE_ERROR,
  CONVERSATION_STATES,
  parseConversationState,
  serializeConversationState,
} from '@/lib/email';

export async function GET(request: Request) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const selected = parseStateFilter(url.searchParams.getAll('state'));
  if (!selected) {
    return Response.json({ error: CONVERSATION_STATE_ERROR }, { status: 400 });
  }

  const beforeValue = url.searchParams.get('before');
  const before = beforeValue ? decodeSummaryCursor(beforeValue) : null;
  if (beforeValue && !before) {
    return Response.json(
      { error: 'Invalid conversation cursor' },
      { status: 400 },
    );
  }

  const limit = getPageLimit(request);
  const client = getPrismaClient();
  const [grouped, conversations] = await Promise.all([
    client.emailConversation.groupBy({
      by: ['state'],
      _count: { _all: true },
    }),
    client.emailConversation.findMany({
      where: {
        state: { in: selected },
        ...(before
          ? {
              OR: [
                { stateChangedAt: { gt: before.stateChangedAt } },
                {
                  stateChangedAt: before.stateChangedAt,
                  id: { gt: before.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ stateChangedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    }),
  ]);

  const counts = Object.fromEntries(
    CONVERSATION_STATES.map((state) => [
      serializeConversationState(state),
      grouped.find((group) => group.state === state)?._count._all ?? 0,
    ]),
  );
  const count = selected.reduce(
    (total, state) => total + counts[serializeConversationState(state)],
    0,
  );

  const hasMore = conversations.length > limit;
  const page = conversations.slice(0, limit);
  return Response.json({
    count,
    counts,
    conversations: page.map((conversation) => ({
      id: conversation.id,
      topic:
        conversation.topicType && conversation.externalTopicId
          ? {
              type: conversation.topicType,
              externalId: conversation.externalTopicId,
              title: conversation.title,
            }
          : null,
      title: conversation.title,
      subject: conversation.subject,
      participant: {
        address: conversation.participantAddress,
        name: conversation.participantName,
      },
      state: serializeConversationState(conversation.state),
      stateChangedAt: conversation.stateChangedAt.toISOString(),
      awaitingReply: conversation.state === 'AWAITING_US',
      lastMessageAt: conversation.lastMessageAt.toISOString(),
    })),
    page: {
      hasMore,
      before: hasMore && page.at(-1) ? encodeSummaryCursor(page.at(-1)!) : null,
    },
  });
}

/** Accepts repeated and comma-separated values; no filter means every state. */
function parseStateFilter(values: string[]): ConversationState[] | null {
  const requested = values.flatMap((value) => value.split(','));
  if (!requested.length) {
    return [...CONVERSATION_STATES];
  }
  const parsed: ConversationState[] = [];
  for (const value of requested) {
    const state = parseConversationState(value);
    if (!state) {
      return null;
    }
    if (!parsed.includes(state)) {
      parsed.push(state);
    }
  }
  return parsed;
}

function encodeSummaryCursor(conversation: {
  id: string;
  stateChangedAt: Date;
}) {
  return Buffer.from(
    JSON.stringify([
      conversation.stateChangedAt.toISOString(),
      conversation.id,
    ]),
  ).toString('base64url');
}

function decodeSummaryCursor(
  value: string,
): { id: string; stateChangedAt: Date } | null {
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
    const stateChangedAt = new Date(parsed[0]);
    return Number.isNaN(stateChangedAt.getTime())
      ? null
      : { stateChangedAt, id: parsed[1] };
  } catch {
    return null;
  }
}
