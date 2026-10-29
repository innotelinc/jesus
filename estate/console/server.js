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

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const SWITCH_URL = (process.env.CANTUS_URL || 'http://cantus-switch:8088').replace(/\/$/, '');
const CONTROL_TOKEN = process.env.CANTUS_CONTROL_TOKEN || '';
const TELNO_URL = (process.env.TELNO_URL || '').replace(/\/$/, '');
const CAPSTONE_URL = (process.env.CAPSTONE_URL || '').replace(/\/$/, '');

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

const routes = [
  ['GET', /^\/api\/estate$/, async () => estate()],
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
