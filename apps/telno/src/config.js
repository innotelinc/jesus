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
  // The public pricing page. One container serves it, but it is linked as its
  // own hostname so the subscriber never lands in the console.
  subscribeUrl: env.SUBSCRIBE_URL || '',
  trustProxy: bool(env.TRUST_PROXY, false),
  // An escape hatch for a deliberate plain-HTTP deployment, e.g. behind a
  // tunnel that terminates TLS and forwards. Off unless someone asks.
  allowInsecurePublicUrl: bool(env.ALLOW_INSECURE_PUBLIC_URL, false),

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

  // Desk phones fetch their configuration from this platform, so a handset with
  // nothing on it can be brought up by MAC alone: Option 66 (or the phone's
  // provisioning URL field) points here, and the phone asks for its own file.
  // `telno.tel` is the address printed in the console, and the SIP domain a
  // handset registers against.
  provisioning: {
    enabled: bool(env.PROVISIONING_ENABLED, true),
    baseUrl: String(env.PROVISIONING_URL || 'http://telno.tel').replace(/\/+$/, ''),
    sipDomain: (env.PROVISIONING_SIP_DOMAIN || env.SIP_DOMAIN || 'telno.tel').toLowerCase(),
    sipPort: int(env.PROVISIONING_SIP_PORT, 5060),
    // A device that has never checked in still gets a config once its MAC is in
    // the inventory; this token gates the public endpoint so a stranger cannot
    // enumerate extensions by guessing MAC addresses.
    requireToken: bool(env.PROVISIONING_REQUIRE_TOKEN, false),
  },

  // Fax. Cantus has no T.38 and no in-band modem signalling by design, so a fax
  // cannot be terminated by this switch: it needs a T.38 gateway on the trunk,
  // which is the one place a PSTN protocol still exists. Off by default, and the
  // console says why rather than offering a button that cannot work.
  fax: {
    enabled: bool(env.FAX_ENABLED, false),
    // Where the fax engine is, when there is one. Cantus carries voice only, so
    // a fax needs a machine that terminates the modem: `FAX_ENGINE_URL` is the
    // IAX2 + iaxmodem + HylaFAX box that does it, and `FAX_GATEWAY` is the
    // older T.38-on-the-trunk route. Exactly one of them, or neither, and the
    // Fax screen says which.
    engineUrl: String(env.FAX_ENGINE_URL || '').replace(/\/+$/, ''),
    engineToken: env.FAX_ENGINE_TOKEN || '',
    transport: String(env.FAX_TRANSPORT || '').toLowerCase(),
    // Where received documents wait to be ingested, and where an outbound
    // document is staged before the switch sends it.
    dir: env.FAX_DIR || '',
    t38: bool(env.FAX_T38, false),
    // Cantus address of the T.38 gateway that actually terminates faxes on the
    // trunk, e.g. `fax@gateway.telno.local`. Empty means sending is refused with
    // that reason instead of being queued forever.
    gateway: env.FAX_GATEWAY || '',
    maxRate: int(env.FAX_MAX_RATE, 14400),
    minRate: int(env.FAX_MIN_RATE, 2400),
    // The station ID the receiving machine prints, and the header on a send.
    stationId: env.FAX_STATION_ID || 'Telno',
    maxPages: Math.max(1, int(env.FAX_MAX_PAGES, 50)),
    // How often the platform looks for documents the switch has finished with.
    sweepSeconds: Math.max(5, int(env.FAX_SWEEP_SECONDS, 15)),
  },

  telephony: {
    enabled: bool(env.TELEPHONY_ENABLED, true),
    // The Cantus switch's control API. Telephony is one JSON API and one
    // WebSocket now: the switch can run beside this container, on another host,
    // or behind a proxy, and every ring event arrives the same way.
    url: String(env.CANTUS_URL || 'http://127.0.0.1:8088').replace(/\/+$/, ''),
    token: env.CANTUS_CONTROL_TOKEN || '',
    // The dialling domain. Every address the switch answers for is
    // `<line>@<domain>`: it is what a call is routed by and what the console
    // prints, so it has to be a name and not a container id.
    domain: (env.CANTUS_DOMAIN || env.SIP_DOMAIN || env.PROVISIONING_SIP_DOMAIN || 'telno.local').toLowerCase(),
    // Where the generated routing document and line inventory are written. The
    // switch reads the same directory, so a restart of either side converges.
    configDir: env.CANTUS_CONFIG_DIR || '',
    // Routes the platform does not own but must not drop. The composition root
    // (christ) writes the AI plane's dial plan here — the DID's office-hours and
    // after-hours branches, the agent extensions, the outbound pattern — and
    // this generator prepends them to its own. Without it, the first settings
    // save in the console re-sends a document with no agent in it, and the
    // receptionist stops answering without anything on either side changing.
    extraRoutes: env.CANTUS_ROUTES_EXTRA || '',
    reloadOnApply: bool(env.CANTUS_RELOAD, true),
    /** No switch on this machine: apply changes locally and say so, never lie. */
    simulate: bool(env.TELEPHONY_SIMULATE, false),
  },

  // The required first login: terms, details, a proved address and phone, and a
  // line. On by default — an install that skips it is one that cannot prove who
  // agreed to what — and switchable off for a deployment that runs its own
  // onboarding in front of this one.
  onboarding: {
    required: bool(env.ONBOARDING_REQUIRED, true),
  },

  // Browser softphone: the platform mints the session, the switch carries the
  // media. There is no SDP, no ICE and no port range: one WebSocket carries
  // signalling and 20 ms PCM frames, and NAT traversal is the protocol's job.
  softphone: {
    enabled: bool(env.SOFTPHONE_ENABLED, true),
    // Where the browser opens its socket. Same origin by default: the console
    // proxies to the switch, so the browser is on the certificate it already
    // trusts and the switch is never exposed to the internet.
    socketUrl: env.SOFTPHONE_SOCKET_URL || '/softphone/line',
    proxy: bool(env.SOFTPHONE_PROXY, true),
    // Only a split deployment (browser talks to the switch directly) sets this.
    directUrl: env.SOFTPHONE_DIRECT_URL || '',
    video: bool(env.SOFTPHONE_VIDEO, false),
    // A ticket is single-use and short-lived: it bootstraps one WebSocket.
    ticketTtlSec: Math.max(15, int(env.SOFTPHONE_TICKET_TTL, 120)),
    // Where the switch writes call recordings (shared with this container).
    recordingDir: env.CANTUS_RECORD_DIR || '/data/recordings',
    // Media is 8 kHz mono PCM16 in 20 ms frames; the client is told the codec
    // so it can refuse to negotiate anything the switch does not carry.
    codec: 'pcm-s16/8000/1',
    frameMs: 20,
  },

  // Voice on the line, not in a vendor. Recognition runs in the browser (Web
  // Speech API) or in the native app (SFSpeechRecognizer), so it costs nothing
  // per minute; the voiceprint that can be required before a session is computed
  // here from the audio the browser sends.
  voice: {
    recognition: bool(env.VOICE_RECOGNITION_ENABLED, true),
    authEnabled: bool(env.VOICE_AUTH_ENABLED, true),
    // Cosine similarity, 0..1. Higher rejects more impostors and more of the
    // owner; the enrollment screen reports the spread it saw so it can be tuned.
    threshold: (() => {
      const value = Number(env.VOICEPRINT_THRESHOLD || 0.82);
      return Number.isFinite(value) && value > 0.5 && value < 0.999 ? value : 0.82;
    })(),
    // How long a passed check is good for, and therefore how long a session is
    // trusted without asking again.
    ticketTtlSec: Math.max(30, int(env.VOICEPRINT_TICKET_TTL, 300)),
    minSeconds: Math.max(1, int(env.VOICEPRINT_MIN_SECONDS, 1)),
    maxSeconds: Math.max(2, int(env.VOICEPRINT_MAX_SECONDS, 20)),
    // Per line, per hour: a voiceprint is a check, not a guessing game.
    attemptsPerHour: Math.max(3, int(env.VOICEPRINT_ATTEMPTS_PER_HOUR, 20)),
  },

  // Apple push for the native SCIF app. A VoIP push is the only thing that can
  // make a locked iPhone ring in CallKit, and it is free: APNs charges nothing,
  // the .p8 comes from the developer account this deployment already has.
  apns: {
    enabled: bool(env.APNS_ENABLED, false),
    keyId: env.APNS_KEY_ID || '',
    teamId: env.APNS_TEAM_ID || '',
    // The .p8 lives on the data volume; the env form is for hosts without one.
    keyPath: env.APNS_KEY_PATH || '',
    key: (env.APNS_KEY || '').replace(/\\n/g, String.fromCharCode(10)),
    bundleId: env.APNS_BUNDLE_ID || 'us.innotel.scif',
    // A VoIP push goes to <bundle>.voip, not to the app's own topic.
    topicSuffix: env.APNS_TOPIC_SUFFIX || '.voip',
    environment: env.APNS_ENVIRONMENT === 'production' ? 'production' : 'development',
    // Overridable so a test can point the sender at a local stub.
    host: env.APNS_HOST || '',
    // Ring a locked phone when the switch says its line is ringing.
    ringOnDial: bool(env.APNS_RING_ON_DIAL, true),
  },

  // Parking. A call that rings a phone in somebody's pocket cannot be joined by
  // that phone while the switch is still ringing the desk, so the call needs
  // somewhere to wait with a name the app can dial back.
  //
  // The routing document still reserves `7XXX` for retrieval, but the lot
  // itself is not implemented on the Cantus switch yet — so this is off by
  // default rather than advertised and absent. Turning it on changes nothing
  // until the switch grows a park action; see `docs/telephony.md`.
  parking: {
    enabled: bool(env.PARKING_ENABLED, false),
    // Slots live in 7000-7999 because the dialplan retrieves one by dialing
    // _7XXX; a lot outside that range could not be reached from a phone.
    lot: (env.PARKING_LOT || 'telno').replace(/[^A-Za-z0-9_]/g, '') || 'telno',
    start: Math.min(7999, Math.max(7000, int(env.PARKING_START, 7001))),
    end: Math.min(7999, Math.max(7000, int(env.PARKING_END, 7099))),
    // How long the desk phone and an open browser ring before the call is parked
    // for the pocket phone: answer locally and parking never happens.
    ringSeconds: Math.min(45, Math.max(5, int(env.PARKING_RING_SECONDS, 12))),
    // How long a parked caller waits for a phone to pick it up before the line's
    // voicemail answers instead.
    timeoutSeconds: Math.min(300, Math.max(10, int(env.PARKING_TIMEOUT, 35))),
    mohClass: (env.PARKING_MOH || 'default').replace(/[^A-Za-z0-9_.-]/g, '') || 'default',
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
    // ...and the console channel is the one case where that holds in production
    // too: the message is written to the log and nothing is sent, so a fresh
    // install whose only delivery channel is the console would have no way to
    // finish its own first login. A code that was never transmitted is not a
    // secret from the account that asked for it. Set
    // DEV_EXPOSE_VERIFICATION_CODES=false to switch this off as well.
    exposeSimulatedCodes: bool(env.DEV_EXPOSE_VERIFICATION_CODES, true),
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

    // Rent on the bill. A number's monthly cost is recorded in the ledger by the
    // rental sweep; this switch decides whether it also becomes a line on the
    // account's invoice. Turning it off leaves the ledger intact.
    rentInvoicing: bool(env.RENT_INVOICING_ENABLED, true),
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

  // The number provider. DIDs are searched, bought and released through VoIP.ms.
  // Its API password is separate from the portal password and belongs in the
  // vault (Settings → Vault) on a deployment that has one; the values here are
  // the .env-only fallback and the defaults an order is placed with.
  voipms: {
    // Overridable so a test can point the client at a local stub.
    apiUrl: String(env.VOIPMS_API_URL || 'https://voip.ms/api/v1/rest.php'),
    apiUsername: env.VOIPMS_API_USERNAME || '',
    apiPassword: env.VOIPMS_API_PASSWORD || '',
    // Where a newly bought DID rings: a routing string such as
    // `account:100001_telno`. Empty means every order has to name one.
    routing: env.VOIPMS_ROUTING || '',
    // The DID verification codes are texted from. Empty means the first DID
    // bought through the console is used; the vault value wins over this one.
    smsDid: env.VOIPMS_SMS_DID || '',
    pop: int(env.VOIPMS_POP, 1),
    // 1 = per minute, 2 = flat monthly. Flat is what an unlimited plan sells.
    billingType: int(env.VOIPMS_BILLING_TYPE, 2),
    dialTime: int(env.VOIPMS_DIAL_TIME, 60),
    cnam: bool(env.VOIPMS_CNAM, false),
    // What the DID costs us a month, in minor units. Stored on the number so the
    // bill can answer for it; 0 means "not priced yet", not "free".
    monthlyCostCents: int(env.VOIPMS_DID_MONTHLY_CENTS, 0),
    currency: (env.VOIPMS_CURRENCY || 'USD').toUpperCase(),
    timeoutMs: int(env.VOIPMS_TIMEOUT_MS, 15000),
  },

  // Backups of everything the data volume holds. The database is dumped with
  // `VACUUM INTO` rather than copied, so a running instance produces a
  // consistent snapshot without stopping the platform.
  backup: {
    enabled: bool(env.BACKUP_ENABLED, true),
    // 0 turns the schedule off; the API and the CLI still work.
    intervalHours: Math.max(0, int(env.BACKUP_INTERVAL_HOURS, 24)),
    // How many archives to keep. One is a mistake waiting to happen: the good
    // copy and the bad state can be the same file.
    keep: Math.max(1, int(env.BACKUP_KEEP, 7)),
    dir: env.BACKUP_DIR || '',
  },

  // The language model behind grading, campaign suggestions and the operations
  // autopilot. Any OpenAI-compatible gateway works; the key belongs in the
  // vault (Settings → Vault → LLM_API_KEY), the environment is the fallback.
  ai: {
    enabled: bool(env.AI_ENABLED, true),
    baseUrl: (env.LLM_BASE_URL || 'https://gateway.innotel.us/v1').replace(/\/+$/, ''),
    model: env.LLM_MODEL || 'gpt-4o-mini',
    timeoutMs: Math.max(3000, int(env.LLM_TIMEOUT_MS, 30000)),
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
    // Which provider texts: voipms, twilio, or empty for "whoever is ready".
    smsProvider: String(env.SMS_PROVIDER || '').toLowerCase(),
    smtpUrl: env.SMTP_URL || '',
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
  },
};

// No switch address means no switch: a dev laptop applying a configuration gets
// a written document and a clear "not applied", never a silent failure.
if (!config.telephony.simulate && !config.telephony.url) {
  config.telephony.simulate = true;
}

/**
 * A production boot refuses to start on the settings that quietly become
 * incidents: a password every reader of this repository knows, or an insecure
 * public URL on a hostname that is actually reachable.
 *
 * Local development is left alone deliberately — `PUBLIC_URL=http://localhost`
 * is not a mistake, it is a laptop — which is why the URL check looks at the
 * host and not just the scheme.
 */
const DEMO_PASSWORDS = new Set([
  'telno-demo-owner',
  'telno-demo',
  'password',
  'password123',
  'administrator',
  'changeme',
  'letmein',
  'admin',
  'telno',
  'test1234',
]);

/** Loopback, and the RFC1918 ranges plus their IPv6 equivalents. */
function isPrivateHost(host) {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!name) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  if (name === '::1' || name.startsWith('fe80:') || name.startsWith('fc') || name.startsWith('fd')) return true;
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Problems that must stop a production boot, as a list of human sentences. */
export function productionProblems() {
  const problems = [];
  if (!config.isProd) return problems;

  const supplied = (process.env.ADMIN_PASSWORD || '').trim();
  if (supplied) {
    if (DEMO_PASSWORDS.has(supplied.toLowerCase())) {
      problems.push('ADMIN_PASSWORD is a known default — choose one that is not in this repository');
    } else if (supplied.length < 12) {
      problems.push(`ADMIN_PASSWORD is ${supplied.length} characters — production requires at least 12`);
    }
  }

  if (!config.allowInsecurePublicUrl) {
    try {
      const url = new URL(config.publicUrl);
      if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
        problems.push(
          `PUBLIC_URL is http:// on ${url.hostname} — sessions are marked secure in production, so sign-in over plain HTTP would fail; use https:// or set ALLOW_INSECURE_PUBLIC_URL=true`
        );
      }
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: ${config.publicUrl}`);
    }
  }

  return problems;
}

export function assertConfig() {
  if (config.isProd && !config.sessionSecret) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  const problems = productionProblems();
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
  if (!config.sessionSecret) {
    // Deterministic per-process fallback so local dev works without a .env.
    config.sessionSecret = `dev-only-${config.port}-not-for-production`;
  }
  if (!config.apiKeyPepper) config.apiKeyPepper = config.sessionSecret;
}
