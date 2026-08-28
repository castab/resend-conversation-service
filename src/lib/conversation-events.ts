import type { Prisma, PrismaClient } from '@/lib/database';

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1;
export const CONVERSATION_EVENT_SINKS = ['NATS'] as const;
export type ConversationEventSinkName =
  (typeof CONVERSATION_EVENT_SINKS)[number];
export type ConversationEventActor =
  | 'participant'
  | 'service'
  | 'operator'
  | 'system';
export type ConversationEventKind =
  | 'CREATED'
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_OUTBOUND_INTENDED'
  | 'STATE_CHANGED'
  | 'ASSIGNED'
  | 'MESSAGE_DELIVERY_UPDATED'
  | 'MERGED';

type EventClient = PrismaClient | Prisma.TransactionClient;

export interface ConversationEventPayload {
  schemaVersion: number;
  id: string;
  type: string;
  occurredAt: string;
  conversationId: string;
  sequence: number;
  topic: { type: string; externalId: string } | null;
  messageId?: string;
  actor: ConversationEventActor;
  cause: string;
  state?: { from: string | null; to: string };
  deliveryState?: string;
  mergedIntoConversationId?: string;
}

export function getEnabledConversationEventSinks(
  environment: NodeJS.ProcessEnv = process.env,
): ConversationEventSinkName[] {
  const raw = environment.CONVERSATION_EVENTS_SINKS?.trim();
  if (!raw) {
    return [];
  }
  const values = [
    ...new Set(raw.split(',').map((value) => value.trim().toUpperCase())),
  ];
  if (
    !values.length ||
    values.some(
      (value) =>
        !CONVERSATION_EVENT_SINKS.includes(value as ConversationEventSinkName),
    )
  ) {
    throw new Error('CONVERSATION_EVENTS_SINKS must contain only nats');
  }
  return values as ConversationEventSinkName[];
}

export function conversationEventsEnabled() {
  return getEnabledConversationEventSinks().length > 0;
}

export async function appendConversationEvent(
  client: EventClient,
  input: {
    conversationId: string;
    type: ConversationEventKind;
    occurredAt: Date;
    actor: ConversationEventActor;
    cause: string;
    messageId?: string;
    state?: { from: string | null; to: string };
    deliveryState?: string;
    mergedIntoConversationId?: string;
  },
): Promise<ConversationEventPayload | null> {
  const sinks = getEnabledConversationEventSinks();
  if (!sinks.length) {
    return null;
  }

  const conversation = await client.emailConversation.update({
    where: { id: input.conversationId },
    data: { eventSequence: { increment: 1 } },
    select: {
      id: true,
      eventSequence: true,
      topicType: true,
      externalTopicId: true,
    },
  });
  const event = await client.conversationEvent.create({
    data: {
      conversationId: conversation.id,
      sequence: conversation.eventSequence,
      type: input.type,
      occurredAt: input.occurredAt,
      payload: {},
    },
  });
  const payload: ConversationEventPayload = {
    schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
    id: event.id,
    type: `conversation.${serializeEventType(input.type)}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: conversation.id,
    sequence: conversation.eventSequence,
    topic:
      conversation.topicType && conversation.externalTopicId
        ? {
            type: conversation.topicType,
            externalId: conversation.externalTopicId,
          }
        : null,
    actor: input.actor,
    cause: input.cause,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
    ...(input.mergedIntoConversationId
      ? { mergedIntoConversationId: input.mergedIntoConversationId }
      : {}),
  };
  await client.conversationEvent.update({
    where: { id: event.id },
    data: { payload: payload as unknown as Prisma.InputJsonObject },
  });
  await client.conversationEventDelivery.createMany({
    data: sinks.map((sink) => ({ eventId: event.id, sink })),
  });
  return payload;
}

function serializeEventType(type: ConversationEventKind): string {
  return type.toLowerCase().replaceAll('_', '.');
}
