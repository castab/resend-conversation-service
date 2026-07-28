import { randomUUID } from 'node:crypto';

const ROUTING_TAG_PREFIX = 'c_';
const ROUTING_TOKEN_LENGTH = 32;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

interface MailboxParts {
  local: string;
  domain: string;
}

export interface RoutingCandidate {
  routingToken: string;
  baseAddress: string;
}

function parseBaseMailbox(address: string): MailboxParts | null {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (
    at <= 0 ||
    at === normalized.length - 1 ||
    normalized.includes('<') ||
    normalized.includes('>') ||
    normalized.slice(0, at).includes('+')
  ) {
    return null;
  }

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const generatedLocalLength =
    local.length + 1 + ROUTING_TAG_PREFIX.length + ROUTING_TOKEN_LENGTH;
  const domainLabels = domain.split('.');
  if (
    !/^[a-z0-9.!#$%&'*/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    generatedLocalLength > 64 ||
    domain.length > 253 ||
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) ||
    generatedLocalLength + domain.length + 1 > 254
  ) {
    return null;
  }
  return { local, domain };
}

export function isValidReplyToBaseAddress(address: string): boolean {
  return parseBaseMailbox(address) !== null;
}

export function createRoutingToken(): string {
  return randomUUID();
}

export function buildConversationReplyTo(
  baseAddress: string,
  routingToken: string,
): string {
  const base = parseBaseMailbox(baseAddress);
  const token = routingToken.replaceAll('-', '').toLowerCase();
  if (!base || !TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid conversation Reply-To configuration');
  }
  return `${base.local}+${ROUTING_TAG_PREFIX}${token}@${base.domain}`;
}

export function extractRoutingTokens(
  addresses: readonly string[],
  baseAddress: string,
): string[] {
  const base = parseBaseMailbox(baseAddress);
  if (!base) {
    throw new Error('Invalid conversation Reply-To configuration');
  }

  const prefix = `${base.local}+${ROUTING_TAG_PREFIX}`;
  const tokens = new Set<string>();
  for (const rawAddress of addresses) {
    const address = rawAddress.trim().toLowerCase();
    const at = address.lastIndexOf('@');
    if (at <= 0 || address.slice(at + 1) !== base.domain) {
      continue;
    }
    const local = address.slice(0, at);
    if (!local.startsWith(prefix)) {
      continue;
    }
    const token = local.slice(prefix.length);
    if (TOKEN_PATTERN.test(token)) {
      tokens.add(
        `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`,
      );
    }
  }
  return [...tokens];
}

export function extractRoutingCandidates(
  addresses: readonly string[],
): RoutingCandidate[] {
  const candidates = new Map<string, RoutingCandidate>();
  for (const rawAddress of addresses) {
    const address = rawAddress.trim().toLowerCase();
    const at = address.lastIndexOf('@');
    const marker = address.lastIndexOf(`+${ROUTING_TAG_PREFIX}`, at);
    if (at <= 0 || marker <= 0) {
      continue;
    }
    const token = address.slice(marker + ROUTING_TAG_PREFIX.length + 1, at);
    const baseAddress = `${address.slice(0, marker)}@${address.slice(at + 1)}`;
    if (!TOKEN_PATTERN.test(token) || !parseBaseMailbox(baseAddress)) {
      continue;
    }
    const routingToken = `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
    candidates.set(`${routingToken}:${baseAddress}`, {
      routingToken,
      baseAddress,
    });
  }
  return [...candidates.values()];
}
