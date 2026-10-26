import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { normalizeNumber, countryList, maskNumber, formatNumber } from '../lib/e164.js';
import { resolveNumber, addListing, searchDirectory, directoryStats, normalizeName, isOptedOut } from '../lib/registry.js';
import { newOtpCode, otpHash } from '../lib/security.js';
import { deliverVerification, channelStatus } from '../lib/channels.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import * as v from '../lib/validate.js';

const KIND_LIST = ['person', 'business', 'service', 'government', 'emergency'];

const domainView = (row) => ({
  slug: row.slug,
  host: row.host,
  label: row.label,
  tagline: row.tagline,
  accent: row.accent,
  scope: row.scope,
});

function publicSubmission(row) {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    number: row.e164,
    channel: row.verify_channel,
    target: row.verify_target ? maskTarget(row.verify_target) : '',
    expiresAt: row.code_expires_at,
    createdAt: row.created_at,
  };
}

const maskTarget = (target) =>
  target.includes('@')
    ? target.replace(/^(.).*(@.*)$/, (_, a, b) => `${a}•••${b}`)
    : maskNumber(target);

export default async function directoryRoutes(app) {
  // ---------------------------------------------------------------- public --
  app.get('/public/domains', async () => ({
    canonical: config.directory.canonical,
    domains: db_.all('SELECT * FROM domains WHERE enabled = 1 ORDER BY sort_order, host').map(domainView),
  }));

  app.get('/public/stats', async () => ({
    ...directoryStats(),
    domains: db_.all('SELECT COUNT(*) AS n FROM domains WHERE enabled = 1').at(0)?.n || 0,
    channel: channelStatus(),
  }));

  app.get('/public/countries', async (request, reply) => {
    reply.header('cache-control', 'public, max-age=86400');
    return { countries: countryList() };
  });

  app.get(
    '/public/search',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const query = request.query || {};
      const result = searchDirectory({
        q: v.str(query.q, { name: 'q', max: 120, required: false }),
        country: v.str(query.country, { name: 'country', max: 2, required: false }).toUpperCase(),
        kind: v.str(query.kind, { name: 'kind', max: 20, required: false }),
        domain: v.str(query.domain, { name: 'domain', max: 120, required: false }),
        limit: v.integer(query.limit, { name: 'limit', min: 1, max: 60, required: false, fallback: 20 }),
        offset: v.integer(query.offset, { name: 'offset', min: 0, max: 5000, required: false, fallback: 0 }),
      });
      return result;
    }
  );

  app.get('/public/lookup', async (request) => {
    const raw = v.str(request.query?.number, { name: 'number', max: 40 });
    const parsed = normalizeNumber(raw);
    if (!parsed.ok) throw badRequest(`That does not look like a phone number (${parsed.reason})`);
    if (isOptedOut(parsed.e164)) return { found: false, parsed };
    const row = db_.get('SELECT * FROM numbers WHERE e164 = ? AND visibility <> ?', [parsed.e164, 'private']);
    if (!row) return { found: false, parsed };
    return { found: true, parsed, entry: entryView(row) };
  });

  app.get('/public/number/:e164', async (request) => {
    const parsed = normalizeNumber(request.params.e164);
    if (!parsed.ok) throw badRequest('Not a valid phone number');
    if (isOptedOut(parsed.e164)) throw notFound('No public listing for this number');
    const row = db_.get('SELECT * FROM numbers WHERE e164 = ? AND visibility <> ?', [parsed.e164, 'private']);
    if (!row) throw notFound('No public listing for this number');
    return { entry: entryView(row) };
  });

  function entryView(row) {
    const listings = db_.all('SELECT * FROM listings WHERE number_id = ? ORDER BY name', [row.id]);
    const masked = row.visibility === 'unlisted';
    return {
      numberId: row.id,
      display: masked ? maskNumber(row.e164) : requestSafeFormat(row.e164),
      e164: masked ? null : row.e164,
      country: row.country,
      region: row.region,
      lineType: row.line_type,
      verifiedAt: row.verified_at,
      trust: row.trust_score,
      masked,
      listings: listings.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        category: l.category,
        city: l.city,
        country: l.country || row.country,
        website: l.website,
        languages: l.languages ? l.languages.split(',').filter(Boolean) : [],
        tags: l.tags ? l.tags.split(',').filter(Boolean) : [],
        verified: !!l.verified_at,
      })),
    };
  }

  const requestSafeFormat = (e164) => {
    const parsed = normalizeNumber(e164);
    return parsed.ok ? parsed.international : e164;
  };

  // ----------------------------------------------------------- submissions --
  app.post(
    '/public/submissions',
    { config: { rateLimit: { max: config.directory.submissionLimitPerHour, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = request.body || {};

      // Honeypot: real people never fill the hidden field. Answer normally so
      // bots do not learn they were caught.
      if (v.str(body.company_url, { name: 'company_url', max: 200, required: false })) {
        return { id: null, status: 'received', message: 'Thanks — your submission is queued for review.' };
      }

      const parsed = normalizeNumber(v.str(body.number, { name: 'number', max: 40 }));
      if (!parsed.ok) {
        throw badRequest(`That does not look like a phone number. Check the country code (${parsed.reason}).`);
      }
      if (isOptedOut(parsed.e164)) {
        // Do not reveal the opt-out, do not create anything.
        return { id: null, status: 'received', message: 'Thanks — your submission is queued for review.' };
      }

      const channel = v.oneOf(body.channel || 'email', ['email', 'sms'], 'channel');
      const target =
        channel === 'email'
          ? v.email(body.email, { name: 'email' })
          : normalizeNumber(v.str(body.phone || body.number, { name: 'phone', max: 40 })).e164;

      const name = v.str(body.name, { name: 'name', max: 160 });
      const nameNorm = normalizeName(name);
      const existingNumber = db_.get('SELECT * FROM numbers WHERE e164 = ?', [parsed.e164]);
      const duplicate =
        existingNumber &&
        db_.get('SELECT id FROM listings WHERE number_id = ? AND name_norm = ?', [existingNumber.id, nameNorm]);

      const id = newId('sub_');
      const record = {
        kind: v.oneOf(body.kind || 'business', KIND_LIST, 'kind'),
        category: v.str(body.category, { name: 'category', max: 80, required: false }),
        address: v.str(body.address, { name: 'address', max: 200, required: false }),
        city: v.str(body.city, { name: 'city', max: 80, required: false }),
        country: v.str(body.country, { name: 'country', max: 2, required: false }).toUpperCase() || parsed.country || '',
        website: v.url(body.website),
        languages: v.csvList(body.languages),
        tags: v.csvList(body.tags),
        notes: v.str(body.notes, { name: 'notes', max: 1000, required: false }),
        domain: db_.get('SELECT slug FROM domains WHERE slug = ?', [v.str(body.domain, { name: 'domain', max: 120, required: false })])
          ?.slug,
      };

      if (duplicate) {
        db_.run(
          `INSERT INTO submissions (id, e164, number_id, name, kind, category, address, city, country,
             website, email, languages, tags, notes, domain_slug, status, verify_channel, verify_target, reviewed_at, review_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'duplicate', ?, ?, ?, ?)`,
          [
            id,
            parsed.e164,
            existingNumber.id,
            name,
            record.kind,
            record.category,
            record.address,
            record.city,
            record.country,
            record.website,
            channel === 'email' ? target : '',
            record.languages,
            record.tags,
            record.notes,
            record.domain || null,
            channel,
            target,
            now(),
            `Matched existing listing for ${parsed.e164}`,
          ]
        );
        logEvent({ actor: 'public', action: 'directory.submission_duplicate', subject: parsed.e164, ip: request.ip });
        return {
          id,
          status: 'duplicate',
          duplicate: true,
          message:
            'This number and name are already in the directory. If you need a correction or removal, use the opt-out form.',
        };
      }

      const code = newOtpCode();
      const expiresAt = new Date(Date.now() + config.directory.otpTtlSeconds * 1000).toISOString();

      db_.run(
        `INSERT INTO submissions (id, e164, number_id, name, kind, category, address, city, country,
           website, email, languages, tags, notes, domain_slug, status, verify_channel, verify_target,
           code_hash, code_expires_at, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_verification', ?, ?, ?, ?, ?)`,
        [
          id,
          parsed.e164,
          existingNumber?.id || null,
          name,
          record.kind,
          record.category,
          record.address,
          record.city,
          record.country,
          record.website,
          channel === 'email' ? target : '',
          record.languages,
          record.tags,
          record.notes,
          record.domain || null,
          channel,
          target,
          otpHash(code, id),
          expiresAt,
          '',
        ]
      );

      const delivery = await deliverVerification({
        channel,
        to: target,
        code,
        submission: { id, name, e164: parsed.e164 },
      });

      reply.status(201);
      return {
        id,
        status: 'awaiting_verification',
        duplicate: false,
        channel,
        target: maskTarget(target),
        expiresAt,
        delivered: delivery.delivered,
        message:
          channel === 'email'
            ? `We sent a 6-digit code to ${maskTarget(target)}.`
            : `We sent a 6-digit code by SMS to ${maskTarget(target)}.`,
        ...(config.directory.devExposeCodes && delivery.simulated ? { devCode: code } : {}),
      };
    }
  );

  app.post(
    '/public/submissions/:id/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request) => {
      const row = db_.get('SELECT * FROM submissions WHERE id = ?', [request.params.id]);
      if (!row) throw notFound('Submission not found');
      if (row.status === 'verified' || row.status === 'approved') {
        return { status: row.status, alreadyVerified: true, message: 'This submission is already verified.' };
      }
      if (row.status !== 'awaiting_verification') {
        throw conflict(`This submission cannot be verified (status: ${row.status})`);
      }
      if (row.code_expires_at && row.code_expires_at < now()) {
        db_.run("UPDATE submissions SET status = 'expired' WHERE id = ?", [row.id]);
        throw conflict('That code expired. Submit the listing again to get a fresh one.');
      }
      if (row.attempts >= config.directory.otpMaxAttempts) {
        db_.run("UPDATE submissions SET status = 'expired' WHERE id = ?", [row.id]);
        throw conflict('Too many incorrect codes. Submit the listing again.');
      }

      const code = v.str(request.body?.code, { name: 'code', max: 10 }).replace(/\D/g, '');
      db_.run('UPDATE submissions SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      if (code.length !== 6 || otpHash(code, row.id) !== row.code_hash) {
        const left = config.directory.otpMaxAttempts - (row.attempts + 1);
        throw badRequest(`That code is not correct. ${Math.max(0, left)} attempt(s) left.`);
      }

      db_.run("UPDATE submissions SET status = 'verified', code_hash = NULL WHERE id = ?", [row.id]);
      logEvent({ actor: 'public', action: 'directory.submission_verified', subject: row.e164, ip: request.ip });
      return {
        status: 'verified',
        message: 'Number verified. Your listing is now queued for review — most reviews finish within one business day.',
      };
    }
  );

  app.get('/public/submissions/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const row = db_.get('SELECT * FROM submissions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Submission not found');
    return { submission: publicSubmission(row) };
  });

  app.post(
    '/public/optout',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request) => {
      const parsed = normalizeNumber(v.str(request.body?.number, { name: 'number', max: 40 }));
      if (!parsed.ok) throw badRequest('Enter the number to remove, including the country code');
      const reason = v.str(request.body?.reason, { name: 'reason', max: 300, required: false });
      db_.run('INSERT INTO optouts (e164, reason) VALUES (?, ?) ON CONFLICT (e164) DO UPDATE SET reason = excluded.reason', [
        parsed.e164,
        reason,
      ]);
      db_.run('UPDATE numbers SET visibility = ?, updated_at = ? WHERE e164 = ?', ['private', now(), parsed.e164]);
      logEvent({ actor: 'public', action: 'directory.optout', subject: parsed.e164, ip: request.ip });
      // Same answer whether or not the number was listed, so opt-out itself
      // cannot be used to confirm that a number is in the registry.
      return { ok: true, message: 'If this number was listed, it has been removed from public view.' };
    }
  );

  // ----------------------------------------------------------- moderation --
  app.get('/submissions', { preHandler: app.authenticate }, async (request) => {
    const status = v.str(request.query?.status, { name: 'status', max: 30, required: false });
    const limit = v.integer(request.query?.limit, { name: 'limit', min: 1, max: 100, required: false, fallback: 50 });
    const rows = status
      ? db_.all('SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, limit])
      : db_.all('SELECT * FROM submissions ORDER BY created_at DESC LIMIT ?', [limit]);
    const counts = db_.all('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status');
    return {
      items: rows.map((row) => ({
        ...row,
        display: formatNumber(row.e164),
        notes: row.notes,
        matches: row.number_id
          ? db_.all('SELECT name, kind FROM listings WHERE number_id = ?', [row.number_id]).map((l) => `${l.name} (${l.kind})`)
          : [],
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    };
  });

  app.post('/submissions/:id/approve', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const row = db_.get('SELECT * FROM submissions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Submission not found');
    if (row.status === 'approved') return { ok: true, alreadyApproved: true };
    if (row.status !== 'verified') throw conflict('Only verified submissions can be approved');

    const resolved = resolveNumber(row.e164, { source: 'submission', status: 'active' });
    const listing = addListing(resolved.id, {
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
      domainSlug: row.domain_slug,
      verified: true,
    });

    const stamp = now();
    db_.run(
      "UPDATE submissions SET status = 'approved', number_id = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
      [resolved.id, request.account.email, stamp, v.str(request.body?.note, { name: 'note', max: 300, required: false }), row.id]
    );
    db_.run('UPDATE numbers SET status = ?, verified_at = COALESCE(verified_at, ?), trust_score = MIN(100, trust_score + 20), updated_at = ? WHERE id = ?', [
      'active',
      stamp,
      stamp,
      resolved.id,
    ]);

    logEvent({
      actor: request.account.email,
      action: 'directory.submission_approved',
      subject: row.e164,
      detail: JSON.stringify({ listing: listing.id, created: listing.created }),
      ip: request.ip,
    });

    const number = db_.get('SELECT * FROM numbers WHERE id = ?', [resolved.id]);
    return {
      ok: true,
      listing: { id: listing.id, created: listing.created },
      number: { id: number.id, e164: number.e164, status: number.status, visibility: number.visibility },
    };
  });

  app.post('/submissions/:id/reject', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const row = db_.get('SELECT * FROM submissions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Submission not found');
    const note = v.str(request.body?.note, { name: 'note', max: 300, required: false, fallback: 'No reason given' });
    db_.run(
      "UPDATE submissions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
      [request.account.email, now(), note, row.id]
    );
    logEvent({ actor: request.account.email, action: 'directory.submission_rejected', subject: row.e164, detail: note, ip: request.ip });
    return { ok: true };
  });

  app.get('/optouts', { preHandler: app.authenticate }, async () => ({
    items: db_.all('SELECT * FROM optouts ORDER BY created_at DESC LIMIT 200'),
  }));

  /** Reverses an opt-out made in error. The number becomes public again. */
  app.delete('/optouts/:e164', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const parsed = normalizeNumber(request.params.e164);
    if (!parsed.ok) throw badRequest('Not a valid phone number');
    const removed = db_.run('DELETE FROM optouts WHERE e164 = ?', [parsed.e164]);
    db_.run('UPDATE numbers SET visibility = ?, updated_at = ? WHERE e164 = ? AND visibility = ?', [
      'public',
      now(),
      parsed.e164,
      'private',
    ]);
    logEvent({ actor: request.account.email, action: 'directory.optout_reversed', subject: parsed.e164, ip: request.ip });
    return { ok: true, restored: removed.changes > 0 };
  });
}
