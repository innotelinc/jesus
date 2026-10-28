import { config } from '../../config.js';
import { db_ } from '../../db/index.js';
import { getSecret } from '../vault.js';
import { normalizeNumber, formatNumber } from '../e164.js';
import { HttpError, badRequest } from '../errors.js';

/**
 * The number provider.
 *
 * A DID is not something this platform invents: it is bought from a carrier,
 * routed to the switch, and paid for every month until it is released. VoIP.ms
 * is that carrier here, and this module is the whole of our contact with it.
 *
 * The wire format is one GET per call: `rest.php?api_username=…&api_password=…&
 * method=…&<params>`, answering a JSON envelope whose `status` is `success` or a
 * reason. Two consequences matter:
 *
 *  - The API password is a *separate* credential from the portal password. It
 *    lives in the vault (Settings → Numbers from VoIP.ms) so it can be rotated without a
 *    redeploy, and the env values are only the .env-only fallback.
 *  - VoIP.ms only answers allow-listed source addresses. Their `getIP` method is
 *    the one exception, so an operator who sees `invalid_ip` is told exactly
 *    which address to add rather than being left guessing.
 *
 * Nothing here writes to the database. Ordering, pricing and releasing are the
 * route's business; this file answers what the provider says.
 */

const USER_KEY = 'VOIPMS_API_USERNAME';
const PASS_KEY = 'VOIPMS_API_PASSWORD';
const ROUTING_KEY = 'VOIPMS_ROUTING';

/**
 * Where a newly bought DID rings.
 *
 * Three places, in order of preference: the value sent with the order, then the
 * vault, then the environment. The vault in the middle is the point — it is where
 * Settings → Numbers from VoIP.ms writes, so a routing target typed in the console takes effect
 * on the next order. Reading the environment alone meant a DID bought from the
 * console could not be routed at all until the container was redeployed.
 */
export const voipmsRouting = () => getSecret(ROUTING_KEY) || config.voipms.routing;

/** A provider failure is not this platform's fault, and says so with 502. */
const providerError = (message, details) => new HttpError(502, 'provider_error', message, details);

const notConfigured = () =>
  new HttpError(
    409,
    'not_configured',
    'VoIP.ms is not connected. Add the API username and API password in Settings → Numbers from VoIP.ms (or VOIPMS_API_USERNAME and VOIPMS_API_PASSWORD in the environment).'
  );

function credentials() {
  return {
    username: getSecret(USER_KEY) || config.voipms.apiUsername || '',
    password: getSecret(PASS_KEY) || config.voipms.apiPassword || '',
  };
}

const sourceOf = (name, fallback) => (getSecret(name) ? 'vault' : fallback ? 'environment' : '');

export const voipmsConfigured = () => {
  const { username, password } = credentials();
  return !!(username && password);
};

/** Fail with 409, not a 500, when a write needs a provider that is not set up. */
export function assertConfigured() {
  if (!voipmsConfigured()) throw notConfigured();
}

/**
 * The DID as the provider spells it: digits, with the NANP country code
 * stripped. `+1 415 555 0123` is `4155550123`; anything else keeps its digits.
 */
export function providerDid(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** The provider's own status strings, in words an operator can act on. */
function explain(status, method) {
  const hints = {
    invalid_credentials: 'The API username or API password is wrong. Both come from Main Menu → SOAP & REST/JSON API in the VoIP.ms portal, and the API password is not the portal password.',
    invalid_ip: 'This server\'s address is not allow-listed for the VoIP.ms API. Add it under Main Menu → SOAP & REST/JSON API → API IP address.',
    insufficient_funds: 'The VoIP.ms account balance is too low to buy this number. Top it up and try again.',
    did_not_found: 'The provider does not hold that DID any more.',
    did_already_ordered: 'That DID is already on the VoIP.ms account.',
    no_dids: '',
    no_charges: '',
  };
  const hint = hints[status];
  if (hint !== undefined) return hint;
  return `VoIP.ms refused ${method}: ${status}`;
}

const isEmpty = (status) =>
  ['no_dids', 'no_charges', 'no_recordings', 'no_sms', 'no_mms', 'no_voicemails', 'not_found'].includes(status);

async function call(method, params = {}) {
  const { username, password } = credentials();
  if (!username || !password) throw notConfigured();

  const query = new URLSearchParams({ api_username: username, api_password: password, method });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(`${config.voipms.apiUrl}?${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.voipms.timeoutMs),
    });
  } catch (err) {
    throw providerError(`Could not reach VoIP.ms: ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw providerError(`VoIP.ms answered HTTP ${response.status}`, { body: text.slice(0, 400) });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML error page means the request never reached the API: usually a
    // proxy in front of the container, or a wrong VOIPMS_API_URL.
    throw providerError('VoIP.ms did not answer JSON — check VOIPMS_API_URL and any proxy in front of the platform');
  }

  const status = String(body.status || '');
  if (status !== 'success' && !isEmpty(status)) {
    throw providerError(explain(status, method), { status, method });
  }
  return status === 'success' ? body : { ...body, status };
}

/** A DID from a search result, normalized into this platform's canonical form. */
function searchView(entry, country) {
  const raw = typeof entry === 'string' ? entry : entry?.did ?? entry?.number ?? '';
  const parsed = normalizeNumber(String(raw), { defaultCountry: country });
  if (!parsed.ok) return null;
  const extra = typeof entry === 'object' && entry ? entry : {};
  return {
    e164: parsed.e164,
    national: parsed.national,
    display: formatNumber(parsed.e164),
    country: parsed.country || country,
    region: extra.ratecenter || extra.rate_center || extra.state || extra.province || '',
    lineType: 'voip',
    currency: config.voipms.currency,
    monthlyCostCents: config.voipms.monthlyCostCents,
  };
}

/**
 * Available DIDs, by area code or prefix.
 *
 * The parameter is `type` — starts, contains or ends — and the API refuses the
 * whole search with `missing_type` when it is absent. It was sent as
 * `search_type`, which reads like the field name and is not one: every search
 * on a live account failed with that refusal until it was corrected here.
 *
 * US searches are scoped by state and Canadian ones by province, which is what
 * the provider's two methods take.
 */
export async function searchNumbers({ country = 'US', region = '', query = '', searchType = 'starts', limit = 25 } = {}) {
  const iso = String(country || 'US').toUpperCase();
  const method = iso === 'CA' ? 'searchDIDsCAN' : iso === 'US' ? 'searchDIDsUSA' : '';
  if (!method) {
    throw new HttpError(
      400,
      'unsupported_country',
      'DIDs are bought in the United States and Canada. Use an existing number for any other country.'
    );
  }

  const body = await call(method, {
    [iso === 'CA' ? 'province' : 'state']: region ? String(region).toUpperCase() : undefined,
    type: searchType,
    query: String(query || '').trim(),
  });

  const rows = Array.isArray(body.dids) ? body.dids : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const view = searchView(row, iso);
    if (!view || seen.has(view.e164)) continue;
    seen.add(view.e164);
    items.push(view);
    if (items.length >= Math.max(1, Math.min(200, limit))) break;
  }
  return { items, country: iso, region: String(region || '').toUpperCase(), query: String(query || ''), searchType };
}

/** Order one DID. Returns the provider's record of it. */
export async function orderNumber(e164, { routing = '', pop, dialTime, cnam, billingType, note = '' } = {}) {
  const did = providerDid(e164);
  const target = routing || voipmsRouting();
  if (!target) {
    throw new HttpError(
      400,
      'routing_required',
      'VoIP.ms needs to know where the DID rings. Store VOIPMS_ROUTING in Settings → Numbers from VoIP.ms (for example account:100001_telno), or pass a routing value with the order.'
    );
  }

  const body = await call('orderDID', {
    did,
    routing: target,
    pop: pop ?? config.voipms.pop,
    dial_time: dialTime ?? config.voipms.dialTime,
    cnam: (cnam ?? config.voipms.cnam) ? 1 : 0,
    billing_type: billingType ?? config.voipms.billingType,
    note,
  });
  return { did, routing: target, raw: body };
}

/* --------------------------------------------------------------------- sms -- */

const SMS_FROM_KEY = 'VOIPMS_SMS_DID';

/**
 * Which DID a text comes from.
 *
 * A verification code is one message to one handset, and the sender has to be a
 * number this platform actually holds with SMS switched on. The vault names it
 * when an operator cares which one; otherwise the first DID bought through the
 * console is used, which is what an install holding a single number ends up
 * with anyway. `source` is reported so the console can say where it came from
 * rather than implying the choice was deliberate.
 */
export function smsFrom() {
  const stored = getSecret(SMS_FROM_KEY);
  if (stored) return { did: stored, source: 'vault' };
  const environment = String(config.voipms.smsDid || '');
  if (environment) return { did: environment, source: 'environment' };
  const row = db_.get(
    "SELECT e164 FROM numbers WHERE provider = 'voipms' AND released_at IS NULL ORDER BY COALESCE(rented_at, '') , created_at LIMIT 1"
  );
  return row ? { did: row.e164, source: 'number' } : { did: '', source: 'none' };
}

/**
 * VoIP.ms texts US and Canadian numbers, written as NANPA (10 digits) or E.164.
 * The API call takes NANPA, so a +1 is stripped and anything else is refused in
 * this platform's own words rather than sent to be rejected by the carrier.
 */
const smsDestination = (number) => {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return '';
};

/**
 * One text, from this platform's own DID.
 *
 * `did`, `dst` and `message` are the whole of the provider's contract here; the
 * message ceiling is 160 characters, and a code is far shorter than that. A
 * longer notice is refused instead of being cut in half, because a truncated
 * code is worse than no text at all.
 */
export async function sendSmsMessage({ to, text, from = '' }) {
  const sender = String(from || smsFrom().did || '');
  const did = providerDid(sender);
  const dst = smsDestination(to);
  if (!did) {
    throw badRequest(
      'No number to text from. Store VOIPMS_SMS_DID in Settings → Text messages — an SMS-enabled DID on the VoIP.ms account.'
    );
  }
  if (!dst) {
    throw badRequest(
      'VoIP.ms texts US and Canadian numbers only. Use the handset in international form, for example +1 415 555 0123.'
    );
  }
  const message = String(text || '');
  if (!message) throw badRequest('A text needs a message');
  if (message.length > 160) throw badRequest('An SMS is limited to 160 characters');

  const body = await call('sendSMS', { did, dst, message });
  return { delivered: true, provider: 'voipms', did, dst, raw: body };
}

/** Release a DID back to the provider. This cannot be undone. */
export async function releaseNumber(e164, { comment = 'Released from the Telno console' } = {}) {
  const did = providerDid(e164);
  const body = await call('cancelDID', { did, cancel_comment: comment });
  return { did, raw: body };
}

/** A single DID as the provider holds it: billing mode, renewal date, SMS. */
export function didView(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const parsed = normalizeNumber(String(entry.did || ''), { defaultCountry: 'US' });
  const billingType = Number(entry.billing_type ?? 0);
  return {
    e164: parsed.ok ? parsed.e164 : '',
    description: entry.description || '',
    routing: entry.routing || '',
    billingType,
    billing: billingType === 1 ? 'per-minute' : billingType === 2 ? 'flat' : 'unknown',
    nextBillingAt: String(entry.next_billing || '').trim() || null,
    smsEnabled: entry.sms_enabled === true || entry.sms_enabled === '1',
    smsAvailable: entry.sms_available === true || entry.sms_available === '1',
    pop: entry.pop ?? null,
  };
}

/** Everything the provider says this account holds. */
export async function inventory() {
  const body = await call('getDIDsInfo');
  const rows = Array.isArray(body.dids) ? body.dids : [];
  return rows.map(didView).filter(Boolean);
}

/** One DID, or null when the provider does not hold it. */
export async function numberInfo(e164) {
  const body = await call('getDIDsInfo', { did: providerDid(e164) });
  const rows = Array.isArray(body.dids) ? body.dids : [];
  return didView(rows[0]) || null;
}

/** The account balance, which is what a purchase is checked against. */
export async function balance() {
  const body = await call('getBalance');
  const raw = body.balance || body;
  const amount = Number(raw.current_balance ?? raw.balance ?? NaN);
  return {
    balanceCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: String(raw.currency || config.voipms.currency).toUpperCase(),
    raw: body,
  };
}

/**
 * Status for the console: whether it is connected, from where, and — only when
 * it is — what the balance is. A disconnected provider is a normal state, not an
 * error, so this never throws for that.
 */
export async function providerStatus() {
  const configured = voipmsConfigured();
  const base = {
    provider: 'voipms',
    label: 'VoIP.ms',
    configured,
    credentials: {
      username: sourceOf(USER_KEY, config.voipms.apiUsername),
      password: sourceOf(PASS_KEY, config.voipms.apiPassword),
    },
    routingSource: getSecret(ROUTING_KEY) ? 'vault' : config.voipms.routing ? 'environment' : '',
    defaults: {
      routing: voipmsRouting(),
      pop: config.voipms.pop,
      billingType: config.voipms.billingType,
      dialTime: config.voipms.dialTime,
      cnam: config.voipms.cnam,
      monthlyCostCents: config.voipms.monthlyCostCents,
      currency: config.voipms.currency,
    },
    reachable: false,
    balanceCents: null,
    currency: config.voipms.currency,
    error: configured ? '' : 'not_configured',
    checkedAt: new Date().toISOString(),
  };

  if (!configured) return base;

  try {
    const info = await balance();
    return { ...base, reachable: true, balanceCents: info.balanceCents, currency: info.currency, error: '' };
  } catch (err) {
    return { ...base, reachable: false, error: err.message, code: err.code || 'provider_error' };
  }
}
