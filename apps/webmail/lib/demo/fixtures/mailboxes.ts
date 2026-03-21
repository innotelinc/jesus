import type { Mailbox } from '@/lib/jmap/types';

const RIGHTS_SYSTEM = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: false, mayDelete: false, maySubmit: true };
const RIGHTS_CUSTOM = { ...RIGHTS_SYSTEM, mayRename: true, mayDelete: true };

export function createDemoMailboxes(): Mailbox[] {
  return [
    { id: 'demo-mailbox-inbox', name: 'Inbox', role: 'inbox', sortOrder: 1, totalEmails: 12, unreadEmails: 5, totalThreads: 10, unreadThreads: 4, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-sent', name: 'Sent', role: 'sent', sortOrder: 2, totalEmails: 8, unreadEmails: 0, totalThreads: 8, unreadThreads: 0, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-drafts', name: 'Drafts', role: 'drafts', sortOrder: 3, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-trash', name: 'Trash', role: 'trash', sortOrder: 5, totalEmails: 2, unreadEmails: 0, totalThreads: 2, unreadThreads: 0, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-archive', name: 'Archive', role: 'archive', sortOrder: 4, totalEmails: 4, unreadEmails: 0, totalThreads: 4, unreadThreads: 0, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-junk', name: 'Spam', role: 'junk', sortOrder: 6, totalEmails: 3, unreadEmails: 1, totalThreads: 3, unreadThreads: 1, myRights: RIGHTS_SYSTEM, isSubscribed: true },
    { id: 'demo-mailbox-projects', name: 'Projects', sortOrder: 10, totalEmails: 5, unreadEmails: 2, totalThreads: 5, unreadThreads: 2, myRights: RIGHTS_CUSTOM, isSubscribed: true },
    { id: 'demo-mailbox-receipts', name: 'Receipts', sortOrder: 11, totalEmails: 3, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, myRights: RIGHTS_CUSTOM, isSubscribed: true },
  ];
}
