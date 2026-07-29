import {
  authorize,
  getPageLimit,
  isUuid,
  readJson,
  sendResultResponse,
  serializeMessage,
} from '@/lib/api';
import {
  deliverPendingMessage,
  recoverPendingMessage,
} from '@/lib/conversation-service';
import { getPrismaClient, Prisma, type PrismaClient } from '@/lib/database';
import {
  buildConversationReplyTo,
  createRoutingToken,
  hashSendRequest,
  isValidReplyToBaseAddress,
  normalizeSubject,
  parseAddress,
} from '@/lib/email';
import { validateCreateBody } from '@/lib/send-validation';

export async function POST(request: Request) {
  const unauthorized = authorize(request);
  if (unauthorized) {
    return unauthorized;
  }

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length > 256) {
    return Response.json(
      { error: 'A valid Idempotency-Key header is required' },
      { status: 400 },
    );
  }

  const parsed = await readJson(request);
  if ('response' in parsed) {
    return parsed.response;
  }
  const validation = validateCreateBody(parsed.value);
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const configuredFrom = process.env.RESEND_FROM;
  const configuredReplyTo = process.env.RESEND_REPLY_TO;
  if (
    !configuredFrom ||
    !configuredReplyTo ||
    !isValidReplyToBaseAddress(configuredReplyTo)
  ) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const client = getPrismaClient();
  const requestHash = hashSendRequest(validation.value);
  const existing = await client.emailMessage.findUnique({
    where: { idempotencyKey },
    include: { conversation: true },
  });
  if (existing) {
    if (
      existing.kind !== 'CONVERSATION' ||
      !existing.conversationId ||
      existing.requestHash !== requestHash
    ) {
      return Response.json(
        { error: 'Idempotency key was already used for a different request' },
        { status: 409 },
      );
    }
    const recovered = await recoverPendingMessage(client, existing.id);
    return sendResultResponse(recovered, existing.conversationId);
  }

  const from = parseAddress(configuredFrom);
  const subject = normalizeSubject(
    validation.value.subject ?? validation.value.topic.title,
  );
  const now = new Date();
  const routingToken = createRoutingToken();
  const replyToAddress = buildConversationReplyTo(
    configuredReplyTo,
    routingToken,
  );

  let created;
  try {
    created = await client.emailConversation.create({
      data: {
        routingToken,
        apiVersion: 'V1',
        topicType: validation.value.topic.type,
        externalTopicId: validation.value.topic.externalId,
        title: validation.value.topic.title,
        subject,
        participantAddress: validation.value.participant.email,
        participantName: validation.value.participant.name,
        replyToBaseAddress: configuredReplyTo.trim().toLowerCase(),
        replyToRequiresAllowlist: false,
        lastMessageAt: now,
        messages: {
          create: {
            direction: 'OUTBOUND',
            state: 'PENDING',
            deliveryState: 'UNKNOWN',
            fromAddress: from.address,
            fromName: from.name,
            toAddress: validation.value.participant.email,
            replyToAddress,
            replyToName: validation.value.message.replyToName ?? null,
            subject,
            textBody: validation.value.message.text,
            htmlBody: validation.value.message.html,
            emailCreatedAt: now,
            idempotencyKey,
            requestHash,
          },
        },
      },
      include: { messages: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const raced = await client.emailMessage.findUnique({
        where: { idempotencyKey },
      });
      if (raced) {
        if (
          raced.kind !== 'CONVERSATION' ||
          !raced.conversationId ||
          raced.requestHash !== requestHash
        ) {
          return Response.json(
            {
              error: 'Idempotency key was already used for a different request',
            },
            { status: 409 },
          );
        }
        const recovered = await recoverPendingMessage(client, raced.id);
        return sendResultResponse(recovered, raced.conversationId);
      }

      let reopened: { conversationId: string; messageId: string } | null;
      try {
        reopened = await reopenFailedTopicConversation(client, {
          value: validation.value,
          from,
          subject,
          idempotencyKey,
          requestHash,
          configuredReplyTo,
        });
      } catch (reopenError) {
        if (
          reopenError instanceof Prisma.PrismaClientKnownRequestError &&
          reopenError.code === 'P2002'
        ) {
          const racedReopen = await client.emailMessage.findUnique({
            where: { idempotencyKey },
          });
          if (
            racedReopen?.kind === 'CONVERSATION' &&
            racedReopen.conversationId &&
            racedReopen.requestHash === requestHash
          ) {
            const recovered = await recoverPendingMessage(
              client,
              racedReopen.id,
            );
            return sendResultResponse(recovered, racedReopen.conversationId);
          }
          return Response.json(
            { error: 'Idempotency key is already in use' },
            { status: 409 },
          );
        }
        throw reopenError;
      }
      if (reopened) {
        return deliverOpeningMessage(
          client,
          reopened.conversationId,
          reopened.messageId,
        );
      }
      return Response.json(
        { error: 'A conversation already exists for this topic' },
        { status: 409 },
      );
    }
    throw error;
  }

  return deliverOpeningMessage(client, created.id, created.messages[0].id);
}

async function deliverOpeningMessage(
  client: PrismaClient,
  conversationId: string,
  messageId: string,
) {
  try {
    const message = await deliverPendingMessage(client, messageId);
    return Response.json(
      {
        conversationId,
        message: serializeMessage(message),
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      'Failed to send opening conversation email:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    const message = await client.emailMessage.findUniqueOrThrow({
      where: { id: messageId },
    });
    return Response.json(
      {
        error: 'Failed to send email',
        conversationId,
        message: serializeMessage(message),
      },
      { status: 502 },
    );
  }
}

async function reopenFailedTopicConversation(
  client: PrismaClient,
  input: {
    value: {
      topic: { type: string; externalId: string; title: string };
      participant: { email: string; name: string | null };
      message: { text?: string; html?: string; replyToName?: string };
    };
    from: { address: string; name: string | null };
    subject: string;
    idempotencyKey: string;
    requestHash: string;
    configuredReplyTo: string;
  },
): Promise<{ conversationId: string; messageId: string } | null> {
  const conversation = await client.emailConversation.findUnique({
    where: {
      topicType_externalTopicId: {
        topicType: input.value.topic.type,
        externalTopicId: input.value.topic.externalId,
      },
    },
  });
  if (!conversation) {
    return null;
  }

  const now = new Date();
  return client.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${conversation.id}))::text
    `;
    const liveMessage = await transaction.emailMessage.findFirst({
      where: { conversationId: conversation.id, state: { not: 'FAILED' } },
    });
    if (liveMessage) {
      return null;
    }
    const current = await transaction.emailConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    if (current.apiVersion === 'V2') {
      return null;
    }
    const replyToBaseAddress =
      current.replyToBaseAddress ??
      input.configuredReplyTo.trim().toLowerCase();

    await transaction.emailConversation.update({
      where: { id: conversation.id },
      data: {
        apiVersion: 'V1',
        title: input.value.topic.title,
        subject: input.subject,
        participantAddress: input.value.participant.email,
        participantName: input.value.participant.name,
        replyToBaseAddress,
        replyToRequiresAllowlist: false,
        lastMessageAt: now,
      },
    });
    const message = await transaction.emailMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        state: 'PENDING',
        deliveryState: 'UNKNOWN',
        fromAddress: input.from.address,
        fromName: input.from.name,
        toAddress: input.value.participant.email,
        replyToAddress: buildConversationReplyTo(
          replyToBaseAddress,
          conversation.routingToken,
        ),
        replyToName: input.value.message.replyToName ?? null,
        subject: input.subject,
        textBody: input.value.message.text ?? null,
        htmlBody: input.value.message.html ?? null,
        emailCreatedAt: now,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      },
    });
    return { conversationId: conversation.id, messageId: message.id };
  });
}

export async function GET(request: Request) {
  const unauthorized = authorize(request);
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
  const client = getPrismaClient();
  const beforeValue = url.searchParams.get('before');
  const before = beforeValue ? decodeConversationCursor(beforeValue) : null;
  if (beforeValue && !before) {
    return Response.json(
      { error: 'Invalid conversation cursor' },
      { status: 400 },
    );
  }
  const conversations = await client.emailConversation.findMany({
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
