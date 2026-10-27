import { db_, now } from '../db/index.js';
import { hashPassword, verifyPassword, signSession } from '../lib/security.js';
import { unauthorized, badRequest, paymentRequired } from '../lib/errors.js';
import { loginSuspension } from '../lib/escalation.js';
import { money } from '../lib/mail.js';
import { cookieOptions, SESSION_COOKIE } from '../plugins/auth.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';
import { clearFirstRunPassword, firstRunPasswordFile, firstRunPasswordPending } from '../lib/firstRun.js';

const view = (account) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  role: account.role,
  // 'staff' or 'customer'. The SPA needs it to tell a console user from a
  // subscriber, whose access depends on a paid subscription.
  kind: account.account_kind || 'staff',
  createdAt: account.created_at,
  lastLoginAt: account.last_login_at,
});

export default async function authRoutes(app) {
  app.post(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = request.body || {};
      const email = v.email(body.email);
      const password = v.str(body.password, { name: 'password', max: 200 });
      const account = db_.get('SELECT * FROM accounts WHERE email = ?', [email]);
      // Same response for unknown user and wrong password.
      if (!account || !verifyPassword(password, account.password_hash)) {
        logEvent({ actor: email, action: 'auth.login_failed', ip: request.ip });
        throw unauthorized('Email or password is incorrect');
      }
      // A correct password is not enough when billing has switched the account
      // off: the customer is told exactly what is owed, in dollars.
      if (account.suspended_at) {
        const suspended = loginSuspension(account.email);
        const amount = suspended?.overdueCents ? money(suspended.overdueCents, suspended.currency) : '';
        logEvent({ actor: account.email, action: 'auth.login_suspended', subject: account.id, ip: request.ip });
        throw paymentRequired(
          amount
            ? `This account is suspended for non-payment. ${amount} is past due; paying restores access automatically.`
            : 'This account is suspended for non-payment. Settling the balance restores access automatically.'
        );
      }
      db_.run('UPDATE accounts SET last_login_at = ? WHERE id = ?', [now(), account.id]);
      const token = signSession({ sub: account.id, role: account.role, tv: account.token_version });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      logEvent({ actor: account.email, action: 'auth.login', subject: account.id, ip: request.ip });
      return { token, user: view(account) };
    }
  );

  app.post('/logout', async (request, reply) => {
    const account = app.readSession(request);
    if (account) {
      // Invalidates every issued token for this account, not just this browser.
      db_.run('UPDATE accounts SET token_version = token_version + 1 WHERE id = ?', [account.id]);
      logEvent({ actor: account.email, action: 'auth.logout', ip: request.ip });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // The session payload carries one thing beyond the account view: whether this
  // install still has the credential it generated at first boot sitting on the
  // volume. Only an owner has one to retire, so nobody else is told about it —
  // and the password itself is never part of this answer, only its existence
  // and where it lives.
  app.get('/me', { preHandler: app.authenticate }, async (request) => ({
    user: view(request.account),
    firstRun:
      request.account.role === 'owner'
        ? { pending: firstRunPasswordPending(), file: firstRunPasswordFile() }
        : null,
  }));

  app.post('/password', { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body || {};
    const current = v.str(body.currentPassword, { name: 'currentPassword', max: 200 });
    const next = v.str(body.newPassword, { name: 'newPassword', min: 10, max: 200 });
    if (!verifyPassword(current, request.account.password_hash)) throw unauthorized('Current password is incorrect');
    if (next === current) throw badRequest('New password must differ from the current one');
    db_.run('UPDATE accounts SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [
      hashPassword(next),
      request.account.id,
    ]);
    const fresh = db_.get('SELECT * FROM accounts WHERE id = ?', [request.account.id]);
    const token = signSession({ sub: fresh.id, role: fresh.role, tv: fresh.token_version });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    logEvent({ actor: fresh.email, action: 'auth.password_changed', ip: request.ip });
    // The generated first-run password is dead from here, so the file holding
    // it is not left lying on the volume.
    const removed = clearFirstRunPassword();
    return { ok: true, token, user: view(fresh), firstRunCredentialRemoved: removed };
  });
}
