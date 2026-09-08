import { Readable } from 'node:stream';
import { authorizeEmailV2, isUuid } from '@/lib/api';
import {
  AttachmentStorageError,
  attachmentsEnabled,
  getConfiguredAttachmentStorage,
} from '@/lib/attachments';
import { getPrismaClient } from '@/lib/database';
import { logEvent } from '@/lib/logger';

/**
 * Streams an attachment's bytes. Serving through the service keeps the same
 * bearer credential as every other read and never exposes the bucket, the
 * storage credentials, or a shareable pre-signed link to callers.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  if (!attachmentsEnabled()) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const unauthorized = authorizeEmailV2(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { attachmentId: rawAttachmentId } = await context.params;
  if (!isUuid(rawAttachmentId)) {
    return Response.json({ error: 'Invalid attachment ID' }, { status: 400 });
  }
  const attachmentId = rawAttachmentId.toLowerCase();

  const attachment = await getPrismaClient().emailAttachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }
  if (attachment.state !== 'STORED') {
    return Response.json(
      {
        error:
          attachment.state === 'PENDING'
            ? 'Attachment is still being stored'
            : 'Attachment could not be stored',
        state: attachment.state.toLowerCase(),
      },
      { status: 409 },
    );
  }

  try {
    const object = await getConfiguredAttachmentStorage().get(
      attachment.storageKey,
    );
    return new Response(
      Readable.toWeb(object.body) as unknown as ReadableStream,
      {
        status: 200,
        headers: {
          'content-type': attachment.contentType,
          'content-disposition': buildContentDisposition(attachment.filename),
          ...(object.contentLength
            ? { 'content-length': String(object.contentLength) }
            : {}),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      },
    );
  } catch (error) {
    if (error instanceof AttachmentStorageError && error.notFound) {
      return Response.json({ error: 'Attachment not found' }, { status: 404 });
    }
    logEvent('error', 'attachment_download_failed', {
      error_type: error instanceof Error ? error.name : 'unknown_error',
    });
    return Response.json(
      { error: 'Failed to read attachment' },
      { status: 502 },
    );
  }
}

/**
 * Filenames come from remote senders. The ASCII fallback is stripped to a
 * quote-free, control-free token and the exact name is carried in the RFC 5987
 * form so a hostile name cannot inject header syntax.
 */
export function buildContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename,
  )}`;
}
