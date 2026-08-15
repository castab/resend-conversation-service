import type { ConversationState, Prisma, PrismaClient } from '@/lib/database';

export const CONVERSATION_STATES = [
  'AWAITING_US',
  'AWAITING_PARTICIPANT',
  'CONCLUDED',
  'TERMINATED',
] as const satisfies readonly ConversationState[];

type StateClient = PrismaClient | Prisma.TransactionClient;

/**
 * Automatic transitions never move a TERMINATED conversation and never restamp
 * `state_changed_at` when the state already matches, so the oldest waiting
 * timestamp survives a burst of messages and keeps its place in the queue.
 */
async function applyAutomaticState(
  client: StateClient,
  conversationId: string,
  state: ConversationState,
  changedAt: Date,
) {
  await client.$executeRaw`
    UPDATE email_conversations
    SET state = ${state}::"ConversationState",
        state_changed_at = ${changedAt},
        updated_at = now()
    WHERE id = ${conversationId}::uuid
      AND state <> ${state}::"ConversationState"
      AND state <> 'TERMINATED'
  `;
}

/** Inbound mail hands the turn back to us, reopening a CONCLUDED conversation. */
export async function markConversationAwaitingUs(
  client: StateClient,
  conversationId: string,
  changedAt: Date,
) {
  await applyAutomaticState(client, conversationId, 'AWAITING_US', changedAt);
}

/** Outbound reply intent hands the turn to the participant. */
export async function markConversationAwaitingParticipant(
  client: StateClient,
  conversationId: string,
  changedAt: Date,
) {
  await applyAutomaticState(
    client,
    conversationId,
    'AWAITING_PARTICIPANT',
    changedAt,
  );
}

/**
 * A hard delivery failure means the participant is unreachable, so it wins over
 * every other state including an operator's CONCLUDED.
 */
export async function markConversationTerminated(
  client: StateClient,
  conversationId: string,
  changedAt: Date,
) {
  await client.$executeRaw`
    UPDATE email_conversations
    SET state = 'TERMINATED'::"ConversationState",
        state_changed_at = ${changedAt},
        updated_at = now()
    WHERE id = ${conversationId}::uuid
      AND state <> 'TERMINATED'
  `;
}

const MERGE_PRECEDENCE: readonly ConversationState[] = [
  'TERMINATED',
  'AWAITING_US',
  'AWAITING_PARTICIPANT',
  'CONCLUDED',
];

/**
 * When conversations merge, the surviving row takes the highest-precedence state
 * across every row involved, timestamped with the earliest change among the rows
 * that hold that winning state.
 */
export function mergeConversationState(
  rows: readonly { state: ConversationState; stateChangedAt: Date }[],
): { state: ConversationState; stateChangedAt: Date } | null {
  const winner = MERGE_PRECEDENCE.find((candidate) =>
    rows.some((row) => row.state === candidate),
  );
  if (!winner) {
    return null;
  }
  const changedAt = rows
    .filter((row) => row.state === winner)
    .reduce<Date | null>(
      (earliest, row) =>
        earliest && earliest.getTime() <= row.stateChangedAt.getTime()
          ? earliest
          : row.stateChangedAt,
      null,
    );
  return changedAt ? { state: winner, stateChangedAt: changedAt } : null;
}

export function parseConversationState(
  value: unknown,
): ConversationState | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return CONVERSATION_STATES.find((state) => state === normalized) ?? null;
}

export function serializeConversationState(state: ConversationState): string {
  return state.toLowerCase();
}

export const CONVERSATION_STATE_ERROR = `state must be one of ${CONVERSATION_STATES.map(
  serializeConversationState,
).join(', ')}`;
