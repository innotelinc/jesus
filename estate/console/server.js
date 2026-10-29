/**
 * The estate console's server.
 *
 * It is a window, not a control plane: it holds no state the switch does not
 * already hold, and it is the only process in the demo that talks to every
 * product. When a product is absent the console says so and keeps serving —
 * a demo that 500s because telno is still starting is a worse demo.
 *
 * No dependencies, on purpose: the switch has none, so the front door should
 * not need a package registry either.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as voipms from './voipms.js';
import { flip } from './flip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const SWITCH_URL = (process.env.CANTUS_URL || 'http://cantus-switch:8088').replace(/\/$/, '');
const CONTROL_TOKEN = process.env.CANTUS_CONTROL_TOKEN || '';
const TELNO_URL = (process.env.TELNO_URL || '').replace(/\/$/, '');
const CAPSTONE_URL = (process.env.CAPSTONE_URL || '').replace(/\/$/, '');
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/$/, '');

/**
 * A call tape: what finished, newest first, bounded.
 *
 * It is built from the switch's event log rather than from `/v1/calls`: a call
 * that rings out and ends between two polls never appears in the active list,
 * which is exactly the call a demo makes. The event log keeps `call.ended`
 * (with its cause and duration) and `call.routed` (with the route name), so the
 * tape can show both without the console holding any state of its own.
 */
const tape = [];
const tapeIds = new Set();

async function call(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (CONTROL_TOKEN) headers.authorization = `Bearer ${CONTROL_TOKEN}`;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${SWITCH_URL}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(body?.error || `switch answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function probe(name, url, path = '/') {
  if (!url) return { name, state: 'not configured', url: null };
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2500) });
    return { name, state: response.ok ? 'up' : `HTTP ${response.status}`, url };
  } catch (error) {
    return { name, state: `unreachable (${error.code || error.name})`, url };
  }
}

function record(events) {
  const routes = new Map();
  for (const event of events) {
    if (event.type === 'call.routed') routes.set(event.callId, event.route);
  }
  for (const event of events) {
    if (event.type !== 'call.ended' || tapeIds.has(event.callId)) continue;
    tapeIds.add(event.callId);
    tape.unshift({
      id: event.callId,
      from: event.from,
      to: event.to,
      route: routes.get(event.callId) || '',
      cause: event.cause || '',
      seconds: event.duration ?? 0,
      at: event.at || new Date().toISOString(),
    });
  }
  if (tape.length > 40) {
    for (const dropped of tape.splice(40)) tapeIds.delete(dropped.id);
  }
}

async function estate() {
  const [status, calls, routes, lines, events] = await Promise.all([
    call('/v1/status'),
    call('/v1/calls'),
    call('/v1/routes'),
    call('/v1/lines'),
    call('/v1/events?limit=200'),
  ]);
  record(events);
  const products = await Promise.all([
    probe('telno', TELNO_URL, '/healthz'),
    // `/srtp` rather than `/healthz`: the health answer is 503 while the trunk
    // is unregistered, and a gateway that is up with no carrier is not down.
    probe('gateway', GATEWAY_URL, '/srtp'),
    probe('capstone', CAPSTONE_URL, '/api/health'),
  ]);
  return {
    at: new Date().toISOString(),
    switch: status,
    calls,
    routes: routes?.routes || [],
    lines: lines?.lines || lines || [],
    tape,
    products,
    switchUrl: SWITCH_URL,
  };
}

/**
 * Encryption, as each side of the carrier leg sees it.
 *
 * The gateway's answer is a local HTTP call, so it is read fresh every time. The
 * carrier's is an API call behind a rate limit and an IP allowlist, so it is
 * cached for a few seconds: the console polls, and the console must not be the
 * reason the account starts refusing requests.
 */
const CARRIER_TTL = 12_000;
let carrierCache = { at: 0, value: null };

async function carrierState(force = false) {
  if (!force && carrierCache.value && Date.now() - carrierCache.at < CARRIER_TTL) return carrierCache.value;
  const value = await voipms.state();
  carrierCache = { at: Date.now(), value };
  return value;
}

async function gatewayState() {
  if (!GATEWAY_URL) {
    return { configured: false, reachable: false, srtp: null, registered: false, server: '', error: 'GATEWAY_URL is empty' };
  }
  try {
    const response = await fetch(`${GATEWAY_URL}/status`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`gateway answered ${response.status}`);
    const body = await response.json();
    const sip = body.sip || {};
    return {
      configured: true,
      reachable: true,
      srtp: sip.srtp === true,
      registered: !!sip.registered,
      server: sip.server || '',
      expiresAt: sip.expiresAt || null,
      error: sip.error || '',
    };
  } catch (error) {
    return { configured: true, reachable: false, srtp: null, registered: false, server: '', error: error.message };
  }
}

async function encryption({ refresh = false } = {}) {
  const [gateway, carrier] = await Promise.all([gatewayState(), carrierState(refresh)]);
  return {
    at: new Date().toISOString(),
    gateway,
    carrier,
    // Both known and disagreeing is the state that gets every call refused with
    // 488 — one side offering encryption the other will not take. Showing them
    // side by side is the point.
    inSync: gateway.srtp === null || carrier.encryption === null ? null : gateway.srtp === carrier.encryption,
  };
}

/**
 * Switch the gateway's own half and wait for it to say so.
 *
 * Acknowledged by the value it reports, not by the request being sent: a 200
 * that leaves the offer unchanged is not a switch. The deadline is generous
 * because this re-registers the trunk on the way.
 */
async function setGatewaySrtp(enabled) {
  if (!GATEWAY_URL) throw new Error('GATEWAY_URL is empty');
  const response = await fetch(`${GATEWAY_URL}/srtp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `gateway answered ${response.status}`);
  if (body.enabled !== enabled) throw new Error(`gateway still reports enabled=${body.enabled}`);
}

/**
 * Change both sides, in the order that can be undone.
 *
 * The carrier goes first and the gateway second; if the gateway refuses even
 * after a retry, the carrier is put back, so the estate never stays half on and
 * half off with every call failing and nothing saying why.
 */
async function setEncryption(enabled) {
  const outcome = await flip({
    enabled,
    carrier: {
      configured: voipms.configured(),
      set: async (value) => {
        if (!voipms.configured()) throw new Error('voip.ms API credentials are not set, so the sub-account was not touched');
        return voipms.setEncryption(value);
      },
    },
    gateway: { set: setGatewaySrtp },
  });
  return { requested: enabled, ...outcome, state: await encryption({ refresh: true }) };
}

const routes = [
  ['GET', /^\/api\/estate$/, async () => estate()],
  ['GET', /^\/api\/encryption$/, async () => encryption()],
  ['POST', /^\/api\/encryption$/, async (request) => {
    const body = await json(request);
    if (typeof body?.enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { status: 400 });
    return setEncryption(body.enabled);
  }],
  ['POST', /^\/api\/calls$/, async (request) => {
    const body = await json(request);
    if (!body?.to) throw Object.assign(new Error('to is required'), { status: 400 });
    return call('/v1/calls', { method: 'POST', body: JSON.stringify(body) });
  }],
  ['DELETE', /^\/api\/calls\/([\w-]+)$/, async (_request, id) => {
    await call(`/v1/calls/${id}`, { method: 'DELETE' });
    return { ok: true };
  }],
  ['POST', /^\/api\/calls\/([\w-]+)\/dtmf$/, async (request, id) => {
    const body = await json(request);
    await call(`/v1/calls/${id}/dtmf`, { method: 'POST', body: JSON.stringify(body) });
    return { ok: true };
  }],
];

function json(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
      } catch (error) {
        reject(Object.assign(error, { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    for (const [method, pattern, handler] of routes) {
      const match = method === request.method && pattern.exec(url.pathname);
      if (match) {
        send(response, 200, await handler(request, ...match.slice(1)));
        return;
      }
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(response, 200, await readFile(join(HERE, 'public/index.html')), 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, { ok: true, switch: SWITCH_URL });
      return;
    }
    send(response, 404, { error: 'not found', path: url.pathname });
  } catch (error) {
    send(response, error.status || 502, { error: error.message, switch: SWITCH_URL });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[console] on :${PORT}  switch ${SWITCH_URL}${TELNO_URL ? `  telno ${TELNO_URL}` : ''}`);
});
