import type { EmailAttachment } from '@/lib/database';
import { getPrismaClient } from '@/lib/database';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveStoredAttachment(
  rawAttachmentId: string,
): Promise<{ attachment: EmailAttachment } | { response: Response }> {
  if (!UUID_PATTERN.test(rawAttachmentId)) {
    return {
      response: Response.json(
        { error: 'Invalid attachment ID' },
        { status: 400 },
      ),
    };
  }

  const attachment = await getPrismaClient().emailAttachment.findUnique({
    where: { id: rawAttachmentId.toLowerCase() },
  });
  if (!attachment) {
    return {
      response: Response.json(
        { error: 'Attachment not found' },
        { status: 404 },
      ),
    };
  }
  if (attachment.state !== 'STORED') {
    return {
      response: Response.json(
        {
          error:
            attachment.state === 'PENDING'
              ? 'Attachment is still being stored'
              : 'Attachment could not be stored',
          state: attachment.state.toLowerCase(),
        },
        { status: 409 },
      ),
    };
  }
  return { attachment };
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
