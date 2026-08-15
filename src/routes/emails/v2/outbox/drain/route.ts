import { authorizeOutboxDrain, isRecord, readJson } from '@/lib/api';
import { getPrismaClient } from '@/lib/database';
import { drainEmailOutbox } from '@/lib/outbox-service';

export async function POST(request: Request) {
  const unauthorized = authorizeOutboxDrain(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = await readJson(request);
  if ('response' in parsed) {
    return parsed.response;
  }
  if (!isRecord(parsed.value)) {
    return Response.json(
      { error: 'Request body must be an object' },
      { status: 400 },
    );
  }
  const limit = parsed.value.limit ?? 100;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return Response.json(
      { error: 'limit must be an integer between 1 and 100' },
      { status: 400 },
    );
  }

  try {
    return Response.json(await drainEmailOutbox(getPrismaClient(), limit));
  } catch (error) {
    console.error(
      'Failed to drain email outbox:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return Response.json(
      { error: 'Failed to drain email outbox' },
      { status: 500 },
    );
  }
}
