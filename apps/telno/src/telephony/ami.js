import net from 'node:net';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

/**
 * Minimal Asterisk Manager Interface client.
 *
 * Why AMI and not a second control protocol: every FreePBX/Asterisk box in the
 * existing stack already exposes it, it is a plain TCP key/value protocol, and
 * it costs a few hundred bytes of memory per connection. That is what makes the
 * control plane slim — no Node-to-Asterisk bridge, no extra daemon.
 */
/**
 * How often the link is proved alive, and how much silence is tolerated first.
 *
 * An idle Asterisk says nothing at all — it speaks when something happens — so
 * "no bytes for N seconds" cannot mean "the peer is gone". It used to: this
 * client called `socket.setTimeout(20000)`, which fires on idleness, and over
 * ten hours of an idle switch it logged 609 connects against 608 disconnects.
 * Every cycle was a second with no AMI session, which is a ring event that
 * never arrives. Being asked a question is different from being quiet, so a
 * Ping goes out every 15 seconds and 45 seconds of silence is real evidence.
 */
const HEARTBEAT_EVERY_MS = 15_000;
const HEARTBEAT_GRACE_MS = 45_000;

export class AmiClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...config.telephony, ...opts };
    this.socket = null;
    this.buffer = '';
    this.queue = [];
    this.pending = [];
    this.connected = false;
    this.lastError = '';
    this.backoff = 1000;
    this.timer = null;
    this.stopped = false;
    this.seq = 0;
    this.lastInbound = 0;
    this.heartbeat = null;
  }

  connect() {
    if (this.socket || this.stopped) return this;
    if (this.opts.simulate) {
      this.connected = false;
      this.lastError = 'simulated';
      return this;
    }
    const socket = net.createConnection({ host: this.opts.amiHost, port: this.opts.amiPort });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    // No socket timeout here: idleness is not death on an event-driven
    // protocol. Liveness is checked on purpose, in #startHeartbeat.

    socket.on('connect', () => {
      this.buffer = '';
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      this.lastError = err.message;
      socket.destroy();
    });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      this.pending.splice(0).forEach((p) => p.resolve(null));
      if (wasConnected) this.emit('disconnected');
      this.#scheduleReconnect();
    });
    this.#startHeartbeat();
    return this;
  }

  /**
   * Prove the link is alive by asking, rather than by assuming silence is bad.
   *
   * A Ping every 15 seconds is a real round trip: if the switch is there it
   * answers, which both keeps TCP warm and tells us the session still works. If
   * nothing at all comes back for 45 seconds — two missed heartbeats — the
   * socket is torn down and the reconnect backoff takes over.
   */
  #startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.stopped || !this.connected) return;
      if (Date.now() - this.lastInbound > HEARTBEAT_GRACE_MS) {
        this.lastError = 'ami_unresponsive';
        this.socket?.destroy();
        return;
      }
      this.send('Ping', {});
    }, HEARTBEAT_EVERY_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  #scheduleReconnect() {
    if (this.stopped || this.opts.simulate) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.connect();
    }, this.backoff);
    if (this.timer.unref) this.timer.unref();
  }

  #onData(chunk) {
    this.lastInbound = Date.now();
    this.buffer += chunk.toString('utf8');

    // The banner is a single CRLF-terminated line, not a blank-line terminated
    // block: Asterisk 22 sends "Asterisk Call Manager/11.0.0\r\n" and then
    // waits. Treating it as a block means the login is never sent and the
    // connection sits idle until the socket timeout, which is exactly how this
    // failed in the container.
    if (!this.connected) {
      const banner = /^Asterisk Call Manager[^\r\n]*\r?\n/.exec(this.buffer);
      if (banner) {
        this.buffer = this.buffer.slice(banner[0].length);
        this.#login();
      }
    }

    let boundary;
    while ((boundary = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 4);
      if (!block.trim()) continue;
      const message = parseBlock(block);
      if (!this.connected) {
        // First block is either the banner or the Login response.
        if (message.Response === 'Success' || message.Response === 'Error') {
          this.#settle(message);
        }
        if (/Asterisk Call Manager/i.test(block)) {
          this.#login();
          continue;
        }
        if (message.Response === 'Success') {
          this.connected = true;
          this.backoff = 1000;
          this.emit('connected');
          this.queue.splice(0).forEach((action) => this.send(action.name, action.params));
        }
        continue;
      }
      if (message.Event) this.emit('event', message);
      else this.#settle(message);
    }
  }

  #login() {
    this.send('Login', {
      Username: this.opts.amiUser,
      Secret: this.opts.amiSecret,
      Events: 'on',
    });
  }

  #settle(message) {
    // By ActionID when the answer carries one, otherwise the oldest question.
    // Asterisk replies in order, but more than one action can be in flight —
    // status() sends two, and the heartbeat adds a third — and "the first
    // pending promise" would then be whoever asked first rather than whoever
    // was answered.
    const index = message.ActionID
      ? this.pending.findIndex((entry) => entry.id === message.ActionID)
      : this.pending.length
        ? 0
        : -1;
    if (index === -1) {
      if (message.Response === 'Error') this.lastError = message.Message || 'ami_error';
      return;
    }
    const [pending] = this.pending.splice(index, 1);
    pending.resolve(message);
  }

  send(name, params = {}) {
    if (!this.socket) {
      if (this.queue.length < 50) this.queue.push({ name, params });
      return Promise.resolve(null);
    }
    const id = `tl${++this.seq}`;
    const lines = [
      `Action: ${name}`,
      `ActionID: ${id}`,
      ...Object.entries(params).map(([k, v]) => `${k}: ${v}`),
    ];
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    return new Promise((resolve) => {
      const entry = { id, resolve };
      this.pending.push(entry);
      setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index !== -1) {
          this.pending.splice(index, 1);
          resolve(null);
        }
      }, 5000).unref?.();
    });
  }

  async reload(what = 'all') {
    // `pjsip reload` was removed in Asterisk 20; the module reload is the
    // command that actually exists. Sending the old one returns "No such
    // command" and leaves the running switch on its previous configuration.
    const commands = {
      all: ['dialplan reload', 'module reload res_pjsip.so'],
      dialplan: ['dialplan reload'],
      pjsip: ['module reload res_pjsip.so'],
    }[what] || ['dialplan reload'];
    const results = [];
    for (const command of commands) {
      results.push(await this.send('Command', { Command: command }));
    }
    return results;
  }

  async status() {
    if (this.opts.simulate) {
      return { connected: false, simulated: true, host: this.opts.amiHost, port: this.opts.amiPort };
    }
    if (!this.connected) {
      return { connected: false, host: this.opts.amiHost, port: this.opts.amiPort, error: this.lastError || 'not_connected' };
    }
    const core = await this.send('CoreStatus', {});
    const version = await this.send('Command', { Command: 'core show version' });
    return {
      connected: true,
      host: this.opts.amiHost,
      port: this.opts.amiPort,
      uptime: core?.CoreStartupDate,
      version: (version?.Output || '').split('\n')[0]?.trim() || '',
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.socket?.destroy();
    this.socket = null;
  }
}

function parseBlock(block) {
  const out = {};
  for (const line of block.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

let singleton;
export function ami() {
  if (!singleton) {
    singleton = new AmiClient();
    singleton.connect();
  }
  return singleton;
}
