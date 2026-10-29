import { db_ } from '../db/index.js';
import { config } from '../config.js';
import { verifySession, apiKeyHash, signSession } from '../lib/security.js';
import { unauthorized, forbidden, paymentRequired, onboardingRequired } from '../lib/errors.js';
import { entitlementFor } from '../lib/subscriptions.js';
import { isAllowedWhileOnboarding, needsOnboarding, onboardingState } from '../lib/onboarding.js';

export const SESSION_COOKIE = 'telno_session';

/**
 * Whether the session cookie may carry `Secure`.
 *
 * In production it must, with one exception: a deployment that deliberately
 * runs on plain HTTP. `ALLOW_INSECURE_PUBLIC_URL` is what lets such a boot past
 * the checks in `productionProblems()`, so it has to reach the cookie too —
 * a browser silently discards a `Secure` cookie that arrives over http, and
 * the symptom is `POST /auth/login` answering 200 followed by every request
 * being anonymous, which reads as a broken sign-in rather than a broken flag.
 */
function secureCookie() {
  if (!config.isProd) return false;
  if (!config.allowInsecurePublicUrl) return true;
  try {
    return new URL(config.publicUrl).protocol !== 'http:';
  } catch {
    return true;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: secureCookie(),
  path: '/',
  maxAge: config.sessionDays * 86400,
};

function readToken(request) {
  const header = request.headers.authorization;
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  if (request.cookies?.[SESSION_COOKIE]) return request.cookies[SESSION_COOKIE];
  return null;
}

function accountFromToken(token) {
  const payload = verifySession(token);
  if (!payload?.sub) return null;
  const account = db_.get('SELECT * FROM accounts WHERE id = ?', [payload.sub]);
  if (!account) return null;
  // Bumped on password change, invalidating every previously issued token.
  if (Number(payload.tv ?? 0) !== Number(account.token_version)) return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
  return account;
}

function keyFromRequest(request) {
  const raw = request.headers['x-api-key'];
  if (!raw || typeof raw !== 'string') return null;
  const row = db_.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [apiKeyHash(raw)]);
  if (!row) return null;
  db_.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
  return row;
}

/** Installed directly on the root instance so decorators are visible everywhere. */
/**
 * What a customer account is allowed to reach.
 *
 * A customer owns a subscription, a line and the softphone on it. Everything
 * else under /api belongs to the platform: the switch and its inventory, the
 * registry, the campaigns, the books. Allowing a paid customer to read those
 * was never a decision anyone made — the console simply had no notion of a
 * customer — so the surface is named here instead of inherited.
 */
const CUSTOMER_PATHS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/me(\/|$)/,
  /^\/api\/portal(\/|$)/,
  /^\/api\/softphone(\/|$)/,
  // A voiceprint belongs to a line, and a customer's line is theirs. The route
  // itself checks ownership before it reads, writes or scores anything.
  /^\/api\/voice(\/|$)/,
  /^\/api\/public(\/|$)/,
  // The wizard's last step: a subscriber's first line and number are created by
  // the person who owns them, and that screen is part of signing up. The rest of
  // setup — the switch inventory and its trunks — stays staff-only.
  /^\/api\/setup\/line$/,
  /^\/api\/setup\/number$/,
  /^\/api\/onboarding(\/|$)/,
];

/**
 * Routes that are not paid capabilities.
 *
 * The first login is what makes an account real: it records the agreement, proves
 * the address and the phone, and puts a line behind the account. A subscriber
 * whose payment has not settled yet must be able to finish it — the wizard is not
 * something the subscription buys. Everything that opens *because* of the
 * subscription (the portal, the line, the softphone) stays behind the paid gate,
 * which is also what keeps /auth/me answering 402 to a lapsed customer.
 */
const NOT_A_PAID_CAPABILITY = [/^\/api\/onboarding(\/|$)/, /^\/api\/setup\/(line|number)$/];

export const isPaidCapability = (path) => !NOT_A_PAID_CAPABILITY.some((pattern) => pattern.test(path));

export function installAuth(app) {
  app.decorateRequest('account', null);
  app.decorateRequest('apiKey', null);

  // One choke point, before any route runs: signing a customer in must not sign
  // them into the operator's console.
  app.addHook('onRequest', async (request) => {
    const path = String(request.url || '').split('?')[0];
    if (!path.startsWith('/api/')) return;
    const account = app.readSession(request);
    if (!account || (account.account_kind || 'staff') !== 'customer') return;
    if (CUSTOMER_PATHS.some((pattern) => pattern.test(path))) return;
    throw forbidden('That part of the platform is for staff. Your account reaches your own line, plan and invoices.');
  });

  app.decorate('readSession', (request) => {
    const token = readToken(request);
    return token ? accountFromToken(token) : null;
  });

  /**
   * The paid-portal gate.
   *
   * A customer account holds a subscription; without a live one there is no
   * console for it, because every route behind this decorator is a paid
   * capability. Staff accounts are never gated here — the owner locking
   * themselves out of their own platform is not a billing remedy.
   */
  app.decorate('enforceEntitlement', (account) => {
    const entitlement = entitlementFor(account);
    if (!entitlement.active) {
      const reason =
        entitlement.reason === 'no_subscription'
          ? 'This portal is for subscribers. Choose a plan to open it.'
          : entitlement.reason === 'period_ended'
            ? 'Your subscription period has ended. Renewing restores access immediately.'
            : `Your subscription is ${String(entitlement.reason).replace(/_/g, ' ')}. Update billing to restore access.`;
      throw paymentRequired(reason);
    }
    return entitlement;
  });

  /**
   * The first-login gate.
   *
   * An account that has signed in has to finish the wizard before the console
   * answers it: the terms on record, the details confirmed, the address and the
   * phone proved, and a line that can actually ring. Enforced here rather than
   * in the screen so a hand-written request cannot skip it. The step it stopped
   * at travels in the error, which is what lets the console open the right one.
   */
  const enforceOnboarding = (request, account) => {
    if (!needsOnboarding(account)) return;
    const path = String(request.url || '').split('?')[0];
    if (isAllowedWhileOnboarding(path)) return;
    const state = onboardingState(account);
    throw onboardingRequired(state.next, state.next ? undefined : 'Finish setting up your account to continue');
  };

  app.decorate('authenticate', async (request) => {
    const account = app.readSession(request);
    if (!account) throw unauthorized();
    // Billing suspension is a lock on the front door, not a filter on a page:
    // a suspended customer cannot read numbers, calls or anything else.
    if (account.suspended_at) {
      throw paymentRequired('This account is suspended for non-payment. Settling the balance restores access automatically.');
    }
    enforceOnboarding(request, account);
    const path = String(request.url || '').split('?')[0];
    request.entitlement = isPaidCapability(path) ? app.enforceEntitlement(account) : entitlementFor(account);
    request.account = account;
  });

  app.decorate('authenticateAny', async (request, scope = 'registry:read') => {
    const account = app.readSession(request);
    if (account) {
      if (account.suspended_at) {
        throw paymentRequired('This account is suspended for non-payment. Settling the balance restores access automatically.');
      }
      // A session is a session, whichever decorator reads it: the first-login
      // gate would mean nothing if a half-finished account could reach the
      // registry through this door. An API key is a machine and is never asked.
      enforceOnboarding(request, account);
      request.entitlement = app.enforceEntitlement(account);
      request.account = account;
      return;
    }
    const key = keyFromRequest(request);
    if (!key) throw unauthorized('Provide a session cookie, bearer token, or x-api-key header');
    const scopes = key.scope.split(',').map((s) => s.trim());
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      throw forbidden(`API key lacks the "${scope}" scope`);
    }
    request.apiKey = key;
  });

  app.decorate('requireRole', (...roles) => async (request) => {
    const account = app.readSession(request);
    if (!account) throw unauthorized();
    if (account.suspended_at) {
      throw paymentRequired('This account is suspended for non-payment. Settling the balance restores access automatically.');
    }
    if (!roles.includes(account.role)) throw forbidden(`Requires one of: ${roles.join(', ')}`);
    enforceOnboarding(request, account);
    const path = String(request.url || '').split('?')[0];
    request.entitlement = isPaidCapability(path) ? app.enforceEntitlement(account) : entitlementFor(account);
    request.account = account;
  });

  app.decorate('sessionFor', (account) =>
    signSession({ sub: account.id, role: account.role, tv: account.token_version })
  );
}
