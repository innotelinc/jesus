import type { Mailbox } from '@/lib/jmap/types';

/**
 * `searchMailboxId` of the "All folders" search scope: every folder of every
 * account, Trash and Junk included. The default scope, "" ("All folders
 * except Spam and Trash"), leaves those two out. JMAP ids never contain "*",
 * so this cannot collide with a folder id.
 */
export const SEARCH_SCOPE_ALL_FOLDERS = '*';

/**
 * Whether `searchMailboxId` searches across folders (the default scope or
 * "All folders") rather than inside the one folder picked in the dropdown.
 */
export function isAllFoldersSearchScope(searchMailboxId: string): boolean {
  return searchMailboxId === '' || searchMailboxId === SEARCH_SCOPE_ALL_FOLDERS;
}

export interface SearchScopeFolderGroup {
  /** Owner JMAP account id; the React key. */
  ownerId: string;
  /** Owner account label (`accountName`, else the owner id). */
  label: string;
  mailboxes: Mailbox[];
}

/**
 * Splits the sidebar's folder list into the login's own folders and the
 * group/shared folders grouped by their owner account, for the search
 * panel's Folder dropdown.
 *
 * Shared folders carry their owner's name in the sidebar, but the flat
 * dropdown listed them by bare name, so a group's "Inbox" was
 * indistinguishable from the user's own (#1082).
 */
export function groupSearchScopeFolders(
  mailboxes: Mailbox[],
): { own: Mailbox[]; shared: SearchScopeFolderGroup[] } {
  const own: Mailbox[] = [];
  const byOwner = new Map<string, SearchScopeFolderGroup>();
  for (const mailbox of mailboxes) {
    if (!mailbox.isShared) {
      own.push(mailbox);
      continue;
    }
    const ownerId = mailbox.accountId ?? '';
    let group = byOwner.get(ownerId);
    if (!group) {
      group = { ownerId, label: mailbox.accountName || ownerId, mailboxes: [] };
      byOwner.set(ownerId, group);
    }
    group.mailboxes.push(mailbox);
  }
  return { own, shared: Array.from(byOwner.values()) };
}
