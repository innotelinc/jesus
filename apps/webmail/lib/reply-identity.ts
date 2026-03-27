import type { Identity } from '@/lib/jmap/types';

interface ReplyRecipient {
  email?: string | null;
}

interface ReplyRecipients {
  to?: ReplyRecipient[];
  cc?: ReplyRecipient[];
  bcc?: ReplyRecipient[];
}

function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBaseEmailAddress(email: string): string {
  const normalized = normalizeEmailAddress(email);
  const atIndex = normalized.indexOf('@');

  if (atIndex <= 0) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const plusIndex = localPart.indexOf('+');

  return `${plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart}@${domain}`;
}

export function findReplyIdentityId(
  identities: Identity[],
  recipients?: ReplyRecipients,
): string | null {
  if (identities.length === 0 || !recipients) {
    return null;
  }

  const receivedAddresses = [
    ...(recipients.to || []),
    ...(recipients.cc || []),
    ...(recipients.bcc || []),
  ]
    .map((recipient) => recipient.email?.trim())
    .filter((email): email is string => Boolean(email));

  if (receivedAddresses.length === 0) {
    return null;
  }

  const exactMatches = new Set(receivedAddresses.map(normalizeEmailAddress));
  const exactIdentity = identities.find((identity) => exactMatches.has(normalizeEmailAddress(identity.email)));
  if (exactIdentity) {
    return exactIdentity.id;
  }

  const baseMatches = new Set(receivedAddresses.map(normalizeBaseEmailAddress));
  const baseIdentity = identities.find((identity) => baseMatches.has(normalizeBaseEmailAddress(identity.email)));

  return baseIdentity?.id ?? null;
}