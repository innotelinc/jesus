import { db_ } from '../db/index.js';
import { config } from '../config.js';
import { verifySession, apiKeyHash, signSession } from '../lib/security.js';
import { unauthorized, forbidden, paymentRequired } from '../lib/errors.js';
import { entitlementFor } from '../lib/subscriptions.js';

export const SESSION_COOKIE = 'telno_session';

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
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
export function installAuth(app) {
  app.decorateRequest('account', null);
  app.decorateRequest('apiKey', null);

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

  app.decorate('authenticate', async (request) => {
    const account = app.readSession(request);
    if (!account) throw unauthorized();
    // Billing suspension is a lock on the front door, not a filter on a page:
    // a suspended customer cannot read numbers, calls or anything else.
    if (account.suspended_at) {
      throw paymentRequired('This account is suspended for non-payment. Settling the balance restores access automatically.');
    }
    request.entitlement = app.enforceEntitlement(account);
    request.account = account;
  });

  app.decorate('authenticateAny', async (request, scope = 'registry:read') => {
    const account = app.readSession(request);
    if (account) {
      if (account.suspended_at) {
        throw paymentRequired('This account is suspended for non-payment. Settling the balance restores access automatically.');
      }
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
    request.entitlement = app.enforceEntitlement(account);
    request.account = account;
  });

  app.decorate('sessionFor', (account) =>
    signSession({ sub: account.id, role: account.role, tv: account.token_version })
  );
}
