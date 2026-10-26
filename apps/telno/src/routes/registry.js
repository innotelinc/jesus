import { db_, now } from '../db/index.js';
import { normalizeNumber, formatNumber } from '../lib/e164.js';
import { resolveNumber, addListing, listingsFor, mergeNumbers, normalizeName } from '../lib/registry.js';
import { notFound, badRequest } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';

const numberView = (row, extra = {}) => ({
  id: row.id,
  e164: row.e164,
  display: formatNumber(row.e164),
  country: row.country,
  national: row.national,
  ext: row.ext,
  lineType: row.line_type,
  carrier: row.carrier,
  region: row.region,
  timezone: row.timezone,
  status: row.status,
  visibility: row.visibility,
  trust: row.trust_score,
  verifiedAt: row.verified_at,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...extra,
});

const listingView = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  category: row.category,
  address: row.address,
  city: row.city,
  country: row.country,
  website: row.website,
  email: row.email,
  languages: row.languages,
  tags: row.tags,
  domain: row.domain_slug,
  verifiedAt: row.verified_at,
  updatedAt: row.updated_at,
});

function readListing(body) {
  return {
    name: v.str(body.name, { name: 'name', max: 160 }),
    kind: v.oneOf(body.kind || 'business', ['person', 'business', 'service', 'government', 'emergency'], 'kind'),
    category: v.str(body.category, { name: 'category', max: 80, required: false }),
    address: v.str(body.address, { name: 'address', max: 200, required: false }),
    city: v.str(body.city, { name: 'city', max: 80, required: false }),
    country: v.str(body.country, { name: 'country', max: 2, required: false }).toUpperCase(),
    website: v.url(body.website),
    email: v.email(body.email, { required: false }),
    languages: v.csvList(body.languages),
    tags: v.csvList(body.tags),
    domainSlug: v.str(body.domain, { name: 'domain', max: 120, required: false }),
  };
}

export default async function registryRoutes(app) {
  // Reads need registry:read; anything that changes data needs registry:write.
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });

  app.get('/numbers', async (request) => {
    const query = request.query || {};
    const limit = v.integer(query.limit, { name: 'limit', min: 1, max: 100, required: false, fallback: 25 });
    const page = v.integer(query.page, { name: 'page', min: 1, max: 10000, required: false, fallback: 1 });
    const search = v.str(query.q, { name: 'q', max: 120, required: false });
    const country = v.str(query.country, { name: 'country', max: 2, required: false }).toUpperCase();
    const status = v.str(query.status, { name: 'status', max: 20, required: false });

    const where = [];
    const params = [];
    if (country) {
      where.push('n.country = ?');
      params.push(country);
    }
    if (status) {
      where.push('n.status = ?');
      params.push(status);
    }
    if (search) {
      const digits = search.replace(/\D/g, '');
      const like = `%${search.toLowerCase()}%`;
      if (digits.length >= 3) {
        where.push('(n.e164 LIKE ? OR l.name_norm LIKE ?)');
        params.push(`%${digits}%`, like);
      } else {
        where.push('l.name_norm LIKE ?');
        params.push(like);
      }
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db_.all(
      `SELECT n.*, l.id AS listing_id, l.name AS listing_name, l.kind AS listing_kind,
              l.category AS listing_category, l.city AS listing_city,
              e.extension AS extension
         FROM numbers n
         LEFT JOIN listings l ON l.number_id = n.id
         LEFT JOIN extensions e ON e.number_id = n.id
         ${clause}
        GROUP BY n.id
        ORDER BY n.updated_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    const total =
      db_.get(
        `SELECT COUNT(DISTINCT n.id) AS n FROM numbers n LEFT JOIN listings l ON l.number_id = n.id ${clause}`,
        params
      )?.n || 0;

    return {
      items: rows.map((row) =>
        numberView(row, {
          name: row.listing_name || '',
          kind: row.listing_kind || '',
          category: row.listing_category || '',
          city: row.listing_city || '',
          extension: row.extension || '',
          listingCount: db_.get('SELECT COUNT(*) AS n FROM listings WHERE number_id = ?', [row.id]).n,
        })
      ),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  });

  app.post('/numbers', async (request, reply) => {
    const body = request.body || {};
    const resolved = resolveNumber(body.number, {
      visibility: body.visibility ? v.oneOf(body.visibility, ['public', 'unlisted', 'private'], 'visibility') : undefined,
      lineType: body.lineType,
      carrier: v.str(body.carrier, { name: 'carrier', max: 80, required: false }),
      region: v.str(body.region, { name: 'region', max: 120, required: false }),
      source: 'operator',
    });

    let listing = null;
    if (v.str(body.name, { name: 'name', max: 160, required: false })) {
      listing = addListing(resolved.id, readListing(body));
    }

    logEvent({
      actor: request.account?.email || request.apiKey?.label || 'api',
      action: resolved.created ? 'registry.number_created' : 'registry.number_touched',
      subject: resolved.e164,
      ip: request.ip,
    });

    reply.status(resolved.created ? 201 : 200);
    return {
      number: numberView(resolved.number),
      listing: listing ? listingView(listing.listing) : null,
      created: resolved.created,
      deduplicated: !resolved.created,
      parsed: resolved.parsed.valid === false ? { reason: resolved.parsed.reason, valid: false } : { valid: true },
    };
  });

  app.get('/numbers/:id', async (request) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ? OR e164 = ?', [request.params.id, request.params.id]);
    if (!row) throw notFound('Number not found');
    const extension = db_.get('SELECT * FROM extensions WHERE number_id = ?', [row.id]);
    const calls = db_.all(
      'SELECT * FROM calls WHERE from_number = ? OR to_number = ? ORDER BY started_at DESC LIMIT 10',
      [row.e164, row.e164]
    );
    return {
      number: numberView(row),
      listings: listingsFor(row.id).map(listingView),
      extension: extension ? { id: extension.id, extension: extension.extension, name: extension.display_name } : null,
      calls: calls.map((c) => ({
        id: c.id,
        direction: c.direction,
        from: c.from_number,
        to: c.to_number,
        startedAt: c.started_at,
        duration: c.duration,
        disposition: c.disposition,
      })),
    };
  });

  app.patch('/numbers/:id', async (request) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Number not found');
    const body = request.body || {};
    const patch = {};
    if (body.status !== undefined) {
      patch.status = v.oneOf(body.status, ['registered', 'active', 'reserved', 'ported', 'retired'], 'status');
    }
    if (body.visibility !== undefined) {
      patch.visibility = v.oneOf(body.visibility, ['public', 'unlisted', 'private'], 'visibility');
    }
    if (body.lineType !== undefined) {
      patch.line_type = v.oneOf(body.lineType, ['fixed', 'mobile', 'voip', 'tollfree', 'premium', 'unknown'], 'lineType');
    }
    if (body.carrier !== undefined) patch.carrier = v.str(body.carrier, { name: 'carrier', max: 80, required: false });
    if (body.region !== undefined) patch.region = v.str(body.region, { name: 'region', max: 120, required: false });
    if (body.timezone !== undefined) patch.timezone = v.str(body.timezone, { name: 'timezone', max: 60, required: false });
    if (body.trust !== undefined) patch.trust_score = v.integer(body.trust, { name: 'trust', min: 0, max: 100 });
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE numbers SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    const fresh = db_.get('SELECT * FROM numbers WHERE id = ?', [row.id]);
    logEvent({
      actor: request.account?.email || request.apiKey?.label || 'api',
      action: 'registry.number_updated',
      subject: fresh.e164,
      detail: JSON.stringify(patch),
      ip: request.ip,
    });
    return { number: numberView(fresh) };
  });

  app.post('/numbers/:id/listings', async (request, reply) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Number not found');
    const result = addListing(row.id, readListing(request.body || {}));
    reply.status(result.created ? 201 : 200);
    return { listing: listingView(result.listing), created: result.created, deduplicated: !result.created };
  });

  app.patch('/listings/:id', async (request) => {
    const row = db_.get('SELECT * FROM listings WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Listing not found');
    const body = request.body || {};
    const patch = {};
    if (body.name !== undefined) {
      patch.name = v.str(body.name, { name: 'name', max: 160 });
      patch.name_norm = normalizeName(patch.name);
    }
    for (const [key, column, max] of [
      ['category', 'category', 80],
      ['address', 'address', 200],
      ['city', 'city', 80],
      ['country', 'country', 2],
      ['languages', 'languages', 200],
      ['tags', 'tags', 200],
    ]) {
      if (body[key] !== undefined) patch[column] = v.str(body[key], { name: key, max, required: false });
    }
    if (body.kind !== undefined) {
      patch.kind = v.oneOf(body.kind, ['person', 'business', 'service', 'government', 'emergency'], 'kind');
    }
    if (body.website !== undefined) patch.website = v.url(body.website);
    if (body.email !== undefined) patch.email = v.email(body.email, { required: false });
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE listings SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    logEvent({ actor: request.account?.email || 'api', action: 'registry.listing_updated', subject: row.id, ip: request.ip });
    return { listing: listingView(db_.get('SELECT * FROM listings WHERE id = ?', [row.id])) };
  });

  app.delete('/listings/:id', async (request) => {
    const row = db_.get('SELECT * FROM listings WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Listing not found');
    db_.run('DELETE FROM listings WHERE id = ?', [row.id]);
    logEvent({ actor: request.account?.email || 'api', action: 'registry.listing_deleted', subject: row.id, ip: request.ip });
    return { ok: true };
  });

  app.delete('/numbers/:id', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Number not found');
    db_.tx(() => {
      db_.run('DELETE FROM numbers WHERE id = ?', [row.id]);
    });
    logEvent({ actor: request.account.email, action: 'registry.number_deleted', subject: row.e164, ip: request.ip });
    return { ok: true, deleted: row.e164 };
  });

  app.post('/numbers/merge', async (request) => {
    const body = request.body || {};
    const into = v.str(body.into, { name: 'into', max: 60 });
    const from = v.str(body.from, { name: 'from', max: 60 });
    const result = mergeNumbers(into, from, request.account?.email || 'api', v.str(body.reason, { name: 'reason', max: 200, required: false }));
    logEvent({ actor: request.account?.email || 'api', action: 'registry.numbers_merged', subject: result.merged, detail: JSON.stringify({ into }), ip: request.ip });
    return { number: numberView(result.into), merged: result.merged };
  });

  app.post('/numbers/:id/verify', async (request) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Number not found');
    const stamp = now();
    db_.run('UPDATE numbers SET verified_at = ?, trust_score = MIN(100, trust_score + 15), updated_at = ? WHERE id = ?', [
      stamp,
      stamp,
      row.id,
    ]);
    db_.run('UPDATE listings SET verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE number_id = ?', [stamp, stamp, row.id]);
    logEvent({ actor: request.account?.email || 'api', action: 'registry.number_verified', subject: row.e164, ip: request.ip });
    return { number: numberView(db_.get('SELECT * FROM numbers WHERE id = ?', [row.id])) };
  });

  /** Quick check used by the UI before creating a number. */
  app.get('/numbers/lookup/:value', async (request) => {
    const parsed = normalizeNumber(request.params.value);
    if (!parsed.ok) return { found: false, parsed };
    const row = db_.get('SELECT * FROM numbers WHERE e164 = ?', [parsed.e164]);
    return {
      found: !!row,
      parsed,
      number: row ? numberView(row, { listings: listingsFor(row.id).map(listingView) }) : null,
    };
  });
}
