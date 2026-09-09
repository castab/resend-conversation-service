import { createHash } from 'node:crypto';
import { authorizeEmailV2, serializeAttachment } from '@/lib/api';
import {
  attachmentsEnabled,
  buildStorageKey,
  deleteStoredObject,
  getConfiguredAttachmentStorage,
  normalizeContentType,
  normalizeFilename,
  resolveAttachmentLimits,
} from '@/lib/attachments';
import { getPrismaClient } from '@/lib/database';
import { logEvent } from '@/lib/logger';

export const FILENAME_HEADER = 'x-attachment-filename';

/**
 * Accepts raw attachment bytes and stores them, returning an ID that a later
 * send references. Uploading separately keeps the JSON body limit on every
 * send route unchanged while still allowing attachments up to the provider's
 * per-email ceiling.
 */
export async function POST(request: Request) {
  if (!attachmentsEnabled()) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }

  const rawFilename = request.headers.get(FILENAME_HEADER);
  if (!rawFilename?.trim()) {
    return Response.json(
      { error: `A ${FILENAME_HEADER} header is required` },
      { status: 400 },
    );
  }
  const filename = normalizeFilename(rawFilename);
  const contentType = normalizeContentType(request.headers.get('content-type'));

  const body = Buffer.from(await request.arrayBuffer());
  if (!body.byteLength) {
    return Response.json(
      { error: 'Request body must contain the attachment bytes' },
      { status: 400 },
    );
  }
  const limits = resolveAttachmentLimits();
  if (body.byteLength > limits.maxBytes) {
    return Response.json(
      { error: `Attachment must be at most ${limits.maxBytes} bytes` },
      { status: 413 },
    );
  }

  const client = getPrismaClient();
  const storageKey = buildStorageKey();
  await getConfiguredAttachmentStorage().put(storageKey, body, contentType);

  try {
    const attachment = await client.emailAttachment.create({
      data: {
        source: 'UPLOAD',
        state: 'STORED',
        filename,
        contentType,
        sizeBytes: BigInt(body.byteLength),
        checksumSha256: createHash('sha256').update(body).digest('hex'),
        storageKey,
      },
    });
    return Response.json(serializeAttachment(attachment), { status: 201 });
  } catch (error) {
    // The object is already written but has no row pointing at it, so nothing
    // would ever reap it. Queue it for deletion before surfacing the failure.
    await deleteStoredObject(client, storageKey);
    logEvent('error', 'attachment_upload_failed', {
      error_type: error instanceof Error ? error.name : 'unknown_error',
    });
    throw error;
  }
}
