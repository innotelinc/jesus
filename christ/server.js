/**
 * CHRIST — the front door of the estate.
 *
 * One page that answers "what is this system, and what is it doing right now",
 * one JSON API the page reads, and a path-prefix proxy so every product in the
 * tree is reachable on one origin instead of a dozen tabs and a port list.
 *
 * Read-only on purpose: it shows calls and wiring, it never hangs one up. The
 * wiring change is `cli.js wire`, a deliberate command with a dry run, not a
 * button somebody can lean on.
 *
 * No dependencies, like the switch it fronts.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { request as upstreamRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadSystem, board, projectUrl } from './lib/board.js';
import { buildPlan } from './lib/wire.js';
import { loadSouls, agentsDocument } from './lib/souls.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8001);

const system = loadSystem(join(HERE, 'system.json'));
const estate = JSON.parse(await readFile(join(HERE, 'estate.json'), 'utf8'));
const { souls, byFile } = loadSouls(join(HERE, 'souls'));
const agentDoc = agentsDocument(estate, { byFile, byExt: new Map(souls.map((soul) => [soul.ext, soul.file])) });
const plan = buildPlan(estate);

const byId = new Map(system.projects.map((project) => [project.id, project]));

function send(response, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(payload);
}

/** Hop-by-hop headers belong to one connection and must not be forwarded. */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host']);

function forwardHeaders(headers, host) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP.has(key.toLowerCase())) out[key] = value;
  }
  out.host = host;
  return out;
}

function targetOf(id) {
  const project = byId.get(id);
  if (!project) return null;
  // Read at request time, not at boot: a product that starts after CHRIST is
  // still reachable without restarting the front door.
  const url = projectUrl(project, process.env);
  if (!url) return null;
  return { project, url: new URL(url) };
}

/** `/p/<id>/<rest>` → the product at `<url>/<rest>`. */
function proxyHttp(request, response, id, rest, search) {
  const target = targetOf(id);
  if (!target) {
    send(response, 404, { error: `no reachable product '${id}'`, hint: 'set its URL in the environment and restart CHRIST' });
    return;
  }
  const { url } = target;
  const path = `${url.pathname.replace(/\/$/, '')}${rest || '/'}${search || ''}`;
  const upstream = upstreamRequest(
    {
      hostname: url.hostname,
      port: url.port || 80,
      path,
      method: request.method,
      headers: forwardHeaders(request.headers, url.host),
    },
    (answer) => {
      const headers = { ...answer.headers };
      delete headers.connection;
      delete headers['keep-alive'];
      response.writeHead(answer.statusCode || 502, headers);
      answer.pipe(response);
    }
  );
  upstream.setTimeout(15_000, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (error) => {
    if (!response.headersSent) send(response, 502, { error: `upstream ${id} failed: ${error.message}`, product: id });
    else response.destroy();
  });
  request.pipe(upstream);
}

/** A WebSocket is a socket: pipe it, do not try to understand it. */
function proxyUpgrade(request, socket, head, id, rest, search) {
  const target = targetOf(id);
  if (!target) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const { url } = target;
  const connection = connect({ host: url.hostname, port: Number(url.port || 80) }, () => {
    const path = `${url.pathname.replace(/\/$/, '')}${rest || '/'}${search || ''}`;
    const lines = [`GET ${path} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const key = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (key.toLowerCase() === 'host') lines.push(`Host: ${url.host}`);
      else if (key.toLowerCase() !== 'connection') continue;
      else lines.push(`${key}: ${value === 'keep-alive, Upgrade' ? 'Upgrade' : value}`);
    }
    lines.push('Connection: Upgrade');
    connection.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) connection.write(head);
    connection.pipe(socket);
    socket.pipe(connection);
  });
  connection.on('error', () => {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  });
  socket.on('error', () => connection.destroy());
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const { pathname } = url;
  try {
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      send(response, 200, await readFile(join(HERE, 'public/index.html')), 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && pathname === '/healthz') {
      send(response, 200, { ok: true, service: 'christ', switch: process.env.CANTUS_URL || 'http://127.0.0.1:8188' });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/board') {
      send(response, 200, await board({ system, estate, agents: agentDoc.agents }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/plan') {
      send(response, 200, {
        did: estate.did,
        domain: plan.routes.domain,
        lines: plan.lines,
        trunks: plan.trunks,
        agents: agentDoc.agents.map(({ ext, name, ari, voice, model }) => ({ ext, name, ari, voice, model })),
        routes: plan.routes.routes.map((route) => ({ name: route.name, when: route.when, then: route.then.map((action) => Object.keys(action)[0]) })),
        unwired: agentDoc.unwired,
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/souls') {
      send(response, 200, {
        souls: souls.map(({ ext, name, voice, model, temperature, prompt, bytes, file }) => ({ ext, name, voice, model, temperature, prompt, bytes, file })),
      });
      return;
    }
    const proxied = /^\/p\/([a-z0-9][a-z0-9-]*)(\/.*)?$/i.exec(pathname);
    if (proxied) {
      proxyHttp(request, response, proxied[1], proxied[2], url.search);
      return;
    }
    send(response, 404, { error: 'not found', path: pathname });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const proxied = /^\/p\/([a-z0-9][a-z0-9-]*)(\/.*)?$/i.exec(url.pathname);
  if (!proxied) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  proxyUpgrade(request, socket, head, proxied[1], proxied[2], url.search);
});

server.listen(PORT, '0.0.0.0', () => {
  const up = agentDoc.agents.length;
  console.log(`[christ] on :${PORT}  ${system.projects.length} projects  ${plan.routes.routes.length} routes  ${up} soul${up === 1 ? '' : 's'}  did ${estate.did}`);
});
