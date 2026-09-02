import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type EmailConversation,
  type EmailMessage,
  getPrismaClient,
  type Prisma,
} from '@/lib/database';
import {
  buildConversationReplyTo,
  serializeConversationState,
} from '@/lib/email';
import { resolveEmailV2ApiKey } from '@/lib/environment';
import { logEvent } from '@/lib/logger';

export function authorizeEmailV2(request: Request): Response | null {
  return authorizeWithCredential(
    request,
    resolveEmailV2ApiKey(),
    'EMAIL_v2_API_KEY or EMAIL_V2_API_KEY',
  );
}

export function authorizeOutboxDrain(request: Request): Response | null {
  return authorizeWithCredential(
    request,
    process.env.OUTBOX_DRAIN_API_KEY,
    'OUTBOX_DRAIN_API_KEY',
  );
}

function authorizeWithCredential(
  request: Request,
  expected: string | undefined,
  variableName: string,
): Response | null {
  if (!expected) {
    logEvent('error', 'api_credential_configuration_missing', {
      credential: variableName,
    });
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.match(/^Bearer[ ]+(\S+)$/i)?.[1] ?? '';
  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();

  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  return null;
}

export async function readJson(
  request: Request,
): Promise<{ value: unknown } | { response: Response }> {
  try {
    return { value: await request.json() };
  } catch {
    return {
      response: Response.json(
        { error: 'Request body must be valid JSON' },
        { status: 400 },
      ),
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_TITLE_LENGTH = 255;
export const MAX_SUBJECT_LENGTH = 255;
export const MAX_NAME_LENGTH = 256;
export const MAX_BODY_LENGTH = 1_048_576;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isHeaderSafeText(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    !containsControlCharacter(value)
  );
}

export function isEmailAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function serializeMessage(message: EmailMessage) {
  return {
    id: message.id,
    parentMessageId: message.parentMessageId,
    direction: message.direction.toLowerCase(),
    state: message.state.toLowerCase(),
    stateDetail: message.stateDetail,
    deliveryState:
      message.direction === 'OUTBOUND'
        ? (message.deliveryState ?? 'UNKNOWN').toLowerCase()
        : null,
    deliveryStateDetail:
      message.direction === 'OUTBOUND' ? message.deliveryStateDetail : null,
    deliveredAt:
      message.direction === 'OUTBOUND'
        ? (message.deliveredAt?.toISOString() ?? null)
        : null,
    resendEmailId: message.resendEmailId,
    internetMessageId: message.internetMessageId,
    from: {
      address: message.fromAddress,
      name: message.fromName,
    },
    to: message.toAddress,
    replyTo: message.replyToAddress,
    replyToName: message.replyToName,
    subject: message.subject,
    text: message.textBody,
    html: message.htmlBody,
    createdAt: message.emailCreatedAt.toISOString(),
  };
}

export function serializeConversation(
  conversation: EmailConversation,
  messages: EmailMessage[],
  hasMoreBefore = false,
) {
  return {
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
    replyToAddress: buildConversationReplyTo(
      conversation.replyToBaseAddress ?? process.env.RESEND_REPLY_TO ?? '',
      conversation.routingToken,
    ),
    state: serializeConversationState(conversation.state),
    stateChangedAt: conversation.stateChangedAt.toISOString(),
    awaitingReply: conversation.state === 'AWAITING_US',
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    messages: messages.map(serializeMessage),
    page: {
      hasMoreBefore,
      before: hasMoreBefore ? (messages[0]?.id ?? null) : null,
    },
  };
}

export function sendResultResponse(
  message: EmailMessage,
  conversationId: string,
) {
  const failed =
    message.state === 'FAILED' || message.state === 'INDETERMINATE';
  return Response.json(
    {
      ...(failed ? { error: 'Email was not confirmed as sent' } : {}),
      conversationId,
      message: serializeMessage(message),
    },
    {
      status: failed ? 502 : message.state === 'PENDING' ? 202 : 200,
    },
  );
}

export function getPageLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get('limit');
  if (!value) {
    return 50;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

export async function getConversationResponse(
  request: Request,
  where: Prisma.EmailConversationWhereUniqueInput,
) {
  const client = getPrismaClient();
  const conversation = await client.emailConversation.findUnique({ where });
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const limit = getPageLimit(request);
  const beforeId = new URL(request.url).searchParams.get('before');
  if (beforeId && !isUuid(beforeId)) {
    return Response.json({ error: 'Invalid message cursor' }, { status: 400 });
  }
  const before = beforeId
    ? await client.emailMessage.findFirst({
        where: { id: beforeId, conversationId: conversation.id },
      })
    : null;
  if (beforeId && !before) {
    return Response.json({ error: 'Invalid message cursor' }, { status: 400 });
  }

  const messages = await client.emailMessage.findMany({
    where: {
      conversationId: conversation.id,
      ...(before
        ? {
            OR: [
              { emailCreatedAt: { lt: before.emailCreatedAt } },
              { emailCreatedAt: before.emailCreatedAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ emailCreatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMoreBefore = messages.length > limit;
  const page = messages.slice(0, limit).reverse();
  return Response.json(
    serializeConversation(conversation, page, hasMoreBefore),
  );
}
