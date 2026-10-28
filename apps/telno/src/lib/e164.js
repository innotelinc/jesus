import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from 'libphonenumber-js/min';
import { config } from '../config.js';

/**
 * E.164 is the canonical key for the entire platform: extensions point at it,
 * trunks dial it, listings attach to it, calls reference it. Everything that
 * enters the system passes through here first, so "+1 (415) 555-0123",
 * "14155550123" and "+14155550123" all collapse to one row.
 */

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

const TYPE_MAP = {
  MOBILE: 'mobile',
  FIXED_LINE: 'fixed',
  FIXED_LINE_OR_MOBILE: 'unknown',
  TOLL_FREE: 'tollfree',
  PREMIUM_RATE: 'premium',
  VOIP: 'voip',
  SHARED_COST: 'unknown',
  PERSONAL_NUMBER: 'unknown',
  PAGER: 'unknown',
  UAN: 'unknown',
  VOICEMAIL: 'unknown',
};

const fail = (reason, extra = {}) => ({ ok: false, valid: false, reason, ...extra });

/** Split a trailing extension off the input: "x12", "ext 12", "#12", ",12". */
function splitExtension(raw) {
  const match = raw.match(/(?:\s*(?:,|x|ext\.?|extension|#)\s*)(\d{1,6})\s*$/i);
  if (!match) return { body: raw, ext: '' };
  const body = raw.slice(0, match.index);
  if (body.replace(/\D/g, '').length < 6) return { body: raw, ext: '' };
  return { body, ext: match[1] };
}

export function normalizeNumber(input, opts = {}) {
  const defaultCountry = String(opts.defaultCountry || config.defaultCountry || 'US').toUpperCase();
  if (input === null || input === undefined) return fail('empty');

  let raw = String(input).trim();
  if (!raw) return fail('empty');

  const { body, ext } = splitExtension(raw);
  let candidate = body.trim();
  // "00" is the international prefix in most of the world; rewrite it as "+".
  if (!candidate.startsWith('+') && /^00[1-9]/.test(candidate.replace(/\D/g, ''))) {
    candidate = '+' + candidate.replace(/\D/g, '').slice(2);
  }
  // A trailing extension sometimes arrives as a bare ", " separator.
  if (!candidate.replace(/\D/g, '')) return fail('no-digits');

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return fail('unparseable', { input: String(input) });

  const valid = parsed.isValid();
  const possible = valid || parsed.isPossible();
  if (!possible) {
    // Parseable as a number but structurally impossible (too short, bad prefix).
    return fail('invalid-number', { national: parsed.formatNational() });
  }

  return {
    ok: true,
    e164: parsed.number,
    country: parsed.country || '',
    countryName: parsed.country ? regionNames.of(parsed.country) : '',
    dial: parsed.countryCallingCode,
    nsn: parsed.nationalNumber,
    ext,
    valid,
    possible,
    lineType: TYPE_MAP[parsed.getType() || ''] || 'unknown',
    international: parsed.formatInternational(),
    national: parsed.formatNational(),
    reason: valid ? null : possible ? 'possible-not-valid' : 'invalid-number',
  };
}

/** Pretty international form. Falls back to the raw value when unparseable. */
export function formatNumber(value) {
  const parsed = parsePhoneNumberFromString(String(value || ''));
  return parsed ? parsed.formatInternational() : String(value || '');
}

export function isE164(value) {
  return /^\+[1-9]\d{3,14}$/.test(String(value || ''));
}

export function splitE164(value) {
  const parsed = parsePhoneNumberFromString(String(value || ''));
  if (!parsed) return { dial: '', nsn: String(value || '').replace(/\D/g, ''), country: undefined };
  return { dial: parsed.countryCallingCode, nsn: parsed.nationalNumber, country: parsed.country };
}

/** Public display for listings that must not expose the full number. */
export function maskNumber(value) {
  const { dial, nsn } = splitE164(value);
  if (!nsn) return 'Private number';
  const keep = Math.min(2, nsn.length);
  return `+${dial} ${'•'.repeat(Math.max(0, nsn.length - keep))}${nsn.slice(-keep)}`;
}

/** ISO country list with dial codes, for pickers and the public country index. */
export function countryList() {
  return getCountries()
    .map((iso) => {
      let dial = '';
      try {
        dial = String(getCountryCallingCode(iso));
      } catch {
        dial = '';
      }
      return { iso, dial, name: regionNames.of(iso) || iso };
    })
    .filter((c) => c.dial)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function countryByIso(iso) {
  const key = String(iso || '').toUpperCase();
  if (!key) return undefined;
  let dial = '';
  try {
    dial = String(getCountryCallingCode(key));
  } catch {
    return undefined;
  }
  return { iso: key, dial, name: regionNames.of(key) || key };
}

export function countryForE164(value) {
  return splitE164(value).country;
}
