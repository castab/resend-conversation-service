import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  MAX_PRESIGNED_URL_TTL_SECONDS,
  resolveAttachmentPresignedUrlTtlSeconds,
} from '@/lib/attachments/config';

describe('attachment presigned URL configuration', () => {
  it('defaults to five minutes', () => {
    expect(resolveAttachmentPresignedUrlTtlSeconds({})).toBe(
      DEFAULT_PRESIGNED_URL_TTL_SECONDS,
    );
    expect(DEFAULT_PRESIGNED_URL_TTL_SECONDS).toBe(300);
  });

  it('accepts only integer lifetimes within the hard limit', () => {
    expect(
      resolveAttachmentPresignedUrlTtlSeconds({
        ATTACHMENTS_PRESIGNED_URL_TTL_SECONDS: '1',
      }),
    ).toBe(1);
    expect(
      resolveAttachmentPresignedUrlTtlSeconds({
        ATTACHMENTS_PRESIGNED_URL_TTL_SECONDS: '900',
      }),
    ).toBe(MAX_PRESIGNED_URL_TTL_SECONDS);

    for (const value of ['0', '901', '1.5', 'invalid']) {
      expect(() =>
        resolveAttachmentPresignedUrlTtlSeconds({
          ATTACHMENTS_PRESIGNED_URL_TTL_SECONDS: value,
        }),
      ).toThrow(/must be an integer between 1 and 900/);
    }
  });
});
