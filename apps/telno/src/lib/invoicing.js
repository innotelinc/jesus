import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { formatNumber } from './e164.js';
import { monthPeriod } from './rentals.js';
import { badRequest, notFound } from './errors.js';

/**
 * What an invoice is made of.
 *
 * An invoice used to be one number: an amount and a name. That is enough to
 * collect money and useless to the person paying it. A line item is the answer
 * to "what am I being charged for?" — one row per thing, with the number or the
 * month it belongs to, so the total is a sum rather than an assertion.
 *
 * Rent is the first thing that needs this. A DID bought from the carrier costs
 * money every month; the ledger in lib/rentals.js records that fact, and this
 * module is what puts it on the customer's bill. The two are deliberately
 * separate: a charge can be recorded without being billed, and the transition
 * (pending → invoiced) is what makes billing a month twice impossible.
 */

export const ITEM_KINDS = ['plan', 'number_rent', 'usage', 'charge', 'discount', 'tax'];

const itemView = (row) => ({
  id: row.id,
  invoiceId: row.invoice_id,
  kind: row.kind,
  description: row.description,
  quantity: row.quantity,
  unitAmountCents: row.unit_amount_cents,
  amountCents: row.amount_cents,
  // 'subscription' means a card already collected this line, so it is shown on
  // the bill but not added to what is due.
  settledBy: row.settled_by || 'invoice',
  numberId: row.number_id || null,
  period: row.period || '',
  createdAt: row.created_at,
});

export const itemsFor = (invoiceId) =>
  db_
    .all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY created_at, id', [invoiceId])
    .map(itemView);

export const invoiceTotalCents = (invoiceId) =>
  Number(
    db_.get(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoice_items WHERE invoice_id = ? AND settled_by <> 'subscription'",
      [invoiceId]
    )?.total || 0
  );

/** What a card subscription already collected — shown, never charged twice. */
export const invoiceCoveredCents = (invoiceId) =>
  Number(
    db_.get(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoice_items WHERE invoice_id = ? AND settled_by = 'subscription'",
      [invoiceId]
    )?.total || 0
  );

/**
 * The invoice's amount is the sum of its lines, whenever it has any.
 *
 * An invoice with no line items keeps the amount an operator typed, so the
 * invoice that already exists — and the way it is created by hand — is not
 * rewritten by this module.
 */
export function recalcInvoice(invoiceId) {
  const row = db_.get('SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
  if (!row?.n) return null;
  const total = Math.max(0, invoiceTotalCents(invoiceId));
  db_.run('UPDATE invoices SET amount_cents = ? WHERE id = ?', [total, invoiceId]);
  return total;
}

/** Add one line. `amountCents` wins when given, otherwise quantity × unit. */
export function addItem(invoiceId, data = {}) {
  const invoice = db_.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) throw notFound('Invoice not found');
  const description = String(data.description || '').trim();
  if (!description) throw badRequest('A line item needs a description');
  const kind = ITEM_KINDS.includes(data.kind) ? data.kind : 'charge';
  const quantity = Math.max(1, Math.round(Number(data.quantity ?? 1)));
  const unit = Math.round(Number(data.unitAmountCents ?? data.amountCents ?? 0));
  if (!Number.isFinite(unit)) throw badRequest('A line item needs an amount');
  // A discount is the only negative line: it is what makes the sum the total.
  const amount = Math.round(Number(data.amountCents ?? quantity * unit));
  if (!Number.isFinite(amount)) throw badRequest('A line item needs an amount');
  if (amount < 0 && kind !== 'discount') {
    throw badRequest('Only a discount may be negative');
  }
  if (Math.abs(amount) > 100_000_000_00) throw badRequest('That amount is too large');

  // Only the billing engine may mark a line as collected by a subscription; a
  // request that tries to smuggle one in is treated as payable.
  const settledBy = data.settledBy === 'subscription' ? 'subscription' : 'invoice';

  const id = newId('itm_');
  db_.run(
    `INSERT INTO invoice_items
       (id, invoice_id, kind, description, quantity, unit_amount_cents, amount_cents, number_id, period, settled_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      invoice.id,
      kind,
      description.slice(0, 200),
      quantity,
      Math.round(Number(data.unitAmountCents ?? amount / quantity)),
      amount,
      data.numberId || null,
      String(data.period || '').slice(0, 20),
      settledBy,
    ]
  );
  recalcInvoice(invoice.id);
  return itemView(db_.get('SELECT * FROM invoice_items WHERE id = ?', [id]));
}

export function updateItem(id, data = {}) {
  const row = db_.get('SELECT * FROM invoice_items WHERE id = ?', [id]);
  if (!row) throw notFound('Line item not found');
  const patch = {};
  if (data.description !== undefined) {
    const description = String(data.description || '').trim();
    if (!description) throw badRequest('A line item needs a description');
    patch.description = description.slice(0, 200);
  }
  if (data.quantity !== undefined) patch.quantity = Math.max(1, Math.round(Number(data.quantity) || 1));
  if (data.unitAmountCents !== undefined) {
    const unit = Math.round(Number(data.unitAmountCents));
    if (!Number.isFinite(unit)) throw badRequest('unitAmountCents must be a number');
    patch.unit_amount_cents = unit;
    // Changing the unit re-prices the line; the amount is derived, not typed.
    patch.amount_cents = unit * (patch.quantity ?? row.quantity);
  }
  if (data.amountCents !== undefined && patch.unit_amount_cents === undefined) {
    const amount = Math.round(Number(data.amountCents));
    if (!Number.isFinite(amount)) throw badRequest('amountCents must be a number');
    if (amount < 0 && row.kind !== 'discount') throw badRequest('Only a discount may be negative');
    patch.amount_cents = amount;
  }
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
  db_.run(`UPDATE invoice_items SET ${sets} WHERE id = ?`, [...Object.values(patch), row.id]);
  recalcInvoice(row.invoice_id);
  return itemView(db_.get('SELECT * FROM invoice_items WHERE id = ?', [row.id]));
}

export function removeItem(id) {
  const row = db_.get('SELECT * FROM invoice_items WHERE id = ?', [id]);
  if (!row) throw notFound('Line item not found');
  // A rent line that is removed gives its month back to the ledger, so the
  // charge can be billed again rather than silently disappearing.
  if (row.kind === 'number_rent' && row.number_id && row.period) {
    db_.run(
      `UPDATE number_charges
          SET status = 'pending', invoice_id = NULL
        WHERE number_id = ? AND period = ? AND status = 'invoiced'`,
      [row.number_id, row.period]
    );
  }
  db_.run('DELETE FROM invoice_items WHERE id = ?', [row.id]);
  recalcInvoice(row.invoice_id);
  return { id: row.id, invoiceId: row.invoice_id };
}

/** First day and last day of a YYYY-MM period, as ISO instants. */
export function monthBounds(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString(),
  };
}

/** "October 2026" — how a bill names its month. */
export function monthLabel(period) {
  const bounds = monthBounds(period);
  if (!bounds) return String(period || '');
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(bounds.start)
  );
}

/**
 * The next invoice number, reserved.
 *
 * Invoice numbers are read by humans and quoted in email, so they are serial
 * per year. A counter in `settings` makes the number unique even when two bills
 * are written back to back, and a number is spent rather than reused if the
 * insert that follows fails — the safe direction for an invoice register. The
 * loop still guards an existing row, so a restored backup cannot collide.
 */
export function nextInvoiceNumber(at = new Date()) {
  const year = at.getUTCFullYear();
  const stored = Number(db_.get("SELECT value FROM settings WHERE key = 'invoice_serial'")?.value || 0);
  let serial = Math.max(stored, db_.get('SELECT COUNT(*) AS n FROM invoices')?.n || 0) + 1;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `INV-${year}-${String(serial).padStart(4, '0')}`;
    if (!db_.get('SELECT 1 AS found FROM invoices WHERE invoice_no = ?', [candidate])) {
      db_.run(
        "INSERT INTO settings (key, value) VALUES ('invoice_serial', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(serial)]
      );
      return candidate;
    }
    serial += 1;
  }
  return `INV-${year}-${Date.now()}`;
}

const accountByEmail = (email) =>
  email ? db_.get('SELECT * FROM accounts WHERE lower(email) = ?', [String(email).toLowerCase()]) : null;

const chargeDescription = (charge) =>
  `Number rent — ${formatNumber(charge.e164)} (${monthLabel(charge.period)})`;

/**
 * Put every unbilled charge for one account and month onto one invoice.
 *
 * The invoice is found or created for that (account, month) pair and the unique
 * index on the pair is what makes a rerun safe. Each charge is marked invoiced
 * in the same pass, so a crash between the two steps at worst leaves a line
 * item and a pending charge: the retry then finds the line already there and
 * only flips the charge, which is the harmless direction to fail in.
 */
export function billRentOnto(invoice, period = invoice.rent_period || monthPeriod()) {
  const bounds = monthBounds(period);
  if (!bounds) throw badRequest('period must be a YYYY-MM month');
  const charges = db_.all(
    `SELECT * FROM number_charges
      WHERE account_id = ? AND period = ? AND status = 'pending'
      ORDER BY e164`,
    [invoice.account_id, period]
  );

  let added = 0;
  let cents = 0;
  for (const charge of charges) {
    const existing = db_.get(
      "SELECT id FROM invoice_items WHERE kind = 'number_rent' AND invoice_id = ? AND number_id = ? AND period = ?",
      [invoice.id, charge.number_id, period]
    );
    if (!existing) {
      addItem(invoice.id, {
        kind: 'number_rent',
        description: chargeDescription(charge),
        quantity: 1,
        unitAmountCents: charge.amount_cents,
        numberId: charge.number_id,
        period,
      });
      added += 1;
      cents += charge.amount_cents;
    }
    db_.run("UPDATE number_charges SET status = 'invoiced', invoice_id = ? WHERE id = ? AND status = 'pending'", [
      invoice.id,
      charge.id,
    ]);
  }

  // Keep the billed month on an invoice that was created for something else, so
  // the pair stays unique and the bill can say which month it covers.
  if (!invoice.rent_period) db_.run('UPDATE invoices SET rent_period = ? WHERE id = ?', [period, invoice.id]);
  return { added, cents };
}

/** Find or create the one invoice that bills this account for a month. */
export function invoiceForMonth(accountId, period = monthPeriod(), { dueDays = 14 } = {}) {
  const bounds = monthBounds(period);
  if (!bounds) throw badRequest('period must be a YYYY-MM month');
  const existing = db_.get(
    "SELECT * FROM invoices WHERE account_id = ? AND rent_period = ? AND status <> 'void'",
    [accountId, period]
  );
  if (existing) return { invoice: existing, created: false };

  const account = db_.get('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw notFound('Account not found');
  const id = newId('inv_');
  const dueAt = new Date(Date.now() + dueDays * 86400_000).toISOString();
  db_.run(
    `INSERT INTO invoices
       (id, invoice_no, account_name, email, account_id, rent_period, period_start, period_end,
        amount_cents, currency, status, issued_at, due_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?)`,
    [
      id,
      nextInvoiceNumber(),
      account.company || account.name || account.email,
      account.email || '',
      account.id,
      period,
      bounds.start,
      bounds.end,
      config.voipms.currency,
      now(),
      dueAt,
      `Monthly bill for ${monthLabel(period)}.`,
    ]
  );
  return { invoice: db_.get('SELECT * FROM invoices WHERE id = ?', [id]), created: true };
}

/**
 * The subscription that should appear on this month's bill.
 *
 * A monthly plan is billed for every month it is live. A yearly plan is not
 * prorated here — this run would have to invent a monthly share of it — so it
 * stays off the monthly statement and is collected by its own charge.
 */
export function billableSubscription(accountId, period = monthPeriod()) {
  const bounds = monthBounds(period);
  if (!bounds) return null;
  const row = db_.get(
    "SELECT * FROM subscriptions WHERE account_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1",
    [accountId]
  );
  if (!row || row.interval !== 'month' || !(Number(row.price_cents) > 0)) return null;
  if (row.created_at && new Date(row.created_at).getTime() > new Date(bounds.end).getTime()) return null;
  if (row.current_period_end && new Date(row.current_period_end).getTime() < new Date(bounds.start).getTime()) {
    return null;
  }
  return row;
}

/**
 * Put the plan fee on the month's invoice.
 *
 * A card subscription has already collected it, so that line is marked as
 * settled and does not raise the amount due. A comped or hand-onboarded
 * subscription has collected nothing, so its fee is payable on this bill.
 */
export function billPlanOnto(invoice, period = invoice.rent_period || monthPeriod()) {
  if (!invoice.account_id) return { added: 0, cents: 0, settledBy: '' };
  const subscription = billableSubscription(invoice.account_id, period);
  if (!subscription) return { added: 0, cents: 0, settledBy: '' };
  const existing = db_.get("SELECT id FROM invoice_items WHERE invoice_id = ? AND kind = 'plan'", [invoice.id]);
  if (existing) return { added: 0, cents: 0, settledBy: '' };

  const settledBy = subscription.stripe_subscription_id ? 'subscription' : 'invoice';
  const item = addItem(invoice.id, {
    kind: 'plan',
    description: `Plan — ${subscription.plan_name || 'Subscription'} (${monthLabel(period)})`,
    quantity: 1,
    unitAmountCents: subscription.price_cents,
    settledBy,
  });
  return { added: 1, cents: item.amountCents, settledBy, plan: subscription.plan_name };
}

/**
 * Bill one account for one month: the plan and every number it rents, on one
 * invoice.
 *
 * Returns `created: false` and no lines when there is nothing to bill, so a
 * sweep can call it for every account without caring who owes anything.
 */
export function billMonthForAccount(accountId, period = monthPeriod()) {
  const pending = db_.get(
    "SELECT COUNT(*) AS n FROM number_charges WHERE account_id = ? AND period = ? AND status = 'pending'",
    [accountId, period]
  );
  const subscription = billableSubscription(accountId, period);
  const existing = db_.get(
    "SELECT * FROM invoices WHERE account_id = ? AND rent_period = ? AND status <> 'void'",
    [accountId, period]
  );
  // A month already settled is history. Rent added to it would change an amount
  // the customer has paid, so it stays pending — and visible as unbilled — until
  // an operator deals with it.
  if (existing && existing.status === 'paid') {
    return {
      accountId,
      period,
      billed: 0,
      planAdded: 0,
      cents: 0,
      invoice: existing,
      created: false,
      totalCents: existing.amount_cents,
      skipped: 'paid',
    };
  }

  // A plan a card subscription already collects needs no statement of its own:
  // it goes on the month's bill when rent gives the account one, and otherwise
  // there is nothing to send. A plan nothing has collected is billed on its own.
  const planPayable = !!subscription && !subscription.stripe_subscription_id && Number(subscription.price_cents) > 0;
  const nothingToBill = !pending?.n && !planPayable;
  if (nothingToBill) {
    return {
      accountId,
      period,
      billed: 0,
      planAdded: 0,
      cents: 0,
      invoice: existing || null,
      created: false,
      totalCents: existing?.amount_cents || 0,
    };
  }

  const { invoice, created } = invoiceForMonth(accountId, period);
  const plan = billPlanOnto(invoice, period);
  const rent = billRentOnto(invoice, period);

  // The bill stays open even at zero: a covered plan plus rent later that month
  // must still be collectable, and dunning skips what has nothing to collect.
  const fresh = db_.get('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
  return {
    accountId,
    period,
    billed: rent.added,
    planAdded: plan.added,
    planSettledBy: plan.settledBy || '',
    cents: rent.cents + (plan.settledBy === 'invoice' ? plan.cents : 0),
    invoice: fresh,
    created,
    totalCents: fresh.amount_cents,
  };
}

/**
 * Voiding an invoice must not eat the month: its rent lines go back to pending
 * so the charge can be billed on a corrected invoice.
 */
export function releaseRentFromInvoice(invoiceId) {
  const items = db_.all(
    "SELECT * FROM invoice_items WHERE invoice_id = ? AND kind = 'number_rent'",
    [invoiceId]
  );
  let released = 0;
  for (const item of items) {
    if (!item.number_id || !item.period) continue;
    const result = db_.run(
      `UPDATE number_charges
          SET status = 'pending', invoice_id = NULL
        WHERE number_id = ? AND period = ? AND invoice_id = ? AND status = 'invoiced'`,
      [item.number_id, item.period, invoiceId]
    );
    released += Number(result.changes || 0);
  }
  if (released) {
    // The invoice keeps its own lines and amount as the record of what it said;
    // only a corrected invoice, not a void one, carries the month now.
    // '' rather than NULL: the column is NOT NULL, and the partial unique index
    // on (account_id, rent_period) deliberately ignores the empty string.
    db_.run("UPDATE invoices SET rent_period = '' WHERE id = ?", [invoiceId]);
  }
  return released;
}

/** Does this invoice carry a month that something else now bills? */
export const rentLinesFor = (invoiceId) =>
  db_.all("SELECT * FROM invoice_items WHERE invoice_id = ? AND kind = 'number_rent'", [invoiceId]).map(itemView);

/**
 * The month's run: one invoice per subscriber, covering the plan and the rent.
 *
 * Idempotent by construction — a plan line is unique per invoice, pending
 * charges are the only rent input, and both are marked as billed in the same
 * pass — so running it at boot, on a timer, or by hand produces the same bills.
 */
export function runMonthlyInvoicing({ period = monthPeriod(), accountId = null } = {}) {
  const ids = new Set();
  if (accountId) {
    ids.add(accountId);
  } else {
    for (const row of db_.all(
      `SELECT DISTINCT account_id FROM number_charges
        WHERE period = ? AND status = 'pending' AND account_id IS NOT NULL`,
      [period]
    )) {
      ids.add(row.account_id);
    }
    for (const row of db_.all(
      "SELECT DISTINCT account_id FROM subscriptions WHERE status IN ('active', 'trialing') AND account_id IS NOT NULL"
    )) {
      ids.add(row.account_id);
    }
  }

  const invoices = [];
  let billedCents = 0;
  let billedLines = 0;
  let planLines = 0;
  let settled = 0;
  for (const id of ids) {
    try {
      const result = billMonthForAccount(id, period);
      if (result.billed || result.planAdded) {
        invoices.push({
          id: result.invoice.id,
          invoiceNo: result.invoice.invoice_no,
          accountId: id,
          created: result.created,
          lines: result.billed,
          planLines: result.planAdded,
          totalCents: result.totalCents,
        });
        billedCents += result.cents;
        billedLines += result.billed;
        planLines += result.planAdded;
      }
      if (result.invoice?.status === 'paid') settled += 1;
    } catch (err) {
      console.error(`[invoicing] could not bill ${id} for ${period}: ${err.message}`);
    }
  }
  return { period, accounts: ids.size, invoices, billedLines, planLines, billedCents, settled };
}

/** What is recorded for a month but not yet on any bill — the console's answer. */
export function uninvoicedRent({ period = monthPeriod() } = {}) {
  const rows = db_.all(
    `SELECT c.*, a.email AS account_email, n.provider
       FROM number_charges c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN numbers n ON n.id = c.number_id
      WHERE c.period = ? AND c.status = 'pending'
      ORDER BY a.email, c.e164`,
    [period]
  );
  return {
    period,
    lines: rows.length,
    totalCents: rows.reduce((total, row) => total + row.amount_cents, 0),
    charges: rows.map((row) => ({
      e164: row.e164,
      account: row.account_email || '',
      amountCents: row.amount_cents,
      currency: row.currency,
    })),
  };
}

/**
 * The automatic run. Same shape as the rent sweep: once at boot, then every
 * twelve hours, which is enough because a month is billed once.
 */
export function startMonthlyInvoicing({ intervalMs = 12 * 60 * 60 * 1000, enabled = config.billing.rentInvoicing } = {}) {
  if (!enabled) return () => {};
  const run = () => {
    try {
      const result = runMonthlyInvoicing({ period: monthPeriod() });
      if (result.billedLines || result.planLines) {
        console.log(
          `[invoicing] billed ${result.planLines} plan and ${result.billedLines} rent line(s) for ${result.period} across ${result.invoices.length} invoice(s)`
        );
      }
      return result;
    } catch (err) {
      console.error('[invoicing] run failed', err.message);
      return null;
    }
  };
  run();
  const timer = setInterval(run, Math.max(60_000, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}

export { accountByEmail };
