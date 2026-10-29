import { EventEmitter } from 'node:events';

/**
 * The control-plane client for the Cantus switch.
 *
 * It replaces the Manager Interface client this platform used to carry. The
 * difference that matters: AMI was a second protocol with a second config file,
 * and it could only be reached from inside the switch's own container. This is
 * a JSON API and one WebSocket, so the switch is a service that can run beside
 * this one, on another host, or behind a proxy — and a call event arrives here
 * the same way it arrives anywhere else.
 *
 * Liveness is proved by asking (a WebSocket ping every 15 s), not by assuming
 * silence is death — the failure mode AMI taught us was a socket that looked
 * healthy for ten hours while no ring event arrived on it.
 */

const HEARTBEAT_MS = 15_000;
const RECONNECT_MAX_MS = 30_000;

export class CantusClient extends EventEmitter {
  constructor({ baseUrl, token = '', domain = 'telno.local', fetchImpl } = {}) {
    super();
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:8088').replace(/\/+$/, '');
    this.token = token;
    this.domain = domain;
    this.connected = false;
    this.lastError = '';
    this.backoff = 1_000;
    this.stopped = false;
    this.socket = undefined;
    this.heartbeat = undefined;
    this.reconnectTimer = undefined;
    this.fetch = fetchImpl || globalThis.fetch;
    this.lastEventAt = 0;
    this.calls = new Map();
  }

  headers() {
    return this.token ? { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  }

  get wsUrl() {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws/events${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
  }

  start() {
    if (this.socket || this.stopped) return this;
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped) return;
    let socket;
    try {
      socket = new WebSocket(this.wsUrl, { headers: this.headers() });
    } catch (err) {
      this.lastError = err.message;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.backoff = 1_000;
      this.lastError = '';
      this.emit('connected');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastEventAt > HEARTBEAT_MS * 3) {
          this.lastError = 'switch_unresponsive';
          try {
            socket.close();
          } catch {
            /* already gone */
          }
        }
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    });

    socket.addEventListener('message', (event) => {
      this.lastEventAt = Date.now();
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.track(message);
      this.emit('event', message);
      if (message.type) this.emit(message.type, message);
    });

    socket.addEventListener('error', (event) => {
      this.lastError = event.message || 'socket error';
    });

    socket.addEventListener('close', () => {
      const was = this.connected;
      this.connected = false;
      this.socket = undefined;
      clearInterval(this.heartbeat);
      if (was) this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      this.connect();
    }, this.backoff);
    this.reconnectTimer.unref?.();
  }

  /** A local view of live calls, so status can be answered while the socket is quiet. */
  track(message) {
    if (message.type === 'call.incoming' || message.type === 'call.originated') {
      this.calls.set(message.callId, {
        id: message.callId,
        from: message.from,
        to: message.to,
        direction: message.direction,
        state: 'ringing',
        started: Date.now(),
      });
    } else if (message.type === 'call.answered') {
      const call = this.calls.get(message.callId);
      if (call) Object.assign(call, { state: 'answered', answered: Date.now() });
    } else if (message.type === 'call.ended') {
      this.calls.delete(message.callId);
    }
    if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value);
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(parsed.error || `cantus ${method} ${path} failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  async status() {
    const status = await this.request('GET', '/v1/status');
    return {
      connected: this.connected,
      transport: 'CANTUS',
      host: new URL(this.baseUrl).host,
      node: status.node,
      relay: status.relay,
      routes: status.routes,
      activeChannels: [...this.calls.values()].map((call) => ({
        from: call.from,
        to: call.to,
        context: call.direction,
        seconds: Math.round((Date.now() - call.started) / 1000),
      })),
      uptimeSec: status.uptimeSec,
      version: `Cantus 1.0 (${status.mode})`,
    };
  }

  async applyRoutes(doc) {
    return this.request('POST', '/v1/routes', doc);
  }

  async routes() {
    return this.request('GET', '/v1/routes');
  }

  async setLine(line) {
    return this.request('POST', '/v1/lines', line);
  }

  async lines() {
    return this.request('GET', '/v1/lines');
  }

  /**
   * Register a trunk with the switch.
   *
   * A line is a thing that rings; a trunk is a thing that leaves. The switch
   * cannot dial the PSTN with a trunk it has never been told about, and before
   * this the platform only ever sent lines — so an outbound route matched, found
   * no trunk, and ended the call with `no-route`.
   */
  async setTrunk(trunk) {
    return this.request('POST', '/v1/trunks', trunk);
  }

  async originate({ from, to }) {
    return this.request('POST', '/v1/calls', { from, to });
  }

  async hangup(callId, reason = 'normal') {
    return this.request('DELETE', `/v1/calls/${encodeURIComponent(callId)}?reason=${encodeURIComponent(reason)}`);
  }

  async answer(callId) {
    return this.request('POST', `/v1/calls/${encodeURIComponent(callId)}/answer`);
  }

  async dtmf(callId, digit) {
    return this.request('POST', `/v1/calls/${encodeURIComponent(callId)}/dtmf`, { digit });
  }

  async record(callId, name) {
    return this.request('POST', `/v1/calls/${encodeURIComponent(callId)}/record`, { name });
  }

  /** Mint a softphone socket: the platform keeps the ticket, the switch trusts it. */
  async ticketUrl(ext, ticket) {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws/line?ext=${encodeURIComponent(ext)}&ticket=${encodeURIComponent(ticket)}`;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
    this.connected = false;
  }
}

let singleton;

export function cantus(options) {
  if (!singleton) {
    singleton = new CantusClient(options);
    singleton.start();
  }
  return singleton;
}

export function resetCantusForTests() {
  singleton?.stop();
  singleton = undefined;
}
