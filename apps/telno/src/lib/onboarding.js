import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { newOtpCode, otpHash } from './security.js';
import { deliverNotice, deliverVerification, channelStatus } from './channels.js';
import { welcomeEmail } from './mail.js';
import { voipmsConfigured } from './carriers/voipms.js';
import { badRequest, conflict } from './errors.js';

/**
 * The required first login.
 *
 * A new account used to land in the console with everything it needed to look
 * finished and nothing it needed to be real: no terms on record, an address
 * nobody had proved was reachable, and a switch with no line on it. Every one of
 * those is a problem that surfaces later — a customer who cannot be reached
 * about a bill, a platform that cannot prove anyone agreed to anything, a first
 * call that cannot be placed — so they are asked for once, at the front door,
 * and the door stays shut until they are answered.
 *
 * The steps, in order:
 *
 *   terms    accepted, recorded with the version that was accepted
 *   profile  who the account holder is, plus the public-directory answer
 *   email    a code sent to the account's address and typed back
 *   phone    a code sent by SMS to a number given here and typed back
 *   line     a line on the account, and a number on that line
 *
 * "line" is last because it is the one step that cannot be satisfied with a form:
 * it needs the switch. Its own screen creates both (`POST /api/setup/line`), so
 * whoever is walking through this makes a call at the end of it.
 *
 * Everything here is server-side truth: the console hides the rest of the
 * platform behind these answers, and so does `plugins/auth.js`, which is what
 * stops a hand-written request from skipping the wizard.
 */

/** Bump when the text materially changes; the version is stored per account. */
export const TERMS_VERSION = '2026-10';

/**
 * What the account holder agrees to, shown in full before the box is ticked.
 *
 * It lives here, next to the version, because the two have to move together: an
 * agreement recorded against a version whose text nobody can produce is not an
 * agreement. Deliberately plain — the terms a customer actually reads are the
 * ones they can finish.
 */
export const TERMS_TEXT = [
  'Service. This agreement covers the telephone service provided on this platform: the line or lines on your account, the phone numbers attached to them, and the calls, messages and faxes carried on them.',
  'Your details. You agree to keep the account, billing and contact details on this platform accurate, and to verify the email address and phone number on the account. Notices about your service and your bill go to those.',
  'Billing. Charges are billed in advance at the rate in effect when the period begins, in US dollars, to the payment method on the account. A number rented for your line is billed monthly while you hold it. Invoices are due on the date shown on them; service may be suspended on an unpaid invoice after the reminders and a final notice, and restored when the balance is settled.',
  'Acceptable use. You will not use the service to break the law, to make calls that are unlawful where you or the person called is located, to send unsolicited bulk messages, or to place calls with a falsified identity. Numbers are registered to the person or business that holds them, and caller ID is presented as it is configured.',
  'Recording and privacy. Calls are not recorded unless recording is switched on for the line; where it is, you are responsible for the notices the law requires. Encryption applies between your device and the switch; a call that reaches the public telephone network is unencrypted on that last leg.',
  'Your data. Your catalogue of numbers, calls and messages stays on the platform that serves you. You may export your own data and close the account at any time; a number released back to its carrier may not be recoverable.',
  'Availability. The service is provided as it is, without a promise of uninterrupted operation. Planned work is announced in advance where it is possible to do so.',
  'Changes. Future revisions of these terms apply to periods that begin after they take effect, and the version you accepted is recorded on your account.',
];

/** Lines this account owns, and numbers on them: two questions the gate and the
 *  setup path both ask, answered one way. */
export const lineCount = (accountId) =>
  db_.get('SELECT COUNT(*) AS n FROM extensions WHERE account_id = ? AND enabled = 1', [accountId])?.n || 0;

export const numberCount = (accountId) =>
  db_.get('SELECT COUNT(*) AS n FROM numbers WHERE account_id = ?', [accountId])?.n || 0;

/** True when this account has agreed to this revision of the terms. */
export const termsAccepted = (account) =>
  !!account.terms_accepted_at && String(account.terms_version || '') === TERMS_VERSION;

/**
 * Whether the wizard applies at all.
 *
 * An API-key client is a machine, not somebody to greet, and a deployment that
 * has said so with `ONBOARDING_REQUIRED=false` keeps its old behaviour. Staff and
 * customers are both asked: the first install's owner needs a line as much as a
 * subscriber does, and the terms apply to whoever is operating the platform.
 */
export const onboardingApplies = () => config.onboarding.required;

/**
 * The gate's own question, asked on every authenticated request.
 *
 * Deliberately cheaper than `onboardingState`: the four timestamps are columns
 * already on the row, so a finished account costs nothing, and the two counts
 * — the only queries — are asked last and only while something is unfinished.
 */
export function needsOnboarding(account) {
  if (!onboardingApplies() || !account) return false;
  if (!termsAccepted(account)) return true;
  if (!account.profile_confirmed_at) return true;
  if (!account.email_verified_at) return true;
  if (!account.phone_verified_at) return true;
  return lineCount(account.id) === 0 || numberCount(account.id) === 0;
}

/** The whole state in one object, so the console and the API agree by construction. */
export function onboardingState(account) {
  const lines = lineCount(account.id);
  const numbers = numberCount(account.id);
  const steps = [
    {
      id: 'terms',
      title: 'Agree to the terms of service',
      detail: 'The agreement that covers the line, the number and the calls made on them.',
      done: termsAccepted(account),
      href: '/terms',
    },
    {
      id: 'profile',
      title: 'Confirm your account and billing details',
      detail:
        'The name that appears on the bill, where the bill is sent, and whether your number may be listed in the public directory.',
      done: !!account.profile_confirmed_at,
    },
    {
      id: 'email',
      title: 'Verify your email address',
      detail: account.email_verified_at
        ? `Verified ${account.email_verified_at}`
        : `We send a six-digit code to ${account.email} and you type it back.`,
      done: !!account.email_verified_at,
      target: account.email,
    },
    {
      id: 'phone',
      title: 'Verify your phone number',
      detail: 'A code by SMS to a mobile we can reach you on. It is where outage and billing notices go.',
      done: !!account.phone_verified_at,
      target: account.phone || '',
    },
    {
      id: 'line',
      title: 'Add your line and a phone number',
      detail:
        lines > 0
          ? `${lines} line${lines === 1 ? '' : 's'} on the switch${numbers ? `, ${numbers} number${numbers === 1 ? '' : 's'} attached` : ' — add a number so it can be dialled'}`
          : 'An extension is the number you dial and the identity that registers; a number is what the outside world calls.',
      done: lines > 0 && numbers > 0,
    },
  ];
  const next = steps.find((step) => !step.done) || null;
  return {
    required: needsOnboarding(account) && !!next,
    complete: !next,
    next: next ? next.id : null,
    steps,
    terms: {
      version: TERMS_VERSION,
      acceptedAt: account.terms_accepted_at || null,
      acceptedVersion: account.terms_version || '',
      current: termsAccepted(account),
    },
    profile: {
      confirmed: !!account.profile_confirmed_at,
      confirmedAt: account.profile_confirmed_at || null,
      name: account.name || '',
      email: account.email || '',
      company: account.company || '',
      address: account.address || '',
      city: account.city || '',
      country: account.country || '',
      website: account.website || '',
      directoryOptIn: !!account.directory_opt_in,
    },
    email: { address: account.email, verifiedAt: account.email_verified_at || null },
    phone: { number: account.phone || '', verifiedAt: account.phone_verified_at || null },
    line: {
      lines,
      numbers,
      // Where a number can come from. A subscriber's line and number are the
      // platform's business, so only the account running the switch is offered
      // the carrier's catalog from inside the wizard.
      carrier: (account.account_kind || 'staff') === 'customer' ? null : { voipms: voipmsConfigured() },
    },
    // Why a code might not arrive, in the operator's terms rather than the
    // customer's: the console shows this, the customer sees the plain sentence.
    delivery: channelStatus(),
  };
}

/**
 * The welcome message, sent once per account.
 *
 * Called when the account is created — the bootstrap owner and a subscriber
 * signing up on the public page — and available on request afterwards. The
 * stamp on the row is what makes "once" true across a restart; `force` is for
 * the operator who knows the first attempt went nowhere.
 */
export async function sendWelcome(account, { force = false } = {}) {
  if (!account?.email) return { sent: false, channel: '', error: 'no address', skipped: true };
  if (account.welcome_sent_at && !force) return { sent: false, channel: '', error: '', skipped: true };
  const message = welcomeEmail(account, {
    line: { lines: lineCount(account.id), numbers: numberCount(account.id) },
    signInUrl: `${String(config.publicUrl || '').replace(/\/$/, '')}/login`,
  });
  const result = await deliverNotice({ to: account.email, ...message });
  if (result.delivered) db_.run('UPDATE accounts SET welcome_sent_at = ? WHERE id = ?', [now(), account.id]);
  return { sent: !!result.delivered, channel: result.channel || '', error: result.error || '', skipped: false };
}

/** Paths a half-onboarded account may still reach — the wizard, and nothing else. */
export const ONBOARDING_ALLOWED = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/onboarding(\/|$)/,
  // The line step is the setup flow: it is how the last step gets completed.
  /^\/api\/setup(\/|$)/,
  /^\/api\/system(\/|$)/,
  /^\/api\/public(\/|$)/,
  // Buying the number the last step asks for, from inside the wizard. Only staff
  // can reach the carrier routes at all — a customer is stopped earlier — and the
  // allowance ends when the wizard does.
  /^\/api\/provider(\/|$)/,
];

export const isAllowedWhileOnboarding = (path) => ONBOARDING_ALLOWED.some((pattern) => pattern.test(path));

/* ------------------------------------------------------------------ codes -- */

const maskTarget = (value) => {
  const text = String(value || '');
  if (text.includes('@')) {
    const [user, host] = text.split('@');
    return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${host}`;
  }
  return text.length > 4 ? `${'•'.repeat(text.length - 4)}${text.slice(-4)}` : text;
};

export { maskTarget };

/**
 * Send a fresh code. Any earlier code for the same channel is retired first, so
 * only the most recent message can be used — otherwise a customer who asked
 * twice has two live codes and no way to know which one to type.
 */
export async function sendCode(account, channel, target) {
  const value = String(target || '').trim();
  if (!value) throw badRequest(channel === 'sms' ? 'A phone number is required' : 'An email address is required');

  const recent = db_.get(
    `SELECT COUNT(*) AS n FROM account_verifications
      WHERE account_id = ? AND channel = ? AND created_at > ?`,
    [account.id, channel, new Date(Date.now() - 60 * 60 * 1000).toISOString()]
  )?.n || 0;
  if (recent >= config.directory.submissionLimitPerHour) {
    throw conflict('Too many codes requested in the last hour. Try again later.');
  }

  db_.run('UPDATE account_verifications SET used_at = ? WHERE account_id = ? AND channel = ? AND used_at IS NULL', [
    now(),
    account.id,
    channel,
  ]);

  const code = newOtpCode();
  const id = newId('av_');
  const expiresAt = new Date(Date.now() + config.directory.otpTtlSeconds * 1000).toISOString();
  db_.run(
    `INSERT INTO account_verifications (id, account_id, channel, target, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, account.id, channel, value, otpHash(code, id), expiresAt]
  );
  // Remember the number being proved, so a reload in the middle of the step does
  // not lose what was typed. It stays unverified until the code comes back.
  if (channel === 'sms') db_.run('UPDATE accounts SET phone = ? WHERE id = ?', [value, account.id]);

  const delivery = await deliverVerification({
    channel,
    to: value,
    code,
    submission: { id, name: account.name || account.email },
  });

  return {
    sent: delivery.delivered,
    channel,
    target: maskTarget(value),
    // A code that never left the server is not a secret from the account that
    // asked for it: when the delivery channel is the console — the default on a
    // fresh install, and the only one until a provider is configured — there is
    // no inbox to open and no handset to check, so the code comes back in the
    // response and the wizard can be finished on the install it is running on.
    // As soon as a real provider delivers, it does not. Only this account ever
    // sees it: the response is the caller's own session.
    ...(delivery.simulated && config.directory.exposeSimulatedCodes ? { devCode: code } : {}),
    expiresIn: config.directory.otpTtlSeconds,
    error: delivery.delivered ? '' : delivery.error || 'delivery failed',
  };
}

/** Check a code and, on success, mark the channel done on the account. */
export function checkCode(account, channel, rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '');
  const row = db_.get(
    `SELECT * FROM account_verifications
      WHERE account_id = ? AND channel = ? AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [account.id, channel]
  );
  if (!row) throw badRequest('Request a code first.');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest('That code has expired. Request a new one.');

  db_.run('UPDATE account_verifications SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  if (code.length !== 6 || otpHash(code, row.id) !== row.code_hash) {
    const left = config.directory.otpMaxAttempts - (row.attempts + 1);
    if (left <= 0) throw conflict('Too many incorrect codes. Request a new one.');
    throw badRequest(`That code is not correct. ${left} attempt(s) left.`);
  }

  db_.run('UPDATE account_verifications SET used_at = ? WHERE id = ?', [now(), row.id]);
  const stamp = now();
  if (channel === 'email') {
    db_.run('UPDATE accounts SET email_verified_at = ? WHERE id = ?', [stamp, account.id]);
  } else {
    db_.run('UPDATE accounts SET phone = ?, phone_verified_at = ? WHERE id = ?', [row.target, stamp, account.id]);
  }
  return db_.get('SELECT * FROM accounts WHERE id = ?', [account.id]);
}
