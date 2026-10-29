/**
 * The Cantus call object and its normative state machine (§7).
 *
 * Five states, fixed legal transitions, idempotent TERMINATE, and no ACK
 * because nothing needs a third leg. Media only flows once a path is committed
 * *and* the call was accepted — which is what makes a silent call impossible.
 */

export const STATES = {
  IDLE: 'IDLE',
  OFFERED: 'OFFERED',
  RINGING: 'RINGING',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
};

const LEGAL = {
  IDLE: { invite_sent: 'OFFERED', invite_recv: 'OFFERED' },
  OFFERED: {
    ring_sent: 'OFFERED',
    ring_recv: 'RINGING',
    accept_sent: 'OFFERED',
    accept_recv: 'OFFERED',
    reject: 'ENDED',
    terminate: 'ENDED',
  },
  RINGING: {
    accept_sent: 'RINGING',
    accept_recv: 'RINGING',
    reject: 'ENDED',
    terminate: 'ENDED',
  },
  ACTIVE: { terminate: 'ENDED' },
  ENDED: {},
};

export const REASONS = [
  'UNSPECIFIED',
  'BUSY',
  'NOT_FOUND',
  'REJECTED',
  'UNAVAILABLE',
  'TIMEOUT',
  'NO_CAPABILITY',
  'NOT_REACHABLE',
  'BAD_REQUEST',
  'GLARE',
  'AUTH_FAILED',
  'LIMIT',
  'CANCELLED',
  'NORMAL',
  'TRANSPORT_ERROR',
  'PATH_FAILED',
];

export const reasonId = (name) => {
  const index = REASONS.indexOf(name);
  return index === -1 ? 0 : index;
};

export const reasonName = (id) => REASONS[id] ?? 'UNKNOWN';

export class Session {
  constructor({ call, gen = 1, role, peer, peerHandle = 0, capsOffer = [], started = Date.now(), context = {} }) {
    this.call = call;
    this.gen = gen;
    this.role = role; // caller | callee
    this.peer = peer;
    this.peerHandle = peerHandle;
    this.state = STATES.IDLE;
    this.accepted = false;
    this.committed = undefined; // 'direct' | 'relay'
    this.capsOffer = capsOffer;
    this.codec = undefined;
    this.context = context;
    this.candidates = [];
    this.reply = 'relay'; // how we answer this peer: 'direct' | 'relay'
    this.replyHandle = 0;
    this.addr = undefined; // direct address of the peer
    this.peerAddr = undefined; // where direct media proved to come from
    this.challenge = undefined;
    this.started = started;
    this.phase = 0;
    this.seq = 0;
    this.ts = 0;
    this.sent = 0;
    this.received = 0;
    this.lastMediaAt = 0;
    this.lastSeenAt = 0;
    this.lastDirectMediaAt = 0;
    this.fbHigh = undefined;
    this.fbStall = 0;
    this.fbStallAt = 0;
    this.fbAt = 0;
    this.fbPeer = undefined;
    this.recvHigh = undefined;
    this.lostFrames = 0;
    this.recvBytes = 0;
    this.peak = 0;
    this.nonces = new Map();
  }

  fire(event) {
    const next = LEGAL[this.state][event];
    if (!next) return false;
    this.state = next;
    if (event === 'accept_sent' || event === 'accept_recv') this.accepted = true;
    return true;
  }

  commitPath(path) {
    if (!this.accepted) return false;
    this.committed = path;
    this.state = STATES.ACTIVE;
    return true;
  }

  get isActive() {
    return this.state === STATES.ACTIVE;
  }

  get isEnded() {
    return this.state === STATES.ENDED;
  }

  /** §7.4 replay window: a sender's nonce must strictly increase. */
  noteNonce(sender, nonce) {
    const previous = this.nonces.get(sender) ?? -1;
    if (nonce <= previous) return false;
    this.nonces.set(sender, nonce);
    return true;
  }
}
