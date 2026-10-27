import { db_, now } from '../db/index.js';
import { formatNumber } from '../lib/e164.js';
import { entitlementFor, planView, subscriptionForAccount, subscriptionView } from '../lib/subscriptions.js';
import { payUrlForInvoice, stripeConfigured } from '../lib/payments.js';
import { publicBrand } from '../lib/brand.js';
import { config } from '../config.js';
import { notFound, badRequest } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';

/**
 * A customer's own corner of the platform.
 *
 * Everything here answers for the signed-in account and nothing else: the lines
 * that carry its `account_id`, the numbers it holds, its subscription, and the
 * invoices addressed to its email. Staff routes are not reachable from a
 * customer session at all — the boundary is in plugins/auth.js, not here — so
 * this file only has to be correct about ownership, not about hiding things.
 */

const lineView = (row) => ({
  id: row.id,
  extension: row.extension,
  displayName: row.display_name,
  email: row.email,
  voicemail: !!row.voicemail,
  dnd: !!row.dnd,
  forwardTo: row.forward_to,
  enabled: !!row.enabled,
  // A line billing switched off is not the same as one the customer turned off.
  suspendedByBilling: !!row.suspended_by_billing,
  number: row.e164 ? formatNumber(row.e164) : '',
  e164: row.e164 || '',
  secretSet: !!row.secret,
  updatedAt: row.updated_at,
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
  // Empty unless card payment is switched on and the invoice is payable.
  payUrl: payUrlForInvoice(row),
});

export default async function meRoutes(app) {
  // The paid gate applies: an unpaid customer reaches /api/portal/status for the
  // reason and the plans, but not the customer area itself.
  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    await app.authenticate(request);
  });

  const ownLines = (accountId) =>
    db_.all(
      `SELECT e.*, n.e164 FROM extensions e
         LEFT JOIN numbers n ON n.id = e.number_id
        WHERE e.account_id = ?
        ORDER BY CAST(e.extension AS INTEGER), e.extension`,
      [accountId]
    );

  /** Everything the customer portal renders, in one request. */
  app.get('/me', async (request) => {
    const account = request.account;
    const entitlement = request.entitlement || entitlementFor(account);
    const subscription = subscriptionForAccount(account.id);
    const invoices = account.email
      ? db_.all(
          `SELECT * FROM invoices
            WHERE lower(email) = ?
            ORDER BY COALESCE(paid_at, issued_at, due_at, period_end) DESC
            LIMIT 24`,
          [String(account.email).toLowerCase()]
        )
      : [];
    const numbers = db_.all('SELECT * FROM numbers WHERE account_id = ? ORDER BY e164', [account.id]);

    return {
      user: {
        id: account.id,
        email: account.email,
        name: account.name,
        kind: account.account_kind || 'staff',
        suspended: !!account.suspended_at,
      },
      brand: publicBrand(),
      entitlement,
      plan: entitlement.plan || null,
      subscription: subscription ? subscriptionView(subscription) : null,
      lines: ownLines(account.id).map(lineView),
      numbers: numbers.map((row) => ({
        id: row.id,
        e164: row.e164,
        display: formatNumber(row.e164),
        carrier: row.carrier,
        lineType: row.line_type,
        status: row.status,
      })),
      invoices: invoices.map(invoiceView),
      payments: {
        // A boolean, never a key: the portal can say honestly whether an unpaid
        // invoice can be settled online right now.
        configured: stripeConfigured() && config.payments.enabled,
        currency: invoices[0]?.currency || 'USD',
      },
    };
  });

  /**
   * Self-service on your own line: what to call it, where it rings, whether it
   * takes voicemail. Anything that changes the switch — the extension number,
   * the SIP secret, the endpoint — stays with an operator.
   */
  app.patch('/me/line/:id', async (request) => {
    const account = request.account;
    const row = db_.get('SELECT * FROM extensions WHERE id = ?', [request.params.id]);
    if (!row || row.account_id !== account.id) throw notFound('That line is not on your account');

    const body = request.body || {};
    const patch = {};
    if (body.displayName !== undefined) patch.display_name = v.str(body.displayName, { name: 'displayName', max: 80 });
    if (body.voicemail !== undefined) patch.voicemail = v.bool(body.voicemail) ? 1 : 0;
    if (body.dnd !== undefined) patch.dnd = v.bool(body.dnd) ? 1 : 0;
    if (body.forwardTo !== undefined) {
      patch.forward_to = v.str(body.forwardTo, { name: 'forwardTo', max: 10, required: false });
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
    db_.run(`UPDATE extensions SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    logEvent({
      actor: account.email,
      action: 'me.line_updated',
      subject: row.extension,
      detail: JSON.stringify(patch),
      ip: request.ip,
    });
    const fresh = db_.get(
      `SELECT e.*, n.e164 FROM extensions e LEFT JOIN numbers n ON n.id = e.number_id WHERE e.id = ?`,
      [row.id]
    );
    return { line: lineView(fresh) };
  });

  /** The catalog, for a customer who wants to move up or down a plan. */
  app.get('/me/plans', async () => ({ plans: entitlementPlans() }));
}

/** The plans the portal may show: the ones on sale, without the add-on flags. */
function entitlementPlans() {
  const rows = db_.all('SELECT * FROM plans WHERE active = 1 ORDER BY audience, sort_order, price_cents');
  return rows.map((row) => planView(row, []));
}
