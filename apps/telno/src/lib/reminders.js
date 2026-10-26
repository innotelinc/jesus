import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { deliverNotice } from './channels.js';
import { finalNoticeEmail, reminderEmail } from './mail.js';
import { addDays, isSuspended, markFinalNotice, runEscalation } from './escalation.js';
import { payUrlForInvoice } from './payments.js';
import { logEvent } from './audit.js';

/**
 * Automatic payment reminders.
 *
 * The rule is one sentence long: an invoice that is past due gets a reminder,
 * once per rung of the ladder, and never twice in the same day. Everything else
 * here exists to keep that sentence true.
 *
 *  1. A rung is a number of days *after* the due date (1, 3, 7, 14, 30 by
 *     default), not a calendar date, so a weekend or a restart cannot move it.
 *  2. The ladder is a ledger, not a counter. `invoice_reminders` holds one row
 *     per rung with a unique (invoice, stage) index; the row is written *before*
 *     the provider is called, so two sweeps cannot both send it.
 *  3. An invoice that arrives already 40 days late must not fire five emails in
 *     one sweep. The highest rung it has reached is sent and the rungs it
 *     skipped over are recorded as skipped — the history says what happened
 *     without pretending a reminder went out on a day it did not.
 *  4. A failed send is a retry, not a lost rung: the failure is recorded, the
 *     rung stays open, and the gap rule waits before trying again. Hammering a
 *     provider that is down helps nobody.
 *  5. Paid and void invoices are never reminded. Paused invoices are skipped
 *     until someone resumes them.
 *  6. Past the final-notice day the ladder stops being a ladder: one final
 *     notice replaces it, states the date service stops, and every rung the
 *     invoice had not reached is recorded as skipped. A suspended account gets
 *     no further reminders — its phones are already off.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Each sweep stays bounded so one sweep cannot stall the process or a provider. */
const BATCH = 50;

/** Midnight UTC for the day a value falls on, or null when it is not a date. */
const utcDay = (value) => {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

/**
 * Whole days between the due date and `at`, counted in UTC calendar days. The
 * due date is a day, not an instant: a due date of 02/14 is one day late on
 * 02/15 whether the reader is in New York or Berlin.
 */
export function daysPastDue(invoice, at = new Date()) {
  const due = utcDay(invoice?.due_at);
  if (due === null) return null;
  const today = utcDay(at);
  return Math.round((today - due) / DAY_MS);
}

/** The ladder, ascending. A hand-written REMINDER_DAYS is normalized in config. */
export const ladder = () => config.billing.reminderDays;

/** Past-due invoices become `overdue`; that is a fact, not a label someone sets. */
function markOverdue(at) {
  const stamp = at.toISOString().slice(0, 10);
  const result = db_.run(
    `UPDATE invoices SET status = 'overdue'
      WHERE status = 'open' AND due_at IS NOT NULL AND due_at <> '' AND date(due_at) < date(?)`,
    [stamp]
  );
  return result?.changes || 0;
}

/**
 * What should happen to this invoice now: which rung to send, which rungs to
 * record as passed over, or why nothing should happen. Pure apart from the
 * ledger read, so the same decision serves the sweep and a manual send.
 */
export function planFor(invoice, at = new Date(), { force = false } = {}) {
  if (!invoice) return { action: 'missing', reason: 'Invoice not found' };
  if (invoice.status === 'paid') return { action: 'none', reason: 'paid' };
  if (invoice.status === 'void') return { action: 'none', reason: 'void' };
  if (invoice.status === 'draft') return { action: 'none', reason: 'draft' };
  if (invoice.reminders_paused) return { action: 'none', reason: 'paused' };
  if (!invoice.email) return { action: 'none', reason: 'no-email' };
  // A suspended account is already switched off; a reminder would be pointing
  // at a phone that no longer rings, and paying is handled by reinstatement.
  if (config.billing.escalation && isSuspended(invoice.email)) {
    return { action: 'none', reason: 'account-suspended' };
  }

  const past = daysPastDue(invoice, at);
  if (past === null) return { action: 'none', reason: 'no-due-date' };

  const rungs = ladder();
  const records = db_.all(
    'SELECT stage_days, status, sent_at, kind FROM invoice_reminders WHERE invoice_id = ?',
    [invoice.id]
  );
  const gapMs = config.billing.reminderGapHours * HOUR_MS;

  // A rung is spent once it has been sent or deliberately passed over. A
  // reservation still in 'sending' counts while it is fresh; if the process
  // died mid-send it ages out and the rung becomes retryable.
  const open = (row) => {
    if (row.status === 'sent' || row.status === 'skipped') return true;
    if (row.status !== 'sending') return false;
    const reserved = new Date(row.sent_at).getTime();
    return Number.isFinite(reserved) && at.getTime() - reserved < gapMs;
  };
  const spent = new Set(records.filter(open).map((row) => row.stage_days));
  const finalRecorded = records.some((row) => row.kind === 'final' && open(row));

  // The final notice is the top of the ladder, not an extra rung: once it has
  // gone out, nothing else is sent about this invoice.
  if (finalRecorded) return { action: 'none', reason: 'final-notice', daysPastDue: past };

  if (!force && invoice.last_reminded_at) {
    const last = new Date(invoice.last_reminded_at).getTime();
    if (Number.isFinite(last) && at.getTime() - last < gapMs) {
      return { action: 'none', reason: 'recently-reminded', daysPastDue: past };
    }
  }

  if (config.billing.escalation && past >= config.billing.finalNoticeDays) {
    // One warning instead of a rung, and the rungs it overtook are spent so a
    // backlog cannot send them after the warning.
    return {
      action: 'send',
      kind: 'final',
      stage: 0,
      skip: rungs.filter((stage) => stage <= past && !spent.has(stage)),
      daysPastDue: past,
      suspendOn: addDays(at, config.billing.suspendGraceDays),
      forced: !!force,
    };
  }

  if (force) {
    // An operator asked for this one by hand: send today's rung even if the
    // ladder has not reached it, and even if one went out this morning.
    const stage = Math.max(1, past);
    return { action: 'send', kind: 'reminder', stage, skip: [], daysPastDue: past, forced: true };
  }

  const reached = rungs.filter((stage) => stage <= past && !spent.has(stage));
  if (!reached.length) {
    return {
      action: 'none',
      reason: past < rungs[0] ? 'not-due-yet' : 'ladder-complete',
      daysPastDue: past,
    };
  }

  // Send the furthest rung that is due; the ones below it were overtaken.
  const stage = Math.max(...reached);
  return {
    action: 'send',
    kind: 'reminder',
    stage,
    skip: reached.filter((value) => value !== stage),
    daysPastDue: past,
    forced: false,
  };
}

/** Reserve a rung before the provider is called, so a sweep cannot double-send. */
function reserve(invoice, stage, at, kind = 'reminder') {
  db_.run(
    `INSERT INTO invoice_reminders (id, invoice_id, stage_days, status, kind, to_email, sent_at)
     VALUES (?, ?, ?, 'sending', ?, ?, ?)
     ON CONFLICT (invoice_id, stage_days) DO UPDATE SET
       status = 'sending', kind = excluded.kind, to_email = excluded.to_email, sent_at = excluded.sent_at,
       provider = '', error = ''`,
    [newId('rem_'), invoice.id, stage, kind, invoice.email, at.toISOString()]
  );
  // The gap clock starts at reservation: a second sweep, or a second click,
  // sees this invoice as recently reminded and leaves it alone.
  db_.run('UPDATE invoices SET last_reminded_at = ? WHERE id = ?', [at.toISOString(), invoice.id]);
}

/** Rungs the ladder passed over, recorded so they are never sent later. */
function recordSkipped(invoice, stages, at) {
  for (const stage of stages) {
    db_.run(
      `INSERT INTO invoice_reminders (id, invoice_id, stage_days, status, to_email, sent_at)
       VALUES (?, ?, ?, 'skipped', ?, ?)
       ON CONFLICT (invoice_id, stage_days) DO NOTHING`,
      [newId('rem_'), invoice.id, stage, invoice.email, at.toISOString()]
    );
  }
}

function finish(invoice, stage, result) {
  db_.run('UPDATE invoice_reminders SET status = ?, provider = ?, error = ? WHERE invoice_id = ? AND stage_days = ?', [
    result.delivered ? 'sent' : 'failed',
    result.channel || '',
    result.delivered ? '' : String(result.error || 'unknown').slice(0, 300),
    invoice.id,
    stage,
  ]);
}

/**
 * Work one invoice. Returns what happened, never throws for a delivery problem:
 * a provider outage is recorded on the invoice, not thrown at the caller.
 */
async function remind(invoice, at, { force = false, actor = 'system' } = {}) {
  const plan = planFor(invoice, at, { force });
  const base = {
    id: invoice.id,
    invoiceNo: invoice.invoice_no,
    accountName: invoice.account_name,
    amountCents: invoice.amount_cents,
    currency: invoice.currency,
    dueAt: invoice.due_at,
  };

  if (plan.action !== 'send') {
    return { ...base, action: plan.action === 'none' ? 'skipped' : plan.action, reason: plan.reason || null };
  }

  const isFinal = plan.kind === 'final';
  recordSkipped(invoice, plan.skip, at);
  reserve(invoice, plan.stage, at, plan.kind);

  const message = isFinal
    ? finalNoticeEmail(invoice, {
        suspendOn: plan.suspendOn,
        daysPastDue: plan.daysPastDue,
        // The warning is the last chance to avoid losing service; it carries a
        // way to pay instead of only a threat.
        payUrl: payUrlForInvoice(invoice),
      })
    : reminderEmail(invoice, { stageDays: plan.stage, daysPastDue: plan.daysPastDue });
  let result;
  try {
    result = await deliverNotice({ to: invoice.email, ...message });
  } catch (err) {
    result = { delivered: false, channel: 'unknown', error: err.message };
  }
  finish(invoice, plan.stage, result);

  // The date the customer was told only becomes real once the warning has
  // actually left: a failed notice must not count as having warned anyone.
  if (result.delivered && isFinal) {
    markFinalNotice(invoice, { at, suspendOn: plan.suspendOn });
  }

  logEvent({
    actor,
    action: result.delivered
      ? isFinal
        ? 'billing.final_notice_sent'
        : 'billing.reminder_sent'
      : 'billing.reminder_failed',
    subject: invoice.invoice_no,
    detail: `${invoice.email} via ${result.channel || 'unknown'} ` +
      `${isFinal ? `final notice, service stops ${plan.suspendOn}` : `stage ${plan.stage}d`}` +
      `${plan.forced ? ' (manual)' : ''}: ${result.delivered ? 'sent' : result.error}`,
  });

  return {
    ...base,
    action: result.delivered ? 'sent' : 'failed',
    kind: plan.kind || 'reminder',
    stage: plan.stage,
    suspendOn: isFinal ? plan.suspendOn : null,
    skippedStages: plan.skip,
    daysPastDue: plan.daysPastDue,
    channel: result.channel || null,
    simulated: !!result.simulated,
    error: result.delivered ? null : result.error || 'unknown',
  };
}

/**
 * One pass over everything that could owe money. Safe to call whenever: the
 * ledger and the gap rule make it idempotent, so a restart, a second sweep or a
 * manual run cannot produce a duplicate email.
 */
export async function runReminderSweep({ at = new Date(), actor = 'system', invoiceId = null } = {}) {
  const markedOverdue = markOverdue(at);
  const candidates = invoiceId
    ? db_.all('SELECT * FROM invoices WHERE id = ?', [invoiceId])
    : db_.all(
        `SELECT * FROM invoices
          WHERE status IN ('open', 'overdue') AND due_at IS NOT NULL AND due_at <> ''
          ORDER BY date(due_at) ASC LIMIT ?`,
        [BATCH]
      );

  const items = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const invoice of candidates) {
    // An invoice paid while the sweep was running must not be chased.
    const fresh = db_.get('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
    const item = await remind(fresh, at, { actor });
    items.push(item);
    if (item.action === 'sent') sent += 1;
    else if (item.action === 'failed') failed += 1;
    else skipped += 1;
  }

  // Warn first, then act: the escalation pass reads the final notices this
  // sweep has just written, so a notice and a suspension never disagree.
  const escalation = await runEscalation({ at, actor });

  return {
    checked: candidates.length,
    markedOverdue,
    sent,
    failed,
    skipped,
    batchLimited: !invoiceId && candidates.length >= BATCH,
    items,
    escalation: {
      enabled: escalation.enabled,
      suspended: escalation.suspended.map((row) => ({ email: row.email, extensionsOff: row.extensionsOff })),
      reinstated: escalation.reinstated.map((row) => ({ email: row.email, extensionsRestored: row.extensionsRestored })),
    },
    at: at.toISOString(),
  };
}

/** "Send this one now", for an operator who does not want to wait for a sweep. */
export async function sendReminderNow(invoiceId, { actor = 'system', at = new Date() } = {}) {
  const invoice = db_.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  return remind(invoice, at, { force: true, actor });
}

/** Reminders already attempted for an invoice, newest first. */
export const reminderHistory = (invoiceId, limit = 25) =>
  db_
    .all(          `SELECT id, stage_days, status, kind, to_email, provider, error, sent_at
         FROM invoice_reminders WHERE invoice_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
      [invoiceId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
    )
    .map((row) => ({
      id: row.id,
      stageDays: row.stage_days,
      kind: row.kind || 'reminder',
      status: row.status,
      to: row.to_email,
      provider: row.provider,
      error: row.error,
      at: row.sent_at,
    }));

/**
 * The background sweep. It runs once shortly after boot — a container that
 * restarts should resume reminding without an operator clicking anything — and
 * then on the configured interval.
 */
export function startReminderSweep() {
  if (!config.billing.reminders) {
    console.log('[reminders] automatic payment reminders are disabled');
    return () => {};
  }
  let stopped = false;
  let first = null;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runReminderSweep({ actor: 'system' });
      if (result.sent || result.failed || result.markedOverdue) {
        console.log(
          `[reminders] ${result.checked} checked, ${result.sent} sent, ${result.failed} failed, ` +
            `${result.markedOverdue} marked overdue`
        );
      }
    } catch (err) {
      // A sweep that throws must not take the process down or stop the timer.
      console.error('[reminders] sweep failed:', err.message);
    }
  };

  first = setTimeout(tick, 5000);
  first.unref?.();
  timer = setInterval(tick, config.billing.reminderSweepMinutes * 60_000);
  timer.unref?.();
  console.log(
    `[reminders] every ${config.billing.reminderSweepMinutes} min, ` +
      `rungs ${ladder().join('/')} days past due, ${config.billing.reminderGapHours}h gap`
  );
  console.log(
    config.billing.escalation
      ? `[escalation] final notice at ${config.billing.finalNoticeDays} days past due, ` +
        `suspension ${config.billing.suspendGraceDays} days later, automatic reinstatement when paid`
      : '[escalation] off — no account is suspended automatically'
  );

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
