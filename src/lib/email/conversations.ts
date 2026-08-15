import { createHash } from 'node:crypto';
import type { EmailConversation, EmailMessage } from '@/lib/database';
import { Prisma, type PrismaClient } from '@/lib/database';
import {
  markConversationAwaitingUs,
  mergeConversationState,
} from './conversation-state';
import type { ResendEmail, ResendEmailClient } from './resend-client';
import { extractRoutingCandidates } from './routing';
import {
  extractMessageIds,
  getHeader,
  normalizeSubject,
  parseAddress,
} from './threading';
import type { EmailEventData } from './webhook';

export interface TopicIdentity {
  type: string;
  externalId: string;
  title: string;
}

export interface MessageContent {
  text?: string;
  html?: string;
}

type ConversationMessage = EmailMessage & {
  conversationId: string;
  conversation: EmailConversation;
};

function hasConversation<
  T extends {
    kind: EmailMessage['kind'];
    conversationId: string | null;
    conversation: EmailConversation | null;
  },
>(message: T): message is T & ConversationMessage {
  return (
    message.conversationId !== null &&
    message.conversation !== null &&
    message.kind === 'CONVERSATION'
  );
}

export function hashSendRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function preserveMergedConversationState(
  transaction: Prisma.TransactionClient,
  target: EmailConversation,
  sources: EmailConversation[],
) {
  const uniqueSources = [
    ...new Map(
      sources
        .filter((source) => source.id !== target.id)
        .map((source) => [source.id, source]),
    ).values(),
  ];
  if (!uniqueSources.length) {
    return;
  }

  await transaction.emailConversationRoutingAlias.updateMany({
    where: { conversationId: { in: uniqueSources.map((source) => source.id) } },
    data: { conversationId: target.id },
  });
  await transaction.emailConversationRoutingAlias.createMany({
    data: uniqueSources.flatMap((source) =>
      source.replyToBaseAddress
        ? [
            {
              conversationId: target.id,
              routingToken: source.routingToken,
              baseAddress: source.replyToBaseAddress,
            },
          ]
        : [],
    ),
    skipDuplicates: true,
  });

  const promotedSource = uniqueSources.find(
    (source) => source.apiVersion === 'V2' && source.replyToBaseAddress,
  );
  const selectedSource =
    promotedSource ?? uniqueSources.find((source) => source.replyToBaseAddress);
  const replyToBaseAddress =
    target.replyToBaseAddress ?? selectedSource?.replyToBaseAddress;
  const apiVersion =
    target.apiVersion === 'V2' || promotedSource
      ? 'V2'
      : (target.apiVersion ??
        uniqueSources.find((source) => source.apiVersion)?.apiVersion);
  const mergedState = mergeConversationState([target, ...uniqueSources]);
  await transaction.emailConversation.update({
    where: { id: target.id },
    data: {
      apiVersion,
      replyToBaseAddress,
      replyToRequiresAllowlist:
        apiVersion === 'V2'
          ? (target.apiVersion === 'V2' && target.replyToRequiresAllowlist) ||
            Boolean(promotedSource?.replyToRequiresAllowlist)
          : target.replyToRequiresAllowlist,
      ...(mergedState ?? {}),
    },
  });
}

async function lockConversationIds(
  transaction: Prisma.TransactionClient,
  conversationIds: string[],
) {
  for (const conversationId of [...new Set(conversationIds)].sort()) {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text
    `;
  }
}

const MAX_OUTBOUND_HYDRATION_CANDIDATES = 10;
const OUTBOUND_HYDRATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function hydrateReferencedOutboundMessages(
  client: PrismaClient,
  resend: ResendEmailClient,
  participantAddress: string,
  internetMessageIds: string[],
  preferredInternetMessageId?: string,
): Promise<void> {
  const ancestry = [...new Set(internetMessageIds)].filter(Boolean);
  if (!ancestry.length) {
    return;
  }

  const knownMessage = await client.emailMessage.findFirst({
    where: {
      internetMessageId: preferredInternetMessageId
        ? preferredInternetMessageId
        : { in: ancestry },
      conversation: {
        is: {
          participantAddress: {
            equals: participantAddress,
            mode: 'insensitive',
          },
        },
      },
    },
  });
  if (knownMessage) {
    return;
  }

  const candidates = await client.emailMessage.findMany({
    where: {
      direction: 'OUTBOUND',
      state: 'ACCEPTED',
      resendEmailId: { not: null },
      internetMessageId: null,
      conversation: {
        is: {
          participantAddress: {
            equals: participantAddress,
            mode: 'insensitive',
          },
        },
      },
    },
    orderBy: [{ emailCreatedAt: 'desc' }, { id: 'desc' }],
    take: MAX_OUTBOUND_HYDRATION_CANDIDATES + 1,
  });
  if (!candidates.length) {
    return;
  }

  const limitedCandidates = candidates.slice(
    0,
    MAX_OUTBOUND_HYDRATION_CANDIDATES,
  );
  const retrieved = await Promise.allSettled(
    limitedCandidates.map((message) =>
      resend.getSent(message.resendEmailId as string),
    ),
  );
  let matched = false;
  let recentRetrievalFailed = false;
  const retryCutoff = Date.now() - OUTBOUND_HYDRATION_RETRY_WINDOW_MS;

  for (const [index, result] of retrieved.entries()) {
    if (result.status === 'rejected') {
      recentRetrievalFailed ||=
        limitedCandidates[index].emailCreatedAt.getTime() >= retryCutoff;
      continue;
    }

    const message = limitedCandidates[index];
    await recordOutboundInternetMessageId(
      client,
      message.id,
      result.value.message_id,
      new Date(result.value.created_at),
    );
    matched ||= ancestry.includes(result.value.message_id);
  }

  if (
    !matched &&
    (recentRetrievalFailed ||
      (candidates.length > MAX_OUTBOUND_HYDRATION_CANDIDATES &&
        candidates[
          MAX_OUTBOUND_HYDRATION_CANDIDATES
        ].emailCreatedAt.getTime() >= retryCutoff))
  ) {
    throw new Error('Outbound threading metadata could not be fully hydrated');
  }
}

export async function recordOutboundInternetMessageId(
  client: PrismaClient,
  messageId: string,
  internetMessageId: string,
  emailCreatedAt?: Date,
): Promise<EmailMessage> {
  return client.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${internetMessageId}))::text
      `;
      const outbound = await transaction.emailMessage.findUniqueOrThrow({
        where: { id: messageId },
        include: { conversation: true },
      });
      if (outbound.direction !== 'OUTBOUND' || !hasConversation(outbound)) {
        throw new Error('Cannot record sent metadata on an inbound message');
      }

      const updated = await transaction.emailMessage.update({
        where: { id: outbound.id },
        data: {
          internetMessageId,
          ...(emailCreatedAt ? { emailCreatedAt } : {}),
        },
      });
      const waitingChildren = await transaction.emailMessage.findMany({
        where: {
          parentMessageId: null,
          inReplyToInternetMessageId: internetMessageId,
        },
        include: { conversation: true },
      });
      const eligibleChildren = waitingChildren.filter(
        (child): child is typeof child & ConversationMessage =>
          hasConversation(child) &&
          child.conversation.participantAddress.toLowerCase() ===
            outbound.conversation.participantAddress.toLowerCase(),
      );
      const unassignedConversationIds = [
        ...new Set(
          eligibleChildren
            .filter(
              (child) =>
                child.conversationId !== outbound.conversationId &&
                child.conversation.topicType === null,
            )
            .map((child) => child.conversationId),
        ),
      ];

      if (unassignedConversationIds.length) {
        await lockConversationIds(transaction, [
          outbound.conversationId,
          ...unassignedConversationIds,
        ]);
        await preserveMergedConversationState(
          transaction,
          outbound.conversation,
          eligibleChildren
            .map((child) => child.conversation)
            .filter((conversation) =>
              unassignedConversationIds.includes(conversation.id),
            ),
        );
        await transaction.emailMessage.updateMany({
          where: { conversationId: { in: unassignedConversationIds } },
          data: { conversationId: outbound.conversationId },
        });
      }
      await transaction.emailMessage.updateMany({
        where: {
          id: { in: eligibleChildren.map((child) => child.id) },
          conversationId: outbound.conversationId,
          parentMessageId: null,
        },
        data: { parentMessageId: outbound.id },
      });
      if (unassignedConversationIds.length) {
        await transaction.emailConversation.deleteMany({
          where: { id: { in: unassignedConversationIds } },
        });
      }

      const latest = await transaction.emailMessage.aggregate({
        where: { conversationId: outbound.conversationId },
        _max: { emailCreatedAt: true },
      });
      if (latest._max.emailCreatedAt) {
        await transaction.emailConversation.update({
          where: { id: outbound.conversationId },
          data: { lastMessageAt: latest._max.emailCreatedAt },
        });
      }

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function projectInboundEmail(
  client: PrismaClient,
  eventData: EmailEventData,
  email: ResendEmail,
  replyToBaseAddress: string,
): Promise<EmailMessage> {
  const internetMessageId = eventData.message_id ?? email.message_id;
  const inReplyTo = extractMessageIds(
    getHeader(email.headers, 'in-reply-to'),
  ).at(-1);
  const rawReferences = extractMessageIds(
    getHeader(email.headers, 'references'),
  )
    .filter((messageId) => messageId.length <= 998)
    .slice(-100);
  const effectiveParentInternetMessageId = inReplyTo ?? rawReferences.at(-1);
  const references = inReplyTo
    ? [
        ...rawReferences.filter((messageId) => messageId !== inReplyTo),
        inReplyTo,
      ]
    : rawReferences;
  const displayFrom = parseAddress(
    getHeader(email.headers, 'from') ?? email.from,
  );
  const participant = parseAddress(eventData.from || email.from);
  const emailCreatedAt = new Date(email.created_at || eventData.created_at);
  const participantAddress = participant.address.toLowerCase();
  const routingCandidates = extractRoutingCandidates([
    ...email.to,
    ...eventData.to,
    ...(email.received_for ?? []),
    ...(eventData.received_for ?? []),
  ]);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(
        async (transaction) => {
          const lockIds = [
            ...new Set([internetMessageId, ...references].filter(Boolean)),
          ].sort();
          for (const lockId of lockIds) {
            await transaction.$queryRaw`
              SELECT pg_advisory_xact_lock(hashtext(${lockId}))::text
            `;
          }

          const existing = await transaction.emailMessage.findFirst({
            where: {
              kind: 'CONVERSATION',
              OR: [
                { resendEmailId: eventData.email_id },
                { internetMessageId },
              ],
            },
          });
          if (existing) {
            return existing;
          }

          const ancestry = [...references].reverse();
          const relatedMessages = ancestry.length
            ? await transaction.emailMessage.findMany({
                where: {
                  kind: 'CONVERSATION',
                  internetMessageId: { in: ancestry },
                },
                include: { conversation: true },
              })
            : [];
          const eligibleMessages = relatedMessages.filter(
            (message): message is typeof message & ConversationMessage =>
              hasConversation(message) &&
              message.conversation.participantAddress.toLowerCase() ===
                participantAddress,
          );
          const parent = effectiveParentInternetMessageId
            ? eligibleMessages.find(
                (message) =>
                  message.internetMessageId ===
                  effectiveParentInternetMessageId,
              )
            : undefined;
          const nearestAncestor = ancestry
            .map((messageId) =>
              eligibleMessages.find(
                (message) => message.internetMessageId === messageId,
              ),
            )
            .find(Boolean);

          const waitingChildren = (
            await transaction.emailMessage.findMany({
              where: {
                kind: 'CONVERSATION',
                parentMessageId: null,
                inReplyToInternetMessageId: internetMessageId,
              },
              include: { conversation: true },
            })
          ).filter(
            (message): message is typeof message & ConversationMessage =>
              hasConversation(message) &&
              message.conversation.participantAddress.toLowerCase() ===
                participantAddress,
          );
          const waitingConversation =
            waitingChildren.find(
              (message) => message.conversation.topicType !== null,
            )?.conversation ?? waitingChildren[0]?.conversation;

          const parentConversation = parent?.conversation;
          const ancestorConversation = nearestAncestor?.conversation;
          const assignedWaitingConversation = waitingChildren.find(
            (message) => message.conversation.topicType !== null,
          )?.conversation;
          let conversation =
            (parentConversation?.topicType ? parentConversation : undefined) ??
            (ancestorConversation?.topicType
              ? ancestorConversation
              : undefined) ??
            assignedWaitingConversation ??
            parentConversation ??
            ancestorConversation ??
            waitingConversation;
          if (!conversation && routingCandidates.length) {
            const routedConversations =
              await transaction.emailConversation.findMany({
                where: {
                  OR: [
                    {
                      routingToken: {
                        in: routingCandidates.map(
                          (candidate) => candidate.routingToken,
                        ),
                      },
                    },
                    {
                      routingAliases: {
                        some: {
                          routingToken: {
                            in: routingCandidates.map(
                              (candidate) => candidate.routingToken,
                            ),
                          },
                        },
                      },
                    },
                  ],
                },
                include: { routingAliases: true },
              });
            const eligibleConversations = routedConversations.filter(
              (candidateConversation) =>
                candidateConversation.participantAddress.toLowerCase() ===
                  participantAddress &&
                (routingCandidates.some(
                  (candidate) =>
                    candidate.routingToken ===
                      candidateConversation.routingToken &&
                    candidate.baseAddress ===
                      (candidateConversation.replyToBaseAddress ??
                        replyToBaseAddress.trim().toLowerCase()),
                ) ||
                  candidateConversation.routingAliases.some((alias) =>
                    routingCandidates.some(
                      (candidate) =>
                        candidate.routingToken === alias.routingToken &&
                        candidate.baseAddress === alias.baseAddress,
                    ),
                  )),
            );
            if (eligibleConversations.length === 1) {
              conversation = eligibleConversations[0];
            }
          }
          conversation ??= await transaction.emailConversation.create({
            data: {
              title: normalizeSubject(email.subject),
              subject: normalizeSubject(email.subject),
              participantAddress: participant.address,
              participantName: displayFrom.name,
              state: 'AWAITING_US',
              stateChangedAt: emailCreatedAt,
              lastMessageAt: emailCreatedAt,
            },
          });

          const foreignUnassignedConversationIds = [
            ...new Set(
              [...eligibleMessages, ...waitingChildren]
                .filter(
                  (related) =>
                    related.conversationId !== conversation.id &&
                    related.conversation.topicType === null,
                )
                .map((related) => related.conversationId),
            ),
          ];
          if (foreignUnassignedConversationIds.length) {
            await lockConversationIds(transaction, [
              conversation.id,
              ...foreignUnassignedConversationIds,
            ]);
            await preserveMergedConversationState(
              transaction,
              conversation,
              [...eligibleMessages, ...waitingChildren]
                .map((message) => message.conversation)
                .filter((candidateConversation) =>
                  foreignUnassignedConversationIds.includes(
                    candidateConversation.id,
                  ),
                ),
            );
            await transaction.emailMessage.updateMany({
              where: {
                conversationId: { in: foreignUnassignedConversationIds },
              },
              data: { conversationId: conversation.id },
            });
            await transaction.emailConversation.deleteMany({
              where: { id: { in: foreignUnassignedConversationIds } },
            });
          }

          const message = await transaction.emailMessage.create({
            data: {
              conversationId: conversation.id,
              parentMessageId: parent?.id,
              direction: 'INBOUND',
              state: 'RECEIVED',
              resendEmailId: eventData.email_id,
              internetMessageId,
              inReplyToInternetMessageId: effectiveParentInternetMessageId,
              referenceInternetMessageIds: references,
              fromAddress: participant.address,
              fromName: displayFrom.name,
              toAddress: email.to[0] ?? eventData.to[0] ?? '',
              replyToAddress: email.reply_to?.[0] ?? null,
              subject: email.subject,
              textBody: email.text,
              htmlBody: email.html,
              emailCreatedAt,
            },
          });

          await transaction.emailMessage.updateMany({
            where: {
              parentMessageId: null,
              inReplyToInternetMessageId: internetMessageId,
              conversationId: conversation.id,
            },
            data: { parentMessageId: message.id },
          });

          const latest = await transaction.emailMessage.aggregate({
            where: { conversationId: conversation.id },
            _max: { emailCreatedAt: true },
          });
          if (latest._max.emailCreatedAt) {
            await transaction.emailConversation.update({
              where: { id: conversation.id },
              data: { lastMessageAt: latest._max.emailCreatedAt },
            });
          }
          await markConversationAwaitingUs(
            transaction,
            conversation.id,
            emailCreatedAt,
          );

          return message;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < 2
      ) {
        continue;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await client.emailMessage.findFirst({
          where: {
            OR: [{ resendEmailId: eventData.email_id }, { internetMessageId }],
          },
        });
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  throw new Error('Inbound projection retry limit exhausted');
}

export type ConversationWithMessages = EmailConversation & {
  messages: EmailMessage[];
};
