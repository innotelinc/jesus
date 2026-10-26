import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const list = (v, fallback = '') =>
  String(v ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Minimal .env loader. Real environment variables always win over the file. */
function loadDotEnv(file = resolve(process.cwd(), '.env')) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: resolve(env.DATA_DIR || './data'),
  dbFile: env.DB_FILE || '',
  defaultCountry: (env.DEFAULT_COUNTRY || 'US').toUpperCase(),
  publicUrl: env.PUBLIC_URL || `http://localhost:${int(env.PORT, 8080)}`,
  trustProxy: bool(env.TRUST_PROXY, false),

  // Set automatically by the container entrypoint on first boot.
  adminEmail: env.ADMIN_EMAIL || 'admin@telno.local',
  adminPassword: env.ADMIN_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: int(env.SESSION_DAYS, 7),
  apiKeyPepper: env.API_KEY_PEPPER || '',

  // Call recordings, voicemail audio and fax attachments live on the data
  // volume, next to the database, so a container restart keeps them.
  recordingsDir: resolve(env.RECORDINGS_DIR || resolve(env.DATA_DIR || './data', 'recordings')),
  mediaMaxBytes: int(env.MEDIA_MAX_BYTES, 10 * 1024 * 1024),

  devices: {
    // How often a device is asked to check in, and how long it may stay quiet
    // before the platform treats a live device as silent.
    checkInSec: Math.max(15, int(env.DEVICE_CHECKIN_SEC, 300)),
    staleAfterSec: Math.max(60, int(env.DEVICE_STALE_AFTER_SEC, 900)),
  },

  telephony: {
    enabled: bool(env.TELEPHONY_ENABLED, true),
    // Asterisk Manager Interface — the control plane's only path into the switch.
    amiHost: env.AMI_HOST || '127.0.0.1',
    amiPort: int(env.AMI_PORT, 5038),
    amiUser: env.AMI_USER || 'telno',
    amiSecret: env.AMI_SECRET || '',
    // Asterisk REST Interface (audio, channel control, live recordings).
    ariUrl: env.ARI_URL || 'http://127.0.0.1:8088',
    ariUser: env.ARI_USER || 'telno',
    ariSecret: env.ARI_SECRET || '',
    configDir: env.ASTERISK_CONFIG_DIR || '',
    reloadOnApply: bool(env.ASTERISK_RELOAD, true),
    // NAT: the address a client outside the container can actually reach. On
    // Docker's bridge network Asterisk would otherwise advertise its container
    // IP in ICE candidates and media would never arrive.
    externalAddress: env.ASTERISK_EXTERNAL_ADDRESS || '',
    localNets: list(env.ASTERISK_LOCAL_NETS, '172.16.0.0/12,10.0.0.0/8,192.168.0.0/16'),
    // The SIP domain the switch puts in From/To headers. It has to be a name
    // and not the container's hostname: Docker names containers with a hex id,
    // and a SIP parser reads a digit-leading host as a malformed IPv4 address
    // (sip.js rejects the whole message), so a call would ring the browser and
    // never be offered to the operator.
    sipDomain:
      env.SIP_DOMAIN ||
      (() => {
        try {
          return new URL(env.PUBLIC_URL || 'http://localhost').hostname;
        } catch {
          return 'localhost';
        }
      })(),
    /** Simulated switch for `npm run dev` on machines without Asterisk. */
    simulate: bool(env.TELEPHONY_SIMULATE, false),
  },

  // Browser softphone: the platform mints the session, Asterisk carries the
  // media. SIP travels over WSS to chan_pjsip; audio and video are DTLS-SRTP.
  softphone: {
    enabled: bool(env.SOFTPHONE_ENABLED, true),
    // Public WSS address of the switch's HTTP transport. Empty means "derive
    // from the request host", which is right for a same-host deployment.
    wssUrl: env.SOFTPHONE_WSS_URL || '',
    wssPort: int(env.SOFTPHONE_WSS_PORT, 8089),
    // TLS material for that listener; generated under ASTERISK_CONFIG_DIR/keys
    // on first apply when these are left empty.
    tlsCert: env.SOFTPHONE_TLS_CERT || '',
    tlsKey: env.SOFTPHONE_TLS_KEY || '',
    stunUrls: list(env.SOFTPHONE_STUN_URLS, 'stun:stun.l.google.com:19302'),
    turnUrls: list(env.TURN_URLS, ''),
    turnSecret: env.TURN_SECRET || '',
    turnTtlSec: Math.max(300, int(env.TURN_TTL_SEC, 3600)),
    video: bool(env.SOFTPHONE_VIDEO, true),
    // A ticket is single-use and short-lived: it bootstraps one WebSocket.
    ticketTtlSec: Math.max(15, int(env.SOFTPHONE_TICKET_TTL, 120)),
    // Where the switch writes call recordings (inside the container).
    recordingDir: env.ASTERISK_RECORDING_DIR || '/data/recordings',
  },

  directory: {
    // The worldwide registry is served from every one of these hosts.
    domains: (env.DIRECTORY_DOMAINS ||
      'telno.directory,num.directory,number.directory,directory.telno.services,directory.pbx.services,directory.pbx.technology')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    canonical: env.DIRECTORY_CANONICAL || 'telno.directory',
    maxResults: int(env.DIRECTORY_MAX_RESULTS, 50),
    submissionLimitPerHour: int(env.SUBMISSION_LIMIT_PER_HOUR, 5),
    otpTtlSeconds: int(env.OTP_TTL_SECONDS, 600),
    otpMaxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
    // Without a live SMS/email provider, verification codes are returned in the
    // API response only outside production so the flow stays testable.
    devExposeCodes: bool(env.DEV_EXPOSE_VERIFICATION_CODES, env.NODE_ENV !== 'production'),
  },

  // Billing automation. Reminders go out through the same delivery channel as
  // every other notice, and the ladder is measured in days *after* the due
  // date — an invoice is reminded, not nagged before it is owed.
  billing: {
    reminders: bool(env.REMINDER_ENABLED, true),
    reminderDays: (() => {
      // A rung is a day *after* the due date, so 0 is not a rung: reminding on
      // the day an invoice is owed would be nagging before it is late.
      const days = list(env.REMINDER_DAYS, '1,3,7,14,30')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 1);
      const unique = [...new Set(days)].sort((a, b) => a - b);
      return unique.length ? unique : [1, 3, 7, 14, 30];
    })(),
    reminderSweepMinutes: Math.max(5, int(env.REMINDER_SWEEP_MINUTES, 30)),
    // Two reminders for the same invoice inside this window would read as spam,
    // however many sweeps happen in between.
    reminderGapHours: Math.max(1, int(env.REMINDER_GAP_HOURS, 20)),

    // Escalation: a final notice states a date, and the suspension happens on
    // that date. Turning this off leaves the reminder ladder running but never
    // switches a customer off.
    escalation: bool(env.ESCALATION_ENABLED, true),
    // Days past due at which the final notice replaces the ladder.
    finalNoticeDays: Math.max(1, int(env.FINAL_NOTICE_DAYS, 30)),
    // Days after the final notice before service is suspended. The exact date is
    // printed in the notice, so 0 means "today" and is not offered.
    suspendGraceDays: Math.max(0, int(env.SUSPEND_GRACE_DAYS, 14)),
  },

  // Online payment for invoices. The button in a final notice or a suspension
  // email points at this platform, which creates a Stripe Checkout Session and
  // redirects; Stripe's key lives in the vault (Settings → Vault) or here.
  payments: {
    enabled: bool(env.PAYMENTS_ENABLED, true),
    // Overridable so a test can point the API at a local stub instead of
    // charging a real card.
    apiUrl: String(env.STRIPE_API_URL || 'https://api.stripe.com').replace(/\/+$/, ''),
  },

  notify: {
    channel: env.NOTIFY_CHANNEL || 'console', // console | twilio | resend
    from: env.NOTIFY_FROM || 'directory@telno.directory',
    // Overridable so a test can point the mail adapter at a local stub instead
    // of the real provider. The path appended is `/emails`.
    resendUrl: env.RESEND_API_URL || 'https://api.resend.com',
    // Mailjet is the second email provider; the path appended is `/v3.1/send`.
    mailjetUrl: env.MAILJET_API_URL || 'https://api.mailjet.com',
    // An operator's choice, normally stored in the vault instead.
    emailProvider: String(env.EMAIL_PROVIDER || '').toLowerCase(),
    smtpUrl: env.SMTP_URL || '',
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
  },
};

if (!config.telephony.simulate && !config.telephony.amiSecret) {
  config.telephony.simulate = !env.AMI_SECRET;
}

export function assertConfig() {
  if (config.isProd && !config.sessionSecret) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  if (!config.sessionSecret) {
    // Deterministic per-process fallback so local dev works without a .env.
    config.sessionSecret = `dev-only-${config.port}-not-for-production`;
  }
  if (!config.apiKeyPepper) config.apiKeyPepper = config.sessionSecret;
}
