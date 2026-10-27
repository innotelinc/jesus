import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { checkCode, maskTarget, onboardingState, sendCode, sendWelcome, TERMS_TEXT, TERMS_VERSION } from '../lib/onboarding.js';
import { saveProfile } from '../lib/profile.js';
import { badRequest } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { deliverNotice, providerFor } from '../lib/channels.js';
import { welcomeEmail } from '../lib/mail.js';
import * as v from '../lib/validate.js';

/**
 * The required first login, as an API.
 *
 * Every route here answers for the signed-in account and writes only to it. The
 * gate that makes the steps mandatory is not in this file — it is in
 * `plugins/auth.js`, so a request that never comes through the wizard is
 * refused just the same as one that does.
 */

export default async function onboardingRoutes(app) {
  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    await app.authenticate(request);
  });

  const state = (account) => ({
    ...onboardingState(account),
    // The text, not a link: what is agreed to is what was on the screen.
    termsText: TERMS_TEXT,
    // How codes leave the building here, so an operator can see why one did not
    // arrive without reading the log.
    channel: {
      active: config.notify.channel,
      devExposeCodes: config.directory.devExposeCodes,
      // Which of the two codes is going to come back in the response.
      //
      // Asked per channel, and asked of the provider that will actually send:
      // the delivery channel an operator sets for notices is not the provider an
      // email code goes through, so reading one to describe the other is how a
      // screen ends up promising a code that is on its way to a real inbox. The
      // email step and the SMS step can answer differently, and on an install
      // with a mail key but no SMS carrier they do.
      codes: {
        email: providerFor('email').name === 'console' && config.directory.exposeSimulatedCodes,
        sms: providerFor('sms').name === 'console' && config.directory.exposeSimulatedCodes,
      },
    },
  });

  app.get('/onboarding', async (request) => state(request.account));

  /** Record the agreement, with the version that was on screen. */
  app.post('/onboarding/terms', async (request) => {
    if (!v.bool(request.body?.accept, false)) throw badRequest('The terms have to be accepted to continue');
    const stamp = now();
    db_.run('UPDATE accounts SET terms_accepted_at = ?, terms_version = ? WHERE id = ?', [
      stamp,
      TERMS_VERSION,
      request.account.id,
    ]);
    logEvent({
      actor: request.account.email,
      action: 'onboarding.terms_accepted',
      subject: request.account.id,
      detail: `version ${TERMS_VERSION}`,
      ip: request.ip,
    });
    return state(db_.get('SELECT * FROM accounts WHERE id = ?', [request.account.id]));
  });

  /**
   * Confirm who the account holder is — and answer the directory question.
   *
   * The directory answer is required for the same reason it is on the customer
   * portal: a number in a worldwide phonebook is a publication, and it must be
   * their decision rather than a default.
   */
  app.post('/onboarding/profile', async (request) => {
    const body = request.body || {};
    if (body.directoryOptIn === undefined) {
      throw badRequest('Say whether your number may be listed in the public directory');
    }
    const result = saveProfile(request.account, body);
    logEvent({
      actor: request.account.email,
      action: 'onboarding.profile_confirmed',
      subject: request.account.id,
      detail: `directory ${result.profile.directoryOptIn ? 'opt-in' : 'opt-out'}; ${result.applied.listed} listed, ${result.applied.hidden} hidden`,
      ip: request.ip,
    });
    return {
      ...state(db_.get('SELECT * FROM accounts WHERE id = ?', [request.account.id])),
      profile: result.profile,
      applied: result.applied,
    };
  });

  /** Send a code to the account's own address — never to one supplied here. */
  app.post('/onboarding/email/code', async (request) => {
    const result = await sendCode(request.account, 'email', request.account.email);
    logEvent({
      actor: request.account.email,
      action: 'onboarding.email_code',
      subject: maskTarget(request.account.email),
      detail: result.sent ? `sent via ${result.channel}` : `failed: ${result.error}`,
      ip: request.ip,
    });
    if (!result.sent) {
      throw badRequest(
        `The code could not be delivered (${result.error}). An operator has to configure email delivery in Settings → Vault.`
      );
    }
    return result;
  });

  app.post('/onboarding/email/verify', async (request) => {
    const account = checkCode(request.account, 'email', request.body?.code);
    logEvent({
      actor: account.email,
      action: 'onboarding.email_verified',
      subject: account.id,
      ip: request.ip,
    });
    return state(account);
  });

  /**
   * Send a code by SMS to a number given here.
   *
   * Stored as the account's phone the moment it is asked for, so the wizard
   * survives a reload; it is only *verified* when the code comes back.
   */
  app.post('/onboarding/phone/code', async (request) => {
    const phone = v.str(request.body?.phone, { name: 'phone', min: 7, max: 24 });
    const result = await sendCode(request.account, 'sms', phone);
    logEvent({
      actor: request.account.email,
      action: 'onboarding.phone_code',
      subject: maskTarget(phone),
      detail: result.sent ? `sent via ${result.channel}` : `failed: ${result.error}`,
      ip: request.ip,
    });
    if (!result.sent) {
      throw badRequest(
        `The code could not be delivered (${result.error}). An operator has to configure SMS delivery in Settings → Vault.`
      );
    }
    return result;
  });

  app.post('/onboarding/phone/verify', async (request) => {
    const account = checkCode(request.account, 'sms', request.body?.code);
    logEvent({
      actor: account.email,
      action: 'onboarding.phone_verified',
      subject: account.id,
      detail: account.phone || '',
      ip: request.ip,
    });
    return state(account);
  });

  /**
   * Send the welcome message again.
   *
   * Not a step: it goes out on its own when the account is created. This exists
   * because the first attempt can land in a spam folder or be sent before the
   * mail provider was configured at all, and "resend it" is the whole remedy.
   */
  app.post('/onboarding/welcome', async (request) => {
    const account = request.account;
    const result = await sendWelcome(account, { force: true });
    logEvent({
      actor: account.email,
      action: 'onboarding.welcome_sent',
      subject: account.id,
      detail: result.sent ? `via ${result.channel}` : `failed: ${result.error || 'not delivered'}`,
      ip: request.ip,
    });
    return result;
  });
}
