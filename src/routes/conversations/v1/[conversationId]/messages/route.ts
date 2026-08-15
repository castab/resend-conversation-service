import {
  authorize,
  isUuid,
  readJson,
  sendResultResponse,
  serializeMessage,
} from '@/lib/api';
import {
  deliverPendingMessage,
  ensureInternetMessageId,
  recoverPendingMessage,
} from '@/lib/conversation-service';
import { getPrismaClient, Prisma } from '@/lib/database';
import {
  buildConversationReplyTo,
  buildReferences,
  createReplySubject,
  hashSendRequest,
  isValidReplyToBaseAddress,
  markConversationAwaitingParticipant,
  parseAddress,
} from '@/lib/email';
import { validateMessageBody } from '@/lib/send-validation';

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
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
  const validation = validateMessageBody(parsed.value);
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();
  const client = getPrismaClient();
  const requestHash = hashSendRequest({ conversationId, ...validation.value });
  const existing = await client.emailMessage.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (
      existing.requestHash !== requestHash ||
      existing.conversationId !== conversationId
    ) {
      return Response.json(
        { error: 'Idempotency key was already used for a different request' },
        { status: 409 },
      );
    }
    const recovered = await recoverPendingMessage(client, existing.id);
    return sendResultResponse(recovered, conversationId);
  }

  const conversation = await client.emailConversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  if (conversation.apiVersion === 'V2') {
    return Response.json(
      { error: 'Conversation requires API v2' },
      { status: 409 },
    );
  }

  const parent = validation.value.replyToMessageId
    ? await client.emailMessage.findFirst({
        where: {
          id: validation.value.replyToMessageId,
          conversationId,
        },
      })
    : await client.emailMessage.findFirst({
        where: {
          conversationId,
          state: { in: ['RECEIVED', 'ACCEPTED'] },
        },
        orderBy: [{ emailCreatedAt: 'desc' }, { id: 'desc' }],
      });
  if (!parent) {
    return Response.json({ error: 'Reply parent not found' }, { status: 404 });
  }

  let parentInternetMessageId: string | null;
  try {
    parentInternetMessageId = await ensureInternetMessageId(client, parent.id);
  } catch (error) {
    console.error(
      'Failed to retrieve reply parent metadata:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return Response.json(
      { error: 'Reply parent threading metadata is unavailable' },
      { status: 503 },
    );
  }
  if (!parentInternetMessageId) {
    return Response.json(
      { error: 'Reply parent threading metadata is unavailable' },
      { status: 409 },
    );
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
  const from = parseAddress(configuredFrom);
  const replyToBaseAddress =
    conversation.replyToBaseAddress ?? configuredReplyTo.trim().toLowerCase();
  const replyToAddress = buildConversationReplyTo(
    replyToBaseAddress,
    conversation.routingToken,
  );
  const references = buildReferences(
    parent.referenceInternetMessageIds,
    parentInternetMessageId,
  );
  const now = new Date();

  let pending;
  try {
    pending = await client.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text
      `;
      const current = await transaction.emailConversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      if (current.apiVersion === 'V2') {
        throw new Error('CONVERSATION_REQUIRES_V2');
      }
      const message = await transaction.emailMessage.create({
        data: {
          conversationId,
          parentMessageId: parent.id,
          direction: 'OUTBOUND',
          state: 'PENDING',
          deliveryState: 'UNKNOWN',
          inReplyToInternetMessageId: parentInternetMessageId,
          referenceInternetMessageIds: references,
          fromAddress: from.address,
          fromName: from.name,
          toAddress: conversation.participantAddress,
          replyToAddress,
          replyToName: validation.value.replyToName ?? null,
          subject: createReplySubject(conversation.subject),
          textBody: validation.value.text,
          htmlBody: validation.value.html,
          emailCreatedAt: now,
          idempotencyKey,
          requestHash,
        },
      });
      await transaction.$executeRaw`
        UPDATE email_conversations
        SET api_version = 'V1',
            reply_to_base_address = COALESCE(reply_to_base_address, ${replyToBaseAddress}),
            reply_to_requires_allowlist = false,
            last_message_at = GREATEST(last_message_at, ${now}),
            updated_at = now()
        WHERE id = ${conversationId}::uuid
      `;
      await markConversationAwaitingParticipant(
        transaction,
        conversationId,
        now,
      );
      return message;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'CONVERSATION_REQUIRES_V2'
    ) {
      return Response.json(
        { error: 'Conversation requires API v2' },
        { status: 409 },
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const raced = await client.emailMessage.findUnique({
        where: { idempotencyKey },
      });
      if (
        raced &&
        raced.requestHash === requestHash &&
        raced.conversationId === conversationId
      ) {
        const recovered = await recoverPendingMessage(client, raced.id);
        return sendResultResponse(recovered, conversationId);
      }
      return Response.json(
        { error: 'Idempotency key is already in use' },
        { status: 409 },
      );
    }
    throw error;
  }

  try {
    const message = await deliverPendingMessage(client, pending.id);
    return Response.json(
      { conversationId, message: serializeMessage(message) },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      'Failed to send conversation reply:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    const message = await client.emailMessage.findUniqueOrThrow({
      where: { id: pending.id },
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
