/**
 * A Cantus endpoint: one socket, one event loop, signalling + media + Reach.
 * See `apps/cantus/spec/CANTUS-1.0.md` §5, §7, §8 and §9.
 *
 * This is the switch's own leg. Every call it holds is a `Session`; every byte
 * it sends or receives is governed by the same 5-tuple, which is why there is
 * no port range to open and no way to have a call connect with silent audio.
 */

import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';

import {
  TYPES,
  SIGNED,
  TYPE_NAMES,
  F,
  v,
  s,
  b,
  encodeMsg,
  decodeMsg,
  encodeMedia,
  decodeMedia,
  encodeRelay,
  decodeRelay,
  varint,
  datagramKind,
  describe,
} from './wire.js';
import { Identity } from './identity.js';
import { encodeCaps, decodeCaps, negotiate, telephoneSet } from './caps.js';
import {
  encodeCandidates,
  decodeCandidates,
  candidateToken,
  challenge,
  candidateAddr,
  encodeObserved,
  decodeObserved,
  PATH_DIRECT,
  PATH_RELAY,
} from './reach.js';
import { pcmFrame, encodeReport, decodeReport, frameSamples, PCM_RATE } from './media.js';
import { Session, reasonId, reasonName } from './session.js';

export const TIMERS = {
  RING: 32_000,
  LINGER: 4_000,
  KEEPALIVE: 15_000,
  REACH: 300,
  REBIND: 2_000,
  REBIND_FAST: 400,
  FEEDBACK_LIVE: 1_000,
  SEND_STALL: 16,
  REFRESH: 20_000,
  MEDIA_TICK: 20,
  FEEDBACK: 200,
  // A browser line has no registration to expire, so it is kept honest with a
  // ping: answer within two rounds or the socket is not a phone any more.
  LINE_PING: 10_000,
  LINE_DEAD: 30_000,
};

export const DEFAULT_LIMITS = {
  max_calls: 64,
  max_streams: 2,
  max_bitrate: 128,
  max_datagram: 1150,
  keepalive_ms: 15_000,
  reach_ms: 300,
};

const LIMIT_KEYS = ['max_calls', 'max_streams', 'max_bitrate', 'max_datagram', 'keepalive_ms', 'reach_ms'];

export function encodeLimits(limits = DEFAULT_LIMITS) {
  // Each entry is a field tag followed by its varint value (§5.3).
  const parts = [];
  LIMIT_KEYS.forEach((key, index) => {
    parts.push(varint((index + 1) << 3), varint(limits[key] ?? 0));
  });
  return Buffer.concat(parts);
}

export function decodeLimits(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarintAt(buf, pos);
    pos = tag.pos;
    const value = readVarintAt(buf, pos);
    pos = value.pos;
    const id = Math.floor(tag.value / 8);
    if (LIMIT_KEYS[id - 1]) out[LIMIT_KEYS[id - 1]] = value.value;
  }
  return out;
}

function readVarintAt(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    if (byte === undefined) throw new Error('cantus: truncated varint');
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, pos };
    shift += 7;
  }
}

export function tagFor(call) {
  return createHash('sha256').update(call).digest().readUInt16BE(0);
}

export class CantusEndpoint {
  constructor({
    id,
    secret,
    caps = telephoneSet(),
    bind = '0.0.0.0:7443',
    advertise,
    relay,
    limits = {},
    requireSig = true,
    onEvent = () => {},
    mediaSource = undefined,
    toneHz = 440,
    debug = false,
    now = () => Date.now(),
  } = {}) {
    if (!id) throw new Error('CantusEndpoint requires an id');
    this.id = id;
    this.secret = secret || 'cantus-loopback';
    this.caps = caps;
    this.bind = bind;
    this.advertise = advertise || '';
    this.relay = relay;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.requireSig = requireSig;
    this.onEvent = onEvent;
    this.mediaSource = mediaSource;
    this.toneHz = toneHz;
    this.debug = debug;
    this.now = now;

    this.identity = new Identity({ name: id, secret: this.secret });
    this.sessions = new Map();
    this.peers = new Map();
    this.nonce = 0;
    this.handle = 0;
    this.observed = undefined;
    this.ready = false;
    this.startedAt = now();
    this.running = false;
    this.stats = { receivedFrames: 0, sentFrames: 0, relayFrames: 0, directFrames: 0, receivePeak: 0 };
    this.timers = new Set();
    this.counters = { calls: 0, planned: 0 };
    this.socket = undefined;
    this.nextMediaAt = now();
    this.nextKeepaliveAt = now() + TIMERS.KEEPALIVE;
    this.nextFeedbackAt = now();
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.running) return this;
    const [host, port] = this.bind.split(':');
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handleDatagram(buf, `${rinfo.address}:${rinfo.port}`, false);
      } catch (err) {
        this.emit({ kind: 'error', error: err.message });
      }
    });
    this.socket.on('error', (err) => this.emit({ kind: 'error', error: err.message }));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(Number(port || 7443), host === 'localhost' ? '127.0.0.1' : host, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    const { address } = this.socket.address();
    this.localAddr = `${address}:${this.socket.address().port}`;
    this.running = true;

    this.mediaTimer = setInterval(() => this.mediaTick(), TIMERS.MEDIA_TICK);
    this.feedbackTimer = setInterval(() => this.feedbackTick(), TIMERS.FEEDBACK);
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), TIMERS.KEEPALIVE);
    if (this.relay) {
      this.register();
      this.refreshTimer = setInterval(() => this.register(), TIMERS.REFRESH);
    }
    this.emit({ kind: 'listening', id: this.id, addr: this.localAddr });
    return this;
  }

  stop() {
    this.running = false;
    clearInterval(this.mediaTimer);
    clearInterval(this.feedbackTimer);
    clearInterval(this.keepaliveTimer);
    clearInterval(this.refreshTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }

  after(delay, fn, tag) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (err) {
        this.emit({ kind: 'error', error: err.message, tag });
      }
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  emit(event) {
    const record = { ...event, t: this.now() - this.startedAt };
    if (this.debug && ['rx', 'tx'].includes(record.kind)) {
      this.onEvent(record);
      return;
    }
    this.onEvent(record);
  }

  // ------------------------------------------------------------------- transport

  sendto(dest, bytes) {
    if (!dest || !this.socket) return false;
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

  relaySend(route, name, inner) {
    return this.sendto(this.relay, encodeRelay(route, inner, name));
  }

  // ------------------------------------------------------------------ registration

  /**
   * Register an endpoint id with the relay. A switch registers itself *and* every
   * line it hosts: the relay maps a name to an address, and the address of
   * `100@telno.local` is this switch's socket. That is what lets a caller in
   * another domain dial an extension without knowing anything about the box
   * that holds it.
   */
  register(nodeId = this.id) {
    if (!this.relay) return;
    const fields = {
      [F.version]: s('cantus/1'),
      [F.node]: s(nodeId),
      [F.from]: s(nodeId),
      [F.key]: b(this.identity.publicKey),
      [F.limits]: b(encodeLimits(this.limits)),
    };
    this.sendto(this.relay, this.makeMessage(TYPES.REGISTER, fields));
    this.emit({ kind: 'register-sent', relay: this.relay, node: nodeId });
  }

  registerAll(ids) {
    for (const id of new Set([this.id, ...ids])) this.register(id);
  }

  makeMessage(type, fields = {}, sign = false) {
    const out = { ...fields };
    if (out[F.nonce] === undefined) {
      this.nonce += 1;
      out[F.nonce] = v(this.nonce);
    }
    const name = TYPE_NAMES[type];
    if (sign || SIGNED.has(name)) out[F.sig] = b(this.identity.sign(type, out));
    return encodeMsg(type, out);
  }

  verifyMessage(type, fields) {
    if (!this.requireSig) return true;
    if (!SIGNED.has(TYPE_NAMES[type])) return true;
    const signature = fields[F.sig]?.v;
    if (!signature) return false;
    const copy = { ...fields };
    delete copy[F.sig];
    const ok = this.identity.verify(type, copy, signature, this.secret);
    if (!ok) this.emit({ kind: 'auth-fail', type: TYPE_NAMES[type] });
    return ok;
  }

  // ----------------------------------------------------------------- datagrams

  handleDatagram(buf, src, framed) {
    const kind = datagramKind(buf);
    if (kind === undefined) return;

    if (kind === 0) {
      let message;
      try {
        message = decodeMsg(buf);
      } catch (err) {
        this.emit({ kind: 'decode-fail', src, error: err.message });
        return;
      }
      if (this.debug) this.emit({ kind: 'rx', src, msg: describe(message.type, message.fields) });
      if (!this.verifyMessage(message.type, message.fields)) return;
      this.dispatch(message.type, message.fields, src, framed);
      return;
    }

    if (kind === 1) {
      let media;
      try {
        media = decodeMedia(buf);
      } catch {
        return;
      }
      this.onMedia(media, src);
      return;
    }

    if (kind === 2) {
      let relayed;
      try {
        relayed = decodeRelay(buf);
      } catch {
        return;
      }
      if (!relayed.inner.length) return; // no nesting (§8.4)
      this.handleDatagram(relayed.inner, src, true);
    }
  }

  dispatch(type, fields, src, framed) {
    const name = TYPE_NAMES[type];
    switch (name) {
      case 'HELLO':
        return this.onHello(fields, src);
      case 'INVITE':
        return this.onInvite(fields, src, framed);
      case 'RING':
        return this.onRing(fields);
      case 'ACCEPT':
        return this.onAccept(fields);
      case 'REJECT':
        return this.onReject(fields);
      case 'TERMINATE':
        return this.onTerminate(fields);
      case 'PATH':
        return this.onPath(fields, src);
      case 'PATH_ACK':
        return this.onPathAck(fields, src);
      case 'FEEDBACK':
        return this.onFeedback(fields);
      case 'PROBE':
        return this.emit({ kind: 'probe', src });
      case 'INFO':
        return this.onInfo(fields);
      case 'REGISTER_ACK':
        return this.onRegisterAck(fields);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------- HELLO

  onHello(fields, src) {
    const peer = fields[F.from] ? fields[F.from].v.toString('utf8') : undefined;
    if (!peer) return;
    if (this.helloSent?.has(src)) return;
    this.helloSent = this.helloSent || new Set();
    this.helloSent.add(src);
    const reply = {
      [F.version]: s('cantus/1'),
      [F.from]: s(this.id),
      [F.key]: b(this.identity.publicKey),
      [F.caps]: b(encodeCaps(this.caps)),
      [F.limits]: b(encodeLimits(this.limits)),
    };
    this.sendto(src, this.makeMessage(TYPES.HELLO_ACK, reply));
    this.emit({ kind: 'hello', peer });
  }

  onRegisterAck(fields) {
    const previous = this.observed;
    const observedField = fields[F.observed]?.v;
    if (observedField) {
      try {
        this.observed = decodeObserved(observedField).addr;
      } catch {
        /* a malformed observation is not fatal */
      }
    }
    this.handle = fields[F.handle]?.v ?? 0;
    this.ready = true;
    this.emit({ kind: 'registered', observed: this.observed, handle: this.handle });

    // Our public address moved (a rebinding). Tell every call running on the
    // relay path where we now are, so its peer can probe us directly.
    if (previous && this.observed && previous !== this.observed) {
      for (const session of this.sessions.values()) {
        if (!session.isActive || session.committed !== 'relay') continue;
        this.announcePath(session, PATH_RELAY);
        this.scheduleReprobe(session);
      }
    }
  }

  // ----------------------------------------------------------------- candidates

  candidates() {
    const token = candidateToken('self', 0);
    if (this.handle) {
      const [relayIp, relayPort] = String(this.relay).split(':');
      return [
        { kind: 0, ip: this.ipOf(this.observed || this.localAddr), port: this.portOf(this.observed || this.localAddr), priority: 100, token },
        { kind: 0, ip: relayIp, port: Number(relayPort), priority: 50, token },
      ];
    }
    const addr = this.advertise || this.localAddr;
    return [{ kind: 0, ip: this.ipOf(addr), port: this.portOf(addr), priority: 100, token }];
  }

  ipOf(addr) {
    return String(addr).slice(0, String(addr).lastIndexOf(':'));
  }

  portOf(addr) {
    return Number(String(addr).slice(String(addr).lastIndexOf(':') + 1));
  }

  // ---------------------------------------------------------------------- calls

  newCallId(to) {
    const seed = `${this.id}${to}${this.nonce}${this.now()}${randomBytes(4).toString('hex')}`;
    return createHash('sha256').update(seed).digest('hex').slice(0, 32);
  }

  /**
   * Place a call. `to` is an endpoint id; the peer must either be in `peers`
   * (a static address) or reachable through the relay.
   */
  call(to, { context = {}, call } = {}) {
    if (this.sessions.size >= this.limits.max_calls) {
      this.emit({ kind: 'error', error: 'max_calls' });
      return undefined;
    }
    const id = call || this.newCallId(to);
    const session = new Session({ call: id, gen: 1, role: 'caller', peer: to, capsOffer: this.caps, context });
    session.tag = tagFor(id);
    const peer = this.peers.get(to);
    // A relay handles name-addressed traffic whether or not our own REGISTER_ACK
    // has landed yet: the callee is resolved from *its* registration, and our
    // return path is our name, which the relay already knows or will learn on
    // the first refresh. Waiting for the ack here is what makes a call placed
    // during startup fail with "no route" on a perfectly healthy link.
    if (this.relay) {
      session.reply = 'relay';
      session.replyHandle = 0;
    } else if (peer?.addr) {
      session.reply = 'direct';
      session.addr = peer.addr;
    } else {
      this.emit({ kind: 'error', error: `no route to ${to}` });
      return undefined;
    }
    session.fire('invite_sent');
    this.sessions.set(id, session);
    this.counters.calls += 1;

    this.sendCallMsg(session, TYPES.INVITE, {
      [F.to]: s(to),
      [F.caps]: b(encodeCaps(this.caps)),
      [F.cands]: b(encodeCandidates(this.candidates())),
      [F.handle]: v(this.handle),
    });
    this.emit({ kind: 'invite', call: id, to });
    this.after(TIMERS.RING, () => {
      if (!session.accepted && !session.isEnded) this.terminate(session, 'TIMEOUT');
    }, `ring:${id}`);
    return id;
  }

  onInvite(fields, src, framed) {
    const call = fields[F.call]?.v.toString('utf8');
    const peer = fields[F.from]?.v.toString('utf8');
    if (!call || !peer) return;
    if (this.sessions.has(call)) return; // retransmission absorbed (§7.4)

    const session = new Session({
      call,
      gen: fields[F.gen]?.v ?? 1,
      role: 'callee',
      peer,
      peerHandle: fields[F.handle]?.v ?? 0,
      capsOffer: decodeCaps(fields[F.caps]?.v),
    });
    session.tag = tagFor(call);
    // The dialled address is the INVITE's `to` field, and it is what the routing
    // document sees: a call to `100@telno.local` and a call to
    // `support@telno.local` are different calls to the same socket.
    session.dialedTo = fields[F.to]?.v?.toString('utf8') || this.id;
    try {
      session.candidates = decodeCandidates(fields[F.cands]?.v);
    } catch {
      session.candidates = [];
    }
    // An INVITE that arrived through the relay must be answered through it: its
    // source address is the relay's, which proves nothing about a direct path.
    const viaRelay = framed || (this.relay && src === this.relay) || !this.peers.has(peer);
    session.reply = viaRelay ? 'relay' : 'direct';
    session.addr = src;
    session.replyHandle = session.peerHandle;
    session.fire('invite_recv');
    this.sessions.set(call, session);
    this.emit({ kind: 'incoming', call, from: peer, to: session.dialedTo });
    this.onIncoming?.(session, session.dialedTo);
  }

  get pending() {
    return [...this.sessions.values()];
  }

  accept(session) {
    if (!session || session.accepted || session.isEnded) return false;
    const agreed = negotiate(session.capsOffer, this.caps);
    if (!agreed) {
      this.reject(session, 'NO_CAPABILITY');
      return false;
    }
    session.codec = agreed;
    session.fire('accept_sent');
    this.sendCallMsg(session, TYPES.ACCEPT, {
      [F.caps]: b(encodeCaps(this.caps)),
      [F.cands]: b(encodeCandidates(this.candidates())),
      [F.handle]: v(this.handle),
    });
    this.emit({ kind: 'accepted', call: session.call, codec: agreed.name });
    this.startReach(session);
    return true;
  }

  reject(session, reason = 'REJECTED') {
    if (!session || session.isEnded) return false;
    session.fire('reject');
    this.sendCallMsg(session, TYPES.REJECT, { [F.reason]: v(reasonId(reason)) });
    this.emit({ kind: 'rejected', call: session.call, reason });
    this.after(TIMERS.LINGER, () => this.sessions.delete(session.call), `linger:${session.call}`);
    return true;
  }

  terminate(session, reason = 'NORMAL') {
    if (!session || session.isEnded) return false;
    session.fire('terminate');
    this.sendCallMsg(session, TYPES.TERMINATE, { [F.reason]: v(reasonId(reason)) });
    this.emit({ kind: 'ended', call: session.call, reason });
    this.after(TIMERS.LINGER, () => this.sessions.delete(session.call), `linger:${session.call}`);
    return true;
  }

  hangup(call, reason = 'NORMAL') {
    return this.terminate(this.sessions.get(call), reason);
  }

  sendDtmf(session, digit) {
    if (!session) return false;
    this.sendCallMsg(session, TYPES.INFO, { [F.event]: v(0), [F.payload]: b(Buffer.from(String(digit))) });
    return true;
  }

  sendCallMsg(session, type, fields = {}) {
    const out = { ...fields };
    if (out[F.call] === undefined) out[F.call] = s(session.call);
    if (out[F.gen] === undefined) out[F.gen] = v(session.gen);
    if (out[F.from] === undefined) out[F.from] = s(this.id);
    const bytes = this.makeMessage(type, out);
    if (session.reply === 'direct' && session.addr) this.sendto(session.addr, bytes);
    else this.relaySend(session.replyHandle ?? 0, session.peer, bytes);
    if (this.debug) this.emit({ kind: 'tx', msg: TYPE_NAMES[type], call: session.call, path: session.reply });
  }

  onRing(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    session.fire('ring_recv');
    this.emit({ kind: 'ringing', call: session.call, peer: 1 });
  }

  onAccept(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session || session.accepted) return;
    const agreed = negotiate(session.capsOffer, decodeCaps(fields[F.caps]?.v));
    if (!agreed) {
      this.terminate(session, 'NO_CAPABILITY');
      return;
    }
    session.codec = agreed;
    session.peerHandle = fields[F.handle]?.v ?? session.peerHandle;
    try {
      session.candidates = decodeCandidates(fields[F.cands]?.v);
    } catch {
      /* no candidates from this peer */
    }
    session.fire('accept_recv');
    this.emit({ kind: 'accepted', call: session.call, codec: agreed.name, peer: 1 });
    this.startReach(session);
  }

  onReject(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    session.fire('reject');
    this.emit({ kind: 'rejected', call: session.call, reason: reasonName(fields[F.reason]?.v ?? 3), peer: 1 });
    this.after(TIMERS.LINGER, () => this.sessions.delete(session.call), `linger:${session.call}`);
  }

  onTerminate(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session || session.isEnded) return;
    const reason = reasonName(fields[F.reason]?.v ?? 0);
    session.fire('terminate');
    this.emit({ kind: 'ended', call: session.call, reason, peer: 1 });
    this.after(TIMERS.LINGER, () => this.sessions.delete(session.call), `linger:${session.call}`);
  }

  onInfo(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    const payload = fields[F.payload]?.v?.toString('utf8') ?? '';
    if ((fields[F.event]?.v ?? 1) === 0) this.emit({ kind: 'dtmf', call: session.call, digit: payload });
    else this.emit({ kind: 'info', call: session.call, payload });
  }

  // --------------------------------------------------------------------- Reach

  startReach(session) {
    session.challenge = challenge(session.call, session.gen);
    for (const delay of [0, 100, 200]) this.after(delay, () => this.probe(session), `probe:${session.call}`);
    this.after(TIMERS.REACH, () => {
      if (session.committed || session.isEnded) return;
      // No direct path confirmed in time: use the relay path opened at
      // registration. This is a success, not a failure (§8.6).
      this.commitPath(session, PATH_RELAY);
      this.announcePath(session, PATH_RELAY);
    }, `reach:${session.call}`);
  }

  probe(session) {
    if (!session?.accepted || session.isEnded) return;
    const bytes = this.makeMessage(TYPES.PATH, {
      [F.call]: s(session.call),
      [F.gen]: v(session.gen),
      [F.path]: v(PATH_DIRECT),
      [F.token]: b(session.challenge),
      [F.time]: v(this.now() - this.startedAt),
    }, true);
    for (const cand of session.candidates || []) {
      if (!cand.ip || !cand.port) continue;
      this.sendto(candidateAddr(cand), bytes);
    }
  }

  /** A PATH announcement: where the sender now is. Not a probe — no challenge. */
  announcePath(session, path) {
    const fields = { [F.path]: v(path) };
    if (path === PATH_RELAY) fields[F.cands] = b(encodeCandidates(this.candidates()));
    this.sendCallMsg(session, TYPES.PATH, fields);
  }

  scheduleReprobe(session) {
    for (const delay of [100, 600, 1600, 4000]) {
      this.after(delay, () => {
        if (session.isEnded || session.committed === 'direct') return;
        // Re-state where we are on every wave: an announcement can be lost while
        // the peer is itself re-registering, and recovery must not depend on a
        // single message arriving.
        this.announcePath(session, PATH_RELAY);
        this.probe(session);
      }, `reprobe:${session.call}`);
    }
  }

  onPath(fields, src) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    const path = fields[F.path]?.v ?? PATH_RELAY;

    if (path === PATH_DIRECT) {
      const token = fields[F.token]?.v ?? Buffer.alloc(0);
      if (!token.length) {
        // Announcement only: the peer is direct and wants us to come back.
        session.peerPath = 'direct';
        this.probe(session);
        this.scheduleReprobe(session);
        return;
      }
      const expected = session.challenge;
      const ok = expected && Buffer.compare(Buffer.from(expected), Buffer.from(token)) === 0;
      // A probe that arrived from the relay proves nothing about a direct path.
      if (!ok || this.viaRelaySource(src)) return;
      session.peerAddr = src;
      const was = session.committed;
      if (!was || was === 'relay') {
        this.commitPath(session, PATH_DIRECT);
        if (was) this.announcePath(session, PATH_DIRECT);
      }
      // Answer on the path it arrived by.
      const ack = this.makeMessage(TYPES.PATH_ACK, {
        [F.call]: s(session.call),
        [F.gen]: v(session.gen),
        [F.from]: s(this.id),
        [F.path]: v(PATH_DIRECT),
        [F.token]: b(token),
      }, true);
      this.sendto(src, ack);
      return;
    }

    // A relayed announcement that arrives late must not pull a working direct
    // path back to the relay while audio is still landing directly.
    if (session.committed === 'direct' && this.now() - (session.lastDirectMediaAt || 0) < 500) return;
    session.peerPath = 'relay';
    let changed = false;
    if (fields[F.cands]) {
      try {
        const fresh = decodeCandidates(fields[F.cands].v);
        if (fresh.length) {
          const before = (session.candidates || []).map(candidateAddr).join(',');
          const after = fresh.map(candidateAddr).join(',');
          changed = before !== after;
          session.candidates = fresh;
        }
      } catch {
        /* keep the candidates we have */
      }
    }
    this.commitPath(session, PATH_RELAY);
    if (changed) {
      // The peer's probes cannot reach us until we have sent something to its
      // new address: that outbound packet is what opens the mapping its return
      // path needs (§8.7).
      this.probe(session);
      this.scheduleReprobe(session);
    }
  }

  onPathAck(fields, src) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    const path = fields[F.path]?.v ?? PATH_RELAY;
    session.peerPath = path === PATH_DIRECT ? 'direct' : 'relay';
    if (path === PATH_DIRECT) {
      if (this.viaRelaySource(src)) return;
      session.peerAddr = src;
      this.commitPath(session, PATH_DIRECT);
    } else if (!session.committed) {
      this.commitPath(session, PATH_RELAY);
    }
  }

  viaRelaySource(src) {
    return !!this.relay && src === this.relay;
  }

  commitPath(session, path) {
    if (session.committed === path) return;
    const previous = session.committed;
    session.fbStall = 0; // reception evidence belongs to the path it was gathered on
    session.committed = path;
    session.commitPath(path);
    this.emit({ kind: 'path', call: session.call, path: path === PATH_DIRECT ? 'direct' : 'relay', from: previous, switch: !!previous });
  }

  // --------------------------------------------------------------------- media

  setMediaSource(fn) {
    this.mediaSource = fn;
  }

  mediaTick() {
    const now = this.now();
    let sent = 0;
    while (now >= this.nextMediaAt && sent < 5) {
      for (const session of this.sessions.values()) {
        if (!session.isActive) continue;
        this.sendMedia(session);
      }
      this.nextMediaAt += TIMERS.MEDIA_TICK;
      sent += 1;
    }
    if (this.nextMediaAt < now - 1000) this.nextMediaAt = now + TIMERS.MEDIA_TICK;
  }

  sendMedia(session) {
    const ptime = session.codec?.ptime ?? 20;
    const rate = session.codec?.rate ?? PCM_RATE;
    const samples = frameSamples(ptime, rate);
    let payload = this.mediaSource ? this.mediaSource(session) : undefined;
    if (!payload) {
      const frame = pcmFrame({ hz: this.toneHz, samples, phase: session.phase, rate });
      payload = frame.payload;
      session.phase = frame.phase;
    }
    const bytes = encodeMedia({
      stream: 0,
      tag: session.tag,
      seq: session.seq++,
      ts: session.ts,
      codec: session.codec?.codec ?? 2,
      flags: 0,
      payload,
    });
    session.ts += samples;

    if (session.committed === PATH_DIRECT && session.peerAddr) this.sendto(session.peerAddr, bytes);
    else if (session.committed) this.relaySend(session.peerHandle ?? 0, session.peer, bytes);
    else return;
    session.sent += 1;
    this.stats.sentFrames += 1;
  }

  onMedia(media, src) {
    let session;
    for (const candidate of this.sessions.values()) {
      if (candidate.tag === media.tag && candidate.isActive) {
        session = candidate;
        break;
      }
    }
    if (!session) return;
    session.received += 1;
    session.lastMediaAt = this.now();
    session.lastSeenAt = this.now();
    if (!this.viaRelaySource(src)) session.lastDirectMediaAt = this.now();
    session.recvBytes += media.payload.length;

    if (session.recvHigh === undefined) session.recvHigh = media.seq;
    else if (media.seq > session.recvHigh) {
      const gap = media.seq - session.recvHigh - 1;
      if (gap > 0 && gap < 10_000) session.lostFrames += gap;
      session.recvHigh = media.seq;
    }

    this.stats.receivedFrames += 1;
    if (this.viaRelaySource(src)) this.stats.relayFrames += 1;
    else this.stats.directFrames += 1;
    this.emit({ kind: 'media', call: session.call, bytes: media.payload.length, srcPath: this.viaRelaySource(src) ? 'relay' : 'direct' });
    this.onInboundMedia?.(session, media);
  }

  // ------------------------------------------------------------------- feedback

  feedbackTick() {
    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      this.sendFeedback(session);
      this.checkRebinding(session);
    }
  }

  sendFeedback(session) {
    const now = this.now();
    const elapsed = Math.max(1, now - (session.fbIvStart || session.started)) / 1000;
    const kbps = Math.round((session.recvBytes * 8) / 1000 / elapsed);
    const total = session.received + session.lostFrames;
    const lossQ8 = total > 0 ? Math.round((256 * session.lostFrames) / total) : 0;
    const report = encodeReport({
      loss_q8: lossQ8,
      rtt_us: 0,
      jitter_us: 0,
      recv_kbps: kbps,
      desired_kbps: 24,
      frames_lost: session.lostFrames,
      recv_high: session.recvHigh ?? 0,
    });
    this.sendCallMsg(session, TYPES.FEEDBACK, { [F.report]: b(report) });
    session.fbIvStart = now;
    session.recvBytes = 0;
    session.lostFrames = 0;
  }

  onFeedback(fields) {
    const session = this.sessions.get(fields[F.call]?.v.toString('utf8'));
    if (!session) return;
    const report = decodeReport(fields[F.report]?.v);
    session.fbPeer = report;
    session.fbAt = this.now();
    session.lastSeenAt = session.fbAt;
    if (report.recv_high !== undefined) {
      const sent = session.seq || 0;
      if (session.fbHigh !== undefined && report.recv_high <= session.fbHigh && sent - session.fbHigh >= TIMERS.SEND_STALL) {
        session.fbStall += 1;
        session.fbStallAt = session.fbStallAt || this.now();
      } else {
        session.fbStall = 0;
        session.fbStallAt = 0;
      }
      if (session.fbHigh === undefined || report.recv_high > session.fbHigh) session.fbHigh = report.recv_high;
    }
  }

  /**
   * §8.7 in one place: a committed direct path that stopped delivering means the
   * mapping moved. Three things can reveal it, fastest first — the peer's own
   * report, then silence while the peer is demonstrably alive, then the timer
   * that keeps a half-dead path from hanging a call forever.
   */
  checkRebinding(session) {
    if (session.committed !== PATH_DIRECT || session.isEnded) return;
    const now = this.now();
    const idle = now - (session.lastMediaAt || session.started || now);
    const reportAge = session.fbAt ? now - session.fbAt : undefined;
    let trigger;
    if (session.fbStall >= 2 && (session.fbHigh || 0) > 0 && this.now() - session.fbStallAt >= TIMERS.REBIND_FAST) trigger = 'report';
    else if (idle > TIMERS.REBIND_FAST && reportAge !== undefined && reportAge < TIMERS.FEEDBACK_LIVE) trigger = 'silence';
    else if (idle > TIMERS.REBIND) trigger = 'timer';
    if (!trigger) return;
    this.emit({ kind: 'rebind', call: session.call, after_ms: idle, trigger });
    this.register();
    this.commitPath(session, PATH_RELAY);
    this.announcePath(session, PATH_RELAY);
    this.scheduleReprobe(session);
  }

  keepaliveTick() {
    for (const session of this.sessions.values()) {
      if (!session.accepted || session.isEnded) continue;
      this.sendCallMsg(session, TYPES.PROBE, {
        [F.call]: s(session.call),
        [F.gen]: v(session.gen),
        [F.time]: v(this.now() - this.startedAt),
      });
      if (this.now() - (session.lastSeenAt || session.started) > TIMERS.KEEPALIVE * 3) {
        this.terminate(session, 'TRANSPORT_ERROR');
      }
    }
  }

  // -------------------------------------------------------------------- helpers

  setPeers(peers) {
    for (const [id, addr] of Object.entries(peers)) this.peers.set(id, { addr });
  }

  get activeSessions() {
    return [...this.sessions.values()];
  }
}
