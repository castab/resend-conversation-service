import { authorizeEmailV2, readJson } from '@/lib/api';
import {
  deliverPendingMessage,
  recoverPendingMessage,
} from '@/lib/conversation-service';
import {
  type EmailMessage,
  getPrismaClient,
  isEmailAddressAllowed,
  lockAllowedEmailIdentity,
  Prisma,
} from '@/lib/database';
import { hashSendRequest } from '@/lib/email';
import { validateDirectEmailV2Body } from '@/lib/send-validation';

const IDENTITY_NOT_ALLOWED =
  'The requested email identity is not allowed. Contact the administrator.';

class IdentityNotAllowedError extends Error {}

function getIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get('idempotency-key');
  return key && key.length <= 256
    ? key
    : Response.json(
        { error: 'A valid Idempotency-Key header is required' },
        { status: 400 },
      );
}

function identityNotAllowedResponse() {
  return Response.json({ error: IDENTITY_NOT_ALLOWED }, { status: 400 });
}

function serializeDirectEmail(message: EmailMessage) {
  return {
    id: message.id,
    state: message.state.toLowerCase(),
    resendEmailId: message.resendEmailId,
  };
}

function replayResponse(message: EmailMessage) {
  const failed =
    message.state === 'FAILED' || message.state === 'INDETERMINATE';
  return Response.json(
    {
      ...(failed ? { error: 'Email was not confirmed as sent' } : {}),
      email: serializeDirectEmail(message),
    },
    { status: failed ? 502 : message.state === 'PENDING' ? 202 : 200 },
  );
}

function idempotencyConflictResponse() {
  return Response.json(
    { error: 'Idempotency key was already used for a different request' },
    { status: 409 },
  );
}

export async function sendDirectEmailV2(
  request: Request,
  deliveryMode: 'synchronous' | 'outbox',
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
  const validation = validateDirectEmailV2Body(parsed.value);
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const client = getPrismaClient();
  const requestHash = hashSendRequest({
    operation:
      deliveryMode === 'outbox' ? 'outbox-direct-email-v2' : 'direct-email-v2',
    request: validation.value,
  });
  const existing = await client.emailMessage.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (existing.kind !== 'DIRECT' || existing.requestHash !== requestHash) {
      return idempotencyConflictResponse();
    }
    const message =
      deliveryMode === 'outbox'
        ? existing
        : await recoverPendingMessage(client, existing.id);
    return replayResponse(message);
  }

  if (
    !(await isEmailAddressAllowed(
      client,
      validation.value.from.address,
      'FROM',
    ))
  ) {
    return identityNotAllowedResponse();
  }

  let message: EmailMessage;
  try {
    message = await client.$transaction(async (transaction) => {
      if (
        !(await lockAllowedEmailIdentity(
          transaction,
          validation.value.from.address,
          'FROM',
        ))
      ) {
        throw new IdentityNotAllowedError();
      }
      return transaction.emailMessage.create({
        data: {
          kind: 'DIRECT',
          direction: 'OUTBOUND',
          state: 'PENDING',
          deliveryState: 'UNKNOWN',
          fromAddress: validation.value.from.address,
          fromName: validation.value.from.name,
          toAddress: validation.value.to[0].address,
          toName: validation.value.to[0].name,
          toRecipients: validation.value.to,
          subject: validation.value.subject,
          textBody: validation.value.text ?? null,
          htmlBody: validation.value.html ?? null,
          tags: validation.value.tags ?? undefined,
          emailCreatedAt: new Date(),
          idempotencyKey,
          requestHash,
          ...(deliveryMode === 'outbox' ? { outboxEntry: { create: {} } } : {}),
        },
      });
    });
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
    if (
      !raced ||
      raced.kind !== 'DIRECT' ||
      raced.requestHash !== requestHash
    ) {
      return idempotencyConflictResponse();
    }
    const message =
      deliveryMode === 'outbox'
        ? raced
        : await recoverPendingMessage(client, raced.id);
    return replayResponse(message);
  }

  if (deliveryMode === 'outbox') {
    return Response.json(
      { email: serializeDirectEmail(message) },
      { status: 202 },
    );
  }

  try {
    const sent = await deliverPendingMessage(client, message.id);
    return Response.json(
      { email: serializeDirectEmail(sent) },
      { status: 201 },
    );
  } catch {
    console.error('Failed to send direct email');
    const failed = await client.emailMessage.findUniqueOrThrow({
      where: { id: message.id },
    });
    return Response.json(
      {
        error: 'Failed to send email',
        email: serializeDirectEmail(failed),
      },
      { status: 502 },
    );
  }
}
