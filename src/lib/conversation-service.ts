import type { EmailMessage, PrismaClient } from '@/lib/database';
import {
  getConfiguredResendClient,
  ResendApiError,
  reconcileOutboundDeliveryState,
  recordOutboundInternetMessageId,
  type SendEmailInput,
} from '@/lib/email';

const SENT_METADATA_RETRY_DELAYS_MS = [0, 100, 250] as const;

export async function deliverPendingMessage(
  client: PrismaClient,
  messageId: string,
) {
  let sendError: unknown;
  const result = await client.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${messageId}))::text
    `;
      const message = await transaction.emailMessage.findUniqueOrThrow({
        where: { id: messageId },
      });
      if (message.state !== 'PENDING') {
        return message;
      }

      try {
        if (!message.idempotencyKey) {
          throw new Error('Pending message is missing an idempotency key');
        }
        const resend = getConfiguredResendClient();
        const sent = await resend.send(
          buildSendEmailInput(message),
          `${message.kind === 'DIRECT' ? 'email' : 'conversation'}/${message.id}`,
        );
        await transaction.emailMessage.update({
          where: { id: message.id },
          data: {
            state: 'ACCEPTED',
            stateDetail: null,
            deliveryState: 'UNKNOWN',
            resendEmailId: sent.id,
          },
        });
        await reconcileOutboundDeliveryState(transaction, sent.id);
        return transaction.emailMessage.findUniqueOrThrow({
          where: { id: message.id },
        });
      } catch (error) {
        sendError = error;
        const knownFailure =
          error instanceof ResendApiError ||
          (error instanceof Error &&
            error.message.startsWith('Missing RESEND_API_KEY'));
        return transaction.emailMessage.update({
          where: { id: message.id },
          data: {
            state: knownFailure ? 'FAILED' : 'INDETERMINATE',
            stateDetail:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : 'Unknown error',
          },
        });
      }
    },
    { maxWait: 5_000, timeout: 25_000 },
  );

  if (sendError) {
    throw sendError;
  }
  return hydrateSentMetadata(client, result);
}

async function hydrateSentMetadata(
  client: PrismaClient,
  message: EmailMessage,
): Promise<EmailMessage> {
  if (
    message.kind === 'DIRECT' ||
    message.state !== 'ACCEPTED' ||
    !message.resendEmailId ||
    message.internetMessageId
  ) {
    return message;
  }

  let lastError: unknown;
  for (const delayMs of SENT_METADATA_RETRY_DELAYS_MS) {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const retrieved = await getConfiguredResendClient().getSent(
        message.resendEmailId,
      );
      return await recordOutboundInternetMessageId(
        client,
        message.id,
        retrieved.message_id,
        new Date(retrieved.created_at),
      );
    } catch (error) {
      lastError = error;
    }
  }

  console.warn(
    'Sent email metadata is not available yet:',
    lastError instanceof Error ? lastError.message : 'Unknown error',
  );
  return message;
}

export async function recoverPendingMessage(
  client: PrismaClient,
  messageId: string,
) {
  const message = await client.emailMessage.findUniqueOrThrow({
    where: { id: messageId },
  });
  if (message.state !== 'PENDING') {
    return message;
  }

  const age = Date.now() - message.createdAt.getTime();
  if (age >= 23 * 60 * 60 * 1000) {
    await client.emailMessage.updateMany({
      where: { id: message.id, state: 'PENDING' },
      data: {
        state: 'INDETERMINATE',
        stateDetail: 'Pending send exceeded the provider idempotency window',
      },
    });
    return client.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
  }

  try {
    return await deliverPendingMessage(client, message.id);
  } catch {
    return client.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
  }
}

export async function ensureInternetMessageId(
  client: PrismaClient,
  messageId: string,
): Promise<string | null> {
  const message = await client.emailMessage.findUniqueOrThrow({
    where: { id: messageId },
  });
  if (message.internetMessageId || !message.resendEmailId) {
    return message.internetMessageId;
  }

  const resend = getConfiguredResendClient();
  const retrieved =
    message.direction === 'INBOUND'
      ? await resend.getReceived(message.resendEmailId)
      : await resend.getSent(message.resendEmailId);
  if (message.direction === 'OUTBOUND') {
    await recordOutboundInternetMessageId(
      client,
      message.id,
      retrieved.message_id,
      new Date(retrieved.created_at),
    );
  } else {
    await client.emailMessage.update({
      where: { id: message.id },
      data: { internetMessageId: retrieved.message_id },
    });
  }
  return retrieved.message_id;
}

const DISPLAY_NAME_PHRASE_PATTERN =
  /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?: [A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;

function formatAddress(address: string, name: string | null): string {
  if (!name) {
    return address;
  }
  if (DISPLAY_NAME_PHRASE_PATTERN.test(name)) {
    return `${name} <${address}>`;
  }
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}" <${address}>`;
}

export function buildSendEmailInput(message: EmailMessage): SendEmailInput {
  return {
    from: formatAddress(message.fromAddress, message.fromName),
    to: [formatAddress(message.toAddress, message.toName)],
    ...(message.replyToAddress === null
      ? {}
      : {
          reply_to: formatAddress(message.replyToAddress, message.replyToName),
        }),
    subject: message.subject,
    ...(message.textBody === null ? {} : { text: message.textBody }),
    ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
    ...(message.inReplyToInternetMessageId
      ? {
          headers: {
            'In-Reply-To': message.inReplyToInternetMessageId,
            References: message.referenceInternetMessageIds.join(' '),
          },
        }
      : {}),
  };
}
