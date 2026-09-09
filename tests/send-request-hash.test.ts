import { afterEach, describe, expect, it } from 'vitest';
import { hashSendRequest } from '@/lib/email';
import {
  validateCreateV2Body,
  validateDirectEmailV2Body,
  validateMessageV2Body,
} from '@/lib/send-validation';

/**
 * `request_hash` is persisted next to every idempotency key, and a replay is
 * only honoured when the recomputed hash matches the stored one. A hash that
 * shifts between releases turns a client's legitimate retry into a spurious
 * `409`, and the damage is delayed: it appears after an upgrade, on traffic
 * that was accepted before it.
 *
 * These vectors were computed against 0.7.1, before attachments existed. They
 * are a wire-format contract, not an implementation detail. If a change here
 * makes them fail, the fix is almost never to update the constants -- it is to
 * stop perturbing the normalized value for request shapes that already exist.
 */
const OPENING_V2 = {
  body: {
    topic: { type: 'order', externalId: 'o-1', title: 'Order 1' },
    participant: { email: 'person@example.com', name: 'Person' },
    message: {
      text: 'hello',
      from: { address: 'system@example.com', name: 'System' },
      replyTo: { address: 'mailbox@replies.example.com' },
    },
  },
  hash: '897d5144c57467584169a688c93a3ebc7b7efc309646c635f8b086c6b3cd00e3',
};

const REPLY_V2 = {
  body: {
    text: 'reply',
    from: { address: 'system@example.com', name: 'System' },
    replyTo: { address: 'mailbox@replies.example.com' },
  },
  hash: '24e537480a10c1e827af501a3a1ccdab4da88d1054f05cbc28fa5f54dbb7db51',
};

const DIRECT_EMAIL_V2 = {
  body: {
    from: { address: 'system@example.com', name: 'System' },
    to: { address: 'person@example.com' },
    subject: 'Verify',
    text: 'link',
  },
  hash: '339b0fa7717083a6638fc880952d7fd5aa536f51e6a57219da95f155cc6d67ae',
};

function hashOf(operation: string, value: unknown) {
  return hashSendRequest({ operation, request: value });
}

function unwrap<T>(result: { value: T } | { error: string }): T {
  if ('error' in result) {
    throw new Error(`expected the body to validate: ${result.error}`);
  }
  return result.value;
}

describe('send request hashing', () => {
  const previous = process.env.ATTACHMENTS_ENABLED;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ATTACHMENTS_ENABLED;
    } else {
      process.env.ATTACHMENTS_ENABLED = previous;
    }
  });

  it('hashes pre-attachment request shapes exactly as 0.7.1 did', () => {
    delete process.env.ATTACHMENTS_ENABLED;

    expect(
      hashOf('opening-v2', unwrap(validateCreateV2Body(OPENING_V2.body))),
    ).toBe(OPENING_V2.hash);
    expect(
      hashOf('reply-v2', unwrap(validateMessageV2Body(REPLY_V2.body))),
    ).toBe(REPLY_V2.hash);
    expect(
      hashOf(
        'direct-email-v2',
        unwrap(validateDirectEmailV2Body(DIRECT_EMAIL_V2.body)),
      ),
    ).toBe(DIRECT_EMAIL_V2.hash);
  });

  // Turning the feature on must not invalidate idempotency records written
  // while it was off, so enabling it may not perturb an attachment-free body.
  it('keeps those hashes stable when attachments are enabled', () => {
    process.env.ATTACHMENTS_ENABLED = 'true';

    expect(
      hashOf('opening-v2', unwrap(validateCreateV2Body(OPENING_V2.body))),
    ).toBe(OPENING_V2.hash);
    expect(
      hashOf('reply-v2', unwrap(validateMessageV2Body(REPLY_V2.body))),
    ).toBe(REPLY_V2.hash);
    expect(
      hashOf(
        'direct-email-v2',
        unwrap(validateDirectEmailV2Body(DIRECT_EMAIL_V2.body)),
      ),
    ).toBe(DIRECT_EMAIL_V2.hash);
  });

  // The mirror image: attachments must participate in the hash. If they did
  // not, reusing a key with different attachments would replay the original
  // send and report success for a document that was never delivered.
  it('separates otherwise identical requests by their attachments', () => {
    process.env.ATTACHMENTS_ENABLED = 'true';
    const first = '019200aa-0000-7000-8000-0000000000a1';
    const second = '019200aa-0000-7000-8000-0000000000a2';

    const withoutAttachments = hashOf(
      'direct-email-v2',
      unwrap(validateDirectEmailV2Body(DIRECT_EMAIL_V2.body)),
    );
    const withFirst = hashOf(
      'direct-email-v2',
      unwrap(
        validateDirectEmailV2Body({
          ...DIRECT_EMAIL_V2.body,
          attachments: [{ id: first }],
        }),
      ),
    );
    const withSecond = hashOf(
      'direct-email-v2',
      unwrap(
        validateDirectEmailV2Body({
          ...DIRECT_EMAIL_V2.body,
          attachments: [{ id: second }],
        }),
      ),
    );
    const withBoth = hashOf(
      'direct-email-v2',
      unwrap(
        validateDirectEmailV2Body({
          ...DIRECT_EMAIL_V2.body,
          attachments: [{ id: first }, { id: second }],
        }),
      ),
    );

    expect(
      new Set([withoutAttachments, withFirst, withSecond, withBoth]).size,
    ).toBe(4);
  });

  // Attachment IDs are case-insensitive UUIDs, so casing alone must not look
  // like a different request.
  it('treats attachment ids case-insensitively', () => {
    process.env.ATTACHMENTS_ENABLED = 'true';
    const lower = '019200aa-0000-7000-8000-0000000000a1';

    expect(
      hashOf(
        'direct-email-v2',
        unwrap(
          validateDirectEmailV2Body({
            ...DIRECT_EMAIL_V2.body,
            attachments: [{ id: lower.toUpperCase() }],
          }),
        ),
      ),
    ).toBe(
      hashOf(
        'direct-email-v2',
        unwrap(
          validateDirectEmailV2Body({
            ...DIRECT_EMAIL_V2.body,
            attachments: [{ id: lower }],
          }),
        ),
      ),
    );
  });
});
