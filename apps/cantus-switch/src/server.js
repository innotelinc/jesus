/**
 * The switch's one TCP listener: control API, ARI-compatible API, the event
 * socket and the browser softphone socket. Telephony itself is one UDP port;
 * this is the management side, and it is the only thing a proxy or a firewall
 * ever needs to know about.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createUpgradeHandler } from './ws.js';
import { AriBridge } from './ari.js';

const MAX_BODY = 2 * 1024 * 1024;

function json(response, status, body) {
  if (status === 204 || body === undefined) {
    response.writeHead(status || 204);
    response.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status || 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

export class CantusServer extends EventEmitter {
  constructor({
    switch: switchRef,
    ari,
    host = '0.0.0.0',
    port = 8088,
    controlToken = '',
    allowLoopback = true,
  } = {}) {
    super();
    this.switch = switchRef;
    this.host = host;
    this.port = port;
    this.controlToken = controlToken;
    this.allowLoopback = allowLoopback;
    this.ari = ari || new AriBridge({
      switch: switchRef,
      username: process.env.CANTUS_ARI_USER || 'dograh',
      password: process.env.CANTUS_ARI_PASSWORD || process.env.DOGRAH_ARI_PASSWORD || 'dograh',
      app: process.env.CANTUS_ARI_APP || process.env.DOGRAH_STASIS_APP_NAME || 'dograh',
      onEvent: (event) => this.emit('ari', event),
    });
    // The switch asks this before it hands a call to an ARI app, so an app with
    // no connected client ends the call instead of parking it in stasis.
    switchRef.ariAppAvailable = (app) => this.ari.has(app);
    this.eventSockets = new Set();
    this.sockets = new Set();
    switchRef.on('event', (event) => this.broadcast(event));
    switchRef.on('cdr', (cdr) => this.broadcast({ type: 'cdr', ...cdr }));
    switchRef.on('endpoint', (event) => {
      if (['registered', 'auth-fail', 'error'].includes(event.kind)) this.broadcast({ type: 'node', ...event });
    });
    switchRef.on('relay', (event) => {
      if (['registered', 'error', 'expired'].includes(event.kind)) this.broadcast({ type: 'relay', ...event });
    });
  }

  broadcast(event) {
    const payload = JSON.stringify({ ...event, at: event.at || new Date().toISOString() });
    for (const ws of this.eventSockets) {
      try {
        ws.send(payload);
      } catch {
        this.eventSockets.delete(ws);
      }
    }
  }

  authorized(request, url) {
    if (!this.controlToken) {
      if (!this.allowLoopback) return false;
      const address = request.socket.remoteAddress || '';
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    }
    const header = request.headers.authorization || '';
    if (header === `Bearer ${this.controlToken}`) return true;
    if (url?.searchParams?.get('token') === this.controlToken) return true;
    return false;
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const { pathname } = url;
    const method = request.method || 'GET';

    if (pathname === '/healthz') {
      json(response, 200, { ok: true, service: 'cantus-switch', mode: this.switch.relay ? 'relay' : 'direct' });
      return;
    }

    const ariResult = await this.ari.handle(method, pathname, url, request);
    if (ariResult) {
      json(response, ariResult.status, ariResult.body);
      return;
    }

    if (!pathname.startsWith('/v1/')) {
      json(response, 404, { error: 'not found', path: pathname });
      return;
    }
    if (!this.authorized(request, url)) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const parts = pathname.replace(/^\/v1\/?/, '').split('/').filter(Boolean);
      const result = await this.routeV1(method, parts, url, request);
      json(response, result.status, result.body);
    } catch (err) {
      json(response, err.status || 400, { error: err.message });
    }
  }

  async routeV1(method, parts, url, request) {
    const sw = this.switch;

    if (parts[0] === 'status' && method === 'GET') return { status: 200, body: sw.status() };

    if (parts[0] === 'calls') {
      if (parts.length === 1 && method === 'GET') {
        return {
          status: 200,
          body: sw.activeCalls().map((call) => ({
            id: call.id,
            direction: call.direction,
            from: call.from,
            to: call.to,
            state: call.state,
            route: call.route || '',
            answeredAt: call.answeredAt ? new Date(call.answeredAt).toISOString() : null,
            seconds: call.durationSec,
            // Counters travel with the leg so a console can turn two polls into
            // a frame rate: `sent` is media written to a phone, `received` is
            // media arriving from it.
            legs: call.legs.map((leg) => ({
              id: leg.id,
              role: leg.role,
              ext: leg.ext,
              state: leg.state,
              sent: leg.sent,
              received: leg.received,
            })),
          })),
        };
      }
      if (parts.length === 1 && method === 'POST') {
        const body = await readBody(request);
        if (!body.to) return { status: 400, body: { error: 'to is required' } };
        const call = sw.originate({ from: body.from || 'api', to: body.to, callerName: body.callerName });
        return { status: 200, body: { id: call.id, state: call.state, cause: call.cause || null } };
      }
      const call = sw.calls.get(parts[1]);
      if (!call) return { status: 404, body: { error: 'no such call' } };
      if (parts.length === 2 && method === 'GET') {
        return {
          status: 200,
          body: {
            id: call.id,
            state: call.state,
            from: call.from,
            to: call.to,
            cause: call.cause,
            duration: call.durationSec,
            billsec: call.billsec,
            recording: call.recording || null,
            legs: call.legs.map((leg) => ({ id: leg.id, role: leg.role, ext: leg.ext, state: leg.state, received: leg.received })),
            events: call.events,
          },
        };
      }
      if (parts.length === 2 && method === 'DELETE') {
        sw.hangup(call.id, 'normal');
        return { status: 204 };
      }
      if (parts.length === 3 && method === 'POST') {
        const action = parts[2];
        if (action === 'answer') {
          const leg = call.legs.find((entry) => entry.state === 'ringing' || entry.role === 'inbound');
          const ok = leg ? sw.answerLeg(call, leg) : false;
          return { status: ok ? 200 : 409, body: { ok } };
        }
        if (action === 'dtmf') {
          const body = await readBody(request);
          const leg = call.legs.find((entry) => entry.endpoint);
          if (!leg) return { status: 409, body: { error: 'no Cantus leg' } };
          sw.endpoint.sendDtmf(leg.endpoint, body.digit);
          return { status: 200, body: { ok: true } };
        }
        if (action === 'record') {
          const body = await readBody(request);
          if (body.action === 'stop') {
            sw.finishRecording(call);
            return { status: 200, body: { file: call.recording } };
          }
          const file = sw.startRecording(call, body.name);
          return { status: 200, body: { file } };
        }
      }
      return { status: 404, body: { error: 'not found' } };
    }

    if (parts[0] === 'routes') {
      if (method === 'GET') return { status: 200, body: sw.routesDoc || null };
      if (method === 'POST') {
        const doc = await readBody(request);
        try {
          const applied = sw.setRoutes(doc);
          this.broadcast({ type: 'routes.applied', count: applied.routes.length });
          return { status: 200, body: { ok: true, routes: applied.routes.length } };
        } catch (err) {
          return { status: 422, body: { error: err.message, errors: err.errors || [] } };
        }
      }
    }

    if (parts[0] === 'lines') {
      if (method === 'GET') {
        return {
          status: 200,
          body: [...sw.lines.values()].map((line) => {
            const registered = line.sockets.size + line.cantus.size;
            const last = (sw.lineLog || []).find((event) => String(event.ext) === String(line.ext));
            return {
              ext: line.ext,
              displayName: line.displayName,
              numbers: line.numbers,
              registered,
              online: registered > 0,
              // Why the count is what it is: a phone that stopped answering is
              // dropped by the health check, and that reason belongs on screen.
              lastChange: last
                ? { kind: last.kind, at: last.at, reason: last.reason || '', transport: last.transport || '' }
                : null,
            };
          }),
        };
      }
      if (method === 'POST') {
        const body = await readBody(request);
        if (!body.ext) return { status: 400, body: { error: 'ext is required' } };
        const line = sw.setLine(body);
        return { status: 200, body: { ok: true, ext: line.ext } };
      }
      if (parts.length === 2 && method === 'DELETE') {
        sw.lines.delete(parts[1]);
        return { status: 204 };
      }
    }

    if (parts[0] === 'trunks' && method === 'POST') {
      const body = await readBody(request);
      sw.setTrunk(body);
      return { status: 200, body: { ok: true } };
    }

    if (parts[0] === 'events' && method === 'GET') {
      // A one-shot snapshot, for clients that cannot hold a socket open.
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 50));
      const events = [];
      for (const call of sw.calls.values()) events.push(...call.events);
      events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { status: 200, body: events.slice(-limit) };
    }

    return { status: 404, body: { error: 'not found' } };
  }

  upgrade() {
    return createUpgradeHandler((ws, request, url) => {
      const { pathname } = url;

      if (pathname === '/ari/events') {
        if (!this.ari.authorized(request)) {
          ws.close(4401, 'unauthorized');
          return;
        }
        this.ari.subscribe(url.searchParams.get('app') || this.ari.app, ws);
        return;
      }

      if (pathname === '/ws/events') {
        if (!this.authorized(request, url)) {
          ws.close(4401, 'unauthorized');
          return;
        }
        this.eventSockets.add(ws);
        ws.on('close', () => this.eventSockets.delete(ws));
        ws.sendJson({ type: 'hello', node: this.switch.status() });
        return;
      }

      if (pathname === '/ws/line') {
        // The platform proxies this socket and authenticates with the shared
        // control token; the browse-level ticket is spent on the platform side.
        // When a token is configured, this socket is not open to the network.
        if (this.controlToken && !this.authorized(request, url)) {
          ws.close(4401, 'unauthorized');
          return;
        }
        const ticket = url.searchParams.get('ticket') || '';
        // `verifyTicket` is async — it may ask the platform over HTTP — so the
        // result has to be awaited. Reading `.ok` off a pending promise is
        // always undefined, which refused *every* softphone socket with 4403
        // even when no verifier was configured at all. The upgrade handler is
        // synchronous (it can only throw), so the wait lives here.
        Promise.resolve(this.verifyTicket ? this.verifyTicket(ticket, url) : { ok: true, ext: url.searchParams.get('ext') })
          .then((check) => {
            if (!check?.ok) {
              ws.close(4403, check?.reason || 'invalid ticket');
              return;
            }
            this.switch.attachSocket(ws, { ext: check.ext, remote: request.socket.remoteAddress || '' });
          })
          .catch((err) => {
            try {
              ws.close(1011, `ticket check failed: ${err.message}`);
            } catch {
              /* socket already gone */
            }
          });
        return;
      }

      ws.close(4404, 'unknown endpoint');
    });
  }

  listen() {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((err) => {
        json(response, 500, { error: err.message });
      });
    });
    this.server.on('upgrade', this.upgrade());
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        /* nothing to close */
      }
    });
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  close() {
    for (const ws of this.eventSockets) ws.close(1001, 'shutting down');
    // A WebSocket keeps its TCP socket open forever by design, so `close()` alone
    // would wait for clients that have no reason to leave. Closing the listener
    // and ending every socket is what makes a shutdown a shutdown.
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
      setTimeout(resolve, 1_000).unref?.();
    });
  }

  get url() {
    const host = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return `http://${host}:${this.port}`;
  }
}
