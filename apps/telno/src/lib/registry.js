import { db_, newId, now } from '../db/index.js';
import { normalizeNumber, maskNumber, formatNumber } from './e164.js';
import { badRequest, notFound } from './errors.js';

/**
 * Dedupe rules, in order of strength:
 *  1. E.164 string  — the hard key. Two inputs that normalize to the same
 *     number are the same registry row, always.
 *  2. (number, normalized name) — one listing per entity per number.
 *  3. (number, name, kind) on submissions — a resubmission is not a new record.
 * Merchants that change names are updated in place, never duplicated.
 */

const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'ab', 'as', 'oy', 'oyj', 'aps', 'pty',
  'plc', 'srl', 'spa', 'kk', 'kg', 'ug', 'pvt', 'private', 'group', 'holdings',
]);

/** Stable comparison key for an entity name. */
export function normalizeName(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words[0] === 'the' && words.length > 1) words.shift();
  return words.join(' ');
}

export function resolveNumber(input, meta = {}, opts = {}) {
  const parsed = typeof input === 'object' && input.e164 ? input : normalizeNumber(input, opts);
  if (!parsed.ok) {
    throw badRequest(`"${input}" is not a usable phone number (${parsed.reason})`, {
      reason: parsed.reason,
      expected: parsed.expected,
    });
  }
  const e164 = parsed.e164;
  const existing = db_.get('SELECT * FROM numbers WHERE e164 = ?', [e164]);

  if (existing) {
    // Fill in blanks from better data, but never overwrite operator edits.
    const patch = {};
    const fill = (column, value) => {
      if (!existing[column] && value) patch[column] = value;
    };
    fill('country', parsed.country);
    fill('national', parsed.national);
    fill('line_type', parsed.lineType && parsed.lineType !== 'unknown' ? parsed.lineType : '');
    fill('region', meta.region);
    fill('carrier', meta.carrier);
    fill('timezone', meta.timezone);
    if (meta.visibility) patch.visibility = meta.visibility;
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      db_.run(`UPDATE numbers SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), existing.id]);
    }
    return { id: existing.id, e164, created: false, number: { ...existing, ...patch }, parsed };
  }

  const id = newId('num_');
  const valid = parsed.valid !== false;
  db_.run(
    `INSERT INTO numbers
       (id, e164, country, national, line_type, carrier, region, timezone,
        status, visibility, trust_score, source, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      e164,
      parsed.country || '',
      parsed.national || '',
      meta.lineType || parsed.lineType || 'unknown',
      meta.carrier || '',
      meta.region || '',
      meta.timezone || '',
      meta.status || (valid ? 'registered' : 'reserved'),
      meta.visibility || 'public',
      Number.isFinite(meta.trustScore) ? meta.trustScore : valid ? 55 : 25,
      meta.source || 'manual',
      null,
    ]
  );
  return {
    id,
    e164,
    created: true,
    number: db_.get('SELECT * FROM numbers WHERE id = ?', [id]),
    parsed,
  };
}

/**
 * Attach an entity to a number. Returns the existing listing when the same
 * entity is already registered against the same number.
 */
export function addListing(numberId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw badRequest('A listing needs a name');
  const nameNorm = normalizeName(name);
  if (!nameNorm) throw badRequest('Listing name has no searchable characters');

  const duplicate = db_.get('SELECT * FROM listings WHERE number_id = ? AND name_norm = ?', [numberId, nameNorm]);
  if (duplicate) return { id: duplicate.id, created: false, listing: duplicate };

  const id = newId('lst_');
  const domain = sanitizeDomain(data.domainSlug);
  db_.run(
    `INSERT INTO listings
       (id, number_id, name, name_norm, kind, category, address, city, country,
        website, email, languages, tags, domain_slug, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      numberId,
      name,
      nameNorm,
      data.kind || 'business',
      data.category || '',
      data.address || '',
      data.city || '',
      data.country || '',
      data.website || '',
      data.email || '',
      data.languages || '',
      data.tags || '',
      domain,
      data.verified ? now() : null,
    ]
  );
  return { id, created: true, listing: db_.get('SELECT * FROM listings WHERE id = ?', [id]) };
}

function sanitizeDomain(slug) {
  if (!slug) return null;
  const row = db_.get('SELECT slug FROM domains WHERE slug = ?', [String(slug)]);
  return row ? row.slug : null;
}

export function getNumberByE164(e164) {
  return db_.get('SELECT * FROM numbers WHERE e164 = ?', [String(e164)]);
}

export function listingsFor(numberId) {
  return db_.all('SELECT * FROM listings WHERE number_id = ? ORDER BY name', [numberId]);
}

export function isOptedOut(e164) {
  return !!db_.get('SELECT 1 FROM optouts WHERE e164 = ?', [String(e164)]);
}

/** Merge a duplicate registry row into the canonical one. */
export function mergeNumbers(intoId, fromId, actor = 'system', reason = '') {
  if (intoId === fromId) throw badRequest('Cannot merge a number into itself');
  const into = db_.get('SELECT * FROM numbers WHERE id = ?', [intoId]);
  const from = db_.get('SELECT * FROM numbers WHERE id = ?', [fromId]);
  if (!into || !from) throw notFound('Number row not found');
  if (into.e164 === from.e164) throw badRequest('Both rows already share one E.164 key');

  db_.tx(() => {
    const listings = db_.all('SELECT * FROM listings WHERE number_id = ?', [fromId]);
    for (const listing of listings) {
      const clash = db_.get('SELECT id FROM listings WHERE number_id = ? AND name_norm = ?', [intoId, listing.name_norm]);
      if (clash) {
        db_.run('DELETE FROM listings WHERE id = ?', [listing.id]);
      } else {
        db_.run('UPDATE listings SET number_id = ? WHERE id = ?', [intoId, listing.id]);
      }
    }
    db_.run('UPDATE extensions SET number_id = ? WHERE number_id = ?', [intoId, fromId]);
    db_.run('UPDATE submissions SET number_id = ? WHERE number_id = ?', [intoId, fromId]);
    db_.run('DELETE FROM numbers WHERE id = ?', [fromId]);
    db_.run('INSERT INTO merges (into_id, from_id, reason, actor) VALUES (?, ?, ?, ?)', [
      intoId,
      fromId,
      reason,
      actor,
    ]);
  });

  return { into: db_.get('SELECT * FROM numbers WHERE id = ?', [intoId]), merged: from.e164 };
}

const PUBLIC_FILTER = `
  AND NOT EXISTS (SELECT 1 FROM optouts o WHERE o.e164 = n.e164)
  AND n.visibility <> 'private'
`;

/**
 * Public directory search. Digit queries hit the number index; text queries
 * hit the FTS5 index. Both return the same shape so the UI stays simple.
 */
export function searchDirectory({ q = '', country = '', kind = '', domain = '', limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const digits = String(q).replace(/[^\d]/g, '');
  const looksNumeric = digits.length >= 4 && /^[\d+\s().-]+$/.test(String(q).trim());

  const filters = [];
  const params = [];

  if (country) {
    filters.push('n.country = ?');
    params.push(String(country).toUpperCase());
  }
  if (kind) {
    filters.push('l.kind = ?');
    params.push(String(kind));
  }
  if (domain) {
    filters.push('(l.domain_slug = ? OR l.domain_slug IS NULL)');
    params.push(String(domain));
  }

  let sql;
  if (looksNumeric) {
    sql = `
      SELECT l.id, l.name, l.kind, l.category, l.city, l.country AS listing_country,
             l.website, l.languages, l.tags, l.verified_at,
             n.id AS number_id, n.e164, n.country, n.visibility, n.trust_score AS trust,
             n.line_type, n.carrier
        FROM numbers n
        JOIN listings l ON l.number_id = n.id
       WHERE n.e164 LIKE ? ${PUBLIC_FILTER} ${filters.map((f) => `AND ${f}`).join(' ')}
       ORDER BY n.trust_score DESC, l.name
       LIMIT ? OFFSET ?`;
    params.unshift(`%${digits}%`);
    params.push(safeLimit, safeOffset);
  } else {
    const terms = String(q)
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    if (!terms.length) return { results: [], total: 0, mode: 'browse' };
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
    sql = `
      SELECT l.id, l.name, l.kind, l.category, l.city, l.country AS listing_country,
             l.website, l.languages, l.tags, l.verified_at,
             n.id AS number_id, n.e164, n.country, n.visibility, n.trust_score AS trust,
             n.line_type, n.carrier
        FROM listing_search s
        JOIN listings l ON l.rowid = s.rowid
        JOIN numbers n ON n.id = l.number_id
       WHERE listing_search MATCH ? ${PUBLIC_FILTER} ${filters.map((f) => `AND ${f}`).join(' ')}
       ORDER BY n.trust_score DESC, rank
       LIMIT ? OFFSET ?`;
    params.unshift(match);
    params.push(safeLimit, safeOffset);
  }

  let rows;
  try {
    rows = db_.all(sql, params);
  } catch {
    // FTS can reject a query shape it dislikes; stay available rather than 500.
    return { results: [], total: 0, mode: 'error' };
  }

  return {
    results: rows.map(publicRow),
    total: rows.length,
    mode: looksNumeric ? 'number' : 'text',
  };
}

function publicRow(row) {
  return {
    id: row.id,
    numberId: row.number_id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    city: row.city,
    country: row.listing_country || row.country,
    website: row.website,
    languages: row.languages ? row.languages.split(',').filter(Boolean) : [],
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    lineType: row.line_type,
    carrier: row.carrier,
    trust: row.trust,
    verified: !!row.verified_at,
    e164: row.visibility === 'unlisted' ? null : row.e164,
    display: row.visibility === 'unlisted' ? maskNumber(row.e164) : formatNumber(row.e164),
    masked: row.visibility === 'unlisted',
  };
}

export function directoryStats() {
  const one = (sql, params = []) => db_.get(sql, params) || {};
  return {
    numbers: one('SELECT COUNT(*) AS n FROM numbers').n || 0,
    listings: one('SELECT COUNT(*) AS n FROM listings').n || 0,
    countries: one("SELECT COUNT(DISTINCT country) AS n FROM numbers WHERE country <> ''").n || 0,
    verified: one('SELECT COUNT(*) AS n FROM listings WHERE verified_at IS NOT NULL').n || 0,
    pending: one("SELECT COUNT(*) AS n FROM submissions WHERE status IN ('verified','awaiting_verification')").n || 0,
    approved: one("SELECT COUNT(*) AS n FROM submissions WHERE status = 'approved'").n || 0,
    optouts: one('SELECT COUNT(*) AS n FROM optouts').n || 0,
    updatedAt: one('SELECT MAX(updated_at) AS t FROM numbers').t || null,
  };
}
