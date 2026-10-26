import { db_, newId, now } from '../db/index.js';
import { logEvent } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import * as v from '../lib/validate.js';

/**
 * Connected systems: the other consoles this platform sits beside.
 *
 * The estate already has one front door (this console), but FreePBX, AvantFAX
 * and Capstone keep their own admin surfaces. Rather than pretend they are
 * gone, they are registered here with their landing path, a per-module catalog
 * and a live reachability probe, so an operator does not have to remember six
 * hostnames or guess whether a box is down.
 *
 * Probes are deliberately conservative: GET, redirects not followed, a short
 * timeout, and a private-address guard. A reachable-but-SSO-gated system is
 * reported as `auth`, which is information, not a failure.
 */

const PROBE_TTL_MS = 60_000;
const probeCache = new Map();

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

function assertPublicUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${name} must be a full http(s) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest(`${name} must use http or https`);
  if (PRIVATE_HOST.some((pattern) => pattern.test(url.hostname))) {
    throw badRequest(`${name} cannot point at a private or loopback address`);
  }
  return url;
}

const linkView = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  path: row.path,
  url: `${row.host.replace(/\/$/, '')}${row.path || '/'}`,
  description: row.description,
  group: row.group_name,
  links: (() => {
    try {
      const parsed = JSON.parse(row.links || '[]');
      return Array.isArray(parsed) ? parsed.slice(0, 60) : [];
    } catch {
      return [];
    }
  })(),
  sortOrder: row.sort_order,
  enabled: !!row.enabled,
  updatedAt: row.updated_at,
});

async function probe(system) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${system.host.replace(/\/$/, '')}${system.path || '/'}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'telno-system-probe/1.0', accept: 'text/html' },
    });
    const latencyMs = Math.round(performance.now() - started);
    const location = res.headers.get('location') || '';
    const gated = res.status === 401 || res.status === 403 || /auth\.|application\/o\/authorize|oauth|login/i.test(location);
    return {
      state: gated ? 'auth' : res.status >= 200 && res.status < 400 ? 'up' : 'down',
      statusCode: res.status,
      latencyMs,
      redirectedTo: location ? location.slice(0, 180) : '',
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      state: 'down',
      statusCode: 0,
      latencyMs: Math.round(performance.now() - started),
      redirectedTo: '',
      error: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCached(system, { force = false } = {}) {
  const entry = probeCache.get(system.id);
  if (!force && entry && Date.now() - entry.at < PROBE_TTL_MS) return entry.result;
  const result = await probe(system);
  probeCache.set(system.id, { at: Date.now(), result });
  return result;
}

export default async function systemsRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  app.get('/systems', async (request) => {
    const rows = db_.all('SELECT * FROM systems ORDER BY sort_order, name');
    const shouldProbe = !['0', 'false', 'off'].includes(String(request.query?.probe ?? '1'));
    const force = ['1', 'true'].includes(String(request.query?.refresh ?? ''));
    const items = [];
    for (const row of rows) {
      const system = linkView(row);
      items.push(
        system.enabled && shouldProbe
          ? { ...system, probe: await probeCached(row, { force }) }
          : { ...system, probe: null }
      );
    }
    return {
      items,
      summary: {
        total: items.length,
        up: items.filter((item) => item.probe?.state === 'up').length,
        auth: items.filter((item) => item.probe?.state === 'auth').length,
        down: items.filter((item) => item.probe?.state === 'down').length,
      },
    };
  });

  app.post('/systems', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', max: 80 });
    if (db_.get('SELECT id FROM systems WHERE name = ?', [name])) throw conflict(`A system named ${name} already exists`);
    const url = assertPublicUrl(v.str(body.url, { name: 'url', max: 300 }), 'url');
    const id = newId('sys_');
    db_.run(
      `INSERT INTO systems (id, name, host, path, description, group_name, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        `${url.protocol}//${url.host}`,
        url.pathname || '/',
        v.str(body.description, { name: 'description', max: 300, required: false }),
        v.str(body.group, { name: 'group', max: 40, required: false, fallback: 'Connected' }),
        v.integer(body.sortOrder, { name: 'sortOrder', min: 0, max: 10_000, required: false, fallback: 100 }),
        v.bool(body.enabled, true) ? 1 : 0,
      ]
    );
    logEvent({ actor: request.account.email, action: 'system.registered', subject: name, detail: url.host, ip: request.ip });
    reply.status(201);
    return { system: linkView(db_.get('SELECT * FROM systems WHERE id = ?', [id])) };
  });

  app.patch('/systems/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM systems WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('System not found');
    const body = request.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = v.str(body.name, { name: 'name', max: 80 });
    if (body.url !== undefined) {
      const url = assertPublicUrl(v.str(body.url, { name: 'url', max: 300 }), 'url');
      patch.host = `${url.protocol}//${url.host}`;
      patch.path = url.pathname || '/';
    }
    if (body.description !== undefined) patch.description = v.str(body.description, { name: 'description', max: 300, required: false });
    if (body.group !== undefined) patch.group_name = v.str(body.group, { name: 'group', max: 40 });
    if (body.sortOrder !== undefined) patch.sort_order = v.integer(body.sortOrder, { name: 'sortOrder', min: 0, max: 10_000 });
    if (body.enabled !== undefined) patch.enabled = v.bool(body.enabled) ? 1 : 0;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
    db_.run(`UPDATE systems SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now(), row.id]);
    probeCache.delete(row.id);
    logEvent({ actor: request.account.email, action: 'system.updated', subject: row.name, ip: request.ip });
    return { system: linkView(db_.get('SELECT * FROM systems WHERE id = ?', [row.id])) };
  });

  app.delete('/systems/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM systems WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('System not found');
    db_.run('DELETE FROM systems WHERE id = ?', [row.id]);
    probeCache.delete(row.id);
    logEvent({ actor: request.account.email, action: 'system.removed', subject: row.name, ip: request.ip });
    return { ok: true };
  });
}
