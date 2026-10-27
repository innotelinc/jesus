import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db_, now } from '../db/index.js';
import { getSecret } from './vault.js';
import { logEvent } from './audit.js';

/**
 * Online payment for an invoice, through Stripe's hosted page.
 *
 * The design rule is the same one the notices follow: the customer gets a link
 * that works, and the platform finds out when it was used.
 *
 *  - A link is a signed reference, not a stored secret: `HMAC(sessionSecret,
 *    kind:ref)`, so a billing email can carry one and nothing in the database
 *    has to be rotated. It only ever grants the ability to pay that invoice.
 *  - Clicking a link creates a fresh Checkout Session and redirects. Sessions
 *    expire; links do not, so an old email still works a month later.
 *  - Stripe calls the webhook and the invoice is marked paid from the event, not
 *    from the browser. A customer who closes the tab at the success page has
 *    still paid, and the account is reinstated by the next sweep either way.
 *  - No SDK: the REST API is form-encoded and `fetch` is already here, so the
 *    container stays slim.
 */

const KEY_NAME = 'STRIPE_SECRET_KEY';
const WEBHOOK_NAME = 'STRIPE_WEBHOOK_SECRET';
const WEBHOOK_PATH = '/api/public/stripe/webhook';
// The two events that mean money moved. An endpoint without them reports 200
// to Stripe and pays nothing, which is the worst possible failure: silent.
// The two events that mean money moved. An endpoint without them reports 200
// to Stripe and pays nothing, which is the worst possible failure: silent.
const PAYMENT_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
// A subscription is a standing instruction, so its own events matter to the
// portal gate. They are recommended rather than required: a deployment that
// only invoices does not need them, and failing its connection test for that
// would be a false alarm.
const SUBSCRIPTION_EVENTS = [
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];
const WEBHOOK_EVENTS = PAYMENT_EVENTS;
export const webhookEventList = () => [...PAYMENT_EVENTS, ...SUBSCRIPTION_EVENTS];
const MIN_CHARGE_CENTS = 50;

/** Key from the vault first, environment second — the console can rotate it. */
export const stripeKey = () => getSecret(KEY_NAME) || process.env.STRIPE_SECRET_KEY || '';
export const webhookSecret = () => getSecret(WEBHOOK_NAME) || process.env.STRIPE_WEBHOOK_SECRET || '';

export const stripeConfigured = () => !!stripeKey();
export const keySource = () =>
  getSecret(KEY_NAME) ? 'vault' : process.env.STRIPE_SECRET_KEY ? 'environment' : 'none';

/** What the Billing screen says about online payment, without exposing a key. */
export const paymentStatus = () => ({
  enabled: config.payments.enabled,
  configured: stripeConfigured() && config.payments.enabled,
  source: keySource(),
  webhookConfigured: !!webhookSecret(),
  provider: 'stripe',
  // The exact URL to paste into the Stripe dashboard's webhook settings.
  webhookPath: WEBHOOK_PATH,
  webhookUrl: webhookUrl(),
  mode: stripeKey().startsWith('sk_live') ? 'live' : stripeKey() ? 'test' : 'none',
});

/* ------------------------------------------------------------------ links -- */

/**
 * A signed reference. It is derived, never stored, and it names exactly one
 * invoice or one account — there is nothing else a link could be used for.
 */
export function paymentToken(kind, ref) {
  return createHmac('sha256', config.sessionSecret).update(`${kind}:${ref}`).digest('base64url').slice(0, 32);
}

export function tokenValid(kind, ref, token) {
  const expected = paymentToken(kind, ref);
  const given = String(token || '');
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

const base = () => String(config.publicUrl || '').replace(/\/+$/, '');

/**
 * A link only exists when it would actually work. A button that opens a page
 * saying "payments are not configured" is worse than no button: it looks like
 * the platform lost the invoice.
 */
const payable = () => config.payments.enabled && stripeConfigured();

/** The link a customer clicks to pay one invoice. A settled bill has none. */
export const payUrlForInvoice = (invoice) =>
  payable() && invoice?.id && PAYABLE.includes(invoice.status)
    ? `${base()}/api/public/pay/invoice/${invoice.id}?t=${paymentToken('invoice', invoice.id)}`
    : '';

/** The link that pays every unpaid invoice on a billing account at once. */
export const payUrlForAccount = (account) =>
  payable() && account?.id
    ? `${base()}/api/public/pay/account/${account.id}?t=${paymentToken('account', account.id)}`
    : '';

/* ------------------------------------------------------------- stripe api -- */

/**
 * One call to Stripe, form-encoded. Returns `{ ok, data, error }` and never
 * throws: a payment link that cannot be created must degrade to a clear page,
 * not a 500 in a customer's face.
 *
 * The timeout matters for the connection test: a key that is right but a host
 * that swallows packets has to come back as a failure, not leave the button
 * spinning until the browser gives up.
 */
async function stripeRequest(method, path, params = {}) {
  const key = stripeKey();
  if (!key) return { ok: false, error: 'stripe_not_configured' };
  const fields = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    fields.append(name, String(value));
  }
  const search = method === 'GET' && fields.size ? `?${fields}` : '';
  let res;
  try {
    res = await fetch(`${config.payments.apiUrl}${path}${search}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        ...(method === 'GET' ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(method === 'GET' ? {} : { body: fields }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out after 10s' : err.message;
    return { ok: false, error: `network: ${reason}` };
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: data?.error?.message || `http_${res.status}`, data };
  }
  return { ok: true, status: res.status, data };
}

const stripePost = (path, params) => stripeRequest('POST', path, params);

const currencyOf = (value) => String(value || 'USD').toLowerCase();

/** The line item Stripe shows on the hosted page, from one invoice row. */
const lineItem = (invoice, index = 0) => {
  const prefix = `line_items[${index}]`;
  const period =
    invoice.period_start && invoice.period_end
      ? `${String(invoice.period_start).slice(0, 10)} – ${String(invoice.period_end).slice(0, 10)}`
      : '';
  const out = {
    [`${prefix}[quantity]`]: 1,
    [`${prefix}[price_data][currency]`]: currencyOf(invoice.currency),
    [`${prefix}[price_data][unit_amount]`]: invoice.amount_cents,
    [`${prefix}[price_data][product_data][name]`]: `Invoice ${invoice.invoice_no}`,
  };
  if (period) out[`${prefix}[price_data][product_data][description]`] = `Service period ${period}`;
  return out;
};

const PAYABLE = ['open', 'overdue'];
const PAYABLE_SQL = "('open', 'overdue')";

/** Everything Stripe needs to know about who is paying and for what. */
function checkoutParams({ invoices, email, reference, invoiceIds }) {
  const success = `${base()}/api/public/pay/return?status=paid&session_id={CHECKOUT_SESSION_ID}`;
  const cancel = `${base()}/api/public/pay/return?status=cancelled`;
  const params = {
    mode: 'payment',
    success_url: success,
    cancel_url: cancel,
    customer_email: email || undefined,
    client_reference_id: reference,
    'payment_intent_data[metadata][platform]': 'telno',
    'metadata[platform]': 'telno',
    'metadata[invoiceIds]': invoiceIds.join(','),
    'metadata[reference]': reference,
  };
  invoices.forEach((invoice, index) => {
    Object.assign(params, lineItem(invoice, index));
  });
  return params;
}

/**
 * Create a hosted subscription page for a plan.
 *
 * `mode=subscription` is the difference: Stripe keeps the card and charges on
 * the interval, so the portal does not have to remember to bill anyone. A plan
 * with a stored price uses it; otherwise the price is created from the plan's
 * own numbers, which is what makes a price edit on the public page immediate.
 */
export async function checkoutForSubscription({ plan, account, subscriptionId, origin }) {
  if (!config.payments.enabled) return { ok: false, error: 'payments_disabled' };
  if (!stripeConfigured()) return { ok: false, error: 'stripe_not_configured' };
  if (!plan?.id) return { ok: false, error: 'not_found' };
  if (!account?.email) return { ok: false, error: 'not_found' };

  const site = String(origin || config.subscribeUrl || base()).replace(/\/+$/, '');
  const item = plan.stripe_price_id
    ? { 'line_items[0][price]': plan.stripe_price_id }
    : {
        'line_items[0][price_data][currency]': currencyOf(plan.currency),
        'line_items[0][price_data][unit_amount]': plan.price_cents,
        'line_items[0][price_data][recurring][interval]': plan.interval || 'month',
        'line_items[0][price_data][product_data][name]': plan.name,
        ...(plan.tagline ? { 'line_items[0][price_data][product_data][description]': plan.tagline } : {}),
      };

  const params = {
    mode: 'subscription',
    success_url: `${site}/subscribe?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/subscribe?status=cancelled`,
    customer_email: account.email,
    client_reference_id: account.id,
    'line_items[0][quantity]': 1,
    ...item,
    'metadata[kind]': 'subscription',
    'metadata[platform]': 'telno',
    'metadata[subscriptionId]': subscriptionId,
    'metadata[planId]': plan.id,
    'subscription_data[metadata][kind]': 'subscription',
    'subscription_data[metadata][subscriptionId]': subscriptionId,
    'subscription_data[metadata][planId]': plan.id,
  };

  const result = await stripePost('/v1/checkout/sessions', params);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  if (!result.data?.url) return { ok: false, error: 'no_checkout_url' };

  db_.run('UPDATE subscriptions SET stripe_session_id = ? WHERE id = ?', [result.data.id || '', subscriptionId]);
  logEvent({
    actor: 'customer',
    action: 'portal.checkout_created',
    subject: account.email,
    detail: `${plan.name} · session ${result.data.id || 'unknown'}`,
  });
  return { ok: true, url: result.data.url, sessionId: result.data.id || null };
}

/** The subscription as Stripe sees it, for the period end checkout omits. */
export async function fetchStripeSubscription(id) {
  if (!id) return { ok: false, error: 'no_subscription_id' };
  return stripeRequest('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Create a hosted payment page for one invoice. Returns the URL to redirect to.
 */
export async function checkoutForInvoice(invoice) {
  if (!config.payments.enabled) return { ok: false, error: 'payments_disabled' };
  if (!stripeConfigured()) return { ok: false, error: 'stripe_not_configured' };
  if (!invoice) return { ok: false, error: 'not_found' };
  if (!PAYABLE.includes(invoice.status)) return { ok: false, error: 'not_payable', status: invoice.status };
  if (!(invoice.amount_cents >= MIN_CHARGE_CENTS)) return { ok: false, error: 'amount_too_small' };

  const result = await stripePost(
    '/v1/checkout/sessions',
    checkoutParams({
      invoices: [invoice],
      email: invoice.email,
      reference: invoice.invoice_no,
      invoiceIds: [invoice.id],
    })
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data?.url) return { ok: false, error: 'no_checkout_url' };

  db_.run('UPDATE invoices SET stripe_session_id = ? WHERE id = ?', [result.data.id || '', invoice.id]);
  logEvent({
    actor: 'customer',
    action: 'billing.checkout_created',
    subject: invoice.invoice_no,
    detail: `${invoice.email} · session ${result.data.id || 'unknown'}`,
  });
  return { ok: true, url: result.data.url, sessionId: result.data.id || null };
}

/**
 * Create one hosted page that settles the whole balance. A customer with three
 * late invoices should not have to pay three times to get their phones back.
 */
export async function checkoutForAccount(account) {
  if (!config.payments.enabled) return { ok: false, error: 'payments_disabled' };
  if (!stripeConfigured()) return { ok: false, error: 'stripe_not_configured' };
  if (!account?.email) return { ok: false, error: 'not_found' };

  const invoices = db_.all(
    `SELECT * FROM invoices
      WHERE lower(email) = ? AND status IN ${PAYABLE_SQL} AND amount_cents > 0
      ORDER BY date(due_at) ASC LIMIT 10`,
    [account.email]
  );
  if (!invoices.length) return { ok: false, error: 'nothing_owed' };
  // Stripe bills one currency per session. The page shows the currency with the
  // largest balance; anything in another currency stays on the account.
  const totals = new Map();
  for (const invoice of invoices) {
    totals.set(invoice.currency, (totals.get(invoice.currency) || 0) + invoice.amount_cents);
  }
  const currency = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const sameCurrency = invoices.filter((invoice) => invoice.currency === currency);
  if (sameCurrency.reduce((total, invoice) => total + invoice.amount_cents, 0) < MIN_CHARGE_CENTS) {
    return { ok: false, error: 'amount_too_small' };
  }

  const result = await stripePost(
    '/v1/checkout/sessions',
    checkoutParams({
      invoices: sameCurrency,
      email: account.email,
      reference: account.email,
      invoiceIds: sameCurrency.map((invoice) => invoice.id),
    })
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data?.url) return { ok: false, error: 'no_checkout_url' };

  for (const invoice of sameCurrency) {
    db_.run('UPDATE invoices SET stripe_session_id = ? WHERE id = ?', [result.data.id || '', invoice.id]);
  }
  logEvent({
    actor: 'customer',
    action: 'billing.checkout_created',
    subject: account.email,
    detail: `balance of ${sameCurrency.length} invoice(s) · session ${result.data.id || 'unknown'}`,
  });
  return { ok: true, url: result.data.url, sessionId: result.data.id || null, invoices: sameCurrency.length };
}

/* --------------------------------------------------------------- webhook -- */

/**
 * Stripe signs `t.body` with the endpoint secret. Compared as bytes, in constant
 * time, and the timestamp is checked so a captured request cannot be replayed
 * forever.
 */
export function verifyWebhook(rawBody, header, secret = webhookSecret(), toleranceSec = 300) {
  if (!secret) return { ok: false, error: 'no_webhook_secret' };
  const parts = String(header || '')
    .split(',')
    .map((piece) => piece.trim().split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || !signatures.length) return { ok: false, error: 'malformed_signature' };
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return { ok: false, error: 'stale_signature' };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const matched = signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  });
  return matched ? { ok: true } : { ok: false, error: 'bad_signature' };
}

/** Marks an invoice paid from a payment event. Idempotent: paying twice is a no-op. */
export function markInvoicePaid(invoice, { sessionId = '', paymentRef = '', at = now(), actor = 'stripe' } = {}) {
  if (!invoice) return { changed: false, reason: 'not-found' };
  if (invoice.status === 'void') return { changed: false, reason: 'void' };
  if (invoice.status === 'paid') return { changed: false, reason: 'already-paid' };
  db_.run(
    `UPDATE invoices
        SET status = 'paid', paid_at = ?, stripe_session_id = ?, payment_ref = ?
      WHERE id = ?`,
    [at, sessionId || invoice.stripe_session_id || '', paymentRef || '', invoice.id]
  );
  logEvent({
    actor,
    action: 'billing.paid_online',
    subject: invoice.invoice_no,
    detail: `${invoice.email || 'no email'} · ${(invoice.amount_cents / 100).toFixed(2)} ${invoice.currency}` +
      `${paymentRef ? ` · ${paymentRef}` : ''}`,
  });
  return { changed: true, invoiceNo: invoice.invoice_no };
}

/**
 * Apply a completed Checkout Session: exactly the invoices it names, and only
 * the ones that are still payable. The event is the authority, so a session
 * cannot be used to settle an invoice it was not created for.
 */
export function applyCheckoutSession(session) {
  const metadata = session?.metadata || {};
  const ids = String(metadata.invoiceIds || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const reference = session?.client_reference_id || metadata.reference || '';
  const paid = [];
  for (const id of ids) {
    const invoice = db_.get('SELECT * FROM invoices WHERE id = ?', [id]);
    const result = markInvoicePaid(invoice, {
      sessionId: session.id || '',
      paymentRef: session.payment_intent || '',
    });
    if (result.changed) paid.push(result.invoiceNo);
  }
  return { paid, reference, invoices: ids.length, sessionId: session?.id || '' };
}

/* ------------------------------------------------------------------- test -- */

/** The URL Stripe has to call, built from the same base as the notice links. */
export const webhookUrl = () => `${base()}${WEBHOOK_PATH}`;

/** Enough of a key to recognise it, never enough to use it. */
const maskKey = (value) =>
  String(value).length <= 8 ? '••••' : `${String(value).slice(0, 8)}…${String(value).slice(-4)}`;

const loopback = (url) => {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
};

/**
 * Proves the stored credentials against Stripe itself.
 *
 * A key being present is not the same as a key that works, and a webhook that
 * points at last week's host fails silently — the invoice simply never gets
 * marked paid, and nobody finds out until a customer complains. So each piece
 * is checked on its own and reported separately, with the specific fix:
 *
 *   1. the key reaches the API (GET /v1/balance)
 *   2. the key may write (create a session, then expire it)
 *   3. the stored webhook secret actually verifies a signature
 *   4. Stripe has an endpoint pointing at this host, subscribed to the events
 *   5. that host is reachable from the internet at all
 */
export async function testConnection() {
  const checks = [];
  const add = (id, label, state, detail) => checks.push({ id, label, state, detail });
  const key = stripeKey();
  const secret = webhookSecret();
  const mode = key.startsWith('sk_live') || key.startsWith('rk_live') ? 'live' : key ? 'test' : 'none';

  add(
    'enabled',
    'Card payment switched on',
    config.payments.enabled ? 'pass' : 'fail',
    config.payments.enabled
      ? 'A notice can carry a Pay now button.'
      : 'PAYMENTS_ENABLED is off, so no payment link is ever built.'
  );

  if (!key) {
    add('key', 'Secret key', 'fail', 'No STRIPE_SECRET_KEY in the vault or the environment.');
  } else {
    add(
      'key',
      'Secret key',
      'pass',
      `${maskKey(key)} · ${mode} mode · from the ${keySource()}`
    );
  }

  let reachable = false;
  if (key) {
    const res = await stripeRequest('GET', '/v1/balance');
    reachable = res.ok;
    if (!res.ok) {
      add(
        'api',
        'Reaches Stripe',
        'fail',
        String(res.error).startsWith('network:')
          ? `Could not reach ${config.payments.apiUrl} — ${String(res.error).replace('network: ', '')}`
          : `Stripe rejected the key: ${res.error}`
      );
    } else {
      const available = (res.data.available || []).map(
        (entry) => `${(entry.amount / 100).toFixed(2)} ${String(entry.currency || '').toUpperCase()}`
      );
      const live = res.data.livemode === true;
      const mismatched = (live && mode === 'test') || (!live && mode === 'live');
      add(
        'api',
        'Reaches Stripe',
        mismatched ? 'fail' : 'pass',
        mismatched
          ? `The key says ${mode} mode but Stripe answered in ${live ? 'live' : 'test'} mode — check you pasted the whole key.`
          : `Answered in ${live ? 'live' : 'test'} mode · ${available.length ? `available ${available.join(', ')}` : 'no available balance yet'}` +
              `${live ? ' · real cards will be charged' : ''}`
      );
    }

    // A read-only key can see the balance and still be unable to create the
    // page a customer is sent to. Creating a $0.50 session costs nothing and
    // charges nothing; it is expired immediately so the probe leaves no page
    // behind that someone could accidentally pay.
    if (reachable) {
      const probe = await stripePost('/v1/checkout/sessions', {
        mode: 'payment',
        success_url: `${base()}/api/public/pay/return?status=paid`,
        cancel_url: `${base()}/api/public/pay/return?status=cancelled`,
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': MIN_CHARGE_CENTS,
        'line_items[0][price_data][product_data][name]': 'Telno connection test',
        'metadata[platform]': 'telno',
        'metadata[connectionTest]': 'true',
      });
      if (!probe.ok) {
        add(
          'checkout',
          'Can create a payment page',
          'fail',
          `Stripe refused the session: ${probe.error}. A restricted key needs write access to Checkout sessions.`
        );
      } else {
        const expired = probe.data?.id
          ? await stripePost(`/v1/checkout/sessions/${probe.data.id}/expire`, {})
          : { ok: false };
        add(
          'checkout',
          'Can create a payment page',
          probe.data?.url ? 'pass' : 'fail',
          probe.data?.url
            ? `Created ${probe.data.id} and expired it${expired.ok ? ' — nothing was charged' : ' (expiry call failed; the page is harmless and expires on its own)'}`
            : 'Stripe created a session with no checkout URL.'
        );
      }
    }
  }

  if (!secret) {
    add(
      'webhook-secret',
      'Webhook signing secret',
      'fail',
      'No STRIPE_WEBHOOK_SECRET — Stripe\'s events would all be rejected and no invoice would ever be marked paid.'
    );
  } else {
    // The secret is ours to test: sign a throwaway body the same way Stripe
    // does and put it through the verifier the live endpoint uses.
    const stamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ id: 'evt_connection_test', type: 'checkout.session.completed' });
    const digest = createHmac('sha256', secret).update(`${stamp}.${raw}`).digest('hex');
    const verdict = verifyWebhook(raw, `t=${stamp},v1=${digest}`);
    add(
      'webhook-secret',
      'Webhook signing secret',
      verdict.ok ? 'pass' : 'fail',
      verdict.ok
        ? `A signature made with the stored secret verifies (${maskKey(secret)}).`
        : `The stored secret does not verify its own signature: ${verdict.error}.`
    );
  }

  if (reachable) {
    const list = await stripeRequest('GET', '/v1/webhook_endpoints', { limit: 100 });
    const wanted = webhookUrl();
    if (!list.ok) {
      add(
        'webhook-endpoint',
        'Endpoint registered in Stripe',
        'warn',
        `Could not list webhook endpoints (${list.error}). A restricted key needs webhook endpoints read access — confirm ${wanted} by hand in Stripe → Developers → Webhooks.`
      );
    } else {
      const endpoints = list.data?.data || [];
      const match = endpoints.find((entry) => String(entry.url || '').replace(/\/+$/, '') === wanted);
      if (!match) {
        add(
          'webhook-endpoint',
          'Endpoint registered in Stripe',
          'fail',
          `No endpoint points at ${wanted}. Add it in Stripe → Developers → Webhooks, then re-run this test.` +
            (endpoints.length ? ` Registered instead: ${endpoints.map((entry) => entry.url).join(', ')}.` : ' Nothing is registered at all.')
        );
      } else {
        const events = match.enabled_events || [];
        const wildcard = events.includes('*');
        const missing = WEBHOOK_EVENTS.filter((event) => !wildcard && !events.includes(event));
        const missingSubscriptions = SUBSCRIPTION_EVENTS.filter((event) => !wildcard && !events.includes(event));
        const problems = [];
        if (match.status && match.status !== 'enabled') problems.push(`its status is ${match.status}`);
        if (missing.length) problems.push(`it is not subscribed to ${missing.join(' or ')}`);
        add(
          'webhook-endpoint',
          'Endpoint registered in Stripe',
          problems.length ? 'fail' : 'pass',
          problems.length
            ? `${match.url} — ${problems.join('; ')}.`
            : `${match.url} · ${wildcard ? 'all events' : `${events.length} event(s)`}, including both payment events.`
        );
        // Subscriptions are a separate promise: the portal gate needs these to
        // know a renewal lapsed, and a missing one is worth fixing before the
        // first customer signs up.
        add(
          'webhook-subscriptions',
          'Subscription events',
          missingSubscriptions.length ? 'warn' : 'pass',
          missingSubscriptions.length
            ? `Not subscribed to ${missingSubscriptions.join(', ')} — the portal will not learn about lapsed or cancelled subscriptions until it does.`
            : 'Renewals, cancellations and failed payments reach the portal gate.'
        );
      }
    }
  }

  // The most common reason a working key still marks nothing paid: the platform
  // is told it lives on localhost, which Stripe's servers cannot call.
  add(
    'public-url',
    'Public address',
    loopback(base()) ? 'warn' : 'pass',
    loopback(base())
      ? `${base()} is a loopback address — the links work on this machine, but Stripe cannot deliver a webhook to it. Set PUBLIC_URL to the public host.`
      : `${base()} — links and the webhook are built from this.`
  );

  const failed = checks.filter((check) => check.state === 'fail');
  const warned = checks.filter((check) => check.state === 'warn');
  return {
    ok: failed.length === 0,
    mode,
    checkedAt: now(),
    webhookUrl: webhookUrl(),
    publicUrl: base(),
    checks,
    summary: failed.length
      ? `${failed.length} problem${failed.length === 1 ? '' : 's'}: ${failed.map((check) => check.label.toLowerCase()).join(', ')}.`
      : warned.length
        ? `Working, with ${warned.length} thing${warned.length === 1 ? '' : 's'} to confirm: ${warned.map((check) => check.label.toLowerCase()).join(', ')}.`
        : 'Every Stripe check passed — the Pay now button will work.',
  };
}

/* ------------------------------------------------------------------ pages -- */

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * A page a customer sees on a link out of an email: no console, no nav, no
 * JavaScript. It has to work on a phone in a bad hotel Wi-Fi.
 */
export function paymentPage({ title, heading, message, tone = 'info', action = null }) {
  const accents = {
    info: '#635bff',
    good: '#027a48',
    warn: '#b42318',
  };
  const accent = accents[tone] || accents.info;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828;padding:24px;">
  <main style="width:100%;max-width:480px;background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:28px;">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">tel<span style="color:#635bff;">no</span></div>
    <div style="width:44px;height:3px;background:${accent};border-radius:2px;margin:18px 0 16px;"></div>
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 10px;letter-spacing:-0.02em;">${escape(heading)}</h1>
    <p style="font-size:14px;line-height:1.6;color:#344054;margin:0;">${escape(message)}</p>
    ${
      action
        ? `<p style="margin:22px 0 0;"><a href="${escape(action.href)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#635bff;color:#fff;font-weight:600;font-size:14px;text-decoration:none;">${escape(action.label)}</a></p>`
        : ''
    }
    <p style="font-size:12px;color:#98a2b3;line-height:1.6;margin:22px 0 0;">
      Telno · This page is safe to close. Nobody at Telno will ever ask for your card details by email or phone.
    </p>
  </main>
</body>
</html>`;
}
