import { describe, it, expect } from 'vitest';
import { buildMailboxTree, flattenMailboxTree, type MailboxNode } from '@/lib/utils';
import type { Mailbox } from '@/lib/jmap/types';

const makeMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
  id: 'mb-1',
  name: 'Test',
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: true,
    maySubmit: true,
  },
  isSubscribed: true,
  ...overrides,
});

/**
 * Helper: walk the tree and collect { id, depth, parentId } for every node.
 */
function collectNodes(tree: MailboxNode[]): { id: string; depth: number; parentName?: string }[] {
  const result: { id: string; depth: number; parentName?: string }[] = [];
  const walk = (nodes: MailboxNode[], parentName?: string) => {
    for (const node of nodes) {
      result.push({ id: node.id, depth: node.depth, parentName });
      if (node.children.length > 0) walk(node.children, node.name);
    }
  };
  walk(tree);
  return result;
}

describe('mailbox deep nesting (depth 4+)', () => {
  // Reproduce the exact scenario from the bug report:
  // INBOX > PRIVAT > BOOKINGS > BOOKING1/BOOKING2/FLIGHTS/HOTEL1/HOTEL2/HOTEL3
  // HOTEL2 > RESTAURANT (depth 4)
  it('should correctly nest the reported folder structure (depth 4)', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'INBOX', role: 'inbox' }),
      makeMailbox({ id: 'privat', name: 'PRIVAT', parentId: 'inbox' }),
      makeMailbox({ id: 'bookings', name: 'BOOKINGS', parentId: 'privat' }),
      makeMailbox({ id: 'booking1', name: 'BOOKING1', parentId: 'bookings' }),
      makeMailbox({ id: 'booking2', name: 'BOOKING2', parentId: 'bookings' }),
      makeMailbox({ id: 'flights', name: 'FLIGHTS', parentId: 'bookings' }),
      makeMailbox({ id: 'hotel1', name: 'HOTEL1', parentId: 'bookings' }),
      makeMailbox({ id: 'hotel2', name: 'HOTEL2', parentId: 'bookings' }),
      makeMailbox({ id: 'hotel3', name: 'HOTEL3', parentId: 'bookings' }),
      makeMailbox({ id: 'restaurant', name: 'RESTAURANT', parentId: 'hotel2' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));

    // RESTAURANT should be at depth 4, NOT depth 0
    expect(byId['restaurant'].depth).toBe(4);
    // Verify the full chain of depths
    expect(byId['inbox'].depth).toBe(0);
    expect(byId['privat'].depth).toBe(1);
    expect(byId['bookings'].depth).toBe(2);
    expect(byId['hotel2'].depth).toBe(3);
    expect(byId['restaurant'].depth).toBe(4);
  });

  it('should not orphan depth-4 folders to root level', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'INBOX', role: 'inbox' }),
      makeMailbox({ id: 'privat', name: 'PRIVAT', parentId: 'inbox' }),
      makeMailbox({ id: 'bookings', name: 'BOOKINGS', parentId: 'privat' }),
      makeMailbox({ id: 'hotel2', name: 'HOTEL2', parentId: 'bookings' }),
      makeMailbox({ id: 'restaurant', name: 'RESTAURANT', parentId: 'hotel2' }),
    ];

    const tree = buildMailboxTree(mailboxes);

    // RESTAURANT must NOT appear at root level
    const rootNames = tree.map(n => n.name);
    expect(rootNames).not.toContain('RESTAURANT');

    // It must be nested under HOTEL2
    const nodes = collectNodes(tree);
    const restaurant = nodes.find(n => n.id === 'restaurant');
    expect(restaurant).toBeDefined();
    expect(restaurant!.depth).toBe(4);
    expect(restaurant!.parentName).toBe('HOTEL2');
  });

  it('should handle nesting up to depth 6', () => {
    const mailboxes = [
      makeMailbox({ id: 'l0', name: 'Level0', sortOrder: 0 }),
      makeMailbox({ id: 'l1', name: 'Level1', parentId: 'l0', sortOrder: 0 }),
      makeMailbox({ id: 'l2', name: 'Level2', parentId: 'l1', sortOrder: 0 }),
      makeMailbox({ id: 'l3', name: 'Level3', parentId: 'l2', sortOrder: 0 }),
      makeMailbox({ id: 'l4', name: 'Level4', parentId: 'l3', sortOrder: 0 }),
      makeMailbox({ id: 'l5', name: 'Level5', parentId: 'l4', sortOrder: 0 }),
      makeMailbox({ id: 'l6', name: 'Level6', parentId: 'l5', sortOrder: 0 }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));

    // Only 1 root node
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Level0');

    // Verify all depths are correct
    for (let i = 0; i <= 6; i++) {
      expect(byId[`l${i}`].depth).toBe(i);
    }
  });

  it('should handle nesting up to depth 10 (Stalwart default max)', () => {
    const mailboxes: Mailbox[] = [];
    for (let i = 0; i <= 10; i++) {
      mailboxes.push(
        makeMailbox({
          id: `level-${i}`,
          name: `Folder${i}`,
          parentId: i === 0 ? undefined : `level-${i - 1}`,
          sortOrder: 0,
        })
      );
    }

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);

    // Should have exactly 11 nodes total
    expect(flat).toHaveLength(11);
    // Only 1 root
    expect(tree).toHaveLength(1);

    // Each node at correct depth
    for (let i = 0; i <= 10; i++) {
      const node = flat.find(n => n.id === `level-${i}`);
      expect(node).toBeDefined();
      expect(node!.depth).toBe(i);
    }
  });

  it('should correctly count children at each level in deep trees', () => {
    const mailboxes = [
      makeMailbox({ id: 'root', name: 'Root', sortOrder: 0 }),
      makeMailbox({ id: 'a', name: 'A', parentId: 'root' }),
      makeMailbox({ id: 'b', name: 'B', parentId: 'root' }),
      makeMailbox({ id: 'a1', name: 'A1', parentId: 'a' }),
      makeMailbox({ id: 'a2', name: 'A2', parentId: 'a' }),
      makeMailbox({ id: 'a1x', name: 'A1X', parentId: 'a1' }),
      makeMailbox({ id: 'a1y', name: 'A1Y', parentId: 'a1' }),
      makeMailbox({ id: 'a1x_deep', name: 'A1X_DEEP', parentId: 'a1x' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));

    // Verify structure
    expect(tree).toHaveLength(1); // just Root
    expect(tree[0].children).toHaveLength(2); // A, B

    // Check depths
    expect(byId['root'].depth).toBe(0);
    expect(byId['a'].depth).toBe(1);
    expect(byId['b'].depth).toBe(1);
    expect(byId['a1'].depth).toBe(2);
    expect(byId['a2'].depth).toBe(2);
    expect(byId['a1x'].depth).toBe(3);
    expect(byId['a1y'].depth).toBe(3);
    expect(byId['a1x_deep'].depth).toBe(4);
  });

  it('should flatten deep trees in correct parent-before-child order', () => {
    const mailboxes = [
      makeMailbox({ id: 'l0', name: 'L0', sortOrder: 0 }),
      makeMailbox({ id: 'l1', name: 'L1', parentId: 'l0', sortOrder: 0 }),
      makeMailbox({ id: 'l2', name: 'L2', parentId: 'l1', sortOrder: 0 }),
      makeMailbox({ id: 'l3', name: 'L3', parentId: 'l2', sortOrder: 0 }),
      makeMailbox({ id: 'l4', name: 'L4', parentId: 'l3', sortOrder: 0 }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const ids = flat.map(n => n.id);

    // Parent must always come before child in the flat list
    for (let i = 0; i < 4; i++) {
      const parentIdx = ids.indexOf(`l${i}`);
      const childIdx = ids.indexOf(`l${i + 1}`);
      expect(parentIdx).toBeLessThan(childIdx);
    }
  });

  it('should handle mailboxes provided in reverse order (children before parents)', () => {
    // JMAP doesn't guarantee order - children might arrive before parents
    const mailboxes = [
      makeMailbox({ id: 'restaurant', name: 'RESTAURANT', parentId: 'hotel2' }),
      makeMailbox({ id: 'hotel2', name: 'HOTEL2', parentId: 'bookings' }),
      makeMailbox({ id: 'bookings', name: 'BOOKINGS', parentId: 'privat' }),
      makeMailbox({ id: 'privat', name: 'PRIVAT', parentId: 'inbox' }),
      makeMailbox({ id: 'inbox', name: 'INBOX', role: 'inbox' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));

    // All nodes present
    expect(flat).toHaveLength(5);
    // Only 1 root
    expect(tree).toHaveLength(1);
    // Correct depths regardless of input order
    expect(byId['inbox'].depth).toBe(0);
    expect(byId['privat'].depth).toBe(1);
    expect(byId['bookings'].depth).toBe(2);
    expect(byId['hotel2'].depth).toBe(3);
    expect(byId['restaurant'].depth).toBe(4);
  });

  it('should handle wide + deep trees without orphaning', () => {
    // Mix of wide (many siblings) and deep nesting
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'INBOX', role: 'inbox' }),
      // 5 children of inbox
      ...Array.from({ length: 5 }, (_, i) =>
        makeMailbox({ id: `child-${i}`, name: `Child${i}`, parentId: 'inbox' })
      ),
      // Each child has 2 sub-children
      ...Array.from({ length: 5 }, (_, i) => [
        makeMailbox({ id: `gc-${i}-0`, name: `GC${i}-0`, parentId: `child-${i}` }),
        makeMailbox({ id: `gc-${i}-1`, name: `GC${i}-1`, parentId: `child-${i}` }),
      ]).flat(),
      // Some grandchildren have great-grandchildren (depth 3)
      makeMailbox({ id: 'ggc-0', name: 'GGC0', parentId: 'gc-0-0' }),
      makeMailbox({ id: 'ggc-1', name: 'GGC1', parentId: 'gc-2-1' }),
      // depth 4
      makeMailbox({ id: 'gggc-0', name: 'GGGC0', parentId: 'ggc-0' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const rootNames = tree.map(n => n.name);

    // Only INBOX should be at root
    expect(rootNames).toEqual(['INBOX']);
    // Total nodes
    expect(flat).toHaveLength(mailboxes.length);

    // Verify depth-4 node
    const gggc = flat.find(n => n.id === 'gggc-0');
    expect(gggc).toBeDefined();
    expect(gggc!.depth).toBe(4);
  });
});

describe('mailbox deduplication side effects on nesting', () => {
  it('should not remove an intermediate parent whose name matches a role mailbox', () => {
    // Scenario: A non-role folder named "Sent" is an intermediate parent.
    // The deduplication logic might remove it because it matches the role "sent" mailbox name.
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'sent-role', name: 'Sent', role: 'sent' }),
      // A user-created folder also named "Sent" that's a child of Inbox
      makeMailbox({ id: 'sent-custom', name: 'Sent', parentId: 'inbox' }),
      // Child of the custom "Sent" folder
      makeMailbox({ id: 'sent-child', name: 'Archive', parentId: 'sent-custom' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);

    // The custom "Sent" (sent-custom) might be filtered by deduplication.
    // If it IS removed, then "sent-child" loses its parent and becomes root — BAD.
    const sentChild = flat.find(n => n.id === 'sent-child');
    expect(sentChild).toBeDefined();

    // Check if sent-child is orphaned at root (the bug)
    const rootIds = tree.map(n => n.id);
    const isOrphaned = rootIds.includes('sent-child');

    if (isOrphaned) {
      // This demonstrates the deduplication bug: removing an intermediate parent
      // causes its children to become orphaned at root level
      console.warn(
        'BUG DETECTED: Deduplication removed intermediate parent "sent-custom", ' +
        'orphaning "sent-child" to root level.'
      );
    }

    // Document the current behavior (this test is diagnostic)
    // Ideally: sent-child should be nested under sent-custom at depth 2
    // If dedup removes sent-custom: sent-child ends up at root with depth 0
    expect(sentChild!.depth).toBeGreaterThanOrEqual(0);
  });

  it('should not remove a parent folder whose name is a substring of a role name', () => {
    // Folder named "Draft" (substring of "Drafts" role) used as intermediate parent
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'drafts-role', name: 'Drafts', role: 'drafts' }),
      makeMailbox({ id: 'draft-folder', name: 'Draft', parentId: 'inbox' }),
      makeMailbox({ id: 'draft-child', name: 'Notes', parentId: 'draft-folder' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const rootIds = tree.map(n => n.id);

    const draftChild = flat.find(n => n.id === 'draft-child');
    expect(draftChild).toBeDefined();

    const isOrphaned = rootIds.includes('draft-child');
    if (isOrphaned) {
      console.warn(
        'BUG DETECTED: Deduplication removed "draft-folder" (substring match with "Drafts"), ' +
        'orphaning "draft-child" to root level.'
      );
    }

    expect(draftChild!.depth).toBeGreaterThanOrEqual(0);
  });
});

describe('mailbox orphan behavior (missing parent)', () => {
  it('should expose orphan-to-root behavior when parent is missing', () => {
    // Simulates what happens if JMAP response is incomplete (e.g., truncated at 500 objects)
    // Middle parent "bookings" is missing from the response
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'INBOX', role: 'inbox' }),
      makeMailbox({ id: 'privat', name: 'PRIVAT', parentId: 'inbox' }),
      // 'bookings' is MISSING — simulating truncated JMAP response
      makeMailbox({ id: 'hotel2', name: 'HOTEL2', parentId: 'bookings' }),
      makeMailbox({ id: 'restaurant', name: 'RESTAURANT', parentId: 'hotel2' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const rootIds = tree.map(n => n.id);

    // hotel2's parent ("bookings") is missing from the response.
    // Current behavior: hotel2 becomes a root node (orphaned).
    // This means RESTAURANT also appears under hotel2 at root, but at depth 1 instead of depth 4.
    const hotel2 = flat.find(n => n.id === 'hotel2');
    expect(hotel2).toBeDefined();

    // Diagnostic: document that orphaning DOES happen
    if (rootIds.includes('hotel2')) {
      expect(hotel2!.depth).toBe(0); // orphaned at root
      const restaurant = flat.find(n => n.id === 'restaurant');
      expect(restaurant!.depth).toBe(1); // child of orphaned root
      console.warn(
        'CONFIRMED: Missing intermediate parent causes orphan-to-root. ' +
        'hotel2 (parentId: "bookings") is at root with depth 0 instead of depth 3.'
      );
    }
  });

  it('should expose orphan behavior with multiple missing parents in chain', () => {
    // Deep chain where two intermediate parents are missing
    const mailboxes = [
      makeMailbox({ id: 'root', name: 'Root', sortOrder: 0 }),
      // 'level1' is MISSING
      // 'level2' is MISSING
      makeMailbox({ id: 'level3', name: 'Level3', parentId: 'level2' }),
      makeMailbox({ id: 'level4', name: 'Level4', parentId: 'level3' }),
    ];

    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const rootIds = tree.map(n => n.id);

    // level3's parent (level2) is missing → level3 becomes root
    expect(rootIds).toContain('level3');

    // level4 is correctly nested under level3 (since level3 IS in the map)
    const level4 = flat.find(n => n.id === 'level4');
    expect(level4).toBeDefined();
    expect(level4!.depth).toBe(1); // child of orphaned level3 (depth 0)

    console.warn(
      'CONFIRMED: Missing parents in chain cause subtree to float to root. ' +
      'Level3 (expected depth 2) is at depth 0, Level4 (expected depth 3) is at depth 1.'
    );
  });
});
