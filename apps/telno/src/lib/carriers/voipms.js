import { config } from '../../config.js';
import { getSecret } from '../vault.js';
import { normalizeNumber, formatNumber } from '../e164.js';
import { HttpError } from '../errors.js';

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
 *    lives in the vault (Settings → Vault) so it can be rotated without a
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

/** A provider failure is not this platform's fault, and says so with 502. */
const providerError = (message, details) => new HttpError(502, 'provider_error', message, details);

const notConfigured = () =>
  new HttpError(
    409,
    'not_configured',
    'VoIP.ms is not connected. Add the API username and API password in Settings → Vault (or VOIPMS_API_USERNAME and VOIPMS_API_PASSWORD in the environment).'
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
 * `search_type` is starts / contains / ends, and the query is the area code (or
 * any run of digits) an operator is looking for. US searches are scoped by state
 * and Canadian ones by province, which is what the provider's two methods take.
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
    search_type: searchType,
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
  const target = routing || config.voipms.routing;
  if (!target) {
    throw new HttpError(
      400,
      'routing_required',
      'VoIP.ms needs to know where the DID rings. Set VOIPMS_ROUTING (for example account:100001_telno) or pass a routing value with the order.'
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
    defaults: {
      routing: config.voipms.routing,
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
