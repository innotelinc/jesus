import { badRequest } from './errors.js';

const isNil = (v) => v === undefined || v === null || v === '';

export function str(value, opts = {}) {
  const { name = 'value', min = 0, max = 500, required = true, lower = false, pattern, fallback = '' } = opts;
  if (isNil(value)) {
    if (required) throw badRequest(`${name} is required`);
    return fallback;
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${name} must be text`);
  let out = String(value).trim();
  if (lower) out = out.toLowerCase();
  if (out.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (out.length > max) out = out.slice(0, max);
  if (pattern && !pattern.test(out)) throw badRequest(`${name} is not in the expected format`);
  return out;
}

export function integer(value, opts = {}) {
  const { name = 'value', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = true, fallback = 0 } = opts;
  if (isNil(value)) {
    if (required) throw badRequest(`${name} is required`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  return Math.min(Math.max(Math.round(n), min), max);
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function oneOf(value, allowed, name = 'value') {
  const out = String(value ?? '').trim();
  if (!allowed.includes(out)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return out;
}

export function email(value, { name = 'email', required = true } = {}) {
  if (isNil(value)) {
    if (required) throw badRequest(`${name} is required`);
    return '';
  }
  const out = String(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out) || out.length > 254) throw badRequest(`${name} is not a valid address`);
  return out;
}

export function url(value, { name = 'website', required = false } = {}) {
  if (isNil(value)) {
    if (required) throw badRequest(`${name} is required`);
    return '';
  }
  const out = String(value).trim();
  if (out.length > 300) throw badRequest(`${name} is too long`);
  if (!out) return '';
  const candidate = /^https?:\/\//i.test(out) ? out : `https://${out}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw badRequest(`${name} must be a valid web address`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw badRequest(`${name} must use http or https`);
  return parsed.toString();
}

export function csvList(value, { max = 12, itemMax = 40 } = {}) {
  if (isNil(value)) return '';
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items
    .map((item) => String(item).trim().slice(0, itemMax))
    .filter(Boolean)
    .slice(0, max)
    .join(',');
}
