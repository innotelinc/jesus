import { db_, newId } from '../db/index.js';
import { config } from '../config.js';

/**
 * What rented numbers cost.
 *
 * A DID bought from the carrier is a monthly charge against somebody: the
 * platform pays VoIP.ms, and the account that holds the line is whose bill it
 * belongs on. That is a fact worth keeping per month rather than recomputing
 * from the current price, because a price change must not rewrite last month.
 *
 * One row per number per month. The unique key on (number_id, period) is what
 * makes the sweep idempotent: running it hourly, or twice after a restart, still
 * records a month once. A released number stops accruing at the next period —
 * the month it was released in was already incurred.
 */

/** UTC month key: 2026-10. */
export function monthPeriod(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month after `period`, and the one after the given date. */
export function nextPeriod(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  return monthPeriod(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
}

const DAY = 86400_000;

export const numberViewCost = (row) => ({
  provider: row.provider || '',
  providerRef: row.provider_ref || '',
  monthlyCostCents: Number(row.monthly_cost_cents || 0),
  currency: row.cost_currency || config.voipms.currency,
  nextBillingAt: row.next_billing_at || null,
  rentedAt: row.rented_at || null,
  releasedAt: row.released_at || null,
});

/** Is this row a live rental that costs money? */
export const isRented = (row) =>
  !!(row && row.provider && row.rented_at && !row.released_at && Number(row.monthly_cost_cents || 0) > 0);

/**
 * Record one month of rent for one number. Idempotent: the same month for the
 * same number is the same row, whatever the price does afterwards.
 */
export function recordRentalCharge(number, { period = monthPeriod(), amountCents, currency } = {}) {
  if (!number) return null;
  const amount = amountCents === undefined ? Number(number.monthly_cost_cents || 0) : Number(amountCents);
  if (!(amount > 0)) return null;
  const id = newId('nch_');
  db_.run(
    `INSERT INTO number_charges (id, number_id, account_id, e164, period, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT (number_id, period) DO NOTHING`,
    [id, number.id, number.account_id || null, number.e164, period, Math.round(amount), currency || number.cost_currency || config.voipms.currency]
  );
  return db_.get('SELECT * FROM number_charges WHERE number_id = ? AND period = ?', [number.id, period]);
}

/**
 * The month's rent for every live rental.
 *
 * Called at boot and on a timer. `created` counts the rows this pass added, so
 * the log line is honest about whether anything happened.
 */
export function ensureRentalCharges({ at = new Date() } = {}) {
  const period = monthPeriod(at);
  const rows = db_.all(
    `SELECT * FROM numbers
      WHERE provider <> '' AND rented_at IS NOT NULL AND released_at IS NULL AND monthly_cost_cents > 0`
  );
  let created = 0;
  for (const row of rows) {
    const before = db_.get('SELECT id FROM number_charges WHERE number_id = ? AND period = ?', [row.id, period]);
    const charge = recordRentalCharge(row, { period });
    if (charge && !before) created += 1;
  }
  return { period, considered: rows.length, created };
}

/** A number that was released stops accruing: only the month it left stays. */
export function voidFutureCharges(numberId, { from = new Date() } = {}) {
  const period = monthPeriod(from);
  const result = db_.run(
    "UPDATE number_charges SET status = 'void' WHERE number_id = ? AND status = 'pending' AND period > ?",
    [numberId, period]
  );
  return Number(result.changes || 0);
}

const chargeView = (row) => ({
  id: row.id,
  numberId: row.number_id,
  e164: row.e164,
  period: row.period,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  invoiceId: row.invoice_id || null,
  createdAt: row.created_at,
});

/**
 * Rent, by account, for one month.
 *
 * Accounts with no rent are absent rather than listed at zero: this answers
 * "who is carrying a number cost", not "who is a customer".
 */
export function rentalCosts({ period = monthPeriod() } = {}) {
  const rows = db_.all(
    `SELECT c.*, a.email AS account_email, a.name AS account_name
       FROM number_charges c
       LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.period = ? AND c.status <> 'void'
      ORDER BY a.email IS NULL, a.email, c.e164`,
    [period]
  );

  const accounts = new Map();
  const unassigned = [];
  let totalCents = 0;
  let currency = '';

  for (const row of rows) {
    totalCents += row.amount_cents;
    currency = currency || row.currency;
    if (!row.account_id) {
      unassigned.push(chargeView(row));
      continue;
    }
    const key = row.account_id;
    if (!accounts.has(key)) {
      accounts.set(key, {
        accountId: key,
        email: row.account_email || '',
        name: row.account_name || '',
        currency: row.currency,
        monthlyCents: 0,
        numbers: [],
      });
    }
    const entry = accounts.get(key);
    entry.monthlyCents += row.amount_cents;
    entry.numbers.push(chargeView(row));
  }

  return {
    period,
    totalCents,
    currency: currency || config.voipms.currency,
    accounts: [...accounts.values()].sort((a, b) => b.monthlyCents - a.monthlyCents),
    unassigned,
  };
}

/** The rent one account carries, which is what its own bill needs. */
export function rentalCostsForAccount(accountId, { period = monthPeriod() } = {}) {
  const rows = db_.all(
    "SELECT * FROM number_charges WHERE account_id = ? AND period = ? AND status <> 'void' ORDER BY e164",
    [accountId, period]
  );
  return {
    period,
    totalCents: rows.reduce((total, row) => total + row.amount_cents, 0),
    currency: rows[0]?.currency || config.voipms.currency,
    charges: rows.map(chargeView),
  };
}

/** Charges a given number has accrued, newest first. */
export function chargesForNumber(numberId, limit = 24) {
  return db_
    .all('SELECT * FROM number_charges WHERE number_id = ? ORDER BY period DESC LIMIT ?', [numberId, limit])
    .map(chargeView);
}

/**
 * The sweep. Billing rent is not a user action, so it has to happen on its own:
 * the first pass runs at boot (a container that restarts daily must still record
 * the month) and then daily, which is cheap because the insert is idempotent.
 */
export function startRentalSweep({ intervalMs = 12 * 60 * 60 * 1000, at = new Date() } = {}) {
  const run = () => {
    try {
      const result = ensureRentalCharges({ at: new Date() });
      if (result.created) console.log(`[rentals] recorded ${result.created} number charge(s) for ${result.period}`);
      return result;
    } catch (err) {
      console.error('[rentals] sweep failed', err.message);
      return null;
    }
  };

  run();
  const timer = setInterval(run, Math.max(60_000, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Renewal date the provider reported, as an ISO date, or null. */
export function parseBillingDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`;
  const parseable = Date.parse(value);
  return Number.isFinite(parseable) ? new Date(parseable).toISOString() : null;
}

/** Days until a renewal, for the console to warn about an upcoming charge. */
export const daysUntil = (iso) => {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.ceil((at - Date.now()) / DAY);
};
