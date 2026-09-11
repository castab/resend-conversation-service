import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type ProviderOperation,
  recordProviderRequest,
} from '@/lib/telemetry-metrics';
import {
  type AttachmentStorageConfig,
  resolveAttachmentStorageConfig,
} from './config';

const STORAGE_TIMEOUT_MS = 30_000;

export class AttachmentStorageError extends Error {
  constructor(
    message: string,
    readonly operation: ProviderOperation,
    readonly code: string,
    readonly notFound = false,
  ) {
    super(message);
    this.name = 'AttachmentStorageError';
  }
}

export interface AttachmentStorage {
  readonly bucket: string;
  buildKey(id: string): string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Readable; contentLength: number | null }>;
  getBuffer(key: string): Promise<Buffer>;
  head(key: string): Promise<void>;
  presignGet(
    key: string,
    options: {
      contentType: string;
      contentDisposition: string;
      expiresInSeconds: number;
      signingDate: Date;
    },
  ): Promise<string>;
  delete(key: string): Promise<void>;
  headBucket(): Promise<void>;
}

export function createAttachmentStorage(
  config: AttachmentStorageConfig,
): AttachmentStorage {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    requestHandler: { requestTimeout: STORAGE_TIMEOUT_MS },
  });

  async function run<T>(
    operation: ProviderOperation,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    let outcome: 'success' | 'failure' = 'failure';
    let statusClass: 'none' | '2xx' | '4xx' | '5xx' = 'none';
    try {
      const result = await execute(AbortSignal.timeout(STORAGE_TIMEOUT_MS));
      outcome = 'success';
      statusClass = '2xx';
      return result;
    } catch (error) {
      const status = statusCodeOf(error);
      statusClass = responseStatusClass(status);
      throw new AttachmentStorageError(
        `Attachment storage ${operation} failed`,
        operation,
        errorCodeOf(error, status),
        status === 404 || errorCodeOf(error, status) === 'NoSuchKey',
      );
    } finally {
      recordProviderRequest(
        (performance.now() - startedAt) / 1_000,
        operation,
        outcome,
        statusClass,
      );
    }
  }

  return {
    bucket: config.bucket,
    buildKey(id) {
      return `${config.keyPrefix}${id}`;
    },
    async put(key, body, contentType) {
      await run('storage_put', (abortSignal) =>
        client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
          { abortSignal },
        ),
      );
    },
    async get(key) {
      const result = await run('storage_get', (abortSignal) =>
        client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
          abortSignal,
        }),
      );
      if (!result.Body) {
        throw new AttachmentStorageError(
          'Attachment storage returned an empty body',
          'storage_get',
          'empty_body',
          true,
        );
      }
      return {
        body: result.Body as Readable,
        contentLength: result.ContentLength ?? null,
      };
    },
    async getBuffer(key) {
      const { body } = await this.get(key);
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async head(key) {
      await run('storage_head_object', (abortSignal) =>
        client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal },
        ),
      );
    },
    presignGet(key, options) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ResponseCacheControl: 'private, no-store',
          ResponseContentDisposition: options.contentDisposition,
          ResponseContentType: options.contentType,
        }),
        {
          expiresIn: options.expiresInSeconds,
          signingDate: options.signingDate,
        },
      );
    },
    async delete(key) {
      await run('storage_delete', (abortSignal) =>
        client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal },
        ),
      );
    },
    async headBucket() {
      await run('storage_head_bucket', (abortSignal) =>
        client.send(new HeadBucketCommand({ Bucket: config.bucket }), {
          abortSignal,
        }),
      );
    },
  };
}

let configured: AttachmentStorage | undefined;

export function getConfiguredAttachmentStorage(): AttachmentStorage {
  configured ??= createAttachmentStorage(resolveAttachmentStorageConfig());
  return configured;
}

function statusCodeOf(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    typeof error.$metadata.httpStatusCode === 'number'
  ) {
    return error.$metadata.httpStatusCode;
  }
  return 0;
}

function errorCodeOf(error: unknown, status: number): string {
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return error.name;
  }
  return status ? `http_${status}` : 'unknown_error';
}

function responseStatusClass(status: number): 'none' | '2xx' | '4xx' | '5xx' {
  if (status >= 200 && status < 300) {
    return '2xx';
  }
  if (status >= 400 && status < 500) {
    return '4xx';
  }
  if (status >= 500 && status < 600) {
    return '5xx';
  }
  return 'none';
}
