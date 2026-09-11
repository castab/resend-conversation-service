import { authorizeEmailV2 } from '@/lib/api';
import {
  AttachmentStorageError,
  attachmentsEnabled,
  buildContentDisposition,
  getConfiguredAttachmentStorage,
  resolveAttachmentPresignedUrlTtlSeconds,
  resolveStoredAttachment,
} from '@/lib/attachments';
import { logEvent } from '@/lib/logger';

/**
 * Issues a short-lived bearer capability only after service authorization and
 * attachment/object validation. The URL is returned once and never persisted
 * or included in operational logs.
 */
export async function POST(
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

  const { attachmentId } = await context.params;
  const resolved = await resolveStoredAttachment(attachmentId);
  if ('response' in resolved) {
    return resolved.response;
  }
  const { attachment } = resolved;

  try {
    const storage = getConfiguredAttachmentStorage();
    await storage.head(attachment.storageKey);

    const expiresInSeconds = resolveAttachmentPresignedUrlTtlSeconds();
    const signingDate = new Date();
    signingDate.setUTCMilliseconds(0);
    const downloadUrl = await storage.presignGet(attachment.storageKey, {
      contentType: attachment.contentType,
      contentDisposition: buildContentDisposition(attachment.filename),
      expiresInSeconds,
      signingDate,
    });
    return Response.json(
      {
        downloadUrl,
        expiresAt: new Date(
          signingDate.getTime() + expiresInSeconds * 1_000,
        ).toISOString(),
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof AttachmentStorageError && error.notFound) {
      return Response.json({ error: 'Attachment not found' }, { status: 404 });
    }
    logEvent('error', 'attachment_download_url_failed', {
      error_type: error instanceof Error ? error.name : 'unknown_error',
    });
    return Response.json(
      { error: 'Failed to create attachment download URL' },
      { status: 502 },
    );
  }
}
