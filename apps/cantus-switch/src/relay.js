/**
 * A Cantus relay: a registry, an observed-address reporter and a datagram
 * forwarder. It holds no call state and cannot read media (§8.2, §8.3, §9.6),
 * which is what makes it acceptable to run beside the trust and storage layers
 * instead of inside them.
 */

import dgram from 'node:dgram';
import { Identity } from './identity.js';
import {
  TYPES,
  F,
  v,
  s,
  b,
  varint,
  encodeMsg,
  decodeMsg,
  decodeRelay,
  datagramKind,
  encodeMedia,
} from './wire.js';
import { encodeObserved } from './reach.js';

const REGISTRATION_TTL_MS = 60_000;

export class CantusRelay {
  constructor({ bind = '0.0.0.0:7444', secret = 'cantus-loopback', onEvent = () => {}, debug = false, advertise } = {}) {
    this.binding = bind;
    this.secret = secret;
    this.onEvent = onEvent;
    this.debug = debug;
    this.advertise = advertise;
    this.byHandle = new Map(); // handle → { addr, id, expires, limits }
    this.byId = new Map(); // endpoint id → handle
    this.nextHandle = 1000;
    this.forwarded = 0;
    this.dropped = 0;
    this.startedAt = Date.now();
  }

  get addr() {
    return this.address;
  }

  get registry() {
    return this.byHandle;
  }

  get stats() {
    return { forwarded: this.forwarded, dropped: this.dropped, endpoints: this.byHandle.size };
  }

  emit(event) {
    this.onEvent({ ...event, t: Date.now() - this.startedAt });
  }

  async start() {
    const [host, port] = this.binding.split(':');
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handleDatagram(buf, `${rinfo.address}:${rinfo.port}`);
      } catch (err) {
        this.emit({ kind: 'error', error: err.message });
      }
    });
    this.socket.on('error', (err) => this.emit({ kind: 'error', error: err.message }));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(Number(port || 7444), host === 'localhost' ? '127.0.0.1' : host, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    const { address } = this.socket.address();
    this.address = `${this.advertise || address}:${this.socket.address().port}`;
    this.identity = new Identity({ name: `relay@${this.address}`, secret: this.secret });
    this.emit({ kind: 'listening', addr: this.address });
    return this;
  }

  stop() {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }

  sendto(dest, bytes) {
    const index = dest.lastIndexOf(':');
    const host = dest.slice(0, index);
    const port = Number(dest.slice(index + 1));
    try {
      this.socket.send(bytes, port, host);
      return true;
    } catch (err) {
      this.emit({ kind: 'error', error: err.message, dest });
      return false;
    }
  }

  prune(now = Date.now()) {
    for (const [handle, entry] of this.byHandle) {
      if (entry.expires > now) continue;
      this.byHandle.delete(handle);
      if (this.byId.get(entry.id) === handle) this.byId.delete(entry.id);
      this.emit({ kind: 'expired', id: entry.id, handle });
    }
  }

  handleDatagram(buf, src) {
    const kind = datagramKind(buf);
    if (kind === undefined) return;
    this.prune();

    if (kind === 2) {
      const relayed = decodeRelay(buf);
      let dest;
      if (relayed.route === 0) {
        const handle = this.byId.get(relayed.name) ?? this.suffixHandle(relayed.name);
        dest = handle ? this.byHandle.get(handle)?.addr : undefined;
      } else {
        dest = this.byHandle.get(relayed.route)?.addr;
      }
      if (!dest) {
        this.dropped += 1;
        return;
      }
      this.sendto(dest, relayed.inner);
      this.forwarded += 1;
      // Address refresh is registration-driven (§8.2); a forwarder must never
      // repoint a handle based on who happened to send it a frame.
      if (datagramKind(relayed.inner) === 0) {
        this.emit({ kind: 'forward', route: relayed.route, name: relayed.name, dest, len: relayed.inner.length });
      }
      return;
    }

    if (kind !== 0) return;
    const { type, fields } = decodeMsg(buf);
    if (type !== TYPES.REGISTER) return;

    const id = fields[F.node]?.v?.toString('utf8') || fields[F.from]?.v?.toString('utf8');
    if (!id) return;

    let handle = this.byId.get(id);
    if (!handle) {
      handle = this.nextHandle++;
      this.byId.set(id, handle);
    }
    this.byHandle.set(handle, {
      addr: src,
      id,
      expires: Date.now() + REGISTRATION_TTL_MS,
      limits: fields[F.limits]?.v,
      key: fields[F.key]?.v,
    });

    const [ip, port] = src.split(':');
    const observed = encodeObserved(4, ip, Number(port));
    const grant = Buffer.concat([
      varint(handle),
      varint(300_000),
      varint(4096),
      varint(Buffer.byteLength(this.address)),
      Buffer.from(this.address, 'utf8'),
    ]);
    const reply = {
      [F.observed]: b(observed),
      [F.handle]: v(handle),
      [F.grant]: b(grant),
      [F.node]: s(`relay@${this.address}`),
      [F.nonce]: v(Date.now() & 0x7fffffff),
    };
    reply[F.sig] = b(this.identity.sign(TYPES.REGISTER_ACK, reply));
    this.sendto(src, encodeMsg(TYPES.REGISTER_ACK, reply));
    this.emit({ kind: 'registered', id, handle, addr: src });
  }

  /**
   * The endpoint that answers for `user@node@host`.
   *
   * Cantus addresses are `user@node`. That is what makes a trunk possible: the
   * gateway registers once as `voipms@gateway`, and every number it serves —
   * `14155550100@voipms@gateway` — has to reach it without the gateway
   * registering a name it cannot know in advance. Exact names win, so a line
   * registered as `101@telno.local` is never swallowed by a shorter suffix;
   * the longest registered suffix takes it next, and `undefined` is a drop.
   */
  suffixHandle(name) {
    const parts = String(name || '').split('@');
    for (let i = 1; i < parts.length; i += 1) {
      const handle = this.byId.get(parts.slice(i).join('@'));
      if (handle !== undefined) return handle;
    }
    return undefined;
  }

  /** Inject media straight into a registered endpoint (used by tests and taps). */
  forwardMedia(id, datagram) {
    const handle = this.byId.get(id);
    const entry = handle ? this.byHandle.get(handle) : undefined;
    if (!entry) return false;
    return this.sendto(entry.addr, datagram);
  }
}

export { encodeMedia };
