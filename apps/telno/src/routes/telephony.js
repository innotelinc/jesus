import { randomBytes } from 'node:crypto';
import { db_, newId, now } from '../db/index.js';
import { formatNumber } from '../lib/e164.js';
import { resolveNumber } from '../lib/registry.js';
import { insertExtension } from '../lib/extensions.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';
import { applyAfterChange, liveChannels } from '../telephony/index.js';

const extensionView = (row) => ({
  id: row.id,
  extension: row.extension,
  displayName: row.display_name,
  email: row.email,
  voicemail: !!row.voicemail,
  dnd: !!row.dnd,
  forwardTo: row.forward_to,
  enabled: !!row.enabled,
  // True only when billing switched this extension off; reinstatement relies on
  // the same flag, so the screen can say why a line is dark.
  suspendedByBilling: !!row.suspended_by_billing,
  // Empty for a platform or staff line, which is every line an operator made
  // before customers could hold one.
  accountId: row.account_id || '',
  accountEmail: row.account_email || '',
  // The secure profile of this line, as the switch applies it.
  scif: !!row.scif,
  callerIdMode: row.caller_id_mode || 'own',
  callerIdNumber: row.caller_id_number || '',
  voiceMask: row.voice_mask || 'off',
  maskText: !!row.mask_text,
  numberId: row.number_id,
  number: row.e164 ? formatNumber(row.e164) : '',
  e164: row.e164 || '',
  secretSet: !!row.secret,
  updatedAt: row.updated_at,
});

const trunkView = (row) => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  host: row.host,
  username: row.username,
  fromUser: row.from_user,
  codecs: row.codecs,
  context: row.context,
  enabled: !!row.enabled,
  hasSecret: !!row.secret,
  updatedAt: row.updated_at,
});

const ivrView = (row) => ({
  id: row.id,
  name: row.name,
  extension: row.extension,
  greeting: row.greeting,
  options: safeParse(row.options),
  timeoutDest: row.timeout_dest,
  enabled: !!row.enabled,
  updatedAt: row.updated_at,
});

function safeParse(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Assign a registry number to a platform object, creating the row if needed. */
function linkNumber(raw) {
  if (!raw) return null;
  const resolved = resolveNumber(raw, { source: 'platform' });
  return resolved.id;
}

export default async function telephonyRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  /**
   * Write the switch configuration and reload it.
   *
   * Every change in this file alters a generated file, so there is no Apply
   * button to forget: a saved change is a live change. The shared helper does
   * the write and reports a failure without rolling the row back, because the
   * row is what commits and the switch is rebuilt from it.
   */
  const syncSwitch = (request) => applyAfterChange(request);

  /**
   * A route whose success rewrites the switch configuration. The handler runs
   * first, so a rejected request never touches the switch, and the reply says
   * whether the change reached it.
   */
  const writeRoute = (method, url, options, handler) =>
    app[method](url, options, async (request, reply) => {
      const result = await handler(request, reply);
      const applied = await syncSwitch(request);
      return applied ? { ...(result || {}), applied } : result;
    });

  // ------------------------------------------------------------ extensions --
  app.get('/extensions', async () => ({
    items: db_
      .all(
        `SELECT e.*, n.e164, a.email AS account_email FROM extensions e
           LEFT JOIN numbers n ON n.id = e.number_id
           LEFT JOIN accounts a ON a.id = e.account_id
          ORDER BY CAST(e.extension AS INTEGER), e.extension`
      )
      .map(extensionView),
  }));

  /** Resolve the account an extension belongs to, by email. */
  function ownerId(raw) {
    const email = v.str(raw, { name: 'account', max: 160, required: false });
    if (!email) return null;
    const target = db_.get('SELECT id FROM accounts WHERE email = ?', [email]);
    if (!target) throw notFound(`No account with the email ${email}`);
    return target.id;
  }

  writeRoute('post', '/extensions', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    // The insert lives in lib/extensions.js so the first-run setup makes a line
    // with the same defaults as this screen does.
    const created = insertExtension({
      extension: v.str(body.extension, { name: 'extension', max: 6, pattern: /^\d{2,6}$/ }),
      displayName: v.str(body.displayName, { name: 'displayName', max: 80 }),
      email: v.email(body.email, { required: false }),
      secret: v.str(body.secret, { name: 'secret', min: 8, max: 64, required: false }),
      voicemail: v.bool(body.voicemail, true),
      dnd: v.bool(body.dnd, false),
      forwardTo: v.str(body.forwardTo, { name: 'forwardTo', max: 10, required: false }),
      enabled: v.bool(body.enabled, true),
      numberId: linkNumber(body.number),
      accountId: ownerId(body.account),
    });
    logEvent({
      actor: request.account.email,
      action: 'telephony.extension_created',
      subject: created.extension,
      ip: request.ip,
    });
    reply.status(201);
    const row = db_.get(
      `SELECT e.*, n.e164, a.email AS account_email FROM extensions e
         LEFT JOIN numbers n ON n.id = e.number_id
         LEFT JOIN accounts a ON a.id = e.account_id
        WHERE e.id = ?`,
      [created.id]
    );
    return { extension: extensionView(row), secret: created.secret };
  });

  writeRoute('patch', '/extensions/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM extensions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Extension not found');
    const body = request.body || {};
    const patch = {};
    if (body.displayName !== undefined) patch.display_name = v.str(body.displayName, { name: 'displayName', max: 80 });
    if (body.email !== undefined) patch.email = v.email(body.email, { required: false });
    if (body.voicemail !== undefined) patch.voicemail = v.bool(body.voicemail) ? 1 : 0;
    if (body.dnd !== undefined) patch.dnd = v.bool(body.dnd) ? 1 : 0;
    if (body.enabled !== undefined) patch.enabled = v.bool(body.enabled) ? 1 : 0;
    if (body.forwardTo !== undefined) patch.forward_to = v.str(body.forwardTo, { name: 'forwardTo', max: 10, required: false });
    if (body.number !== undefined) patch.number_id = body.number ? linkNumber(body.number) : null;
    if (body.account !== undefined) patch.account_id = ownerId(body.account);
    if (body.secret !== undefined) patch.secret = v.str(body.secret, { name: 'secret', min: 8, max: 64 });
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE extensions SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.extension_updated', subject: row.extension, ip: request.ip });
    const fresh = db_.get(
      `SELECT e.*, n.e164, a.email AS account_email FROM extensions e
         LEFT JOIN numbers n ON n.id = e.number_id
         LEFT JOIN accounts a ON a.id = e.account_id
        WHERE e.id = ?`,
      [row.id]
    );
    return { extension: extensionView(fresh) };
  });

  writeRoute('delete', '/extensions/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM extensions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Extension not found');
    db_.run('DELETE FROM extensions WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.extension_deleted', subject: row.extension, ip: request.ip });
    return { ok: true };
  });

  writeRoute('post', '/extensions/:id/rotate-secret', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM extensions WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Extension not found');
    const secret = randomBytes(9).toString('base64url');
    db_.run('UPDATE extensions SET secret = ?, updated_at = ? WHERE id = ?', [secret, now(), row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.extension_secret_rotated', subject: row.extension, ip: request.ip });
    return { ok: true, secret };
  });

  // ---------------------------------------------------------------- trunks --
  app.get('/trunks', async () => ({
    items: db_.all('SELECT * FROM trunks ORDER BY name').map(trunkView),
  }));

  writeRoute('post', '/trunks', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', max: 40, pattern: /^[A-Za-z0-9_.-]+$/ });
    if (db_.get('SELECT id FROM trunks WHERE name = ?', [name])) throw conflict(`Trunk ${name} already exists`);
    const id = newId('trk_');
    db_.run(
      `INSERT INTO trunks (id, name, provider, host, username, secret, from_user, codecs, context, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        v.str(body.provider, { name: 'provider', max: 40, required: false, fallback: 'generic' }),
        v.str(body.host, { name: 'host', max: 120, pattern: /^[A-Za-z0-9.:_-]+$/ }),
        v.str(body.username, { name: 'username', max: 80, required: false }),
        v.str(body.secret, { name: 'secret', max: 200, required: false }),
        v.str(body.fromUser, { name: 'fromUser', max: 40, required: false }),
        v.str(body.codecs, { name: 'codecs', max: 60, required: false, fallback: 'ulaw,alaw' }),
        v.str(body.context, { name: 'context', max: 40, required: false, fallback: 'from-trunk' }),
        v.bool(body.enabled, true) ? 1 : 0,
      ]
    );
    logEvent({ actor: request.account.email, action: 'telephony.trunk_created', subject: name, ip: request.ip });
    reply.status(201);
    return { trunk: trunkView(db_.get('SELECT * FROM trunks WHERE id = ?', [id])) };
  });

  writeRoute('patch', '/trunks/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM trunks WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Trunk not found');
    const body = request.body || {};
    const patch = {};
    if (body.host !== undefined) patch.host = v.str(body.host, { name: 'host', max: 120, pattern: /^[A-Za-z0-9.:_-]+$/ });
    if (body.username !== undefined) patch.username = v.str(body.username, { name: 'username', max: 80, required: false });
    if (body.secret !== undefined) patch.secret = v.str(body.secret, { name: 'secret', max: 200, required: false });
    if (body.fromUser !== undefined) patch.from_user = v.str(body.fromUser, { name: 'fromUser', max: 40, required: false });
    if (body.codecs !== undefined) patch.codecs = v.str(body.codecs, { name: 'codecs', max: 60 });
    if (body.context !== undefined) patch.context = v.str(body.context, { name: 'context', max: 40 });
    if (body.enabled !== undefined) patch.enabled = v.bool(body.enabled) ? 1 : 0;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE trunks SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.trunk_updated', subject: row.name, ip: request.ip });
    return { trunk: trunkView(db_.get('SELECT * FROM trunks WHERE id = ?', [row.id])) };
  });

  writeRoute('delete', '/trunks/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM trunks WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Trunk not found');
    db_.run('DELETE FROM trunks WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.trunk_deleted', subject: row.name, ip: request.ip });
    return { ok: true };
  });

  // ------------------------------------------------------------------ IVRs --
  app.get('/ivr', async () => ({ items: db_.all('SELECT * FROM ivr_flows ORDER BY name').map(ivrView) }));

  writeRoute('post', '/ivr', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const extension = v.str(body.extension, { name: 'extension', max: 6, pattern: /^\d{2,6}$/ });
    if (db_.get('SELECT id FROM ivr_flows WHERE extension = ?', [extension])) {
      throw conflict(`An IVR already uses extension ${extension}`);
    }
    if (db_.get('SELECT id FROM extensions WHERE extension = ?', [extension])) {
      throw conflict(`Extension ${extension} is already a phone`);
    }
    const options = normalizeOptions(body.options);
    const id = newId('ivr_');
    db_.run(
      `INSERT INTO ivr_flows (id, name, extension, greeting, options, timeout_dest, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        v.str(body.name, { name: 'name', max: 80 }),
        extension,
        v.str(body.greeting, { name: 'greeting', max: 400, required: false, fallback: 'Welcome. Please choose an option.' }),
        JSON.stringify(options),
        v.str(body.timeoutDest, { name: 'timeoutDest', max: 10, required: false }),
        v.bool(body.enabled, true) ? 1 : 0,
      ]
    );
    logEvent({ actor: request.account.email, action: 'telephony.ivr_created', subject: extension, ip: request.ip });
    reply.status(201);
    return { ivr: ivrView(db_.get('SELECT * FROM ivr_flows WHERE id = ?', [id])) };
  });

  writeRoute('patch', '/ivr/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM ivr_flows WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('IVR not found');
    const body = request.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = v.str(body.name, { name: 'name', max: 80 });
    if (body.greeting !== undefined) patch.greeting = v.str(body.greeting, { name: 'greeting', max: 400, required: false });
    if (body.options !== undefined) patch.options = JSON.stringify(normalizeOptions(body.options));
    if (body.timeoutDest !== undefined) patch.timeout_dest = v.str(body.timeoutDest, { name: 'timeoutDest', max: 10, required: false });
    if (body.enabled !== undefined) patch.enabled = v.bool(body.enabled) ? 1 : 0;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE ivr_flows SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.ivr_updated', subject: row.extension, ip: request.ip });
    return { ivr: ivrView(db_.get('SELECT * FROM ivr_flows WHERE id = ?', [row.id])) };
  });

  writeRoute('delete', '/ivr/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM ivr_flows WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('IVR not found');
    db_.run('DELETE FROM ivr_flows WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'telephony.ivr_deleted', subject: row.extension, ip: request.ip });
    return { ok: true };
  });

  // ----------------------------------------------------------------- calls --
  app.get('/calls', async (request) => {
    const limit = v.integer(request.query?.limit, { name: 'limit', min: 1, max: 200, required: false, fallback: 40 });
    const direction = v.str(request.query?.direction, { name: 'direction', max: 12, required: false });
    const search = v.str(request.query?.q, { name: 'q', max: 60, required: false });
    const where = [];
    const params = [];
    if (direction) {
      where.push('direction = ?');
      params.push(direction);
    }
    if (search) {
      where.push('(from_number LIKE ? OR to_number LIKE ? OR extension LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const rows = db_.all(
      `SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`,
      [...params, limit]
    );
    return {
      items: rows.map((c) => ({
        id: c.id,
        callId: c.call_id,
        direction: c.direction,
        from: c.from_number ? formatNumber(c.from_number) : '',
        to: c.to_number ? formatNumber(c.to_number) : '',
        extension: c.extension,
        trunk: c.trunk,
        startedAt: c.started_at,
        answeredAt: c.answered_at,
        duration: c.duration,
        billsec: c.billsec,
        disposition: c.disposition,
        hangupCause: c.hangup_cause,
        recording: !!c.recording,
        audioUrl: c.recording ? `/api/calls/${c.id}/audio` : '',
      })),
      active: liveChannels().length,
    };
  });

  app.get('/calls/stats', async () => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const today = new Date(Date.now() - 86400_000).toISOString();
    const one = (sql, params) => db_.get(sql, params) || {};
    const daily = db_.all(
      `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS total,
              SUM(CASE WHEN disposition = 'answered' THEN 1 ELSE 0 END) AS answered,
              SUM(billsec) AS seconds
         FROM calls WHERE started_at >= ? GROUP BY day ORDER BY day`,
      [since]
    );
    return {
      last24h: {
        total: one('SELECT COUNT(*) AS n FROM calls WHERE started_at >= ?', [today]).n || 0,
        answered: one("SELECT COUNT(*) AS n FROM calls WHERE started_at >= ? AND disposition = 'answered'", [today]).n || 0,
        missed:
          one(
            "SELECT COUNT(*) AS n FROM calls WHERE started_at >= ? AND disposition IN ('no-answer','busy','failed')",
            [today]
          ).n || 0,
        avgTalk: Math.round(one("SELECT AVG(billsec) AS n FROM calls WHERE started_at >= ? AND disposition = 'answered'", [today]).n || 0),
      },
      dispositions: db_
        .all("SELECT disposition, COUNT(*) AS n FROM calls WHERE started_at >= ? GROUP BY disposition", [since])
        .map((r) => ({ disposition: r.disposition, count: r.n })),
      daily: daily.map((d) => ({ day: d.day, total: d.total, answered: d.answered, seconds: d.seconds || 0 })),
    };
  });
}

function normalizeOptions(input) {
  const list = Array.isArray(input) ? input : safeParse(input);
  const seen = new Set();
  const out = [];
  for (const option of list.slice(0, 9)) {
    const digit = String(option?.digit ?? '').trim().slice(0, 1);
    const target = String(option?.target ?? '').trim().slice(0, 10);
    if (!/^[1-9]$/.test(digit) || !/^\d{2,6}$/.test(target)) continue;
    if (seen.has(digit)) continue;
    seen.add(digit);
    out.push({ digit, target, label: String(option?.label ?? '').slice(0, 60) });
  }
  return out;
}
