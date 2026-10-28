import { db_, now } from '../db/index.js';
import { config } from '../config.js';

/**
 * White-label branding.
 *
 * The product name, the vendor behind it, the accent color and the logo are
 * rows, not constants: a deployment that resells this platform needs its own
 * name on the marketing site, the console, the signup page and the report it
 * emails — without a fork or an image rebuild.
 *
 * Stored in the existing `settings` table so there is no second place to look,
 * and read through one function so every surface agrees on the name.
 */

const KEYS = {
  name: 'brand.name',
  vendor: 'brand.vendor',
  tagline: 'brand.tagline',
  description: 'brand.description',
  accent: 'brand.accent',
  logoUrl: 'brand.logo_url',
  supportEmail: 'brand.support_email',
  salesEmail: 'brand.sales_email',
  domain: 'brand.domain',
  footerNote: 'brand.footer_note',
};

export const BRAND_DEFAULTS = {
  name: 'Telno',
  vendor: 'Innotel Labs',
  tagline: 'Business phones that answer, dial and grade themselves.',
  description:
    'One number for calls, fax, text and video. Voice agents that pick up and call out. Campaigns whose calls are graded against their own goal, with the report in your inbox.',
  accent: '#6f66ff',
  logoUrl: '',
  supportEmail: '',
  salesEmail: '',
  domain: '',
  footerNote: 'One registry, many doors.',
};

const readAll = () => {
  const rows = db_.all("SELECT key, value FROM settings WHERE key LIKE 'brand.%'");
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return map;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The effective brand: stored values over the defaults, never empty strings. */
export function brand() {
  const stored = readAll();
  const pick = (key, fallback) => {
    const value = stored.get(KEYS[key]);
    return value === undefined || value === '' ? fallback : value;
  };
  const accent = pick('accent', BRAND_DEFAULTS.accent);
  return {
    name: pick('name', BRAND_DEFAULTS.name),
    vendor: pick('vendor', BRAND_DEFAULTS.vendor),
    tagline: pick('tagline', BRAND_DEFAULTS.tagline),
    description: pick('description', BRAND_DEFAULTS.description),
    accent: HEX.test(accent) ? accent : BRAND_DEFAULTS.accent,
    logoUrl: pick('logoUrl', BRAND_DEFAULTS.logoUrl),
    supportEmail: pick('supportEmail', BRAND_DEFAULTS.supportEmail),
    salesEmail: pick('salesEmail', BRAND_DEFAULTS.salesEmail),
    domain: pick('domain', BRAND_DEFAULTS.domain),
    footerNote: pick('footerNote', BRAND_DEFAULTS.footerNote),
  };
}

/** What a public page needs: everything except anything internal. */
export const publicBrand = () => {
  const value = brand();
  return {
    ...value,
    // The signup host is part of the brand story, but the URL is deployment
    // configuration, not branding.
    subscribeUrl: config.subscribeUrl || '/subscribe',
  };
};

const write = (key, value) =>
  db_.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, String(value ?? '')]
  );

/**
 * Save a brand edit. Only known fields are written, and an accent that is not a
 * six-digit hex is refused rather than rendered into a stylesheet — a color is
 * injected into CSS, which is exactly where a free-form string does damage.
 */
export function saveBrand(payload = {}) {
  const errors = [];
  const text = (value, name, max) => {
    if (value === undefined) return undefined;
    const trimmed = String(value).trim();
    if (trimmed.length > max) {
      errors.push(`${name} is longer than ${max} characters`);
      return undefined;
    }
    return trimmed;
  };

  const next = {
    name: text(payload.name, 'name', 40),
    vendor: text(payload.vendor, 'vendor', 60),
    tagline: text(payload.tagline, 'tagline', 160),
    description: text(payload.description, 'description', 600),
    accent: payload.accent === undefined ? undefined : String(payload.accent).trim(),
    logoUrl: text(payload.logoUrl, 'logoUrl', 500),
    supportEmail: text(payload.supportEmail, 'supportEmail', 160),
    salesEmail: text(payload.salesEmail, 'salesEmail', 160),
    domain: text(payload.domain, 'domain', 120),
    footerNote: text(payload.footerNote, 'footerNote', 160),
  };

  if (next.accent !== undefined && next.accent !== '' && !HEX.test(next.accent)) {
    errors.push('accent must be a six-digit hex color such as #6f66ff');
  }
  if (next.logoUrl) {
    try {
      const url = new URL(next.logoUrl);
      if (!['http:', 'https:'].includes(url.protocol)) errors.push('logoUrl must be an http(s) URL');
    } catch {
      errors.push('logoUrl must be a full http(s) URL');
    }
  }
  if (errors.length) return { ok: false, errors };

  for (const [field, key] of Object.entries(KEYS)) {
    if (next[field] !== undefined) write(key, next[field]);
  }
  write('brand.updated_at', now());
  return { ok: true, brand: brand() };
}

/** Seed the defaults once, so the settings table is never ambiguous. */
export function seedBrand() {
  const stored = readAll();
  for (const [field, key] of Object.entries(KEYS)) {
    if (stored.has(key)) continue;
    write(key, BRAND_DEFAULTS[field]);
  }
}
