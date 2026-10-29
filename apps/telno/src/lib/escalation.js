import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { deliverNotice } from './channels.js';
import { suspensionEmail } from './mail.js';
import { payUrlForAccount } from './payments.js';
import { logEvent } from './audit.js';

/**
 * Escalation, the step after the reminder ladder.
 *
 * Reminders ask. A final notice warns, and names the day. Suspension is the
 * switch being thrown on that day — and only on that day. The whole module is
 * built around one promise to the customer:
 *
 *  - the date in the final notice is the date service stops, because the sweep
 *    stores that date once and both the email and the suspension read it;
 *  - suspension is per billing account (the invoice's email, lower-cased), not
 *    per invoice, so a customer with three late invoices is switched off once;
 *  - what the platform switched off is recorded, so reinstatement re-enables
 *    exactly that and never an extension an operator disabled;
 *  - the last owner is never suspended: locking the only administrator out of
 *    the platform is not a billing remedy;
 *  - paying restores service automatically. Nobody has to call support to be
 *    switched back on, and no balance is forgotten because an invoice was paid
 *    between two sweeps.
 */

const DAY_MS = 86_400_000;

/** The billing identity is the invoice's email. Lower-cased, once, everywhere. */
export const billingEmail = (value) => String(value ?? '').trim().toLowerCase();

/**
 * A date, not an instant: `YYYY-MM-DD` in UTC. A due date of 03/01 is late on
 * 03/02 for a reader in every time zone, and a suspension date has to behave
 * the same way.
 */
const dayKey = (value) => {
  if (!value) return '';
  const text = String(value);
  const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

/** A stored day plus N days, still a day. */
export const addDays = (value, days) => {
  const key = dayKey(value);
  if (!key) return '';
  const base = new Date(`${key}T00:00:00Z`).getTime();
  return new Date(base + Math.max(0, Number(days) || 0) * DAY_MS).toISOString().slice(0, 10);
};

const OWED_STATUSES = "('open', 'overdue')";

/** What this billing identity still owes, per currency, largest first. */
export function owed(email) {
  const key = billingEmail(email);
  if (!key) return { cents: 0, currency: 'USD', invoices: 0 };
  const rows = db_.all(
    `SELECT currency, COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n
       FROM invoices
      WHERE lower(email) = ? AND status IN ${OWED_STATUSES} AND amount_cents > 0
      GROUP BY currency ORDER BY cents DESC`,
    [key]
  );
  if (!rows.length) return { cents: 0, currency: 'USD', invoices: 0 };
  return {
    // Currencies are never added together; the largest balance is the headline.
    cents: rows[0].cents,
    currency: rows[0].currency,
    invoices: rows.reduce((total, row) => total + row.n, 0),
    byCurrency: rows.map((row) => ({ currency: row.currency, cents: row.cents, invoices: row.n })),
  };
}

const accountRow = (email) =>
  db_.get('SELECT * FROM billing_accounts WHERE email = ?', [billingEmail(email)]);

/** Insert-if-missing, so every state change has a row to change. */
function ensureAccount(email, { name = '' } = {}) {
  const key = billingEmail(email);
  if (!key) return null;
  const existing = accountRow(key);
  if (existing) {
    if (name && !existing.name) {
      db_.run('UPDATE billing_accounts SET name = ? WHERE id = ?', [String(name).slice(0, 120), existing.id]);
      return accountRow(key);
    }
    return existing;
  }
  const id = newId('bacct_');
  db_.run(
    `INSERT INTO billing_accounts (id, email, name, state, updated_at)
     VALUES (?, ?, ?, 'current', ?)`,
    [id, key, String(name).slice(0, 120), now()]
  );
  return accountRow(key);
}

/** Extensions on this billing identity that the platform switched off. */
const disabledExtensions = (email) =>
  db_.all('SELECT id, extension, display_name FROM extensions WHERE lower(email) = ? AND suspended_by_billing = 1', [
    billingEmail(email),
  ]);

const loginsFor = (email) =>
  db_.all('SELECT * FROM accounts WHERE lower(email) = ?', [billingEmail(email)]);

export const accountView = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name || '',
  state: row.state,
  finalNoticeAt: row.final_notice_at || null,
  suspendOn: row.suspend_on || null,
  suspendedAt: row.suspended_at || null,
  reinstatedAt: row.reinstated_at || null,
  suspendReason: row.suspend_reason || '',
  noticeSentAt: row.suspend_notice_at || null,
  overdueCents: row.overdue_cents || 0,
  currency: row.currency || 'USD',
  extensionsOff: row.extensions_off ?? 0,
  loginsBlocked: row.logins_blocked ?? 0,
  // One page that settles the whole balance. Carried in the suspension email,
  // and offered to an operator who wants to send it by hand.
  payUrl: payUrlForAccount({ id: row.id }),
  updatedAt: row.updated_at,
});

const ACCOUNT_SELECT = `SELECT b.*,
    (SELECT COUNT(*) FROM extensions e WHERE lower(e.email) = b.email AND e.suspended_by_billing = 1) AS extensions_off,
    (SELECT COUNT(*) FROM accounts a WHERE lower(a.email) = b.email AND a.suspended_at IS NOT NULL) AS logins_blocked
  FROM billing_accounts b`;

/**
 * Every account the dunning system is watching. Owed totals are recomputed on
 * read, so a paid invoice cannot leave a stale balance on the screen.
 */
export function listBillingAccounts({ state = '' } = {}) {
  const rows = state
    ? db_.all(`${ACCOUNT_SELECT} WHERE b.state = ? ORDER BY b.updated_at DESC`, [state])
    : db_.all(`${ACCOUNT_SELECT} ORDER BY CASE b.state WHEN 'suspended' THEN 0 WHEN 'final-notice' THEN 1 ELSE 2 END, b.updated_at DESC`);
  return rows.map((row) => {
    const balance = owed(row.email);
    return accountView({ ...row, overdue_cents: balance.cents, currency: balance.currency });
  });
}

export const billingAccount = (email) => {
  const row = accountRow(email);
  if (!row) return null;
  const balance = owed(row.email);
  return accountView({ ...row, overdue_cents: balance.cents, currency: balance.currency });
};

/**
 * The final notice was just sent. Store the date the customer was told — the
 * suspension pass reads this and nothing else.
 */
export function markFinalNotice(invoice, { at = new Date(), suspendOn = '' } = {}) {
  const account = ensureAccount(invoice.email, { name: invoice.account_name });
  if (!account) return null;
  const key = billingEmail(invoice.email);
  const balance = owed(key);
  const deadline = suspendOn || addDays(at, config.billing.suspendGraceDays);
  // A suspended account keeps its suspension; a final notice only moves a
  // current account to the warning state.
  db_.run(
    `UPDATE billing_accounts
        SET state = CASE WHEN state = 'suspended' THEN state ELSE 'final-notice' END,
            name = CASE WHEN name = '' THEN ? ELSE name END,
            final_notice_at = ?, suspend_on = ?, overdue_cents = ?, currency = ?, updated_at = ?
      WHERE id = ?`,
    [
      String(invoice.account_name || '').slice(0, 120),
      dayKey(at),
      deadline,
      balance.cents,
      balance.currency,
      now(),
      account.id,
    ]
  );
  logEvent({
    actor: 'system',
    action: 'billing.final_notice',
    subject: invoice.invoice_no,
    detail: `${key}: service stops ${deadline} unless ${(balance.cents / 100).toFixed(2)} ${balance.currency} is paid`,
  });
  return accountRow(key);
}

/** Push the new routing document to the switch, if one is connected. */
async function applySwitch() {
  if (!config.telephony.enabled) return { applied: false, reason: 'telephony-disabled' };
  try {
    const { applyConfiguration } = await import('../telephony/index.js');
    const result = await applyConfiguration('billing');
    return { applied: true, written: !!result.written, reloaded: !!result.reloaded };
  } catch (err) {
    // A switch that will not reload must not stop the suspension from being
    // recorded: the next successful reload carries the change.
    console.error('[escalation] could not apply switch config:', err.message);
    return { applied: false, error: err.message };
  }
}

/**
 * Suspend one billing account: switch off its extensions, block its logins
 * (never an owner) and tell the customer. Every step is recorded so
 * reinstatement can undo exactly this and nothing else.
 */
export async function suspendAccount(account, { at = new Date(), actor = 'system', reason = '' } = {}) {
  const row = accountRow(account?.email ?? account);
  if (!row) return { action: 'missing', reason: 'unknown-account' };
  if (row.state === 'suspended') return { action: 'none', reason: 'already-suspended', account: accountView(row) };

  const balance = owed(row.email);
  if (balance.cents <= 0) return { action: 'none', reason: 'nothing-owed', account: accountView(row) };
  // A suspension without a warning is not this system's decision to make.
  if (!row.final_notice_at) return { action: 'none', reason: 'no-final-notice', account: accountView(row) };

  const extensions = db_.all(
    "SELECT id, extension FROM extensions WHERE lower(email) = ? AND enabled = 1 AND suspended_by_billing = 0",
    [row.email]
  );
  db_.run(
    'UPDATE extensions SET enabled = 0, suspended_by_billing = 1, updated_at = ? WHERE lower(email) = ? AND enabled = 1 AND suspended_by_billing = 0',
    [now(), row.email]
  );

  const logins = loginsFor(row.email).filter((login) => login.role !== 'owner');
  for (const login of logins) {
    // Bumping the token version ends the sessions that are already open.
    db_.run('UPDATE accounts SET suspended_at = ?, token_version = token_version + 1 WHERE id = ?', [now(), login.id]);
  }

  db_.run(
    `UPDATE billing_accounts
        SET state = 'suspended', suspended_at = ?, suspend_reason = ?, overdue_cents = ?, currency = ?, updated_at = ?
      WHERE id = ?`,
    [now(), String(reason || 'past due').slice(0, 200), balance.cents, balance.currency, now(), row.id]
  );

  const switched = await applySwitch();
  logEvent({
    actor,
    action: 'billing.account_suspended',
    subject: row.email,
    detail: `${extensions.length} extension(s) off, ${logins.length} login(s) blocked, ` +
      `${(balance.cents / 100).toFixed(2)} ${balance.currency} owed` +
      `${switched.reloaded ? ', switch reloaded' : ''}${switched.error ? `, switch: ${switched.error}` : ''}`,
  });

  // The customer is told what happened, once. A failed notice is retried by the
  // next sweep rather than being lost.
  const notice = await sendSuspensionNotice(row, { balance, extensions: extensions.length });
  return {
    action: 'suspended',
    email: row.email,
    extensionsOff: extensions.length,
    loginsBlocked: logins.length,
    overdueCents: balance.cents,
    currency: balance.currency,
    noticeSent: notice.delivered,
    switch: switched,
    account: billingAccount(row.email),
  };
}

async function sendSuspensionNotice(row, { balance, extensions = 0 }) {
  if (!row.email) return { delivered: false, error: 'no-email' };
  const invoices = db_.all(
    `SELECT invoice_no, amount_cents, currency, due_at FROM invoices
      WHERE lower(email) = ? AND status IN ${OWED_STATUSES} AND amount_cents > 0
      ORDER BY date(due_at) ASC LIMIT 5`,
    [row.email]
  );
  const message = suspensionEmail({
    accountName: row.name,
    email: row.email,
    amount: balance.cents,
    currency: balance.currency,
    suspendOn: row.suspend_on,
    suspendedAt: row.suspended_at || now(),
    extensionCount: extensions,
    invoiceNumbers: invoices.map((invoice) => invoice.invoice_no),
    // One page pays the whole balance: a customer with three late invoices
    // must not need three card payments to get their phones back.
    payUrl: payUrlForAccount({ id: row.id }),
  });
  let result;
  try {
    result = await deliverNotice({ to: row.email, ...message });
  } catch (err) {
    result = { delivered: false, channel: 'unknown', error: err.message };
  }
  if (result.delivered) {
    db_.run('UPDATE billing_accounts SET suspend_notice_at = ? WHERE id = ?', [now(), row.id]);
  }
  logEvent({
    actor: 'system',
    action: result.delivered ? 'billing.suspension_notice_sent' : 'billing.suspension_notice_failed',
    subject: row.email,
    detail: `${result.channel || 'unknown'}: ${result.delivered ? 'sent' : result.error}`,
  });
  return result;
}

/**
 * Put an account back in service: re-enable the extensions this platform
 * switched off, unblock its logins and clear the dunning state.
 */
export async function reinstateAccount(account, { actor = 'system', reason = 'paid' } = {}) {
  const row = accountRow(account?.email ?? account);
  if (!row) return { action: 'missing', reason: 'unknown-account' };
  const balance = owed(row.email);
  if (balance.cents > 0 && reason === 'paid') {
    return { action: 'none', reason: 'still-owed', overdueCents: balance.cents, currency: balance.currency };
  }

  const off = disabledExtensions(row.email);
  db_.run(
    'UPDATE extensions SET enabled = 1, suspended_by_billing = 0, updated_at = ? WHERE lower(email) = ? AND suspended_by_billing = 1',
    [now(), row.email]
  );
  const blocked = db_.all('SELECT * FROM accounts WHERE lower(email) = ? AND suspended_at IS NOT NULL', [row.email]);
  for (const login of blocked) {
    db_.run('UPDATE accounts SET suspended_at = NULL, token_version = token_version + 1 WHERE id = ?', [login.id]);
  }

  db_.run(
    `UPDATE billing_accounts
        SET state = 'current', suspended_at = NULL, suspend_reason = '', final_notice_at = NULL,
            suspend_on = NULL, suspend_notice_at = NULL,
            reinstated_at = ?, overdue_cents = ?, currency = ?, updated_at = ?
      WHERE id = ?`,
    [now(), balance.cents, balance.currency, now(), row.id]
  );

  const switched = await applySwitch();
  logEvent({
    actor,
    action: 'billing.account_reinstated',
    subject: row.email,
    detail: `${reason}: ${off.length} extension(s) back on, ${blocked.length} login(s) restored` +
      `${switched.reloaded ? ', switch reloaded' : ''}`,
  });

  return {
    action: 'reinstated',
    email: row.email,
    extensionsRestored: off.length,
    loginsRestored: blocked.length,
    switch: switched,
    account: billingAccount(row.email),
  };
}

/**
 * One escalation pass, run inside the reminder sweep so there is one timer and
 * one order of operations: warn first, then act.
 */
export async function runEscalation({ at = new Date(), actor = 'system' } = {}) {
  if (!config.billing.escalation) {
    return { enabled: false, suspended: [], reinstated: [], retried: [] };
  }

  const today = dayKey(at);
  const suspended = [];
  const reinstated = [];
  const retried = [];

  // Reinstatement first: a customer who paid between two sweeps must not be
  // switched off by the pass that follows the sweep that saw the payment.
  for (const row of db_.all("SELECT * FROM billing_accounts WHERE state = 'suspended'")) {
    const balance = owed(row.email);
    if (balance.cents > 0) continue;
    const result = await reinstateAccount(row, { actor, reason: 'paid' });
    if (result.action === 'reinstated') reinstated.push(result);
  }

  // Then suspension, for exactly the accounts whose stated date has arrived.
  for (const row of db_.all("SELECT * FROM billing_accounts WHERE state = 'final-notice'")) {
    if (!row.suspend_on || dayKey(row.suspend_on) > today) continue;
    const balance = owed(row.email);
    if (balance.cents <= 0) continue;
    const result = await suspendAccount(row, { at, actor });
    if (result.action === 'suspended') suspended.push(result);
  }

  // A suspension whose notice failed gets another try, without suspending twice.
  for (const row of db_.all(
    "SELECT * FROM billing_accounts WHERE state = 'suspended' AND suspend_notice_at IS NULL AND email <> ''"
  )) {
    const balance = owed(row.email);
    if (balance.cents <= 0) continue;
    const notice = await sendSuspensionNotice(row, { balance, extensions: disabledExtensions(row.email).length });
    retried.push({ email: row.email, sent: !!notice.delivered });
  }

  if (suspended.length || reinstated.length) {
    console.log(
      `[escalation] ${suspended.length} suspended, ${reinstated.length} reinstated` +
        `${suspended.length ? ` (${suspended.map((row) => row.email).join(', ')})` : ''}`
    );
  }

  return { enabled: true, today, suspended, reinstated, retried };
}

/** Is this billing identity suspended? Used by reminders and by sign-in. */
export const isSuspended = (email) => accountRow(email)?.state === 'suspended';

/** Escalation rules as the screen states them, straight from config. */
export const escalationPolicy = () => ({
  enabled: config.billing.escalation,
  finalNoticeDays: config.billing.finalNoticeDays,
  graceDays: config.billing.suspendGraceDays,
});

/** The suspension state of a customer's login, if any. */
export function loginSuspension(email) {
  const key = billingEmail(email);
  if (!key) return null;
  const row = accountRow(key);
  if (!row || row.state !== 'suspended') return null;
  return {
    suspendedAt: row.suspended_at,
    suspendOn: row.suspend_on,
    overdueCents: row.overdue_cents,
    currency: row.currency,
  };
}
