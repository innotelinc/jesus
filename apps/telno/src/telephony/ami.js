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
    socket.setTimeout(20000);

    socket.on('connect', () => {
      this.buffer = '';
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('timeout', () => socket.destroy(new Error('ami_timeout')));
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
    return this;
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
    const pending = this.pending.shift();
    if (pending) pending.resolve(message);
    else if (message.Response === 'Error') this.lastError = message.Message || 'ami_error';
  }

  send(name, params = {}) {
    if (!this.socket) {
      if (this.queue.length < 50) this.queue.push({ name, params });
      return Promise.resolve(null);
    }
    const lines = [`Action: ${name}`, ...Object.entries(params).map(([k, v]) => `${k}: ${v}`)];
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    return new Promise((resolve) => {
      this.pending.push({ resolve });
      setTimeout(() => {
        const index = this.pending.findIndex((p) => p.resolve === resolve);
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
