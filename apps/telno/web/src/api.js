export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the platform. Is the container running?');
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { message: text.slice(0, 200) } };
    }
  }

  if (!res.ok) {
    const error = payload?.error || {};
    throw new ApiError(res.status, error.code || 'error', error.message || `Request failed (${res.status})`, error.details);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
  /** Raw body upload (audio, PDF, images). The file's own type is the header. */
  async putFile(path, file) {
    const res = await fetch(`/api${path}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name || '' },
      body: file,
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const error = payload?.error || {};
      throw new ApiError(res.status, error.code || 'error', error.message || `Upload failed (${res.status})`);
    }
    return payload;
  },
};

export const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : '';
};

/* Fallback formatting only. The API returns a `display` field produced by
   libphonenumber metadata; this is used where only an E.164 string exists. */
const TWO_DIGIT = new Set([
  '20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49',
  '51','52','53','54','55','56','57','58','60','61','62','63','64','65','66',
  '81','82','84','86','90','91','92','93','94','95','98',
]);

export function prettyNumber(value) {
  if (!value) return '';
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits || digits.length < 6) return value;
  const dialLen = digits.startsWith('1') || digits.startsWith('7') ? 1 : TWO_DIGIT.has(digits.slice(0, 2)) ? 2 : 3;
  const dial = digits.slice(0, dialLen);
  const rest = digits.slice(dialLen);
  if (dial === '1' && rest.length === 10) return `+1 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6)}`;
  return `+${dial} ${rest.replace(/(\d{3})(?=\d)/g, '$1 ').trim()}`;
}

export const compactNumber = (n) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

export function relativeTime(value) {
  if (!value) return '—';
  const then = new Date(value.endsWith?.('Z') || value.includes('T') ? value : `${value}Z`);
  const diff = Date.now() - then.getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  return then.toLocaleDateString('en-US');
}

export function duration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

export const clockTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  // 12-hour clock, US style: 3:05 PM rather than 15:05.
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
};

export const checkE164 = (value) => /^\+[1-9]\d{3,14}$/.test(String(value || '').trim());
