import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { getSecret } from './vault.js';
import { hashPassword } from './security.js';
import { logEvent } from './audit.js';
import { checkoutForSubscription, fetchStripeSubscription } from './payments.js';
import { publicBrand } from './brand.js';

/**
 * Plans, features and subscriptions.
 *
 * Three rules make this small enough to reason about:
 *
 *  1. Plans and features are rows. The admin console edits them, the public
 *     subscribe page reads the same rows, and the entitlement a customer holds
 *     is derived from the plan — never copied per customer.
 *  2. A subscription is a snapshot of what was sold. Editing a plan tomorrow
 *     must not rewrite what somebody agreed to pay today.
 *  3. Access is decided in one function, `entitlementFor`, so the login gate,
 *     the console and the portal cannot disagree about whether an account is
 *     paid up.
 */

/** Statuses that mean "this subscription is in force right now". */
export const LIVE_STATUSES = ['active', 'trialing'];
/** Everything that is not paid for and never will be again. */
export const DEAD_STATUSES = ['canceled', 'incomplete'];

/** Plans that came with a fresh install. Insert-if-missing so edits stick. */
const STARTER_FEATURES = [
  ['calling', 'Calling', 'Unlimited calls over your own numbers', 'calling', 0, 10],
  ['voicemail', 'Voicemail', 'Recorded messages with transcripts', 'calling', 0, 20],
  ['fax', 'Fax in and out', 'Send and receive faxes on the same number', 'calling', 0, 30],
  ['sms', 'SMS and messaging', 'Text on your business numbers', 'messaging', 0, 40],
  ['video-calling', 'Video calling', 'Encrypted video in the browser and on a handset', 'calling', 0, 50],
  ['encrypted-media', 'Encrypted media', 'DTLS-SRTP on every call, both directions', 'security', 0, 60],
  ['secure-messaging', 'Secure internal messaging', 'Signed, encrypted messaging between staff lines', 'security', 0, 70],
  ['voice-agents', 'Voice agents', 'AI personas that answer and place calls', 'ai', 1, 80],
  ['ai-grading', 'Campaign grading', 'Every marketing call graded against its goal', 'ai', 1, 90],
  ['campaigns', 'Outbound campaigns', 'Dialing queues, dispositions and reports', 'marketing', 1, 100],
  ['rostering', 'Estate inventory', 'Sites, handsets and gateways with check-ins', 'operations', 1, 110],
  ['recording', 'Call recording', 'Kept per direction, per agent', 'compliance', 1, 120],
];

const STARTER_PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    tagline: 'One office, one number, everything you need to sound bigger.',
    description: 'A single site with encrypted calling, voicemail, fax and texting on your own numbers.',
    price_cents: 2900,
    interval: 'month',
    seats: 5,
    included_minutes: 1000,
    features: ['calling', 'voicemail', 'fax', 'sms', 'encrypted-media'],
    sort_order: 10,
  },
  {
    slug: 'business',
    name: 'Business',
    tagline: 'Video, voice agents and the full console.',
    description: 'Video calling, AI voice agents and outbound campaigns over the same numbers, for teams that sell on the phone.',
    price_cents: 7900,
    interval: 'month',
    seats: 25,
    included_minutes: 5000,
    features: [
      'calling',
      'voicemail',
      'fax',
      'sms',
      'video-calling',
      'encrypted-media',
      'secure-messaging',
      'voice-agents',
      'campaigns',
      'ai-grading',
    ],
    sort_order: 20,
    is_default: 1,
  },
  {
    slug: 'scale',
    name: 'Scale',
    tagline: 'Multi-site estate, recording and every AI surface.',
    description: 'Everything in Business plus site inventory, per-agent recording and the marketing pipeline with graded reports.',
    price_cents: 19900,
    interval: 'month',
    seats: 100,
    included_minutes: 20000,
    features: STARTER_FEATURES.map((feature) => feature[0]),
    sort_order: 30,
  },
];

/** Idempotent seed: run on boot, so a fresh container has something to sell. */
export function seedCommerce() {
  for (const [key, label, description, category, addon, sortOrder] of STARTER_FEATURES) {
    db_.run(
      `INSERT INTO features (key, label, description, category, addon, sort_order)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
      [key, label, description, category, addon, sortOrder]
    );
  }
  for (const plan of STARTER_PLANS) {
    if (db_.get('SELECT id FROM plans WHERE slug = ?', [plan.slug])) continue;
    const id = newId('pln_');
    db_.run(
      `INSERT INTO plans (id, slug, name, tagline, description, price_cents, currency, interval, seats,
                          included_minutes, is_default, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`,
      [
        id,
        plan.slug,
        plan.name,
        plan.tagline,
        plan.description,
        plan.price_cents,
        plan.interval,
        plan.seats,
        plan.included_minutes,
        plan.is_default || 0,
        plan.sort_order,
      ]
    );
    for (const key of plan.features) {
      db_.run("INSERT OR IGNORE INTO plan_features (plan_id, feature_key, mode) VALUES (?, ?, 'included')", [id, key]);
    }
  }
}

/* ------------------------------------------------------------------ views -- */

export const featureView = (row) => ({
  key: row.key,
  label: row.label,
  description: row.description,
  category: row.category,
  addon: !!row.addon,
  sortOrder: row.sort_order,
  active: !!row.active,
  plans: row.plans ?? undefined,
});

export const planView = (row, features = []) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  tagline: row.tagline,
  description: row.description,
  priceCents: row.price_cents,
  price: `$${(row.price_cents / 100).toFixed(2)}`,
  currency: row.currency,
  interval: row.interval,
  seats: row.seats,
  includedMinutes: row.included_minutes,
  isDefault: !!row.is_default,
  active: !!row.active,
  sortOrder: row.sort_order,
  stripePriceId: row.stripe_price_id,
  features,
});

export const subscriptionView = (row) => ({
  id: row.id,
  accountId: row.account_id,
  email: row.email || '',
  planId: row.plan_id || '',
  planName: row.plan_name,
  planSlug: row.plan_slug,
  priceCents: row.price_cents,
  currency: row.currency,
  interval: row.interval,
  seats: row.seats || 1,
  status: row.status,
  stripeCustomerId: row.stripe_customer_id,
  stripeSubscriptionId: row.stripe_subscription_id,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: !!row.cancel_at_period_end,
  canceledAt: row.canceled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/* ------------------------------------------------------------------ plans -- */

export function listFeatures() {
  return db_
    .all('SELECT * FROM features ORDER BY sort_order, label')
    .map((row) => featureView(row));
}

export function featuresForPlan(planId) {
  return db_
    .all(
      `SELECT f.*, pf.mode FROM plan_features pf
         JOIN features f ON f.key = pf.feature_key
        WHERE pf.plan_id = ? AND f.active = 1
        ORDER BY f.sort_order`,
      [planId]
    )
    .map((row) => ({ ...featureView(row), mode: row.mode }));
}

/** Every active plan with its feature list, in display order. */
export function listPlans({ activeOnly = false, withFeatures = true } = {}) {
  const rows = db_.all(
    `SELECT * FROM plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, price_cents`
  );
  return rows.map((row) => planView(row, withFeatures ? featuresForPlan(row.id) : []));
}

export const planById = (id) => db_.get('SELECT * FROM plans WHERE id = ? OR slug = ?', [id, id]) || null;

export function savePlan(payload, { id = '' } = {}) {
  const existing = id ? planById(id) : null;
  const fields = {
    slug: payload.slug,
    name: payload.name,
    tagline: payload.tagline,
    description: payload.description,
    price_cents: payload.priceCents,
    currency: payload.currency,
    interval: payload.interval,
    seats: payload.seats,
    included_minutes: payload.includedMinutes,
    active: payload.active,
    sort_order: payload.sortOrder,
  };

  if (existing) {
    const columnFor = {
      slug: 'slug',
      name: 'name',
      tagline: 'tagline',
      description: 'description',
      price_cents: 'price_cents',
      currency: 'currency',
      interval: 'interval',
      seats: 'seats',
      included_minutes: 'included_minutes',
      active: 'active',
      sort_order: 'sort_order',
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${columnFor[key]} = ?`);
      params.push(value);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(now(), existing.id);
      db_.run(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    if (Array.isArray(payload.features)) setPlanFeatures(existing.id, payload.features);
    return planById(existing.id);
  }

  const newPlanId = newId('pln_');
  db_.run(
    `INSERT INTO plans (id, slug, name, tagline, description, price_cents, currency, interval, seats,
                        included_minutes, active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newPlanId,
      fields.slug || `plan-${newPlanId.slice(-6)}`,
      fields.name,
      fields.tagline || '',
      fields.description || '',
      fields.price_cents ?? 0,
      (fields.currency || 'USD').toUpperCase(),
      fields.interval || 'month',
      fields.seats ?? 1,
      fields.included_minutes ?? 0,
      fields.active ?? 1,
      fields.sort_order ?? 100,
    ]
  );
  if (Array.isArray(payload.features)) setPlanFeatures(newPlanId, payload.features);
  return planById(newPlanId);
}

/**
 * Replace a plan's feature list in one transaction. Adding and removing are the
 * same operation — this is the row set the plan carries — so the public page and
 * the portal cannot show a half-applied edit.
 */
export function setPlanFeatures(planId, keys) {
  const wanted = [...new Set((keys || []).map((key) => String(key).trim()).filter(Boolean))];
  db_.tx(() => {
    db_.run('DELETE FROM plan_features WHERE plan_id = ?', [planId]);
    for (const key of wanted) {
      if (!db_.get('SELECT key FROM features WHERE key = ?', [key])) continue;
      db_.run("INSERT OR IGNORE INTO plan_features (plan_id, feature_key, mode) VALUES (?, ?, 'included')", [planId, key]);
    }
  });
  return featuresForPlan(planId);
}

export function saveFeature(payload) {
  const key = String(payload.key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  if (!key) return null;
  const existing = db_.get('SELECT * FROM features WHERE key = ?', [key]);
  if (existing) {
    db_.run(
      'UPDATE features SET label = ?, description = ?, category = ?, addon = ?, sort_order = ?, active = ? WHERE key = ?',
      [
        payload.label ?? existing.label,
        payload.description ?? existing.description,
        payload.category ?? existing.category,
        payload.addon === undefined ? existing.addon : payload.addon ? 1 : 0,
        payload.sortOrder ?? existing.sort_order,
        payload.active === undefined ? existing.active : payload.active ? 1 : 0,
        key,
      ]
    );
  } else {
    db_.run(
      'INSERT INTO features (key, label, description, category, addon, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        key,
        payload.label || key,
        payload.description || '',
        payload.category || 'calling',
        payload.addon ? 1 : 0,
        payload.sortOrder ?? 100,
        payload.active === undefined ? 1 : payload.active ? 1 : 0,
      ]
    );
  }
  return db_.get('SELECT * FROM features WHERE key = ?', [key]);
}

/** Removing a feature removes it from every plan that had it. */
export function deleteFeature(key) {
  const row = db_.get('SELECT * FROM features WHERE key = ?', [key]);
  if (!row) return false;
  db_.tx(() => {
    db_.run('DELETE FROM plan_features WHERE feature_key = ?', [key]);
    db_.run('DELETE FROM features WHERE key = ?', [key]);
  });
  return true;
}

/**
 * Mirror a plan into the subscriber system of record.
 *
 * Magnate owns the commercial catalogue; this platform owns service. When a
 * plan changes, the change is pushed rather than waiting for a human to retype
 * it. A push that fails is logged and does not block the edit: the public page
 * here has already changed, and a retry is the admin's call.
 */
export const magnateUrl = () =>
  getSecret('MAGNATE_WEBHOOK_URL') || process.env.MAGNATE_WEBHOOK_URL || '';

export async function syncPlanToMagnate(plan, action = 'upsert') {
  const url = magnateUrl();
  if (!url) return { ok: false, error: 'magnate_not_configured' };
  const token = getSecret('MAGNATE_API_TOKEN') || process.env.MAGNATE_API_TOKEN || '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        action,
        source: 'telno',
        product: 'telno',
        plan: {
          id: plan.id,
          slug: plan.slug,
          name: plan.name,
          tagline: plan.tagline,
          priceCents: plan.price_cents,
          currency: plan.currency,
          interval: plan.interval,
          seats: plan.seats,
          includedMinutes: plan.included_minutes,
          active: !!plan.active,
        },
        features: featuresForPlan(plan.id).map((feature) => feature.key),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------- subscriptions -- */

/** The newest subscription row for an account, whatever its status. */
export const subscriptionForAccount = (accountId) =>
  db_.get('SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', [accountId]) || null;

export const subscriptionForStripeId = (stripeId) =>
  (stripeId && db_.get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [stripeId])) || null;

/**
 * When the paid period ends, in seconds, from either Stripe shape.
 *
 * API version 2025-03-31 moved `current_period_end` off the subscription and
 * onto its items, so a deployment whose webhook endpoint runs on a newer
 * version would otherwise store no paid-through date at all — and an account
 * with no date to check never looks lapsed. Reading both means the version a
 * customer's endpoint happens to use cannot change whether access expires.
 */
export function subscriptionPeriodEnd(subscription) {
  const direct = Number(subscription?.current_period_end);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const ends = items
    .map((item) => Number(item?.current_period_end))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  // The period ends when the last item's does; a plan with an add-on item keeps
  // access until the add-on lapses too.
  return ends.length ? Math.max(...ends) : null;
}

/**
 * The subscription an invoice belongs to, from either Stripe shape. Before
 * 2025-03-31 that was `invoice.subscription`; the parent field replaced it.
 */
export function invoiceSubscriptionId(invoice) {
  const candidates = [
    invoice?.subscription,
    invoice?.parent?.subscription_details?.subscription,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate.id === 'string' && candidate.id) return candidate.id;
  }
  return '';
}

/**
 * The whole access decision, in one place.
 *
 * A staff account is never gated: the owner locking themselves out of their own
 * platform because the commerce side hiccuped is not a feature. A customer
 * account needs a live subscription whose period has not lapsed.
 */
export function entitlementFor(account) {
  if (!account) return { active: false, reason: 'no_account' };
  if ((account.account_kind || 'staff') !== 'customer') {
    return { active: true, reason: 'staff', features: null };
  }
  const row = subscriptionForAccount(account.id);
  if (!row) return { active: false, reason: 'no_subscription', features: [] };
  if (!LIVE_STATUSES.includes(row.status)) {
    return { active: false, reason: row.status, subscription: subscriptionView(row), features: [] };
  }
  if (row.current_period_end && new Date(row.current_period_end).getTime() < Date.now()) {
    // Stripe has not sent a renewal yet. Lapsed is lapsed: the next event
    // renews it, and access returns then.
    return { active: false, reason: 'period_ended', subscription: subscriptionView(row), features: [] };
  }
  const plan = row.plan_id ? db_.get('SELECT * FROM plans WHERE id = ?', [row.plan_id]) : null;
  const features = plan ? featuresForPlan(plan.id).map((feature) => feature.key) : [];
  return {
    active: true,
    reason: 'subscribed',
    subscription: subscriptionView(row),
    plan: plan ? planView(plan) : null,
    features,
  };
}

/**
 * Start a subscription: create the pending row, then ask Stripe for a page.
 * The row exists before redirecting so the webhook has something to update and
 * an abandoned checkout is visible as `incomplete` rather than invisible.
 */
export async function startSubscription({ account, plan, origin, actor = 'customer' }) {
  const subscriptionId = newId('sub_');
  db_.run(
    `INSERT INTO subscriptions (id, account_id, plan_id, plan_name, plan_slug, price_cents, currency,
                                interval, seats, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incomplete')`,
    [
      subscriptionId,
      account.id,
      plan.id,
      plan.name,
      plan.slug,
      plan.price_cents,
      plan.currency,
      plan.interval,
      plan.seats,
    ]
  );

  const checkout = await checkoutForSubscription({ plan, account, subscriptionId, origin });
  if (!checkout.ok) {
    // Nothing was created in Stripe, so the row would only ever be noise.
    db_.run('DELETE FROM subscriptions WHERE id = ?', [subscriptionId]);
    return { ok: false, error: checkout.error };
  }
  logEvent({
    actor,
    action: 'portal.subscription_started',
    subject: account.email,
    detail: `${plan.name} (${plan.interval})`,
  });
  return { ok: true, url: checkout.url, subscriptionId };
}

/** The plan a customer would land on with no subscription: the default one. */
export const defaultPlan = () =>
  db_.get('SELECT * FROM plans WHERE active = 1 ORDER BY is_default DESC, sort_order LIMIT 1') || null;

/**
 * A completed Checkout Session for a subscription. Called from the webhook, so
 * it is the purchase event — not the browser — that grants access.
 */
export async function activateFromSession(session) {
  const metadata = session?.metadata || {};
  const subscriptionId = String(metadata.subscriptionId || '');
  const row = subscriptionId
    ? db_.get('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId])
    : null;
  if (!row) return { ok: false, error: 'unknown_subscription', subscriptionId };

  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || '';
  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || '';

  // Checkout does not carry the billing period; Stripe's subscription does.
  let periodEnd = null;
  if (stripeSubscriptionId) {
    const remote = await fetchStripeSubscription(stripeSubscriptionId);
    const seconds = remote.ok ? subscriptionPeriodEnd(remote.data) : null;
    if (seconds) periodEnd = new Date(seconds * 1000).toISOString();
  }

  db_.run(
    `UPDATE subscriptions
        SET status = 'active', stripe_subscription_id = ?, stripe_customer_id = ?,
            stripe_session_id = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ?
      WHERE id = ?`,
    [stripeSubscriptionId, stripeCustomerId, session.id || '', periodEnd, now(), row.id]
  );
  logEvent({
    actor: 'stripe',
    action: 'portal.subscription_active',
    subject: row.plan_name,
    detail: `account ${row.account_id}${periodEnd ? ` until ${periodEnd.slice(0, 10)}` : ''}`,
  });
  return { ok: true, subscriptionId: row.id, stripeSubscriptionId, periodEnd };
}

/** `customer.subscription.updated` / `deleted`: the standing instruction moved. */
export function applySubscriptionEvent(subscription, { deleted = false } = {}) {
  if (!subscription?.id) return { ok: false, error: 'no_subscription' };
  const row = subscriptionForStripeId(subscription.id);
  if (!row) return { ok: false, error: 'unknown_subscription' };
  const status = deleted ? 'canceled' : String(subscription.status || row.status);
  const periodEnd = subscriptionPeriodEnd(subscription);
  // 'unpaid' and 'paused' are lapses too: nothing is entitling the account any
  // more, so they are stored rather than ignored in favour of the old status.
  const known = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired'];
  db_.run(
    `UPDATE subscriptions
        SET status = ?, current_period_end = ?, cancel_at_period_end = ?,
            canceled_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      known.includes(status) ? status : row.status,
      periodEnd ? new Date(periodEnd * 1000).toISOString() : row.current_period_end,
      subscription.cancel_at_period_end ? 1 : 0,
      deleted ? now() : row.canceled_at,
      now(),
      row.id,
    ]
  );
  logEvent({
    actor: 'stripe',
    action: 'portal.subscription_updated',
    subject: row.plan_name,
    detail: `${status}${subscription.cancel_at_period_end ? ' (cancels at period end)' : ''}`,
  });
  return { ok: true, subscriptionId: row.id, status };
}

/** `invoice.payment_failed`: a renewal did not go through. */
export function markSubscriptionPastDue(stripeSubscriptionId) {
  const row = subscriptionForStripeId(stripeSubscriptionId);
  if (!row) return { ok: false, error: 'unknown_subscription' };
  db_.run("UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?", [now(), row.id]);
  logEvent({
    actor: 'stripe',
    action: 'portal.subscription_past_due',
    subject: row.plan_name,
    detail: `account ${row.account_id}`,
  });
  return { ok: true, subscriptionId: row.id };
}

/**
 * An operator's override: comp an account, correct a status, cancel a
 * subscription. Stripe is told nothing — this is the "mark it paid" equivalent
 * for access, and the ledger says who did it.
 */
export function setSubscriptionStatus(subscriptionId, status, actor = 'operator') {
  const row = db_.get('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!row) return null;
  db_.run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?', [status, now(), row.id]);
  if (status === 'canceled') {
    db_.run('UPDATE subscriptions SET canceled_at = ? WHERE id = ?', [now(), row.id]);
  }
  logEvent({
    actor,
    action: 'portal.subscription_override',
    subject: row.plan_name,
    detail: `${row.status} -> ${status} for account ${row.account_id}`,
  });
  return db_.get('SELECT s.*, a.email FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [row.id]);
}

/** Change the plan on a subscription, keeping the price snapshot honest. */
export function changeSubscriptionPlan(subscriptionId, planId, actor = 'operator') {
  const row = db_.get('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  const plan = planById(planId);
  if (!row || !plan) return null;
  db_.run(
    `UPDATE subscriptions
        SET plan_id = ?, plan_name = ?, plan_slug = ?, price_cents = ?, currency = ?, interval = ?, seats = ?, updated_at = ?
      WHERE id = ?`,
    [plan.id, plan.name, plan.slug, plan.price_cents, plan.currency, plan.interval, plan.seats, now(), row.id]
  );
  logEvent({
    actor,
    action: 'portal.subscription_plan_changed',
    subject: plan.name,
    detail: `${row.plan_name} -> ${plan.name} for account ${row.account_id}`,
  });
  return db_.get('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
}

/** Every subscription with its account, for the admin list. */
export function listSubscriptions({ status = '' } = {}) {
  const where = status ? 'WHERE s.status = ?' : '';
  return db_
    .all(
      `SELECT s.*, a.email, a.name AS account_name FROM subscriptions s
         JOIN accounts a ON a.id = s.account_id
        ${where}
        ORDER BY s.created_at DESC LIMIT 200`,
      status ? [status] : []
    )
    .map((row) => ({ ...subscriptionView(row), accountName: row.account_name }));
}

/**
 * Create a customer account for a self-serve signup. A customer is a distinct
 * kind of account: it holds a subscription and is gated on it. Staff created by
 * the owner are never customers.
 */
export function createCustomerAccount({ email, name, password }) {
  const existing = db_.get('SELECT * FROM accounts WHERE email = ?', [email]);
  if (existing) {
    // Someone with a staff account should not be turned into a customer by a
    // public form, and an existing customer signs in instead of signing up.
    return { ok: false, error: 'exists', account: existing };
  }
  const id = newId('acc_');
  db_.run(
    "INSERT INTO accounts (id, email, name, password_hash, role, account_kind) VALUES (?, ?, ?, ?, 'viewer', 'customer')",
    [id, email, name || email.split('@')[0], hashPassword(password)]
  );
  logEvent({ actor: 'public', action: 'portal.account_created', subject: email });
  return { ok: true, account: db_.get('SELECT * FROM accounts WHERE id = ?', [id]) };
}

/** The public pricing page's data: plans, features and what the portal needs. */
export function publicPricing() {
  const plans = listPlans({ activeOnly: true });
  const brand = publicBrand();
  return {
    // Kept for compatibility with the first shape; the `brand` block is what a
    // white-labelled page actually renders.
    product: brand.name,
    vendor: brand.vendor,
    brand,
    plans,
    addons: db_
      .all('SELECT * FROM features WHERE active = 1 AND addon = 1 ORDER BY sort_order')
      .map((row) => featureView(row)),
    subscribeUrl: config.subscribeUrl || '',
  };
}
