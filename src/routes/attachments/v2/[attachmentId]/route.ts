import { Readable } from 'node:stream';
import { authorizeEmailV2 } from '@/lib/api';
import {
  AttachmentStorageError,
  attachmentsEnabled,
  buildContentDisposition,
  getConfiguredAttachmentStorage,
  resolveStoredAttachment,
} from '@/lib/attachments';
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
  const resolved = await resolveStoredAttachment(rawAttachmentId);
  if ('response' in resolved) {
    return resolved.response;
  }
  const { attachment } = resolved;

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
