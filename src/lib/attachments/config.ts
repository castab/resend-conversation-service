export const DEFAULT_MAX_ATTACHMENT_BYTES = 26_214_400;
export const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 29_360_128;
export const DEFAULT_MAX_ATTACHMENT_COUNT = 20;

export interface AttachmentStorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
  keyPrefix: string;
}

export interface AttachmentLimits {
  maxBytes: number;
  maxTotalBytes: number;
  maxCount: number;
}

export function attachmentsEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (environment.ATTACHMENTS_ENABLED ?? '').trim().toLowerCase() === 'true'
  );
}

export function resolveAttachmentLimits(
  environment: NodeJS.ProcessEnv = process.env,
): AttachmentLimits {
  return {
    maxBytes: readPositiveInteger(
      environment.ATTACHMENTS_MAX_BYTES,
      DEFAULT_MAX_ATTACHMENT_BYTES,
    ),
    maxTotalBytes: readPositiveInteger(
      environment.ATTACHMENTS_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    ),
    maxCount: readPositiveInteger(
      environment.ATTACHMENTS_MAX_COUNT,
      DEFAULT_MAX_ATTACHMENT_COUNT,
    ),
  };
}

export function resolveAttachmentStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AttachmentStorageConfig {
  const bucket = environment.ATTACHMENTS_S3_BUCKET?.trim();
  const region = environment.ATTACHMENTS_S3_REGION?.trim();
  const accessKeyId = environment.ATTACHMENTS_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.ATTACHMENTS_S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing attachment storage configuration');
  }

  const endpoint = environment.ATTACHMENTS_S3_ENDPOINT?.trim();
  const keyPrefix = normalizeKeyPrefix(environment.ATTACHMENTS_S3_KEY_PREFIX);
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle:
      (environment.ATTACHMENTS_S3_FORCE_PATH_STYLE ?? '')
        .trim()
        .toLowerCase() === 'true',
    keyPrefix,
  };
}

function normalizeKeyPrefix(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number((value ?? '').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
