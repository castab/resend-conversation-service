import type { Prisma, PrismaClient } from '@/lib/database';
import { markConversationTerminated } from './conversation-state';
import type { EmailWebhookEvent } from './webhook';

export const DELIVERY_EVENT_TYPES = [
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.suppressed',
  'email.failed',
] as const;

type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];
type DeliveryState =
  | 'DELIVERED'
  | 'DELIVERY_DELAYED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'SUPPRESSED'
  | 'FAILED';
type DeliveryClient = PrismaClient | Prisma.TransactionClient;

interface StoredDeliveryEvent {
  id: string;
  eventType: string;
  eventCreatedAt: Date;
  webhookReceivedAt: Date;
  deliveryDetail: string | null;
}

const DELIVERY_STATE_BY_EVENT_TYPE: Record<DeliveryEventType, DeliveryState> = {
  'email.delivered': 'DELIVERED',
  'email.delivery_delayed': 'DELIVERY_DELAYED',
  'email.bounced': 'BOUNCED',
  'email.complained': 'COMPLAINED',
  'email.suppressed': 'SUPPRESSED',
  'email.failed': 'FAILED',
};

// States that prove the participant cannot be reached. `FAILED` is a send-side
// problem rather than a statement about the participant, so it is excluded.
const UNREACHABLE_DELIVERY_STATES: readonly DeliveryState[] = [
  'BOUNCED',
  'COMPLAINED',
  'SUPPRESSED',
];

export function isDeliveryEventType(type: string): type is DeliveryEventType {
  return (DELIVERY_EVENT_TYPES as readonly string[]).includes(type);
}

function isUnreachableState(state: DeliveryState): boolean {
  return UNREACHABLE_DELIVERY_STATES.includes(state);
}

export function getDeliveryDetail(event: EmailWebhookEvent): string | null {
  if (event.type === 'email.bounced') {
    return (
      event.data.bounce?.message ??
      event.data.bounce?.diagnosticCode?.join('\n') ??
      event.data.bounce?.type ??
      null
    );
  }
  if (event.type === 'email.failed') {
    return event.data.failed?.reason ?? null;
  }
  if (event.type === 'email.suppressed') {
    return (
      event.data.suppressed?.message ?? event.data.suppressed?.type ?? null
    );
  }
  return null;
}

export async function projectOutboundDeliveryStateForResendEmail(
  client: DeliveryClient,
  resendEmailId: string,
) {
  await client.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${resendEmailId}))::text
  `;

  const events = await client.emailWebhookEvent.findMany({
    where: {
      emailId: resendEmailId,
      eventType: { in: [...DELIVERY_EVENT_TYPES] },
    },
    orderBy: [
      { eventCreatedAt: 'asc' },
      { webhookReceivedAt: 'asc' },
      { id: 'asc' },
    ],
  });
  const projected = reduceDeliveryEvents(events);
  if (!projected.current) {
    return;
  }

  await client.emailMessage.updateMany({
    where: { direction: 'OUTBOUND', resendEmailId },
    data: {
      deliveryState: projected.current.state,
      deliveryStateDetail: projected.current.detail,
      deliveryStateUpdatedAt: projected.current.eventCreatedAt,
      deliveredAt: projected.deliveredAt,
    },
  });

  if (!isUnreachableState(projected.current.state)) {
    return;
  }
  // Direct email carries no conversation, so the filter doubles as the kind check.
  const message = await client.emailMessage.findFirst({
    where: {
      direction: 'OUTBOUND',
      resendEmailId,
      conversationId: { not: null },
    },
    select: { conversationId: true },
  });
  if (message?.conversationId) {
    await markConversationTerminated(
      client,
      message.conversationId,
      projected.current.eventCreatedAt,
    );
  }
}

export async function reconcileOutboundDeliveryState(
  client: DeliveryClient,
  resendEmailId: string,
) {
  await projectOutboundDeliveryStateForResendEmail(client, resendEmailId);
}

function reduceDeliveryEvents(events: StoredDeliveryEvent[]) {
  let deliveredAt: Date | null = null;
  let current: {
    state: DeliveryState;
    detail: string | null;
    eventCreatedAt: Date;
  } | null = null;

  for (const event of events) {
    if (!isDeliveryEventType(event.eventType)) {
      continue;
    }
    const state = DELIVERY_STATE_BY_EVENT_TYPE[event.eventType];
    if (state === 'DELIVERED') {
      deliveredAt = earlierDate(deliveredAt, event.eventCreatedAt);
    }
    if (
      state === 'DELIVERY_DELAYED' &&
      current &&
      current.state !== 'DELIVERY_DELAYED'
    ) {
      continue;
    }
    current = {
      state,
      detail: event.deliveryDetail,
      eventCreatedAt: event.eventCreatedAt,
    };
  }

  return { current, deliveredAt };
}

function earlierDate(left: Date | null, right: Date): Date {
  return left && left.getTime() <= right.getTime() ? left : right;
}
