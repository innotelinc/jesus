import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { verifyPassword } from '../lib/security.js';
import { paymentStatus, stripeConfigured } from '../lib/payments.js';
import {
  LIVE_STATUSES,
  changeSubscriptionPlan,
  createCustomerAccount,
  defaultPlan,
  deleteFeature,
  entitlementFor,
  featuresForPlan,
  listFeatures,
  listPlans,
  listSubscriptions,
  magnateUrl,
  planById,
  planView,
  publicPricing,
  saveFeature,
  savePlan,
  seedCommerce,
  setSubscriptionStatus,
  startSubscription,
  subscriptionForAccount,
  subscriptionView,
  syncPlanToMagnate,
} from '../lib/subscriptions.js';
import { publicBrand } from '../lib/brand.js';
import { onboardingState } from '../lib/onboarding.js';
import * as v from '../lib/validate.js';

/**
 * The subscriber portal and the commerce admin.
 *
 * Two audiences, deliberately separated:
 *
 *  - Public: the pricing page a prospective customer lands on, and the signup
 *    that turns them into an account with a subscription. No session, because
 *    the whole point is that they do not have one yet.
 *  - Admin: plans, features and the subscriptions that exist. Editing a plan
 *    here changes what the public page sells on the next request, and the change
 *    is pushed to the subscriber system of record when one is configured.
 *
 * A customer's own view of their subscription is `/portal/status`, which reads
 * the session without the paid gate — an unpaid customer must be able to see why
 * they are locked out and what to do about it.
 */

const planBody = (body) => ({
  slug: body.slug ? String(body.slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48) : undefined,
  name: body.name === undefined ? undefined : v.str(body.name, { name: 'name', min: 2, max: 80 }),
  tagline: body.tagline === undefined ? undefined : v.str(body.tagline, { name: 'tagline', max: 200, required: false }),
  description:
    body.description === undefined ? undefined : v.str(body.description, { name: 'description', max: 600, required: false }),
  priceCents: body.priceCents === undefined ? undefined : v.integer(body.priceCents, { name: 'priceCents', min: 0, max: 100_000_000 }),
  currency: body.currency === undefined ? undefined : String(body.currency).toUpperCase().slice(0, 3),
  interval: body.interval === undefined ? undefined : v.oneOf(body.interval, ['month', 'year'], 'interval'),
  seats: body.seats === undefined ? undefined : v.integer(body.seats, { name: 'seats', min: 1, max: 100_000 }),
  includedMinutes:
    body.includedMinutes === undefined ? undefined : v.integer(body.includedMinutes, { name: 'includedMinutes', min: 0, max: 10_000_000 }),
  // Flat rate by default: an operator has to deliberately ask for a meter.
  minutesUnlimited: body.minutesUnlimited === undefined ? undefined : body.minutesUnlimited ? 1 : 0,
  audience: body.audience === undefined ? undefined : v.oneOf(body.audience, ['business', 'residential'], 'audience'),
  active: body.active === undefined ? undefined : body.active ? 1 : 0,
  sortOrder: body.sortOrder === undefined ? undefined : v.integer(body.sortOrder, { name: 'sortOrder', min: 0, max: 10_000 }),
  features: Array.isArray(body.features) ? body.features.map((key) => String(key)) : undefined,
});

export default async function portalRoutes(app) {
  const requireAdmin = app.requireRole('owner', 'operator');
  const requireOwner = app.requireRole('owner');

  /* ---------------------------------------------------------------- public -- */

  /**
   * The pricing page's data. Public: this is a shop window, not a secret.
   *
   * `payments.configured` is a boolean, never a key: it lets the site say
   * "checkout is not switched on yet" honestly instead of letting a visitor fill
   * in the signup form and be refused by the API at the last step.
   */
  app.get('/public/plans', async () => ({
    ...publicPricing(),
    payments: { configured: stripeConfigured() && config.payments.enabled },
  }));

  /**
   * The name, vendor, accent and logo every public page renders. One request,
   * cached in the browser, so a white-label deployment shows its own brand on
   * the site, the signup page and the console header.
   */
  app.get('/public/brand', async () => ({ brand: publicBrand() }));

  /**
   * Start a subscription from the public page.
   *
   * An existing account must prove it owns the address before a subscription is
   * attached to it: otherwise anyone could start a checkout against somebody
   * else's account. A new address creates a customer account with the password
   * given here — that is the only way the portal is entered later.
   */
  app.post(
    '/public/subscribe',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body || {};
      const planId = v.str(body.plan, { name: 'plan', min: 2, max: 60 });
      const plan = planById(planId);
      if (!plan || !plan.active) throw notFound('That plan is no longer available');

      if (!stripeConfigured() || !config.payments.enabled) {
        throw badRequest(
          'Card payment is not switched on for this deployment yet. Ask the operator to add the Stripe key in Settings, then try again.'
        );
      }

      const email = v.email(body.email);
      const existing = db_.get('SELECT * FROM accounts WHERE email = ?', [email]);

      let account = existing;
      if (existing) {
        if ((existing.account_kind || 'staff') !== 'customer') {
          throw forbidden('That address belongs to a staff account. Use your console login, or sign up with another address.');
        }
        const password = v.str(body.password, { name: 'password', min: 1, max: 200 });
        if (!verifyPassword(password, existing.password_hash)) {
          throw unauthorized('That email already has an account. Enter its password to continue.');
        }
        if (existing.suspended_at) {
          throw forbidden('That account is suspended. Settling the balance in the console restores it.');
        }
      } else {
        const name = v.str(body.name, { name: 'name', min: 2, max: 80 });
        const password = v.str(body.password, { name: 'password', min: 10, max: 200 });
        const created = createCustomerAccount({ email, name, password });
        if (!created.ok) throw conflict('That email is already registered');
        account = created.account;
      }

      const origin = String(body.origin || request.headers.origin || config.subscribeUrl || config.publicUrl).replace(/\/+$/, '');
      const started = await startSubscription({ account, plan, origin });
      if (!started.ok) throw badRequest(`Stripe would not open a checkout page: ${started.error}`);

      reply.status(201);
      return { checkoutUrl: started.url, subscriptionId: started.subscriptionId, account: { id: account.id, email: account.email } };
    }
  );

  /** What the success page polls: did the webhook land yet? */
  app.get('/public/subscribe/status', async (request) => {
    const email = request.query?.email ? v.email(request.query.email) : '';
    if (!email) return { status: 'unknown' };
    const account = db_.get('SELECT id, email FROM accounts WHERE email = ?', [email]);
    if (!account) return { status: 'unknown' };
    const row = subscriptionForAccount(account.id);
    if (!row) return { status: 'none' };
    return {
      status: row.status,
      plan: row.plan_name,
      currentPeriodEnd: row.current_period_end,
      active: LIVE_STATUSES.includes(row.status),
    };
  });

  /* ------------------------------------------------------- customer status -- */

  /**
   * Why this session can or cannot use the portal. Reads the session directly
   * rather than behind `authenticate`, so a lapsed customer gets an answer
   * instead of a 402 with no body to act on.
   */
  app.get('/portal/status', async (request) => {
    const account = app.readSession(request);
    if (!account) throw unauthorized();
    const entitlement = entitlementFor(account);
    const subscription = entitlement.subscription || (subscriptionForAccount(account.id) ? subscriptionView(subscriptionForAccount(account.id)) : null);
    return {
      user: { id: account.id, email: account.email, name: account.name, role: account.role, kind: account.account_kind || 'staff' },
      entitlement,
      subscription,
      plans: listPlans({ activeOnly: true }),
      payments: { configured: stripeConfigured() && config.payments.enabled },
      subscribeUrl: config.subscribeUrl || '/subscribe',
      // A subscriber who has just paid is in the same first login as anyone else,
      // and this is the only bootstrap an unpaid-then-paid customer reads before
      // the console renders: without the steps here they would be sent into the
      // portal only to have every route refuse them.
      onboarding: onboardingState(account),
    };
  });

  /* ----------------------------------------------------------------- plans -- */

  app.get('/plans', { preHandler: requireAdmin }, async () => {
    const plans = listPlans();
    const features = listFeatures().map((feature) => ({
      ...feature,
      plans: db_
        .all('SELECT plan_id FROM plan_features WHERE feature_key = ?', [feature.key])
        .map((row) => row.plan_id),
    }));
    return {
      plans,
      features,
      subscriptions: listSubscriptions(),
      magnate: { configured: !!magnateUrl(), url: magnateUrl() ? 'configured' : '' },
      // The public page and the admin read the same rows; showing the link here
      // is how an operator checks their own edit from the outside.
      subscribeUrl: config.subscribeUrl || '/subscribe',
      payments: paymentStatus(),
    };
  });

  app.post('/plans', { preHandler: requireAdmin }, async (request, reply) => {
    const body = planBody(request.body || {});
    if (!body.name) throw badRequest('A plan needs a name');
    const slug = body.slug || String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (db_.get('SELECT id FROM plans WHERE slug = ?', [slug])) throw conflict(`A plan with the slug "${slug}" already exists`);

    const saved = savePlan({ ...body, slug });
    // The route answers with the same shape the list uses, features included:
    // a create that returns a raw row is a create the console cannot render.
    const plan = planView(planById(saved.id), featuresForPlan(saved.id));
    const sync = await syncPlanToMagnate(saved);
    logEvent({
      actor: request.account.email,
      action: 'commerce.plan_created',
      subject: plan.name,
      detail: `${plan.price_cents / 100} ${plan.currency}/${plan.interval}${sync.ok ? ' · magnate synced' : ` · magnate ${sync.error}`}`,
      ip: request.ip,
    });
    reply.status(201);
    return { plan: { ...plan, magnate: sync }, plans: listPlans() };
  });

  app.patch('/plans/:id', { preHandler: requireAdmin }, async (request) => {
    const existing = planById(request.params.id);
    if (!existing) throw notFound('Plan not found');
    const body = planBody(request.body || {});
    // A plan change while customers hold it is allowed: the subscription keeps
    // its own snapshot, which is exactly why the snapshot exists.
    const saved = savePlan(body, { id: existing.id });
    const plan = planView(planById(saved.id), featuresForPlan(saved.id));
    const sync = await syncPlanToMagnate(saved);
    logEvent({
      actor: request.account.email,
      action: 'commerce.plan_updated',
      subject: plan.name,
      detail: `${Object.keys(body).filter((key) => body[key] !== undefined).join(', ')}${sync.ok ? ' · magnate synced' : ''}`,
      ip: request.ip,
    });
    return { plan: { ...plan, magnate: sync }, plans: listPlans() };
  });

  /**
   * Retiring a plan hides it from the public page and stops new sales; the
   * customers on it keep it, because deleting the row they bought would be a
   * rewrite of history.
   */
  app.delete('/plans/:id', { preHandler: requireAdmin }, async (request) => {
    const existing = planById(request.params.id);
    if (!existing) throw notFound('Plan not found');
    db_.run('UPDATE plans SET active = 0, is_default = 0, updated_at = ? WHERE id = ?', [now(), existing.id]);
    const live = db_.get(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ? AND status IN ('active','trialing','past_due')`,
      [existing.id]
    ).n;
    logEvent({
      actor: request.account.email,
      action: 'commerce.plan_retired',
      subject: existing.name,
      detail: `${live} live subscription(s) keep the plan`,
      ip: request.ip,
    });
    return { ok: true, liveSubscriptions: live, plans: listPlans() };
  });

  app.post('/plans/:id/sync', { preHandler: requireAdmin }, async (request) => {
    const existing = planById(request.params.id);
    if (!existing) throw notFound('Plan not found');
    const sync = await syncPlanToMagnate(existing);
    return { magnate: sync, plan: { ...planById(existing.id), magnate: sync } };
  });

  /* -------------------------------------------------------------- features -- */

  app.get('/features', { preHandler: requireAdmin }, async () => ({ items: listFeatures() }));

  app.post('/features', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body || {};
    if (db_.get('SELECT key FROM features WHERE key = ?', [String(body.key || '').toLowerCase()])) {
      throw conflict('That feature key already exists');
    }
    const feature = saveFeature(body);
    if (!feature) throw badRequest('A feature needs a key');
    reply.status(201);
    return { feature: { ...feature, addon: !!feature.addon, active: !!feature.active } };
  });

  app.patch('/features/:key', { preHandler: requireAdmin }, async (request) => {
    const existing = db_.get('SELECT * FROM features WHERE key = ?', [request.params.key]);
    if (!existing) throw notFound('Feature not found');
    const body = request.body || {};
    const feature = saveFeature({
      key: existing.key,
      label: body.label,
      description: body.description,
      category: body.category,
      addon: body.addon === undefined ? undefined : body.addon ? 1 : 0,
      sortOrder: body.sortOrder,
      active: body.active === undefined ? undefined : body.active ? 1 : 0,
    });
    logEvent({
      actor: request.account.email,
      action: 'commerce.feature_updated',
      subject: existing.key,
      ip: request.ip,
    });
    return { feature: { ...feature, addon: !!feature.addon, active: !!feature.active }, features: listFeatures() };
  });

  /** Removing a feature removes it from every plan at once. */
  app.delete('/features/:key', { preHandler: requireAdmin }, async (request) => {
    const removed = deleteFeature(request.params.key);
    if (!removed) throw notFound('Feature not found');
    logEvent({
      actor: request.account.email,
      action: 'commerce.feature_deleted',
      subject: request.params.key,
      ip: request.ip,
    });
    return { ok: true, features: listFeatures(), plans: listPlans() };
  });

  /* --------------------------------------------------------- subscriptions -- */

  app.get('/subscriptions', { preHandler: requireAdmin }, async () => ({
    items: listSubscriptions(),
    plans: listPlans({ withFeatures: false }),
  }));

  /**
   * Put an existing account on a plan without a card: a comp, a migration, or a
   * customer who paid by transfer. The row is a normal subscription, so the
   * gate and the portal treat it exactly like one bought online.
   */
  app.post('/subscriptions', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body || {};
    const email = v.email(body.email);
    const account = db_.get('SELECT * FROM accounts WHERE email = ?', [email]);
    if (!account) throw notFound('No account with that email');
    if ((account.account_kind || 'staff') !== 'customer') {
      throw badRequest('That is a staff account. Subscriptions belong to customer accounts.');
    }
    const plan = planById(body.planId || '') || defaultPlan();
    if (!plan) throw badRequest('Create a plan first');
    const status = v.oneOf(body.status || 'active', ['incomplete', 'active', 'trialing', 'past_due', 'canceled'], 'status');

    const id = newId('sub_');
    db_.run(
      `INSERT INTO subscriptions (id, account_id, plan_id, plan_name, plan_slug, price_cents, currency,
                                  interval, seats, status, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        account.id,
        plan.id,
        plan.name,
        plan.slug,
        plan.price_cents,
        plan.currency,
        plan.interval,
        plan.seats,
        status,
        body.currentPeriodEnd || null,
      ]
    );
    logEvent({
      actor: request.account.email,
      action: 'portal.subscription_created',
      subject: plan.name,
      detail: `${email} · ${status}`,
      ip: request.ip,
    });
    reply.status(201);
    return {
      subscription: subscriptionView(
        db_.get('SELECT s.*, a.email FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [id])
      ),
      items: listSubscriptions(),
    };
  });

  /**
   * An operator override: comp an account, correct a status, move it to another
   * plan. Stripe is not touched — this is the deliberate human decision, and the
   * audit trail names who made it.
   */
  app.patch('/subscriptions/:id', { preHandler: requireAdmin }, async (request) => {
    const row = db_.get('SELECT * FROM subscriptions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Subscription not found');
    const body = request.body || {};

    if (body.planId) {
      const plan = changeSubscriptionPlan(row.id, String(body.planId), request.account.email);
      if (!plan) throw badRequest('That plan does not exist');
    }
    if (body.status) {
      setSubscriptionStatus(
        row.id,
        v.oneOf(body.status, ['incomplete', 'active', 'trialing', 'past_due', 'canceled'], 'status'),
        request.account.email
      );
    }
    const fresh = db_.get('SELECT s.*, a.email FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [row.id]);
    return { subscription: subscriptionView(fresh) };
  });

  /** Customers, as accounts and as subscriptions, for the admin list. */
  app.get('/customers', { preHandler: requireAdmin }, async () => ({
    items: db_
      .all(
        `SELECT a.id, a.email, a.name, a.created_at, a.last_login_at, a.suspended_at,
                s.status AS subscription_status, s.plan_name, s.current_period_end
           FROM accounts a
           LEFT JOIN subscriptions s ON s.account_id = a.id
          WHERE a.account_kind = 'customer'
          ORDER BY a.created_at DESC LIMIT 200`
      )
      .map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        suspended: !!row.suspended_at,
        plan: row.plan_name || '',
        status: row.subscription_status || 'none',
        currentPeriodEnd: row.current_period_end,
      })),
  }));

  /**
   * Onboard a customer by hand: an operator taking a signup over the phone, or
   * a customer who paid by transfer. The account is a normal customer account,
   * so the same paid gate applies to it from the first sign-in.
   */
  app.post('/customers', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body || {};
    const email = v.email(body.email);
    const name = v.str(body.name, { name: 'name', min: 2, max: 80 });
    const password = v.str(body.password, { name: 'password', min: 10, max: 200 });

    const created = createCustomerAccount({ email, name, password });
    if (!created.ok) throw conflict('An account with that email already exists. Add a subscription to it instead.');

    let subscription = null;
    if (body.planId) {
      const plan = planById(String(body.planId)) || defaultPlan();
      if (plan) {
        const id = newId('sub_');
        db_.run(
          `INSERT INTO subscriptions (id, account_id, plan_id, plan_name, plan_slug, price_cents, currency,
                                      interval, seats, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            created.account.id,
            plan.id,
            plan.name,
            plan.slug,
            plan.price_cents,
            plan.currency,
            plan.interval,
            plan.seats,
            v.oneOf(body.status || 'active', ['incomplete', 'active', 'trialing', 'past_due', 'canceled'], 'status'),
          ]
        );
        subscription = subscriptionView(
          db_.get('SELECT s.*, a.email FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [id])
        );
      }
    }

    logEvent({
      actor: request.account.email,
      action: 'portal.customer_created',
      subject: email,
      detail: subscription ? `with ${subscription.planName}` : 'no subscription yet',
      ip: request.ip,
    });
    reply.status(201);
    return {
      customer: { id: created.account.id, email: created.account.email, name: created.account.name },
      subscription,
      items: listSubscriptions(),
    };
  });

  /* ------------------------------------------- customer lifecycle (admin) -- */
  /**
   * One customer, by id, with the two facts an admin action needs: is it an
   * owner (never suspendable) and what is it subscribed to (what cancel and
   * remove would take away).
   */
  const customerById = (id) => {
    const row = db_.get('SELECT * FROM accounts WHERE id = ?', [id]);
    if (!row) throw notFound('Customer not found');
    const subscriptions = db_.all('SELECT * FROM subscriptions WHERE account_id = ?', [id]);
    return { row, subscriptions };
  };

  const refuseOwner = (row, action) => {
    if (row.role === 'owner') {
      throw badRequest(`That account is an owner; ${action} it would lock the platform out of itself`);
    }
  };

  /**
   * Suspend a customer. Same shape as a billing suspension — `suspended_at` plus
   * a bumped `token_version`, so an open session stops working immediately
   * instead of at the next expiry — because a suspension the customer can keep
   * using is not a suspension.
   */
  app.post('/customers/:id/suspend', { preHandler: requireAdmin }, async (request) => {
    const { row } = customerById(request.params.id);
    refuseOwner(row, 'suspending');
    const reason = v.str((request.body || {}).reason, { name: 'reason', max: 200, required: false });
    if (row.suspended_at) {
      return { customer: { id: row.id, suspended: true, suspendedAt: row.suspended_at } };
    }
    db_.run(
      'UPDATE accounts SET suspended_at = ?, token_version = token_version + 1 WHERE id = ?',
      [now(), row.id]
    );
    logEvent({
      actor: request.account.email,
      action: 'portal.customer_suspended',
      subject: row.email,
      detail: reason || 'suspended by an operator',
      ip: request.ip,
    });
    return { customer: { id: row.id, email: row.email, suspended: true } };
  });

  /** Lift a suspension. The customer's sessions were invalidated, so this does
   *  not restore a login — it restores the right to log in. */
  app.post('/customers/:id/reinstate', { preHandler: requireAdmin }, async (request) => {
    const { row } = customerById(request.params.id);
    if (!row.suspended_at) {
      return { customer: { id: row.id, suspended: false } };
    }
    db_.run('UPDATE accounts SET suspended_at = NULL WHERE id = ?', [row.id]);
    logEvent({
      actor: request.account.email,
      action: 'portal.customer_reinstated',
      subject: row.email,
      detail: v.str((request.body || {}).reason, { name: 'reason', max: 200, required: false }) || 'reinstated by an operator',
      ip: request.ip,
    });
    return { customer: { id: row.id, email: row.email, suspended: false } };
  });

  /**
   * Cancel what a customer is paying for, without deleting them: the account,
   * its numbers and its history stay, the subscription does not renew. An
   * account that is cancelled rather than suspended loses its entitlement on
   * the same gate, because `entitlementFor` reads the subscription.
   */
  app.post('/customers/:id/cancel', { preHandler: requireAdmin }, async (request) => {
    const { row, subscriptions } = customerById(request.params.id);
    refuseOwner(row, 'cancelling');
    const active = subscriptions.filter((sub) => sub.status !== 'canceled');
    for (const sub of active) setSubscriptionStatus(sub.id, 'canceled', request.account.email);
    if (active.length) {
      logEvent({
        actor: request.account.email,
        action: 'portal.customer_cancelled',
        subject: row.email,
        detail: `${active.length} subscription(s) cancelled`,
        ip: request.ip,
      });
    }
    return {
      customer: { id: row.id, email: row.email },
      cancelled: active.map((sub) => sub.id),
    };
  });

  /**
   * Remove a customer outright. Owner only, and never the last owner: the
   * schema cascades subscriptions, keys and lines, which is exactly why this is
   * a separate, deliberate door rather than a flag on suspend.
   */
  app.delete('/customers/:id', { preHandler: requireOwner }, async (request) => {
    const { row, subscriptions } = customerById(request.params.id);
    refuseOwner(row, 'removing');
    const active = subscriptions.filter((sub) => sub.status === 'active');
    if (active.length && String(request.query?.force || '') !== '1') {
      throw conflict('This customer has an active subscription. Cancel it first, or repeat with force=1.');
    }
    db_.run('DELETE FROM accounts WHERE id = ?', [row.id]);
    logEvent({
      actor: request.account.email,
      action: 'portal.customer_removed',
      subject: row.email,
      detail: active.length ? 'removed with an active subscription' : 'removed',
      ip: request.ip,
    });
    return { removed: row.id, email: row.email };
  });

  /** Re-seed the starter catalog. Idempotent: only ever adds what is missing. */
  app.post('/plans/seed', { preHandler: requireOwner }, async () => {
    seedCommerce();
    return { plans: listPlans(), features: listFeatures() };
  });
}
