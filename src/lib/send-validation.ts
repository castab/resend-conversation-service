import {
  isEmailAddress,
  isHeaderSafeText,
  isRecord,
  isUuid,
  MAX_BODY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TITLE_LENGTH,
} from './api';
import { isValidReplyToBaseAddress } from './email';

export type EmailIdentityInput = {
  address: string;
  name: string | null;
};

export type CreateConversationInput = {
  topic: { type: string; externalId: string; title: string };
  participant: { email: string; name: string | null };
  subject?: string;
  message: { text?: string; html?: string; replyToName?: string };
};

export type CreateConversationV2Input = Omit<
  CreateConversationInput,
  'message'
> & {
  message: Omit<CreateConversationInput['message'], 'replyToName'> & {
    from: EmailIdentityInput;
    replyTo: EmailIdentityInput;
  };
};

export type MessageV2Input = {
  text?: string;
  html?: string;
  replyToMessageId?: string;
  from: EmailIdentityInput;
  replyTo: EmailIdentityInput;
};

export type DirectEmailV2Input = {
  from: EmailIdentityInput;
  to: EmailIdentityInput;
  subject: string;
  text?: string;
  html?: string;
};

function normalizeReplyToName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isHeaderSafeText(value, MAX_NAME_LENGTH)) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return /[<>]/.test(normalized) ? undefined : normalized;
}

export function validateCreateBody(
  value: unknown,
): { value: CreateConversationInput } | { error: string } {
  if (
    !isRecord(value) ||
    !isRecord(value.topic) ||
    !isRecord(value.participant)
  ) {
    return { error: 'topic and participant objects are required' };
  }
  const topic = value.topic;
  const participant = value.participant;
  const message = isRecord(value.message) ? value.message : {};
  if (
    typeof topic.type !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(topic.type) ||
    typeof topic.externalId !== 'string' ||
    !topic.externalId ||
    topic.externalId.length > 255 ||
    !isHeaderSafeText(topic.title, MAX_TITLE_LENGTH) ||
    !topic.title.trim()
  ) {
    return { error: 'topic type, externalId, and title are invalid' };
  }
  if (!isEmailAddress(participant.email)) {
    return { error: 'participant.email must be a valid email address' };
  }
  if (
    participant.name !== undefined &&
    participant.name !== null &&
    !isHeaderSafeText(participant.name, MAX_NAME_LENGTH)
  ) {
    return { error: 'participant.name is invalid' };
  }
  const text = typeof message.text === 'string' ? message.text : undefined;
  const html = typeof message.html === 'string' ? message.html : undefined;
  const replyToName = normalizeReplyToName(message.replyToName);
  if (replyToName === undefined) {
    return {
      error:
        'message.replyToName must be a header-safe string of at most 256 characters',
    };
  }
  if (!text && !html) {
    return { error: 'message.text or message.html is required' };
  }
  if (
    (text?.length ?? 0) > MAX_BODY_LENGTH ||
    (html?.length ?? 0) > MAX_BODY_LENGTH
  ) {
    return { error: 'message.text and message.html are limited to 1 MiB each' };
  }
  if (
    value.subject !== undefined &&
    !isHeaderSafeText(value.subject, MAX_SUBJECT_LENGTH)
  ) {
    return {
      error: 'subject must be a header-safe string of at most 255 characters',
    };
  }
  return {
    value: {
      topic: {
        type: topic.type,
        externalId: topic.externalId,
        title: topic.title.trim(),
      },
      participant: {
        email: participant.email,
        name:
          typeof participant.name === 'string' && participant.name.trim()
            ? participant.name.trim()
            : null,
      },
      ...(typeof value.subject === 'string' && value.subject.trim()
        ? { subject: value.subject.trim() }
        : {}),
      message: {
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(replyToName ? { replyToName } : {}),
      },
    },
  };
}

export function validateMessageBody(value: unknown):
  | {
      value: {
        text?: string;
        html?: string;
        replyToMessageId?: string;
        replyToName?: string;
      };
    }
  | { error: string } {
  if (!isRecord(value)) {
    return { error: 'Request body must be an object' };
  }
  const text = typeof value.text === 'string' ? value.text : undefined;
  const html = typeof value.html === 'string' ? value.html : undefined;
  const replyToName = normalizeReplyToName(value.replyToName);
  if (replyToName === undefined) {
    return {
      error:
        'replyToName must be a header-safe string of at most 256 characters',
    };
  }
  if (!text && !html) {
    return { error: 'text or html is required' };
  }
  if (
    (text?.length ?? 0) > MAX_BODY_LENGTH ||
    (html?.length ?? 0) > MAX_BODY_LENGTH
  ) {
    return { error: 'text and html are limited to 1 MiB each' };
  }
  if (
    value.replyToMessageId !== undefined &&
    (typeof value.replyToMessageId !== 'string' ||
      !isUuid(value.replyToMessageId))
  ) {
    return { error: 'replyToMessageId must be a UUID' };
  }
  return {
    value: {
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      ...(typeof value.replyToMessageId === 'string'
        ? { replyToMessageId: value.replyToMessageId }
        : {}),
      ...(replyToName ? { replyToName } : {}),
    },
  };
}

function normalizeEmailIdentity(
  value: unknown,
  field: string,
  replyTo: boolean,
): { value: EmailIdentityInput } | { error: string } {
  if (!isRecord(value) || typeof value.address !== 'string') {
    return { error: `${field}.address must be a valid email address` };
  }
  const address = value.address.trim().toLowerCase();
  if (
    !isEmailAddress(address) ||
    (replyTo && !isValidReplyToBaseAddress(address))
  ) {
    return {
      error: replyTo
        ? `${field}.address must be an untagged Reply-To base address`
        : `${field}.address must be a valid email address`,
    };
  }
  if (
    value.name !== undefined &&
    value.name !== null &&
    (!isHeaderSafeText(value.name, MAX_NAME_LENGTH) || /[<>]/.test(value.name))
  ) {
    return {
      error: `${field}.name must be a header-safe string of at most 256 characters`,
    };
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  return { value: { address, name: name || null } };
}

export function validateCreateV2Body(
  value: unknown,
): { value: CreateConversationV2Input } | { error: string } {
  const base = validateCreateBody(value);
  if ('error' in base) {
    return base;
  }
  if (!isRecord(value) || !isRecord(value.message)) {
    return { error: 'message is required' };
  }
  if (value.message.replyToName !== undefined) {
    return { error: 'message.replyToName is not supported in API v2' };
  }
  const from = normalizeEmailIdentity(
    value.message.from,
    'message.from',
    false,
  );
  if ('error' in from) {
    return from;
  }
  const replyTo = normalizeEmailIdentity(
    value.message.replyTo,
    'message.replyTo',
    true,
  );
  if ('error' in replyTo) {
    return replyTo;
  }
  return {
    value: {
      topic: base.value.topic,
      participant: base.value.participant,
      ...(base.value.subject ? { subject: base.value.subject } : {}),
      message: {
        ...(base.value.message.text ? { text: base.value.message.text } : {}),
        ...(base.value.message.html ? { html: base.value.message.html } : {}),
        from: from.value,
        replyTo: replyTo.value,
      },
    },
  };
}

export function validateMessageV2Body(
  value: unknown,
): { value: MessageV2Input } | { error: string } {
  const base = validateMessageBody(value);
  if ('error' in base) {
    return base;
  }
  if (!isRecord(value)) {
    return { error: 'Request body must be an object' };
  }
  if (value.replyToName !== undefined) {
    return { error: 'replyToName is not supported in API v2' };
  }
  const from = normalizeEmailIdentity(value.from, 'from', false);
  if ('error' in from) {
    return from;
  }
  const replyTo = normalizeEmailIdentity(value.replyTo, 'replyTo', true);
  if ('error' in replyTo) {
    return replyTo;
  }
  return {
    value: {
      ...(base.value.text ? { text: base.value.text } : {}),
      ...(base.value.html ? { html: base.value.html } : {}),
      ...(base.value.replyToMessageId
        ? { replyToMessageId: base.value.replyToMessageId }
        : {}),
      from: from.value,
      replyTo: replyTo.value,
    },
  };
}

export function validateDirectEmailV2Body(
  value: unknown,
): { value: DirectEmailV2Input } | { error: string } {
  if (!isRecord(value)) {
    return { error: 'Request body must be an object' };
  }
  if (value.replyTo !== undefined) {
    return { error: 'replyTo is not supported for direct email' };
  }

  const from = normalizeEmailIdentity(value.from, 'from', false);
  if ('error' in from) {
    return from;
  }
  const to = normalizeEmailIdentity(value.to, 'to', false);
  if ('error' in to) {
    return to;
  }
  if (
    !isHeaderSafeText(value.subject, MAX_SUBJECT_LENGTH) ||
    !value.subject.trim()
  ) {
    return {
      error:
        'subject must be a nonempty header-safe string of at most 255 characters',
    };
  }

  if (
    value.text !== undefined &&
    (typeof value.text !== 'string' || !value.text)
  ) {
    return { error: 'text must be a nonempty string when provided' };
  }
  if (
    value.html !== undefined &&
    (typeof value.html !== 'string' || !value.html)
  ) {
    return { error: 'html must be a nonempty string when provided' };
  }
  const text = typeof value.text === 'string' ? value.text : undefined;
  const html = typeof value.html === 'string' ? value.html : undefined;
  if (!text && !html) {
    return { error: 'text or html is required' };
  }
  if (
    (text?.length ?? 0) > MAX_BODY_LENGTH ||
    (html?.length ?? 0) > MAX_BODY_LENGTH
  ) {
    return { error: 'text and html are limited to 1 MiB each' };
  }

  return {
    value: {
      from: from.value,
      to: to.value,
      subject: value.subject.trim(),
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
    },
  };
}
