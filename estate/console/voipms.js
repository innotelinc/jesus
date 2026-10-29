/**
 * The one thing this console needs from the VoIP.ms API: the sub-account's
 * encryption setting, read back live and written on request.
 *
 * The carrier owns half of the encryption story. Our gateway decides whether it
 * offers `RTP/SAVP` with an SDES key; the sub-account decides whether it will
 * accept anything else. Flipping one without the other leaves every call refused
 * with `488 Not acceptable here` — in both directions, which reads like a broken
 * gateway. So both halves are read from their source of truth and shown side by
 * side, and the switch changes them together.
 *
 * The API is the legacy REST/JSON one: a GET with the credentials in the query
 * string and `method=` naming the call. It needs an API username/password from
 * the portal (not the sub-account's SIP password) and the box's address on the
 * API allowlist; both failures come back as a status we pass through verbatim
 * rather than a stack trace.
 */

const BASE = process.env.VOIPMS_API_URL || 'https://voip.ms/api/v1/rest.php';
const API_USER = process.env.VOIPMS_API_USERNAME || '';
const API_PASSWORD = process.env.VOIPMS_API_PASSWORD || '';
const SUB_ACCOUNT = process.env.VOIPMS_SUB_ACCOUNT || '';

/**
 * What the portal calls "Encrypted SIP Traffic" (TLS + SRTP on the device).
 * `sip_traffic` is the name the API's `setSubAccount` uses; the read side has
 * been spelled differently over the years, so all of them are checked rather
 * than assuming one.
 */
const ENCRYPTION_KEYS = ['sip_traffic', 'encrypted_sip_traffic', 'encryption'];

/** Fields the API returns but will not accept back as parameters. `id` is not
 * one of them: it is required, and it is how the carrier knows which
 * sub-account the change applies to. */
const READ_ONLY = new Set(['username', 'status', 'protocol']);

const TRUTHY = new Set(['1', 'yes', 'true', 'on', 'y', 'enabled', 'encrypted']);
const FALSY = new Set(['0', 'no', 'false', 'off', 'n', 'disabled', 'plain']);

export const configured = () => Boolean(API_USER && API_PASSWORD && SUB_ACCOUNT);

export const subAccount = () => SUB_ACCOUNT;

/**
 * How long to wait for the carrier.
 *
 * Reading is quick (about a second, occasionally a few). Writing is not:
 * `setSubAccount` sends the whole record back and the carrier has taken forty
 * seconds to answer — long enough that a read-sized deadline reports a timeout
 * for a change that actually landed, leaving the two halves disagreeing and the
 * operator told nothing happened.
 */
const READ_TIMEOUT_MS = Number(process.env.VOIPMS_READ_TIMEOUT_MS || 15000);
const WRITE_TIMEOUT_MS = Number(process.env.VOIPMS_WRITE_TIMEOUT_MS || 90000);

async function call(method, params = {}, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (!configured()) throw new Error('VOIPMS_API_USERNAME, VOIPMS_API_PASSWORD and VOIPMS_SUB_ACCOUNT are not all set');
  const url = new URL(BASE);
  url.searchParams.set('api_username', API_USER);
  url.searchParams.set('api_password', API_PASSWORD);
  url.searchParams.set('method', method);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`voip.ms ${method}: HTTP ${response.status} and no JSON (${text.slice(0, 100)})`);
  }
  if (body.status !== 'success') {
    // `invalid_ip` is the allowlist, and saying so saves a support ticket.
    const hint =
      body.status === 'invalid_ip'
        ? ' — add this box\'s address under Main Menu → SOAP and REST/JSON API in the VoIP.ms portal'
        : body.status === 'invalid_credentials'
          ? ' — the API password is not the portal password; generate one on the same page'
          : '';
    throw new Error(`voip.ms ${method}: ${body.status || `HTTP ${response.status}`}${hint}`);
  }
  return body;
}

/**
 * Does this record answer to the configured name?
 *
 * `getSubAccounts` returns `username` as the bare name (`telno`) and `account`
 * as the prefixed one (`235662_telno`), while a deployment may be configured
 * with either — the SIP credentials use the prefixed form. Comparing only one
 * of them is how the console reported "not in the account" for an account it
 * was looking straight at.
 */
export function matches(entry, wanted) {
  const target = String(wanted || '').toLowerCase();
  if (!target) return false;
  const bare = target.replace(/^\d+_/, '');
  const names = [entry.username, entry.account, entry.id]
    .map((value) => String(value ?? '').toLowerCase())
    .filter(Boolean);
  return names.includes(target) || names.includes(bare);
}

/** The sub-account as the carrier currently holds it, or a reason we cannot see it. */
export async function getSubAccount() {
  const body = await call('getSubAccounts');
  const list = body.sub_accounts || body.subaccounts || body.accounts || [];
  if (!Array.isArray(list) || !list.length) throw new Error('voip.ms returned no sub-accounts');
  const match = list.find((entry) => matches(entry, SUB_ACCOUNT));
  if (!match) {
    const known = list
      .map((entry) => entry.account || entry.username)
      .filter(Boolean)
      .join(', ');
    throw new Error(`sub-account ${SUB_ACCOUNT} is not in the account (it has: ${known || 'none'})`);
  }
  // The API has returned a one-element list in both shapes over time.
  return match;
}

/** true / false / null when the record does not carry a recognisable flag. */
export function readEncryption(record) {
  for (const key of ENCRYPTION_KEYS) {
    if (!(key in record)) continue;
    const value = String(record[key] ?? '').toLowerCase();
    if (TRUTHY.has(value)) return true;
    if (FALSY.has(value)) return false;
    return null;
  }
  return null;
}

/**
 * Every scalar the API handed us, minus the flags we are about to set.
 *
 * `setSubAccount` is not a patch: it wants the whole sub-account back, including
 * the required fields (`auth_type`, `device_type`, `allowed_codecs`, ...).
 * Sending only the difference is what makes a carrier API answer "missing
 * parameter" for a field nobody touched.
 */
export function paramsFor(record, encryption) {
  const params = {};
  for (const [key, value] of Object.entries(record)) {
    if (ENCRYPTION_KEYS.includes(key)) continue;
    if (READ_ONLY.has(key)) continue;
    if (value === null || value === undefined || typeof value === 'object') continue;
    params[key] = value;
  }
  params.sip_traffic = encryption ? '1' : '0';
  return params;
}

/** Set the carrier's side of it and read the record back, so the answer is the carrier's. */
export async function setEncryption(enabled) {
  const record = await getSubAccount();
  const startedAt = Date.now();
  await call('setSubAccount', paramsFor(record, enabled), { timeoutMs: WRITE_TIMEOUT_MS });
  const applied = await getSubAccount();
  // How long the carrier took is the one number that explains a slow switch.
  return { record: applied, ms: Date.now() - startedAt };
}

/**
 * The carrier's live state, shaped for the console.
 *
 * `fields` is only included when the encryption flag could not be recognised:
 * the field name is the one thing that differs between API responses, and
 * guessing silently would report "off" for an account that is encrypted.
 */
export async function state() {
  if (!configured()) {
    return {
      configured: false,
      subAccount: SUB_ACCOUNT || '',
      encryption: null,
      checkedAt: new Date().toISOString(),
      error: 'set VOIPMS_API_USERNAME, VOIPMS_API_PASSWORD and VOIPMS_SUB_ACCOUNT to read and change the sub-account',
    };
  }
  try {
    const record = await getSubAccount();
    const encryption = readEncryption(record);
    return {
      configured: true,
      subAccount: record.account || record.username || SUB_ACCOUNT,
      encryption,
      checkedAt: new Date().toISOString(),
      error: encryption === null ? 'the sub-account record has no encryption flag this console recognises' : '',
      fields: encryption === null ? Object.keys(record) : undefined,
    };
  } catch (error) {
    return {
      configured: true,
      subAccount: SUB_ACCOUNT,
      encryption: null,
      checkedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}
