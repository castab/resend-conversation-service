import {
  authorizeEmailV2,
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
import {
  getPrismaClient,
  isEmailAddressAllowed,
  lockAllowedEmailIdentities,
  Prisma,
  type PrismaClient,
} from '@/lib/database';
import {
  buildConversationReplyTo,
  buildReferences,
  createReplySubject,
  createRoutingToken,
  hashSendRequest,
  markConversationAwaitingParticipant,
  normalizeSubject,
} from '@/lib/email';
import {
  type CreateConversationV2Input,
  type MessageV2Input,
  validateCreateV2Body,
  validateMessageV2Body,
} from '@/lib/send-validation';

const IDENTITY_NOT_ALLOWED =
  'The requested email identity is not allowed. Contact the administrator.';

class IdentityNotAllowedError extends Error {}

function identityNotAllowedResponse() {
  return Response.json({ error: IDENTITY_NOT_ALLOWED }, { status: 400 });
}

async function identitiesAreAllowed(
  client: PrismaClient,
  input: { from: { address: string }; replyTo: { address: string } },
) {
  const [fromAllowed, replyToAllowed] = await Promise.all([
    isEmailAddressAllowed(client, input.from.address, 'FROM'),
    isEmailAddressAllowed(client, input.replyTo.address, 'REPLY_TO'),
  ]);
  return fromAllowed && replyToAllowed;
}

function getIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get('idempotency-key');
  return key && key.length <= 256
    ? key
    : Response.json(
        { error: 'A valid Idempotency-Key header is required' },
        { status: 400 },
      );
}

export async function createConversationV2(request: Request, queued: boolean) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const idempotencyKey = getIdempotencyKey(request);
  if (idempotencyKey instanceof Response) {
    return idempotencyKey;
  }
  const parsed = await readJson(request);
  if ('response' in parsed) {
    return parsed.response;
  }
  const validation = validateCreateV2Body(parsed.value);
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const client = getPrismaClient();
  const requestHash = hashSendRequest({
    operation: queued ? 'outbox-opening-v2' : 'opening-v2',
    request: validation.value,
  });
  const existing = await client.emailMessage.findUnique({
    where: { idempotencyKey },
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
    const message = queued
      ? existing
      : await recoverPendingMessage(client, existing.id);
    return sendResultResponse(message, existing.conversationId);
  }

  if (!(await identitiesAreAllowed(client, validation.value.message))) {
    return identityNotAllowedResponse();
  }

  const subject = normalizeSubject(
    validation.value.subject ?? validation.value.topic.title,
  );
  const now = new Date();
  const routingToken = createRoutingToken();
  let created: { conversationId: string; messageId: string };
  try {
    const conversation = await client.$transaction(async (transaction) => {
      if (
        !(await lockAllowedEmailIdentities(
          transaction,
          validation.value.message.from.address,
          validation.value.message.replyTo.address,
        ))
      ) {
        throw new IdentityNotAllowedError();
      }
      return transaction.emailConversation.create({
        data: {
          routingToken,
          apiVersion: 'V2',
          topicType: validation.value.topic.type,
          externalTopicId: validation.value.topic.externalId,
          title: validation.value.topic.title,
          subject,
          participantAddress: validation.value.participant.email,
          participantName: validation.value.participant.name,
          replyToBaseAddress: validation.value.message.replyTo.address,
          replyToRequiresAllowlist: true,
          lastMessageAt: now,
          messages: {
            create: messageCreateData(
              validation.value,
              subject,
              buildConversationReplyTo(
                validation.value.message.replyTo.address,
                routingToken,
              ),
              now,
              idempotencyKey,
              requestHash,
              queued,
            ),
          },
        },
        include: { messages: true },
      });
    });
    created = {
      conversationId: conversation.id,
      messageId: conversation.messages[0].id,
    };
  } catch (error) {
    if (error instanceof IdentityNotAllowedError) {
      return identityNotAllowedResponse();
    }
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }
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
          { error: 'Idempotency key was already used for a different request' },
          { status: 409 },
        );
      }
      const message = queued
        ? raced
        : await recoverPendingMessage(client, raced.id);
      return sendResultResponse(message, raced.conversationId);
    }
    try {
      const reopened = await reopenFailedConversation(client, {
        value: validation.value,
        subject,
        now,
        idempotencyKey,
        requestHash,
        queued,
      });
      if (!reopened) {
        return Response.json(
          { error: 'A conversation already exists for this topic' },
          { status: 409 },
        );
      }
      created = reopened;
    } catch (reopenError) {
      if (reopenError instanceof IdentityNotAllowedError) {
        return identityNotAllowedResponse();
      }
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
          const message = queued
            ? racedReopen
            : await recoverPendingMessage(client, racedReopen.id);
          return sendResultResponse(message, racedReopen.conversationId);
        }
        return Response.json(
          { error: 'Idempotency key is already in use' },
          { status: 409 },
        );
      }
      throw reopenError;
    }
  }

  return queued
    ? queuedResponse(client, created.conversationId, created.messageId)
    : deliverResponse(
        client,
        created.conversationId,
        created.messageId,
        'opening conversation email',
      );
}

function messageCreateData(
  value: CreateConversationV2Input,
  subject: string,
  replyToAddress: string,
  now: Date,
  idempotencyKey: string,
  requestHash: string,
  queued: boolean,
) {
  const recipients = value.message.to ?? [
    { address: value.participant.email, name: value.participant.name },
  ];
  return {
    direction: 'OUTBOUND' as const,
    state: 'PENDING' as const,
    deliveryState: 'UNKNOWN' as const,
    fromAddress: value.message.from.address,
    fromName: value.message.from.name,
    toAddress: recipients[0].address,
    toName: recipients[0].name,
    toRecipients: recipients,
    replyToAddress,
    replyToName: value.message.replyTo.name,
    subject,
    textBody: value.message.text,
    htmlBody: value.message.html,
    tags: value.message.tags ?? undefined,
    emailCreatedAt: now,
    idempotencyKey,
    requestHash,
    ...(queued ? { outboxEntry: { create: {} } } : {}),
  };
}

async function reopenFailedConversation(
  client: PrismaClient,
  input: {
    value: CreateConversationV2Input;
    subject: string;
    now: Date;
    idempotencyKey: string;
    requestHash: string;
    queued: boolean;
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
  return client.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${conversation.id}))::text
    `;
    const current = await transaction.emailConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    if (
      !(await lockAllowedEmailIdentities(
        transaction,
        input.value.message.from.address,
        input.value.message.replyTo.address,
      ))
    ) {
      throw new IdentityNotAllowedError();
    }
    if (
      current.replyToBaseAddress &&
      current.replyToBaseAddress !== input.value.message.replyTo.address
    ) {
      throw new IdentityNotAllowedError();
    }
    const liveMessage = await transaction.emailMessage.findFirst({
      where: { conversationId: conversation.id, state: { not: 'FAILED' } },
    });
    if (liveMessage) {
      return null;
    }
    await transaction.emailConversation.update({
      where: { id: conversation.id },
      data: {
        apiVersion: 'V2',
        title: input.value.topic.title,
        subject: input.subject,
        participantAddress: input.value.participant.email,
        participantName: input.value.participant.name,
        replyToBaseAddress: input.value.message.replyTo.address,
        replyToRequiresAllowlist: true,
        state: 'AWAITING_PARTICIPANT',
        stateChangedAt: input.now,
        lastMessageAt: input.now,
      },
    });
    const message = await transaction.emailMessage.create({
      data: {
        conversationId: conversation.id,
        ...messageCreateData(
          input.value,
          input.subject,
          buildConversationReplyTo(
            input.value.message.replyTo.address,
            conversation.routingToken,
          ),
          input.now,
          input.idempotencyKey,
          input.requestHash,
          input.queued,
        ),
      },
    });
    return { conversationId: conversation.id, messageId: message.id };
  });
}

export async function createMessageV2(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
  queued: boolean,
) {
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }
  const idempotencyKey = getIdempotencyKey(request);
  if (idempotencyKey instanceof Response) {
    return idempotencyKey;
  }
  const parsed = await readJson(request);
  if ('response' in parsed) {
    return parsed.response;
  }
  const validation = validateMessageV2Body(parsed.value);
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: 400 });
  }
  const { conversationId: rawConversationId } = await context.params;
  if (!isUuid(rawConversationId)) {
    return Response.json({ error: 'Invalid conversation ID' }, { status: 400 });
  }
  const conversationId = rawConversationId.toLowerCase();

  const client = getPrismaClient();
  const requestHash = hashSendRequest({
    operation: queued ? 'outbox-reply-v2' : 'reply-v2',
    conversationId,
    request: validation.value,
  });
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
    const message = queued
      ? existing
      : await recoverPendingMessage(client, existing.id);
    return sendResultResponse(message, conversationId);
  }
  if (!(await identitiesAreAllowed(client, validation.value))) {
    return identityNotAllowedResponse();
  }

  const conversation = await client.emailConversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  if (
    conversation.replyToBaseAddress &&
    conversation.replyToBaseAddress !== validation.value.replyTo.address
  ) {
    return identityNotAllowedResponse();
  }
  const parent = validation.value.replyToMessageId
    ? await client.emailMessage.findFirst({
        where: { id: validation.value.replyToMessageId, conversationId },
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
      if (
        !(await lockAllowedEmailIdentities(
          transaction,
          validation.value.from.address,
          validation.value.replyTo.address,
        ))
      ) {
        throw new IdentityNotAllowedError();
      }
      if (
        current.replyToBaseAddress &&
        current.replyToBaseAddress !== validation.value.replyTo.address
      ) {
        throw new IdentityNotAllowedError();
      }
      const message = await transaction.emailMessage.create({
        data: replyCreateData(
          conversationId,
          parent.id,
          current.participantAddress,
          current.participantName,
          current.subject,
          current.routingToken,
          parentInternetMessageId,
          references,
          validation.value,
          now,
          idempotencyKey,
          requestHash,
          queued,
        ),
      });
      await transaction.emailConversation.update({
        where: { id: conversationId },
        data: {
          apiVersion: 'V2',
          replyToBaseAddress: validation.value.replyTo.address,
          replyToRequiresAllowlist: true,
        },
      });
      await transaction.$executeRaw`
        UPDATE email_conversations
        SET last_message_at = GREATEST(last_message_at, ${now}),
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
    if (error instanceof IdentityNotAllowedError) {
      return identityNotAllowedResponse();
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
        const message = queued
          ? raced
          : await recoverPendingMessage(client, raced.id);
        return sendResultResponse(message, conversationId);
      }
      return Response.json(
        { error: 'Idempotency key is already in use' },
        { status: 409 },
      );
    }
    throw error;
  }

  return queued
    ? Response.json(
        { conversationId, message: serializeMessage(pending) },
        { status: 202 },
      )
    : deliverResponse(client, conversationId, pending.id, 'conversation reply');
}

function replyCreateData(
  conversationId: string,
  parentMessageId: string,
  toAddress: string,
  toName: string | null,
  conversationSubject: string,
  routingToken: string,
  parentInternetMessageId: string,
  references: string[],
  value: MessageV2Input,
  now: Date,
  idempotencyKey: string,
  requestHash: string,
  queued: boolean,
) {
  const recipients = value.to ?? [{ address: toAddress, name: toName }];
  return {
    conversationId,
    parentMessageId,
    direction: 'OUTBOUND' as const,
    state: 'PENDING' as const,
    deliveryState: 'UNKNOWN' as const,
    inReplyToInternetMessageId: parentInternetMessageId,
    referenceInternetMessageIds: references,
    fromAddress: value.from.address,
    fromName: value.from.name,
    toAddress: recipients[0].address,
    toName: recipients[0].name,
    toRecipients: recipients,
    replyToAddress: buildConversationReplyTo(
      value.replyTo.address,
      routingToken,
    ),
    replyToName: value.replyTo.name,
    subject: createReplySubject(conversationSubject),
    textBody: value.text,
    htmlBody: value.html,
    tags: value.tags ?? undefined,
    emailCreatedAt: now,
    idempotencyKey,
    requestHash,
    ...(queued ? { outboxEntry: { create: {} } } : {}),
  };
}

async function queuedResponse(
  client: PrismaClient,
  conversationId: string,
  messageId: string,
) {
  const message = await client.emailMessage.findUniqueOrThrow({
    where: { id: messageId },
  });
  return Response.json(
    { conversationId, message: serializeMessage(message) },
    { status: 202 },
  );
}

async function deliverResponse(
  client: PrismaClient,
  conversationId: string,
  messageId: string,
  operation: string,
) {
  try {
    const message = await deliverPendingMessage(client, messageId);
    return Response.json(
      { conversationId, message: serializeMessage(message) },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      `Failed to send ${operation}:`,
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
