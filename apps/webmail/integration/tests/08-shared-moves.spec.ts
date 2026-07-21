import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  expandSharedFolders,
  openFolder,
  folderMailboxId,
  moveEmailTo,
  forceSync,
} from './helpers/app';

/**
 * Moving mail across the own-account / shared-folder boundary, in both
 * directions, and between two shared folders (same owner and across owners).
 * The move is driven from the list context menu's "Move to" submenu; the
 * authoritative check is the server-side mailbox the message ends up in. Each
 * cross-account case also asserts the source copy is gone (no duplicate) and
 * the read state survives the move (Email/copy drops keywords unless carried).
 */
const { alice, bob, carol } = ACCOUNTS;
const subj = (l: string) => `IT ${l} ${Date.now()}`;

test.describe('Shared-folder moves', () => {
  let ja: JmapClient; // owner A
  let jb: JmapClient; // owner B (cross-owner shared → shared)
  let jc: JmapClient; // grantee
  let teamA: string;
  let teamB: string;
  let teamC: string; // owned by bob

  test.beforeEach(async () => {
    ja = await JmapClient.connect(alice.email, alice.password);
    jb = await JmapClient.connect(bob.email, bob.password);
    jc = await JmapClient.connect(carol.email, carol.password);
    await ja.reset();
    await jb.reset();
    await jc.reset();
    teamA = await ja.createSharedFolder('TeamA', carol.email);
    teamB = await ja.createSharedFolder('TeamB', carol.email);
    teamC = await jb.createSharedFolder('TeamC', carol.email);
  });

  // Seed a message into a mailbox and mark it read, so a lost $seen after the
  // move is observable as the moved copy coming back unread.
  async function seedRead(mailboxId: string, subject: string, owner = ja): Promise<void> {
    const acct = owner === ja ? alice : owner === jb ? bob : carol;
    await sendMail({ from: acct.email, authPass: acct.password, to: acct.email, subject, body: 'x' });
    const m = await owner.waitForEmail(subject);
    await owner.moveEmail(m.id, mailboxId);
    await owner.setSeen(m.id, true);
  }

  const seenOf = (m: any) => Boolean(m?.keywords?.$seen);

  test('shared folder A -> shared folder B (same owner)', async ({ page }) => {
    const s = subj('mv-a2b');
    await seedRead(teamA, s);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    const dest = await folderMailboxId(page, { name: 'TeamB', shared: true });
    await openFolder(page, { name: 'TeamA', shared: true });
    await forceSync(page);

    await moveEmailTo(page, s, dest);
    await page.waitForTimeout(1500);

    const inB = await ja.findEmailBySubject(s, teamB);
    expect(inB, 'message in TeamB').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamA), 'message left TeamA').toBeFalsy();
    expect(seenOf(inB), 'read state kept').toBe(true);
  });

  test('shared folder B -> shared folder A (same owner)', async ({ page }) => {
    const s = subj('mv-b2a');
    await seedRead(teamB, s);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    const dest = await folderMailboxId(page, { name: 'TeamA', shared: true });
    await openFolder(page, { name: 'TeamB', shared: true });
    await forceSync(page);

    await moveEmailTo(page, s, dest);
    await page.waitForTimeout(1500);

    const inA = await ja.findEmailBySubject(s, teamA);
    expect(inA, 'message in TeamA').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamB), 'message left TeamB').toBeFalsy();
    expect(seenOf(inA), 'read state kept').toBe(true);
  });

  // Cross-owner shared → shared: source is alice's account, destination is bob's,
  // so this exercises the true cross-account Email/copy + destroy path.
  test('shared folder (owner A) -> shared folder (owner B)', async ({ page }) => {
    const s = subj('mv-a2c');
    await seedRead(teamA, s);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    await expandSharedFolders(page, bob.email);
    const dest = await folderMailboxId(page, { name: 'TeamC', shared: true });
    await openFolder(page, { name: 'TeamA', shared: true });
    await forceSync(page);

    await moveEmailTo(page, s, dest);
    await page.waitForTimeout(2000);

    const inC = await jb.findEmailBySubject(s, teamC);
    expect(inC, 'message in bob TeamC').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamA), 'message left alice TeamA').toBeFalsy();
    expect(seenOf(inC), 'read state kept').toBe(true);
  });

  // The "Move to" submenu relocates a message across the account boundary
  // (own ↔ shared folder) via copy+delete, matching drag-and-drop.
  test('own account -> shared folder', async ({ page }) => {
    const s = subj('mv-own2sh');
    await sendMail({ from: carol.email, authPass: carol.password, to: carol.email, subject: s, body: 'x' });
    const own = await jc.waitForEmail(s);
    await jc.setSeen(own.id, true);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    const dest = await folderMailboxId(page, { name: 'TeamA', shared: true });
    await openFolder(page, { role: 'inbox', shared: false });
    await forceSync(page);

    await moveEmailTo(page, s, dest);
    await page.waitForTimeout(2000);

    const inTeam = await ja.findEmailBySubject(s, teamA);
    expect(inTeam, 'message in shared TeamA').toBeTruthy();
    expect(await jc.findEmailBySubject(s), 'message left own account').toBeFalsy();
    expect(seenOf(inTeam), 'read state kept').toBe(true);
  });

  test('shared folder -> own account', async ({ page }) => {
    const s = subj('mv-sh2own');
    await seedRead(teamA, s);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    const dest = await folderMailboxId(page, { role: 'inbox', shared: false });
    await openFolder(page, { name: 'TeamA', shared: true });
    await forceSync(page);

    await moveEmailTo(page, s, dest);
    await page.waitForTimeout(2000);

    const inOwn = await jc.findEmailBySubject(s);
    expect(inOwn, 'message in own account').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamA), 'message left shared TeamA').toBeFalsy();
    expect(seenOf(inOwn), 'read state kept').toBe(true);
  });
});
