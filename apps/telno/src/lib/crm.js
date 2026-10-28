import { db_, newId, now } from '../db/index.js';
import { logEvent } from './audit.js';
import { badRequest, notFound } from './errors.js';
import { formatNumber } from './e164.js';
import { itemsFor } from './invoicing.js';
import { entitlementFor, subscriptionForAccount } from './subscriptions.js';

/**
 * The operator's view of a customer.
 *
 * The platform already holds the facts — an account, its subscription, its
 * lines, its invoices, its calls — but spread across tables that each answer
 * their own question. A CRM is not a second copy of those facts: it is one
 * identity with everything about it joined, so the person answering the phone
 * gets an answer instead of a tour of six screens.
 *
 * Everything here is derived. The only records this module owns are the three
 * things the platform could not already know: a complaint or request (a
 * ticket), an operator's private note, and money that actually moved (a
 * payment). That line is deliberate — a CRM that keeps its own copy of the
 * billing data is a CRM that disagrees with the switch.
 */

export const TICKET_CATEGORIES = ['support', 'billing', 'complaint', 'service_change', 'porting', 'outage'];
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const TICKET_STATES = ['open', 'pending', 'resolved', 'closed'];
export const PAYMENT_METHODS = ['stripe', 'manual', 'credit', 'refund'];

/** Urgent first, then newest: the order a queue is actually worked in. */
const PRIORITY_SQL = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

const count = (sql, params = []) => db_.get(sql, params)?.n || 0;
const monthlyPrice = (row) => (row.interval === 'year' ? Math.round(row.price_cents / 12) : row.price_cents);

/**
 * The customer row everything else hangs off.
 *
 * One query, because a list of customers is asked for far more often than a
 * single one and the derived columns (balance, lines, open tickets, last call)
 * are exactly what the list sorts and filters on. The sub-selects are indexed
 * per account, so this stays a page of work rather than a table scan.
 *
 * `nowValue` is bound, not interpolated: an overdue balance is computed against
 * a stated instant so a page cannot flip a row between renders.
 */
const CUSTOMER_BASE = `
  SELECT a.id, a.email, a.name, a.company, a.phone, a.city, a.country, a.website,
         a.address, COALESCE(a.account_kind, 'staff') AS account_kind, a.role,
         a.created_at, a.last_login_at, a.suspended_at,
         a.email_verified_at, a.phone_verified_at, a.terms_accepted_at,
         a.directory_opt_in, a.listing_kind,
         s.plan_name, s.plan_slug, s.price_cents AS plan_price_cents,
         s.currency AS plan_currency, s.interval AS plan_interval,
         s.status AS plan_status, s.current_period_end,
         ba.state AS dunning_state, ba.suspend_on, ba.final_notice_at,
         (SELECT COUNT(*) FROM numbers n WHERE n.account_id = a.id AND n.released_at IS NULL) AS number_count,
         (SELECT COUNT(*) FROM extensions e WHERE e.account_id = a.id) AS line_count,
         (SELECT COALESCE(SUM(i.amount_cents), 0) FROM invoices i
           WHERE i.account_id = a.id AND i.status IN ('open', 'overdue')) AS balance_cents,
         (SELECT COALESCE(SUM(i.amount_cents), 0) FROM invoices i
           WHERE i.account_id = a.id AND i.status IN ('open', 'overdue')
             AND i.due_at IS NOT NULL AND i.due_at < ?) AS overdue_cents,
         (SELECT COUNT(*) FROM tickets t
           WHERE t.account_id = a.id AND t.state IN ('open', 'pending')) AS open_tickets,
         (SELECT MAX(c.started_at) FROM calls c
           WHERE c.extension IN (SELECT extension FROM extensions WHERE account_id = a.id)
              OR c.to_number IN (SELECT e164 FROM numbers WHERE account_id = a.id)
              OR c.from_number IN (SELECT e164 FROM numbers WHERE account_id = a.id)) AS last_call_at
    FROM accounts a
    LEFT JOIN subscriptions s ON s.id = (
      SELECT id FROM subscriptions WHERE account_id = a.id ORDER BY created_at DESC LIMIT 1
    )
    LEFT JOIN billing_accounts ba ON lower(ba.email) = lower(a.email)
`;

const customerView = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name || '',
  company: row.company || '',
  phone: row.phone || '',
  city: row.city || '',
  country: row.country || '',
  website: row.website || '',
  address: row.address || '',
  kind: row.account_kind || 'staff',
  role: row.role,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  suspendedAt: row.suspended_at,
  verified: {
    email: !!row.email_verified_at,
    phone: !!row.phone_verified_at,
    terms: !!row.terms_accepted_at,
    profile: !!row.terms_accepted_at,
  },
  directoryOptIn: !!row.directory_opt_in,
  // The plan is a snapshot of what was sold, not a join to today's catalog: a
  // price change must not rewrite what a customer is paying.
  plan: row.plan_name
    ? {
        name: row.plan_name,
        slug: row.plan_slug || '',
        priceCents: row.plan_price_cents,
        monthlyCents: monthlyPrice({
          interval: row.plan_interval,
          price_cents: row.plan_price_cents,
        }),
        currency: row.plan_currency,
        interval: row.plan_interval,
        status: row.plan_status,
        currentPeriodEnd: row.current_period_end,
      }
    : null,
  dunning: {
    state: row.dunning_state || 'current',
    suspendOn: row.suspend_on || null,
    finalNoticeAt: row.final_notice_at || null,
  },
  balanceCents: row.balance_cents || 0,
  overdueCents: row.overdue_cents || 0,
  lines: row.line_count || 0,
  numbers: row.number_count || 0,
  openTickets: row.open_tickets || 0,
  lastCallAt: row.last_call_at || null,
});

/* -------------------------------------------------------------- customers -- */

/**
 * A page of customers, filtered the way an operator asks for them.
 *
 * The filters run over the derived row, not the raw tables: "overdue" means the
 * balance that is past its due date, and "has tickets" means something is
 * waiting on us — the two questions a queue is really sorted by.
 */
export function listCustomers({ q = '', state = '', plan = '', sort = 'attention', limit = 25, offset = 0 } = {}) {
  const at = now();
  const where = ["c.account_kind = 'customer'"];
  const params = [];
  if (q) {
    const like = `%${q}%`;
    where.push('(c.email LIKE ? OR c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ?)');
    params.push(like, like, like, like);
  }
  if (plan) {
    where.push('c.plan_slug = ?');
    params.push(plan);
  }
  const states = {
    active: "c.plan_status IN ('active', 'trialing') AND c.suspended_at IS NULL",
    past_due: 'c.overdue_cents > 0',
    suspended: 'c.suspended_at IS NOT NULL',
    no_plan: 'c.plan_name IS NULL',
    tickets: 'c.open_tickets > 0',
    unverified: '(c.email_verified_at IS NULL OR c.phone_verified_at IS NULL)',
  };
  if (state && states[state]) where.push(states[state]);

  const orders = {
    attention: 'CASE WHEN c.open_tickets > 0 THEN 0 ELSE 1 END, c.overdue_cents DESC, c.created_at DESC',
    recent: 'c.created_at DESC',
    balance: 'c.balance_cents DESC, c.created_at DESC',
    tickets: 'c.open_tickets DESC, c.created_at DESC',
    name: "COALESCE(NULLIF(c.name, ''), c.email) COLLATE NOCASE",
  };
  const order = orders[sort] || orders.attention;
  const clause = where.join(' AND ');

  const rows = db_.all(
    `SELECT * FROM (${CUSTOMER_BASE}) AS c WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [at, ...params, Math.min(Math.max(Number(limit) || 25, 1), 100), Math.max(Number(offset) || 0, 0)]
  );
  const total = count(`SELECT COUNT(*) AS n FROM (${CUSTOMER_BASE}) AS c WHERE ${clause}`, [at, ...params]);

  return {
    items: rows.map(customerView),
    total,
    limit,
    offset,
    plans: db_.all(
      "SELECT DISTINCT plan_slug AS slug, plan_name AS name FROM subscriptions WHERE plan_slug <> '' ORDER BY plan_name"
    ),
  };
}

/** The head of the customer's page: what the list shows, plus the profile. */
export function customerRow(accountId) {
  const row = db_.get(`SELECT * FROM (${CUSTOMER_BASE}) AS c WHERE c.id = ?`, [now(), String(accountId)]);
  if (!row) throw notFound('Customer not found');
  return customerView(row);
}

const lineView = (row) => ({
  id: row.id,
  e164: row.e164,
  number: formatNumber(row.e164),
  ext: row.line_extension || '',
  displayName: row.display_name || '',
  faxMode: row.fax_mode,
  status: row.status,
  visibility: row.visibility,
  provider: row.provider || '',
  monthlyCostCents: row.monthly_cost_cents || 0,
  rentedAt: row.rented_at,
  releasedAt: row.released_at,
  voicemail: row.voicemail === undefined ? null : !!row.voicemail,
  scif: !!row.scif,
  lineEnabled: row.line_enabled === undefined ? null : !!row.line_enabled,
});

const invoiceView = (row) => ({
  id: row.id,
  number: row.invoice_no,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  issuedAt: row.issued_at,
  dueAt: row.due_at,
  paidAt: row.paid_at,
  rentPeriod: row.rent_period || '',
  email: row.email || '',
  lastSentAt: row.last_sent_at,
  paymentRef: row.payment_ref || '',
  items: itemsFor(row.id).map((item) => ({
    id: item.id,
    kind: item.kind,
    description: item.description,
    quantity: item.quantity,
    amountCents: item.amount_cents,
    settledBy: item.settled_by || 'invoice',
  })),
});

const paymentView = (row) => ({
  id: row.id,
  accountId: row.account_id,
  invoiceId: row.invoice_id,
  amountCents: row.amount_cents,
  currency: row.currency,
  method: row.method,
  reference: row.reference,
  note: row.note,
  receivedAt: row.received_at,
  createdBy: row.created_by,
});

const ticketView = (row) => {
  const due = row.due_at ? Date.parse(row.due_at) : Number.NaN;
  const open = row.state === 'open' || row.state === 'pending';
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    name: row.name,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    state: row.state,
    assignee: row.assignee || '',
    numberId: row.number_id || '',
    number: row.e164 ? formatNumber(row.e164) : '',
    dueAt: row.due_at || null,
    firstResponseAt: row.first_response_at || null,
    resolvedAt: row.resolved_at || null,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: row.notes_count === undefined ? undefined : row.notes_count,
    // Late is a fact about the clock, not an opinion about the customer.
    overdue: open && Number.isFinite(due) && due < Date.now(),
  };
};

/** Calls that belong to a customer: their lines, both ends of the number. */
function customerCalls({ extensions, numbers, limit = 25 }) {
  const exts = extensions.map((row) => row.extension).filter(Boolean);
  const dids = numbers.map((row) => row.e164).filter(Boolean);
  if (!exts.length && !dids.length) return [];
  const clauses = [];
  const params = [];
  if (exts.length) {
    clauses.push(`extension IN (${exts.map(() => '?').join(', ')})`);
    params.push(...exts);
  }
  if (dids.length) {
    clauses.push(`to_number IN (${dids.map(() => '?').join(', ')})`);
    clauses.push(`from_number IN (${dids.map(() => '?').join(', ')})`);
    params.push(...dids, ...dids);
  }
  return db_
    .all(
      `SELECT * FROM calls WHERE ${clauses.join(' OR ')} ORDER BY started_at DESC LIMIT ?`,
      [...params, Math.min(Math.max(Number(limit) || 25, 1), 100)]
    )
    .map((row) => ({
      id: row.id,
      callId: row.call_id,
      direction: row.direction,
      from: row.from_number,
      to: row.to_number,
      extension: row.extension,
      disposition: row.disposition,
      startedAt: row.started_at,
      answeredAt: row.answered_at,
      duration: row.duration,
      billsec: row.billsec,
      recording: row.recording || '',
      audioUrl: row.recording ? `/api/calls/${row.id}/audio` : '',
    }));
}

/**
 * The timeline: what happened to this customer, in the order it happened.
 *
 * Assembled from the facts already recorded rather than written twice. A
 * service change is a number rented or a plan changed, an invoice is issued and
 * later paid, a ticket is opened and resolved — the timeline is a reading of
 * those rows, so it cannot drift from them.
 */
function buildActivity({ customer, subscription, numbers, extensions, invoices, payments, tickets, notes }) {
  const items = [];
  const push = (at, kind, title, detail = '', ref = '') => {
    if (!at) return;
    items.push({ at, kind, title, detail, ref });
  };

  push(customer.createdAt, 'account', 'Account created', customer.email);
  if (customer.lastLoginAt) push(customer.lastLoginAt, 'account', 'Signed in', customer.email);
  if (subscription) {
    push(
      subscription.created_at,
      'plan',
      `Plan: ${subscription.plan_name}`,
      `${(subscription.price_cents / 100).toFixed(2)} ${subscription.currency}/${subscription.interval} · ${subscription.status}`
    );
    if (subscription.canceled_at) push(subscription.canceled_at, 'plan', 'Plan canceled', subscription.plan_name);
  }
  for (const row of numbers) {
    push(row.rented_at, 'service', `Number ${formatNumber(row.e164)} added`, row.provider || 'manual', row.id);
    push(row.released_at, 'service', `Number ${formatNumber(row.e164)} released`, 'no longer billed', row.id);
  }
  for (const row of extensions) {
    push(row.created_at, 'service', `Line ${row.extension} added`, row.display_name || '', row.id);
  }
  for (const row of invoices) {
    push(row.issued_at || row.created_at, 'billing', `Invoice ${row.invoice_no} issued`, `${(row.amount_cents / 100).toFixed(2)} ${row.currency} · ${row.status}`, row.id);
    if (row.paid_at) push(row.paid_at, 'billing', `Invoice ${row.invoice_no} paid`, `${(row.amount_cents / 100).toFixed(2)} ${row.currency}`, row.id);
  }
  for (const row of payments) {
    const refund = row.amount_cents < 0;
    push(
      row.received_at,
      'billing',
      `${refund ? 'Refund' : 'Payment'} recorded`,
      `${(Math.abs(row.amount_cents) / 100).toFixed(2)} ${row.currency} · ${row.method}${row.reference ? ` · ${row.reference}` : ''}`,
      row.id
    );
  }
  for (const row of tickets) {
    push(row.created_at, 'ticket', `Ticket opened: ${row.subject}`, `${row.category} · ${row.priority}`, row.id);
    if (row.resolved_at) push(row.resolved_at, 'ticket', `Ticket ${row.state}: ${row.subject}`, row.assignee || '', row.id);
  }
  for (const row of notes) {
    push(row.created_at, 'note', 'Note added', String(row.body).slice(0, 120), row.id);
  }

  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
}

/** Everything about one customer, in the shape the panel renders. */
export function customerDetail(accountId) {
  const customer = customerRow(accountId);
  const account = db_.get('SELECT * FROM accounts WHERE id = ?', [customer.id]);
  if (!account) throw notFound('Customer not found');
  const subscription = subscriptionForAccount(customer.id);
  const numbers = db_.all(
    `SELECT n.*, e.extension AS line_extension, e.display_name, e.voicemail, e.enabled AS line_enabled, e.scif
       FROM numbers n LEFT JOIN extensions e ON e.number_id = n.id
      WHERE n.account_id = ?
      ORDER BY n.released_at IS NOT NULL, n.e164`,
    [customer.id]
  );
  const extensions = db_.all('SELECT * FROM extensions WHERE account_id = ? ORDER BY extension', [customer.id]);
  const invoices = db_.all(
    `SELECT * FROM invoices
      WHERE account_id = ? OR lower(email) = lower(?)
      ORDER BY COALESCE(issued_at, created_at) DESC LIMIT 40`,
    [customer.id, account.email]
  );
  const payments = db_.all(
    'SELECT * FROM payments WHERE account_id = ? ORDER BY received_at DESC LIMIT 40',
    [customer.id]
  );
  const tickets = db_.all(
    `SELECT t.*, n.e164 FROM tickets t LEFT JOIN numbers n ON n.id = t.number_id
      WHERE t.account_id = ?
      ORDER BY t.state IN ('open', 'pending') DESC, ${PRIORITY_SQL}, t.created_at DESC
      LIMIT 50`,
    [customer.id]
  );
  const notes = db_.all(
    'SELECT id, actor, body, created_at FROM customer_notes WHERE account_id = ? ORDER BY created_at DESC LIMIT 50',
    [customer.id]
  );
  const calls = customerCalls({ extensions, numbers, limit: 25 });
  const collected = payments.reduce((sum, row) => sum + (row.amount_cents || 0), 0);
  const entitlement = entitlementFor(account);

  return {
    customer,
    profile: {
      address: account.address || '',
      listingKind: account.listing_kind || 'business',
      directoryOptIn: !!account.directory_opt_in,
      emailVerifiedAt: account.email_verified_at || null,
      phoneVerifiedAt: account.phone_verified_at || null,
      termsAcceptedAt: account.terms_accepted_at || null,
      termsVersion: account.terms_version || '',
    },
    subscription: subscription
      ? {
          id: subscription.id,
          planName: subscription.plan_name,
          planSlug: subscription.plan_slug,
          priceCents: subscription.price_cents,
          currency: subscription.currency,
          interval: subscription.interval,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
          canceledAt: subscription.canceled_at,
          stripeSubscriptionId: subscription.stripe_subscription_id,
          since: subscription.created_at,
        }
      : null,
    entitlement: { active: !!entitlement.active, reason: entitlement.reason || '' },
    lines: numbers.map(lineView),
    extensions: extensions.map((row) => ({
      id: row.id,
      extension: row.extension,
      displayName: row.display_name,
      enabled: !!row.enabled,
      voicemail: !!row.voicemail,
      suspendedByBilling: !!row.suspended_by_billing,
      scif: !!row.scif,
    })),
    billing: {
      balanceCents: customer.balanceCents,
      overdueCents: customer.overdueCents,
      collectedCents: collected,
      currency: customer.plan?.currency || invoices[0]?.currency || 'USD',
      invoices: invoices.map(invoiceView),
      payments: payments.map(paymentView),
    },
    calls,
    tickets: tickets.map(ticketView),
    notes: notes.map((row) => ({ id: row.id, actor: row.actor, body: row.body, at: row.created_at })),
    activity: buildActivity({ customer, subscription, numbers, extensions, invoices, payments, tickets, notes }),
  };
}

/** The numbers behind the top of the panel. */
export function crmOverview() {
  const at = now();
  const monthStart = `${at.slice(0, 7)}-01`;
  const live = "status IN ('active', 'trialing')";
  const subscriptions = db_.all(`SELECT * FROM subscriptions WHERE ${live}`);
  const mrr = subscriptions.reduce((sum, row) => sum + monthlyPrice(row), 0);
  return {
    customers: count("SELECT COUNT(*) AS n FROM accounts WHERE COALESCE(account_kind, 'staff') = 'customer'"),
    newThisMonth: count("SELECT COUNT(*) AS n FROM accounts WHERE COALESCE(account_kind, 'staff') = 'customer' AND created_at >= ?", [monthStart]),
    activeSubscriptions: subscriptions.length,
    mrrCents: mrr,
    currency: subscriptions[0]?.currency || 'USD',
    outstandingCents: count("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoices WHERE status IN ('open', 'overdue')"),
    overdueCents: count("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoices WHERE status IN ('open', 'overdue') AND due_at IS NOT NULL AND due_at < ?", [at]),
    suspended: count('SELECT COUNT(*) AS n FROM accounts WHERE suspended_at IS NOT NULL'),
    openTickets: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending')"),
    urgentTickets: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND priority IN ('urgent', 'high')"),
    unassignedTickets: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND assignee = ''"),
    breachingTickets: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND due_at IS NOT NULL AND due_at < ?", [at]),
    openTicketsToday: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND created_at >= ?", [at.slice(0, 10)]),
    collectedThisMonth: count('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE received_at >= ?', [monthStart]),
    paymentsThisMonth: count('SELECT COUNT(*) AS n FROM payments WHERE received_at >= ?', [monthStart]),
  };
}

/* --------------------------------------------------------------- customer -- */

/**
 * What an operator may correct on a customer's record.
 *
 * Contact details, and only those. The email is the identity the whole platform
 * keys on — invoices, dunning and logins all point at it — so changing it is an
 * account operation, not a CRM edit, and is deliberately not in this list.
 */
export function updateCustomer(accountId, patch = {}, actor = '') {
  const row = db_.get('SELECT * FROM accounts WHERE id = ?', [String(accountId)]);
  if (!row) throw notFound('Customer not found');

  const fields = {
    name: ['name', 120],
    company: ['company', 120],
    phone: ['phone', 40],
    address: ['address', 200],
    city: ['city', 80],
    country: ['country', 80],
    website: ['website', 200],
  };
  const sets = [];
  const values = [];
  for (const [key, [column, max]] of Object.entries(fields)) {
    if (patch[key] === undefined) continue;
    const value = String(patch[key] ?? '').trim().slice(0, max);
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  values.push(row.id);
  db_.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, values);
  logEvent({
    actor,
    action: 'crm.customer_updated',
    subject: row.email,
    detail: Object.keys(patch).filter((key) => key in fields).join(', '),
  });
  return customerRow(row.id);
}

/** A private note about the customer: not a job, but worth remembering. */
export function addCustomerNote(accountId, body, actor = '') {
  const text = String(body || '').trim();
  if (!text) throw badRequest('A note needs a body');
  if (text.length > 4000) throw badRequest('A note must be under 4000 characters');
  const account = db_.get('SELECT id, email FROM accounts WHERE id = ?', [String(accountId)]);
  if (!account) throw notFound('Customer not found');
  const id = newId('cnote_');
  db_.run('INSERT INTO customer_notes (id, account_id, actor, body) VALUES (?, ?, ?, ?)', [id, account.id, actor, text]);
  logEvent({ actor, action: 'crm.note_added', subject: account.email, detail: text.slice(0, 160) });
  return { id, actor, body: text, at: now() };
}

/* ----------------------------------------------------------------- tickets -- */

/**
 * The queue.
 *
 * Sorted by what is waiting on us, not by what is oldest: an urgent ticket
 * opened a minute ago outranks a normal one from last week, and a ticket past
 * its due date outranks both. The counts come from the same filter so the
 * badges and the list cannot disagree.
 */
export function listTickets({ state = '', priority = '', assignee = '', category = '', q = '', accountId = '', limit = 25, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (state === 'open') where.push("t.state IN ('open', 'pending')");
  else if (state) {
    where.push('t.state = ?');
    params.push(state);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (assignee === 'unassigned') where.push("t.assignee = ''");
  else if (assignee) {
    where.push('t.assignee = ?');
    params.push(assignee);
  }
  if (category) {
    where.push('t.category = ?');
    params.push(category);
  }
  if (accountId) {
    where.push('t.account_id = ?');
    params.push(accountId);
  }
  if (q) {
    where.push('(t.subject LIKE ? OR t.email LIKE ? OR t.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db_.all(
    `SELECT t.*, n.e164,
            (SELECT COUNT(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id) AS notes_count
       FROM tickets t LEFT JOIN numbers n ON n.id = t.number_id
       ${clause}
      ORDER BY t.state IN ('open', 'pending') DESC, ${PRIORITY_SQL},
               CASE WHEN t.state IN ('open', 'pending') AND t.due_at IS NOT NULL AND t.due_at < ? THEN 0 ELSE 1 END,
               t.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, now(), Math.min(Math.max(Number(limit) || 25, 1), 100), Math.max(Number(offset) || 0, 0)]
  );
  const total = count(`SELECT COUNT(*) AS n FROM tickets t ${clause}`, params);
  return {
    items: rows.map(ticketView),
    total,
    summary: {
      open: count("SELECT COUNT(*) AS n FROM tickets WHERE state = 'open'"),
      pending: count("SELECT COUNT(*) AS n FROM tickets WHERE state = 'pending'"),
      unassigned: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND assignee = ''"),
      urgent: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND priority IN ('urgent', 'high')"),
      overdue: count("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('open', 'pending') AND due_at IS NOT NULL AND due_at < ?", [now()]),
      resolvedToday: count("SELECT COUNT(*) AS n FROM tickets WHERE resolved_at >= ?", [now().slice(0, 10)]),
    },
    assignees: db_
      .all("SELECT DISTINCT assignee FROM tickets WHERE assignee <> '' ORDER BY assignee")
      .map((row) => row.assignee),
  };
}

/** One ticket with its whole conversation, oldest first. */
export function ticketDetail(ticketId) {
  const row = db_.get(
    `SELECT t.*, n.e164,
            (SELECT COUNT(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id) AS notes_count
       FROM tickets t LEFT JOIN numbers n ON n.id = t.number_id
      WHERE t.id = ?`,
    [String(ticketId)]
  );
  if (!row) throw notFound('Ticket not found');
  return {
    ticket: ticketView(row),
    notes: db_
      .all('SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at, rowid', [row.id])
      .map((note) => ({ id: note.id, actor: note.actor, kind: note.kind, body: note.body, at: note.created_at })),
  };
}

const assertCategory = (value, fallback) => {
  const category = String(value || fallback || '').trim();
  if (!TICKET_CATEGORIES.includes(category)) throw badRequest(`category must be one of: ${TICKET_CATEGORIES.join(', ')}`);
  return category;
};
const assertPriority = (value, fallback) => {
  const priority = String(value || fallback || '').trim();
  if (!TICKET_PRIORITIES.includes(priority)) throw badRequest(`priority must be one of: ${TICKET_PRIORITIES.join(', ')}`);
  return priority;
};
const assertState = (value) => {
  const state = String(value || '').trim();
  if (!TICKET_STATES.includes(state)) throw badRequest(`state must be one of: ${TICKET_STATES.join(', ')}`);
  return state;
};

function systemNote(ticketId, body) {
  db_.run(
    "INSERT INTO ticket_notes (id, ticket_id, actor, kind, body) VALUES (?, ?, 'system', 'system', ?)",
    [newId('tnote_'), ticketId, body]
  );
}

export function createTicket({
  accountId = '',
  subject,
  description = '',
  category = 'support',
  priority = 'normal',
  assignee = '',
  numberId = '',
  dueAt = '',
  actor = '',
} = {}) {
  const title = String(subject || '').trim();
  if (!title) throw badRequest('A ticket needs a subject');
  if (title.length > 160) throw badRequest('A subject must be under 160 characters');
  const account = accountId ? db_.get('SELECT * FROM accounts WHERE id = ?', [String(accountId)]) : null;
  if (accountId && !account) throw notFound('Customer not found');
  if (numberId && !db_.get('SELECT id FROM numbers WHERE id = ?', [String(numberId)])) {
    throw badRequest('Unknown number for this ticket');
  }
  const id = newId('tkt_');
  const stamp = now();
  const wantedCategory = assertCategory(category);
  const wantedPriority = assertPriority(priority);
  db_.run(
    `INSERT INTO tickets (id, account_id, email, name, subject, category, priority, state, assignee,
                          number_id, due_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      account?.id || null,
      account?.email || '',
      account?.name || '',
      title,
      wantedCategory,
      wantedPriority,
      String(assignee || '').slice(0, 120),
      numberId || null,
      dueAt || null,
      actor,
      stamp,
      stamp,
    ]
  );
  const opening = String(description || '').trim();
  if (opening) {
    db_.run("INSERT INTO ticket_notes (id, ticket_id, actor, kind, body) VALUES (?, ?, ?, 'note', ?)", [
      newId('tnote_'),
      id,
      actor,
      opening.slice(0, 4000),
    ]);
    // Opening a ticket with what was said is already the first response: the
    // promise is measured from the customer's question to our reply, not to the
    // moment someone remembers to press a button.
    db_.run('UPDATE tickets SET first_response_at = ? WHERE id = ? AND first_response_at IS NULL', [stamp, id]);
  }
  logEvent({
    actor,
    action: 'crm.ticket_opened',
    subject: account?.email || title,
    detail: `${wantedCategory} · ${wantedPriority}`,
  });
  return ticketDetail(id);
}

/**
 * Move a ticket. Every change writes a system note, so the conversation reads
 * back as the history of what was done to it, not only what was said.
 */
export function updateTicket(ticketId, patch = {}, actor = '') {
  const row = db_.get('SELECT * FROM tickets WHERE id = ?', [String(ticketId)]);
  if (!row) throw notFound('Ticket not found');
  const sets = [];
  const values = [];
  const changes = [];

  if (patch.subject !== undefined) {
    const subject = String(patch.subject || '').trim();
    if (!subject) throw badRequest('A ticket needs a subject');
    sets.push('subject = ?');
    values.push(subject.slice(0, 160));
    changes.push('subject changed');
  }
  if (patch.category !== undefined) {
    const category = assertCategory(patch.category);
    sets.push('category = ?');
    values.push(category);
    changes.push(`category → ${category}`);
  }
  if (patch.priority !== undefined) {
    const priority = assertPriority(patch.priority);
    sets.push('priority = ?');
    values.push(priority);
    changes.push(`priority → ${priority}`);
  }
  if (patch.assignee !== undefined) {
    const assignee = String(patch.assignee || '').trim().slice(0, 120);
    sets.push('assignee = ?');
    values.push(assignee);
    changes.push(assignee ? `assigned to ${assignee}` : 'unassigned');
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = ?');
    values.push(patch.dueAt || null);
    changes.push(patch.dueAt ? `due ${String(patch.dueAt).slice(0, 10)}` : 'due date cleared');
  }
  if (patch.numberId !== undefined) {
    if (patch.numberId && !db_.get('SELECT id FROM numbers WHERE id = ?', [String(patch.numberId)])) {
      throw badRequest('Unknown number for this ticket');
    }
    sets.push('number_id = ?');
    values.push(patch.numberId || null);
    changes.push('number changed');
  }
  if (patch.state !== undefined) {
    const state = assertState(patch.state);
    if (state !== row.state) {
      sets.push('state = ?');
      values.push(state);
      // Resolving stamps the clock once; reopening clears it, because a ticket
      // that came back is not resolved and its resolution time is not history.
      if (state === 'resolved' || state === 'closed') {
        sets.push('resolved_at = ?');
        values.push(row.resolved_at || now());
      } else {
        sets.push('resolved_at = NULL');
      }
      changes.push(`state ${row.state} → ${state}`);
    }
  }
  if (!sets.length) throw badRequest('Nothing to update');

  sets.push('updated_at = ?');
  values.push(now(), row.id);
  db_.run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, values);
  systemNote(row.id, `${actor || 'platform'}: ${changes.join(' · ')}`);
  logEvent({ actor, action: 'crm.ticket_updated', subject: row.subject, detail: changes.join(' · ') });
  return ticketDetail(row.id);
}

export function addTicketNote(ticketId, { body, kind = 'note', actor = '' } = {}) {
  const row = db_.get('SELECT * FROM tickets WHERE id = ?', [String(ticketId)]);
  if (!row) throw notFound('Ticket not found');
  const text = String(body || '').trim();
  if (!text) throw badRequest('A note needs a body');
  const noteKind = ['note', 'internal'].includes(kind) ? kind : 'note';
  const id = newId('tnote_');
  const stamp = now();
  db_.run('INSERT INTO ticket_notes (id, ticket_id, actor, kind, body) VALUES (?, ?, ?, ?, ?)', [
    id,
    row.id,
    actor,
    noteKind,
    text.slice(0, 4000),
  ]);
  db_.run('UPDATE tickets SET updated_at = ? WHERE id = ?', [stamp, row.id]);
  // A reply is what the service promise measures, so the first one stops the
  // clock — including one written on a ticket that is still open.
  if (!row.first_response_at) {
    db_.run('UPDATE tickets SET first_response_at = ? WHERE id = ? AND first_response_at IS NULL', [stamp, row.id]);
  }
  logEvent({ actor, action: 'crm.ticket_note', subject: row.subject, detail: text.slice(0, 160) });
  return ticketDetail(row.id);
}

/* ---------------------------------------------------------------- payments -- */

/**
 * Money that moved, and what it settled.
 *
 * Stripe writes its own row when its webhook collects an invoice; this is for
 * everything else — a transfer, a cheque, a goodwill credit, a refund — and it
 * carries the invoice it was meant for, so the bill reconciles later without an
 * operator reconstructing what the money was for. A payment that covers an open
 * invoice marks it paid, with the payment id as the receipt.
 */
export function recordPayment({
  accountId = '',
  invoiceId = '',
  amountCents,
  method = 'manual',
  reference = '',
  note = '',
  receivedAt = '',
  actor = '',
} = {}) {
  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount === 0) throw badRequest('A payment needs a non-zero amount');
  if (Math.abs(amount) > 100_000_000) throw badRequest('That amount is outside what this platform records');
  const paymentMethod = String(method || 'manual');
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw badRequest(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);

  const invoice = invoiceId ? db_.get('SELECT * FROM invoices WHERE id = ?', [String(invoiceId)]) : null;
  if (invoiceId && !invoice) throw notFound('Invoice not found');
  const owner = accountId || invoice?.account_id || '';
  if (!owner) throw badRequest('A payment needs a customer, or an invoice that belongs to one');
  const account = db_.get('SELECT id, email FROM accounts WHERE id = ?', [String(owner)]);
  if (!account) throw notFound('Customer not found');

  const id = newId('pay_');
  const stamp = receivedAt || now();
  db_.run(
    `INSERT INTO payments (id, account_id, invoice_id, amount_cents, currency, method, reference, note, received_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      account.id,
      invoice?.id || null,
      amount,
      invoice?.currency || 'USD',
      paymentMethod,
      String(reference || '').slice(0, 120),
      String(note || '').slice(0, 500),
      stamp,
      actor,
    ]
  );
  if (invoice && amount > 0 && ['open', 'overdue'].includes(invoice.status) && amount >= invoice.amount_cents) {
    db_.run("UPDATE invoices SET status = 'paid', paid_at = ?, payment_ref = ? WHERE id = ?", [stamp, id, invoice.id]);
  }
  logEvent({
    actor,
    action: 'crm.payment_recorded',
    subject: account.email,
    detail: `${(amount / 100).toFixed(2)} via ${paymentMethod}${invoice ? ` · ${invoice.invoice_no}` : ''}`,
  });
  return paymentView(db_.get('SELECT * FROM payments WHERE id = ?', [id]));
}
