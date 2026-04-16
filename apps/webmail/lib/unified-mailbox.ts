import type { Email, Mailbox, UnifiedMailboxRole } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export interface UnifiedAccountClient {
  accountId: string;
  accountLabel: string;
  client: IJMAPClient;
  mailboxes: Mailbox[];
}

export interface UnifiedFetchResult {
  emails: Email[];
  total: number;
  hasMore: boolean;
  errors: Map<string, string>; // accountId -> error message
}

export interface UnifiedMailboxCounts {
  role: UnifiedMailboxRole;
  unreadEmails: number;
  totalEmails: number;
}

const ALL_UNIFIED_ROLES: UnifiedMailboxRole[] = [
  'inbox', 'sent', 'drafts', 'trash', 'archive', 'junk',
];

/**
 * Finds the first mailbox matching the given role.
 */
export function findMailboxByRole(
  mailboxes: Mailbox[],
  role: UnifiedMailboxRole,
): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role);
}

/**
 * Fetches emails from all accounts for a given unified role, merges and sorts
 * them by receivedAt descending. Per-account failures are collected in the
 * errors map while successful results are still returned.
 */
export async function fetchUnifiedEmails(
  accounts: UnifiedAccountClient[],
  role: UnifiedMailboxRole,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  const errors = new Map<string, string>();

  // Build one fetch task per account, wrapping each in a catch so we can
  // track per-account errors while still using Promise.allSettled.
  type AccountResult = {
    account: UnifiedAccountClient;
    result: { emails: Email[]; total: number; hasMore: boolean };
  } | null;

  const promises = accounts.map(
    async (account): Promise<AccountResult> => {
      const mailbox = findMailboxByRole(account.mailboxes, role);
      if (!mailbox) return null;

      try {
        const result = await account.client.getEmails(
          mailbox.id,
          undefined,
          limit,
          position,
        );
        return { account, result };
      } catch (err) {
        errors.set(
          account.accountId,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    },
  );

  const results = await Promise.allSettled(promises);

  let mergedEmails: Email[] = [];
  let totalSum = 0;
  let anyHasMore = false;

  for (const outcome of results) {
    if (outcome.status !== 'fulfilled' || outcome.value === null) continue;

    const { account, result } = outcome.value;

    // Decorate each email with the source account info.
    for (const email of result.emails) {
      email.accountId = account.accountId;
      email.accountLabel = account.accountLabel;
    }

    mergedEmails = mergedEmails.concat(result.emails);
    totalSum += result.total;
    if (result.hasMore) {
      anyHasMore = true;
    }
  }

  // Sort merged emails by receivedAt descending.
  mergedEmails.sort((a, b) => {
    const dateA = new Date(a.receivedAt).getTime();
    const dateB = new Date(b.receivedAt).getTime();
    return dateB - dateA;
  });

  return {
    emails: mergedEmails,
    total: totalSum,
    hasMore: anyHasMore,
    errors,
  };
}

/**
 * Aggregates unread and total email counts across all accounts for each
 * unified mailbox role. Only includes roles that exist in at least one account.
 */
export function fetchUnifiedMailboxCounts(
  accounts: UnifiedAccountClient[],
): UnifiedMailboxCounts[] {
  const counts: UnifiedMailboxCounts[] = [];

  for (const role of ALL_UNIFIED_ROLES) {
    let unreadEmails = 0;
    let totalEmails = 0;
    let found = false;

    for (const account of accounts) {
      const mailbox = findMailboxByRole(account.mailboxes, role);
      if (mailbox) {
        found = true;
        unreadEmails += mailbox.unreadEmails;
        totalEmails += mailbox.totalEmails;
      }
    }

    if (found) {
      counts.push({ role, unreadEmails, totalEmails });
    }
  }

  return counts;
}

/**
 * Returns the list of unified roles that exist in at least one account's
 * mailboxes.
 */
export function getUnifiedRoles(
  accounts: UnifiedAccountClient[],
): UnifiedMailboxRole[] {
  const roles: UnifiedMailboxRole[] = [];

  for (const role of ALL_UNIFIED_ROLES) {
    for (const account of accounts) {
      if (findMailboxByRole(account.mailboxes, role)) {
        roles.push(role);
        break;
      }
    }
  }

  return roles;
}
