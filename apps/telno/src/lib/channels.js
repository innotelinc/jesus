import { config } from '../config.js';
import { getSecret } from './vault.js';
import { sendSmsMessage, smsFrom, voipmsConfigured } from './carriers/voipms.js';

/**
 * Outbound mail and SMS is plug-and-play: the platform picks a provider per
 * channel, so a mail key never affects SMS and vice versa.
 *
 *   send({ channel: 'email'|'sms', to, code, submission }) -> { delivered, provider }
 *
 * Credentials come from the vault first and the environment second. The vault
 * is what the console writes to (Settings → Email delivery), so an operator can
 * add or rotate a key without rebuilding the container; RESEND_API_KEY in the
 * environment still works for a deployment that would rather set it in compose.
 */

const consoleChannel = {
  name: 'console',
  async send({ channel, to, code, submission, body }) {
    // Deliberately explicit: this is the local/dev path, never a silent failure.
    console.log(
      `[verify] ${channel} -> ${to || '(no address)'} ${body ? `body=${body}` : `code=${code}`} submission=${submission?.id} name=${submission?.name}`
    );
    return { delivered: true, provider: 'console', simulated: true };
  },
};

/* -------------------------------------------------------------------- sms -- */

/**
 * SMS has one provider, Twilio, and the same rule as email: the vault holds the
 * credentials, the environment is the fallback.
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *
 * Three values, not two: a SID and token can send nothing without a sender, and
 * a half-filled form should read as unconfigured rather than fail at the first
 * verification code somebody is waiting for.
 */

const TWILIO_SID = 'TWILIO_ACCOUNT_SID';
const TWILIO_TOKEN = 'TWILIO_AUTH_TOKEN';
const TWILIO_FROM = 'TWILIO_FROM';

/** Vault first, environment second. Never logged, never returned by an API. */
export function twilioCredentials() {
  return {
    sid: getSecret(TWILIO_SID) || config.notify.twilioSid || '',
    token: getSecret(TWILIO_TOKEN) || config.notify.twilioToken || '',
    from: getSecret(TWILIO_FROM) || config.notify.twilioFrom || '',
  };
}

export const twilioConfigured = () => {
  const { sid, token, from } = twilioCredentials();
  return !!(sid && token && from);
};

export const twilioSource = () => sourceOf(TWILIO_SID, config.notify.twilioSid);

const twilioChannel = {
  name: 'twilio',
  async send({ channel, to, code, body }) {
    const { sid, token, from } = twilioCredentials();
    if (!sid || !token || !from) {
      return { delivered: false, provider: 'twilio', error: 'twilio_not_configured' };
    }
    if (channel !== 'sms') return { delivered: false, provider: 'twilio', error: 'sms_only' };
    const form = new URLSearchParams({
      To: to,
      From: from,
      Body:
        body ||
        `Your ${config.directory.canonical} verification code is ${code}. It expires in ${Math.round(
          config.directory.otpTtlSeconds / 60
        )} minutes.`,
    });
    let res;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A blocked egress or a wrong host is a delivery failure to report, not a
      // crash in the middle of somebody's verification step.
      return { delivered: false, provider: 'twilio', error: `network: ${err.message}` };
    }
    if (!res.ok) {
      // Twilio explains itself in the body (an unverified sender, a bad token);
      // passing that on is what turns a 400 into something an operator can fix.
      const problem = await res.json().catch(() => ({}));
      return { delivered: false, provider: 'twilio', error: problem?.message || `http_${res.status}` };
    }
    const sent = await res.json().catch(() => ({}));
    return { delivered: true, provider: 'twilio', id: sent?.sid || null };
  },
};

/**
 * SMS from the platform's own DID, which is what an install running on VoIP.ms
 * wants: the code arrives from the number the customer already knows, and no
 * second provider has to be paid for a message of sixty characters.
 */
const voipmsSmsChannel = {
  name: 'voipms',
  async send({ channel, to, code, body }) {
    if (channel !== 'sms') return { delivered: false, provider: 'voipms', error: 'sms_only' };
    if (!voipmsConfigured()) return { delivered: false, provider: 'voipms', error: 'voipms_not_configured' };
    try {
      const result = await sendSmsMessage({
        to,
        text:
          body ||
          `Your ${config.directory.canonical} verification code is ${code}. It expires in ${Math.round(
            config.directory.otpTtlSeconds / 60
          )} minutes.`,
      });
      return { delivered: true, provider: 'voipms', from: `+1${result.did}` };
    } catch (err) {
      // The carrier's own reason (an unverified DID, a refused destination) is
      // the only thing that tells an operator what to change.
      return { delivered: false, provider: 'voipms', error: err.message };
    }
  },
};

const SMS_PROVIDER_KEY = 'SMS_PROVIDER';

/**
 * Who an operator asked to text, when they asked. Empty means "whoever is ready".
 *
 * Choice beats presence, the same rule email follows: storing Twilio afterwards
 * does not quietly take the channel back from the DID that was chosen for it.
 */
export const smsPreference = () =>
  String(getSecret(SMS_PROVIDER_KEY) || config.notify.smsProvider || '').toLowerCase();

/** A provider that has everything it needs: credentials and a sender. */
export const voipmsSmsReady = () => voipmsConfigured() && !!smsFrom().did;

/**
 * One text, for a test send or a notice. Goes through whichever provider the
 * SMS channel resolves to, so a test proves the same path a code would take.
 */
export async function sendSms({ to, body }) {
  const provider = providerFor('sms');
  try {
    const result = await provider.send({ channel: 'sms', to, body });
    return { ...result, provider: provider.name };
  } catch (err) {
    return { delivered: false, provider: provider.name, error: err.message };
  }
}

/* ------------------------------------------------------------------ email -- */

/**
 * Two email providers, one adapter. The operator chooses; the vault holds the
 * credentials, so switching between Resend and Mailjet is a click in Settings
 * rather than an image rebuild and a restart.
 *
 *   EMAIL_PROVIDER = 'resend' | 'mailjet'   (vault first, environment second)
 *
 * Choice beats presence: a stored Resend key does not win while Mailjet is the
 * chosen provider. A chosen provider with no credentials fails loudly instead
 * of quietly posting invoices to the container log — a customer waiting for a
 * final notice must not be failed silently.
 */

const RESEND_KEY = 'RESEND_API_KEY';
const MAILJET_KEY = 'MAILJET_API_KEY';
const MAILJET_SECRET = 'MAILJET_API_SECRET';
const PROVIDER_KEY = 'EMAIL_PROVIDER';

/** Vault first, environment second. Never logged, never returned by an API. */
const resendKey = () => getSecret(RESEND_KEY) || process.env.RESEND_API_KEY || '';
const mailjetKey = () => getSecret(MAILJET_KEY) || process.env.MAILJET_API_KEY || '';
const mailjetSecret = () => getSecret(MAILJET_SECRET) || process.env.MAILJET_API_SECRET || '';

export const resendConfigured = () => !!resendKey();
// Mailjet authenticates with a key *and* a secret: one without the other is not
// a working configuration, and saying so beats a 401 from the provider.
export const mailjetConfigured = () => !!(mailjetKey() && mailjetSecret());

/** A From address can be stored too: providers reject a sender they do not own. */
const emailFrom = () => getSecret('EMAIL_FROM') || config.notify.from;

/** Where a credential came from, without disclosing it. */
const sourceOf = (name, environment) => (getSecret(name) ? 'vault' : environment ? 'environment' : 'none');

export const providerPreference = () =>
  String(getSecret(PROVIDER_KEY) || config.notify.emailProvider || '').toLowerCase();

/**
 * Which provider actually sends right now. An explicit choice wins; with no
 * choice the first configured provider is used, which keeps a deployment that
 * only ever had a Resend key working exactly as it did.
 */
export function emailProviderName() {
  const chosen = providerPreference();
  if (chosen === 'resend' || chosen === 'mailjet') return chosen;
  if (resendConfigured()) return 'resend';
  if (mailjetConfigured()) return 'mailjet';
  return 'console';
}

export const emailSource = () => {
  const name = emailProviderName();
  if (name === 'resend') return sourceOf(RESEND_KEY, process.env.RESEND_API_KEY);
  if (name === 'mailjet') return sourceOf(MAILJET_KEY, process.env.MAILJET_API_KEY);
  return 'none';
};

/**
 * Attachments as both providers want them: a filename, a content type and the
 * bytes as base64. A campaign report is the reason this exists — a PDF that
 * arrives as a link is a PDF somebody has to log in to read.
 */
const resendAttachments = (attachments) =>
  (attachments || []).map((file) => ({
    filename: file.filename,
    content: Buffer.from(file.content).toString('base64'),
    ...(file.contentType ? { content_type: file.contentType } : {}),
  }));

/** Resend: one POST, bearer key, JSON body. */
async function sendViaResend({ to, subject, text, html, attachments }) {
  const key = resendKey();
  if (!key) return { delivered: false, provider: 'resend', error: 'resend_not_configured' };
  let res;
  try {
    res = await fetch(`${config.notify.resendUrl}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      // `html` is optional: a message without markup is still sent as text, and
      // a client that refuses HTML reads the text part.
      body: JSON.stringify({
        from: emailFrom(),
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(attachments?.length ? { attachments: resendAttachments(attachments) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // A wrong host or a blocked egress is a delivery failure, not a crash: the
    // caller shows the reason and the operator can fix the key or the network.
    return { delivered: false, provider: 'resend', error: `network: ${err.message}` };
  }
  if (!res.ok) return { delivered: false, provider: 'resend', error: `http_${res.status}` };
  const body = await res.json().catch(() => ({}));
  return { delivered: true, provider: 'resend', id: body?.id || null };
}

/**
 * Mailjet: key + secret as Basic auth, a `Messages` array, and a 200 that can
 * still carry a per-message failure — so the status inside the body is checked,
 * not just the HTTP code.
 */
async function sendViaMailjet({ to, subject, text, html, attachments }) {
  const key = mailjetKey();
  const secret = mailjetSecret();
  if (!key || !secret) {
    return {
      delivered: false,
      provider: 'mailjet',
      error: !key ? 'mailjet_not_configured' : 'mailjet_secret_missing',
    };
  }
  let res;
  try {
    res = await fetch(`${config.notify.mailjetUrl}/v3.1/send`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: emailFrom(), Name: 'Telno' },
            To: [{ Email: to }],
            Subject: subject,
            TextPart: text,
            ...(html ? { HTMLPart: html } : {}),
            ...(attachments?.length
              ? {
                  Attachments: attachments.map((file) => ({
                    ContentType: file.contentType || 'application/octet-stream',
                    Filename: file.filename,
                    Base64Content: Buffer.from(file.content).toString('base64'),
                  })),
                }
              : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { delivered: false, provider: 'mailjet', error: `network: ${err.message}` };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body?.ErrorMessage || body?.Messages?.[0]?.Errors?.[0]?.ErrorMessage || `http_${res.status}`;
    return { delivered: false, provider: 'mailjet', error: why };
  }
  const message = body?.Messages?.[0] || {};
  if (message.Status && message.Status !== 'success') {
    return {
      delivered: false,
      provider: 'mailjet',
      error: message.Errors?.[0]?.ErrorMessage || message.Status,
    };
  }
  return { delivered: true, provider: 'mailjet', id: message.To?.[0]?.MessageID || null };
}

/**
 * One call, one message, whichever provider is chosen. Used by verification
 * codes, invoice resend, reports and the Settings test button, so every
 * outbound mail behaves the same way.
 */
export async function sendEmail({ to, subject, text, html, attachments }) {
  const provider = emailProviderName();
  if (provider === 'resend') return sendViaResend({ to, subject, text, html, attachments });
  if (provider === 'mailjet') return sendViaMailjet({ to, subject, text, html, attachments });
  return { delivered: false, provider: 'console', error: 'email_not_configured' };
}

/** The verification code, worded once so both providers send the same message. */
const verificationMessage = ({ code, submission }) => ({
  subject: `Verify your listing on ${config.directory.canonical}`,
  text:
    `Someone (hopefully you) submitted a directory listing for "${submission.name}".\n\n` +
    `Verification code: ${code}\n\n` +
    `It expires in ${Math.round(config.directory.otpTtlSeconds / 60)} minutes. ` +
    `If this was not you, ignore this message — nothing is published without the code.`,
});

const resendChannel = {
  name: 'resend',
  async send({ channel, to, code, submission }) {
    if (channel !== 'email') return { delivered: false, provider: 'resend', error: 'email_only' };
    return sendViaResend({ to, ...verificationMessage({ code, submission }) });
  },
};

const mailjetChannel = {
  name: 'mailjet',
  async send({ channel, to, code, submission }) {
    if (channel !== 'email') return { delivered: false, provider: 'mailjet', error: 'email_only' };
    return sendViaMailjet({ to, ...verificationMessage({ code, submission }) });
  },
};

/**
 * Which provider handles this channel right now. For email it is the operator's
 * choice; SMS keeps its own provider, so the two cannot interfere.
 */
export function providerFor(channel) {
  if (channel === 'email') {
    const name = emailProviderName();
    if (name === 'resend') return resendChannel;
    if (name === 'mailjet') return mailjetChannel;
    return consoleChannel;
  }
  // Stored credentials are enough on their own: a key pasted into Settings must
  // not need a redeploy before a code can reach a handset.
  const chosen = smsPreference();
  if (chosen === 'voipms') return voipmsSmsChannel;
  if (chosen === 'twilio') return twilioChannel;
  // Nothing chosen: the DID the platform already pays for goes first, and Twilio
  // stays the alternative for an install that has no number of its own.
  if (voipmsSmsReady()) return voipmsSmsChannel;
  if (twilioConfigured() || config.notify.channel === 'twilio') return twilioChannel;
  return consoleChannel;
}

export function activeChannel(channel = 'email') {
  return providerFor(channel);
}

export async function deliverVerification(payload) {
  const provider = providerFor(payload.channel);
  try {
    const result = await provider.send(payload);
    return { ...result, channel: provider.name };
  } catch (err) {
    return { delivered: false, channel: provider.name, error: err.message };
  }
}

/**
 * Sends an operational notice (an invoice, a reminder) through the configured
 * channel. Same provider, different message: verification codes have their own
 * template, so the two paths cannot accidentally cross.
 */
export async function deliverNotice({ to, subject, text, html, attachments }) {
  const channel = emailProviderName();
  try {
    if (channel === 'resend' || channel === 'mailjet') {
      const result = channel === 'resend'
        ? await sendViaResend({ to, subject, text, html, attachments })
        : await sendViaMailjet({ to, subject, text, html, attachments });
      return { ...result, channel };
    }
    if (config.notify.channel === 'twilio') {
      const { sid, token, from } = twilioCredentials();
      if (!sid || !token || !from) return { delivered: false, channel, error: 'twilio_not_configured' };
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: `${subject}. ${text}`.slice(0, 300) }),
      });
      return res.ok
        ? { delivered: true, channel }
        : { delivered: false, channel, error: `http_${res.status}` };
    }
    // Console: the local/dev path. Delivered to the log, deliberately visible.
    // The text part is what is logged — it is the same message the HTML shows.
    console.log(`[notice] ${channel} -> ${to} :: ${subject}${html ? ' (html)' : ''}\n${text}`);
    return { delivered: true, channel, simulated: true };
  } catch (err) {
    return { delivered: false, channel, error: err.message };
  }
}

export const channelStatus = () => {
  const provider = emailProviderName();
  return {
    active: provider,
    available: ['console', 'twilio', 'resend', 'mailjet'],
    devExposeCodes: config.directory.devExposeCodes,
    email: {
      provider,
      configured: provider === 'resend' ? resendConfigured() : provider === 'mailjet' ? mailjetConfigured() : false,
      // What the operator asked for, which may differ from what is delivering.
      preference: providerPreference(),
      source: emailSource(),
      from: emailFrom(),
      providers: {
        resend: {
          configured: resendConfigured(),
          source: sourceOf(RESEND_KEY, process.env.RESEND_API_KEY),
        },
        mailjet: {
          configured: mailjetConfigured(),
          key: !!mailjetKey(),
          secret: !!mailjetSecret(),
          source: sourceOf(MAILJET_KEY, process.env.MAILJET_API_KEY),
        },
      },
    },
    sms: (() => {
      const provider = providerFor('sms').name;
      const sender = smsFrom();
      const twilio = twilioCredentials();
      return {
        provider,
        configured: provider === 'voipms' ? voipmsSmsReady() : provider === 'twilio' ? twilioConfigured() : false,
        // What the operator asked for, which may differ from what is delivering.
        preference: smsPreference(),
        source: provider === 'voipms' ? sender.source : twilioSource(),
        // The number codes would come from, so an operator can see which one the
        // carrier is actually texting as. Never the credentials themselves.
        from: provider === 'voipms' ? sender.did : twilio.from,
        // A half-filled configuration has to say which part is missing rather
        // than one flat "not configured" that leaves the wrong field blamed.
        missing:
          provider === 'voipms'
            ? [
                !voipmsConfigured() && 'VoIP.ms API username and password (Settings → Numbers from VoIP.ms)',
                !sender.did && 'VOIPMS_SMS_DID',
              ].filter(Boolean)
            : provider === 'twilio'
              ? [
                  !twilio.sid && 'TWILIO_ACCOUNT_SID',
                  !twilio.token && 'TWILIO_AUTH_TOKEN',
                  !twilio.from && 'TWILIO_FROM',
                ].filter(Boolean)
              : ['a VoIP.ms number with SMS enabled, or TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM'],
        providers: {
          voipms: { configured: voipmsSmsReady(), from: sender.did, source: sender.source },
          twilio: {
            configured: twilioConfigured(),
            from: twilio.from,
            source: twilioSource(),
            missing: [!twilio.sid && 'TWILIO_ACCOUNT_SID', !twilio.token && 'TWILIO_AUTH_TOKEN', !twilio.from && 'TWILIO_FROM'].filter(
              Boolean
            ),
          },
        },
      };
    })(),
  };
};
