/**
 * The switch: what a telephone system does with Cantus calls.
 *
 * The protocol (endpoint.js) moves datagrams; this file decides that a call to
 * `100@telno.local` rings the browser at extension 100 *and* the desk phone,
 * bridges whichever answers first, records the far end when policy says so,
 * writes the CDR, and hands the same calls to an ARI subscriber (an agent) when
 * a route says `bridge: "agent"`.
 *
 * There is no dialplan language here and no generated `.conf` tree: the routing
 * document is the dialplan, it is validated at load, and the same file can be
 * scored offline with `bin/cantus route-test`.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CantusEndpoint, TIMERS } from './endpoint.js';
import { CantusRelay } from './relay.js';
import { Router, RoutingError, firstAction } from './router.js';
import { reasonId, reasonName } from './session.js';
import { silence, wavWrap, PCM_RATE } from './media.js';
import { asString } from './wire.js';

const FRAME = silence(160);
const now = () => Date.now();

let callSeq = 0;
const newId = (prefix) => `${prefix}${++callSeq}-${Math.random().toString(16).slice(2, 8)}`;

export class Leg {
  constructor({ id, call, role, endpoint, ext, ws }) {
    this.id = id || newId('leg-');
    this.call = call;
    this.role = role; // inbound | outbound | web | agent
    this.endpoint = endpoint; // Cantus session (when this leg is a Cantus peer)
    this.ws = ws; // WebSocket connection (when this leg is a browser)
    this.ext = ext || '';
    this.state = 'new';
    this.rx = undefined;
    this.rxAt = 0;
    this.answeredAt = 0;
    this.endedAt = 0;
    this.muted = false;
    this.received = 0;
    this.sent = 0;
  }

  get isAnswered() {
    return this.state === 'answered';
  }

  get isEnded() {
    return this.state === 'ended';
  }
}

export class Call {
  constructor({ id, direction, from, to, route }) {
    this.id = id || newId('call-');
    this.direction = direction; // inbound | outbound | internal
    this.from = from;
    this.to = to;
    this.route = route;
    this.legs = [];
    this.state = 'new';
    this.startedAt = now();
    this.answeredAt = 0;
    this.endedAt = 0;
    this.cause = '';
    this.recording = '';
    this.recordingName = '';
    this.recordBuffer = [];
    this.recordBytes = 0;
    this.events = [];
  }

  get answeredLeg() {
    return this.legs.find((leg) => leg.isAnswered);
  }

  get durationSec() {
    return Math.max(0, Math.round(((this.endedAt || now()) - this.startedAt) / 1000));
  }

  get billsec() {
    if (!this.answeredAt) return 0;
    return Math.max(0, Math.round(((this.endedAt || now()) - this.answeredAt) / 1000));
  }
}

export class Switch extends EventEmitter {
  constructor({
    domain = 'telno.local',
    id = `switch@${domain}`,
    secret = 'cantus-loopback',
    bind = '0.0.0.0:7443',
    relay,
    relayAddress = '',
    relayBind = '0.0.0.0:7444',
    advertise = '',
    relayAdvertise = '',
    routes,
    lines = [],
    trunks = [],
    recordDir = './data/recordings',
    prompts = './data/prompts',
    caps,
    requireSig = true,
    debug = false,
    mediaPort = 0,
  } = {}) {
    super();
    this.domain = domain;
    this.id = id;
    this.secret = secret;
    this.recordDir = recordDir;
    this.prompts = prompts;
    this.debug = debug;
    this.calls = new Map();
    this.lines = new Map();
    this.trunks = new Map();
    this.webSockets = new Set();
    this.counters = { calls: 0, answered: 0, rejected: 0, failed: 0 };
    this.startedAt = now();

    // A deployment either runs its own relay or points at one that already
    // exists; there is no third case, and no silent fallback to "direct only".
    this.relayAddress = relayAddress;
    this.relay = relay === false || relayAddress ? null : new CantusRelay({
      bind: relayBind,
      secret,
      advertise: relayAdvertise,
      debug,
      onEvent: (event) => this.emit('relay', event),
    });

    this.endpoint = new CantusEndpoint({
      id,
      secret,
      bind,
      advertise,
      caps,
      requireSig,
      debug,
      relay: relayAddress || undefined,
      onEvent: (event) => this.onEndpointEvent(event),
      mediaSource: (session) => this.mediaFor(session),
    });
    this.endpoint.onIncoming = (session) => this.onIncoming(session, session.dialedTo);
    this.endpoint.onInboundMedia = (session, media) => this.onMedia(this.legOf(session), media.payload);

    this.router = new Router();
    if (routes) this.setRoutes(routes);
    // Set by the server once the ARI bridge exists: an app nobody is subscribed
    // to must not leave a call ringing forever. Null means "no ARI surface on
    // this switch", which is a valid deployment (selftest, a media-only node).
    this.ariAppAvailable = null;
    for (const line of lines) this.setLine(line);
    for (const trunk of trunks) this.setTrunk(trunk);
    this.registeredNodes = new Set();
    for (const sub of [recordDir, prompts]) {
      try {
        mkdirSync(sub, { recursive: true });
      } catch {
        /* read-only deployments still run, they just cannot save audio */
      }
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.relay) {
      await this.relay.start();
      this.endpoint.relay = this.relay.addr;
    }
    await this.endpoint.start();
    this.mediaTimer = setInterval(() => this.webMediaTick(), TIMERS.MEDIA_TICK);
    if (this.endpoint.relay) {
      this.syncRegistrations();
      this.registrationTimer = setInterval(() => this.syncRegistrations(), 20_000);
    }
    this.emit('started', this.status());
    return this;
  }

  stop() {
    clearInterval(this.mediaTimer);
    clearInterval(this.registrationTimer);
    this.endpoint.stop();
    this.relay?.stop();
  }

  /** Every address this switch answers for, registered through the relay. */
  syncRegistrations() {
    if (!this.endpoint.relay) return;
    const ids = [this.id, this.domain, ...this.lines.keys()].map((entry) =>
      String(entry).includes('@') ? String(entry) : `${entry}@${this.domain}`
    );
    this.endpoint.registerAll(ids);
    this.registeredNodes = new Set(ids);
  }

  setRoutes(doc) {
    this.router.load(doc);
    this.routesDoc = this.router.doc;
    return this.routesDoc;
  }

  setLine(line) {
    const { ext } = line;
    if (ext === undefined) throw new Error('a line needs an ext');
    const entry = {
      ext: String(ext),
      displayName: line.displayName || '',
      numbers: (line.numbers || []).map(String),
      secret: line.secret || '',
      voicemail: !!line.voicemail,
      dnd: !!line.dnd,
      forwardTo: line.forwardTo || '',
      sockets: new Set(),
      cantus: new Set(),
      contacts: new Map(),
    };
    this.lines.set(String(ext), entry);
    if (this.endpoint.relay && this.endpoint.running) this.syncRegistrations();
    return entry;
  }

  setTrunk(trunk) {
    this.trunks.set(trunk.name, {
      name: trunk.name,
      endpoint: trunk.endpoint, // a Cantus endpoint id, e.g. gw@carrier.example
      numbers: (trunk.numbers || []).map(String),
      enabled: trunk.enabled !== false,
      from: trunk.from || '',
    });
    return this.trunks.get(trunk.name);
  }

  lineForAddress(address) {
    const [user] = String(address || '').split('@');
    const digits = String(user || '').replace(/\D/g, '');
    if (this.lines.has(user)) return this.lines.get(user);
    for (const line of this.lines.values()) {
      if (line.numbers.includes(user) || line.numbers.some((n) => n.replace(/\D/g, '') === digits)) return line;
    }
    return undefined;
  }

  // -------------------------------------------------------------------- status

  status() {
    const active = [...this.calls.values()].filter((call) => call.state !== 'ended');
    return {
      ok: true,
      id: this.id,
      domain: this.domain,
      uptimeSec: Math.round((now() - this.startedAt) / 1000),
      mode: this.relay ? 'relay' : 'direct',
      relay: this.relay ? { addr: this.relay.addr, ...this.relay.stats } : null,
      node: {
        addr: this.endpoint.localAddr,
        observed: this.endpoint.observed,
        handle: this.endpoint.handle,
        ready: this.endpoint.ready,
        stats: this.endpoint.stats,
      },
      calls: { active: active.length, total: this.counters.calls, answered: this.counters.answered },
      routes: { loaded: !!this.router.doc, count: this.router.doc?.routes?.length || 0 },
      lines: [...this.lines.values()].map((line) => ({
        ext: line.ext,
        numbers: line.numbers,
        registered: line.sockets.size + line.cantus.size,
      })),
      transport: 'CANTUS',
    };
  }

  // --------------------------------------------------------------------- calls

  call(id) {
    return this.calls.get(id);
  }

  activeCalls() {
    return [...this.calls.values()].filter((call) => call.state !== 'ended');
  }

  legOf(session) {
    for (const call of this.calls.values()) {
      const leg = call.legs.find((entry) => entry.endpoint === session);
      if (leg) return leg;
    }
    return undefined;
  }

  /** Originate: dial a local line, a trunk number or a raw Cantus address. */
  originate({ from = 'switch', to, callerName = '', ws, ext = '' } = {}) {
    if (!to) throw new Error('originate needs a to');
    const target = String(to);
    const call = new Call({ id: newId('call-'), direction: 'outbound', from, to: target });
    call.state = 'ringing';
    this.calls.set(call.id, call);
    this.counters.calls += 1;

    // The socket that dialled is a leg of the call. It was not, until an
    // outbound call from a softphone reached the carrier, was answered, and
    // left the browser in silence: the trunk leg had no peer to exchange audio
    // with, and a hangup had no leg to find. It starts answered because the
    // person holding the phone is already there.
    if (ws) {
      const local = new Leg({ call, role: 'web', ws, ext });
      local.state = 'answered';
      local.answeredAt = now();
      call.legs.push(local);
    }

    // A number this switch owns never leaves the box: it rings the line's own
    // endpoints, exactly as an inbound call to that line would. The routing
    // document still gets first refusal (see below) so that a line's own rule —
    // voicemail, a forward, a DND-style reject — applies whether the call came
    // from another node or from the console.
    const lineEntry = this.lineForAddress(target);

    // Everything else goes through the routing document first. Without this a
    // route like `8000@* -> ari dograh` only applied to calls arriving from
    // another node, and dialling it from the console tried to reach 8000 as a
    // remote endpoint instead — the one path an operator is most likely to
    // test. `call.routed` is emitted here too, so the console can show which
    // rule took the call.
    if (this.router.doc) {
      const decision = this.router.decide({ to: target, from, calls: this.activeCalls().length });
      if (decision.matched) {
        call.route = decision.route;
        const leg = new Leg({ call, role: 'outbound' });
        call.legs.push(leg);
        this.emitCall(call, 'call.originated', { to: target, route: call.route, local: !!lineEntry });
        this.emitCall(call, 'call.routed', { route: call.route, actions: decision.actions });
        this.runActions(call, leg, decision.actions);
        return call;
      }
    }

    if (lineEntry) {
      this.emitCall(call, 'call.originated', { to: lineEntry.ext, local: true });
      this.ringTargets(call, lineEntry.ext, { timeout: 25 });
      return call;
    }

    let endpointId = target.includes('@') ? target : undefined;
    if (!endpointId) {
      const trunk = this.trunkFor(target);
      if (!trunk) {
        call.state = 'ended';
        call.cause = 'no-route';
        this.counters.failed += 1;
        this.emitCall(call, 'call.failed', { cause: 'no-route' });
        return call;
      }
      endpointId = `${target.replace(/\D/g, '')}@${trunk.endpoint}`;
    }

    const leg = new Leg({ call, role: 'outbound' });
    call.legs.push(leg);
    const sessionId = this.endpoint.call(endpointId, {
      context: { callId: call.id, from, to: target, callerName },
    });
    if (!sessionId) {
      call.state = 'ended';
      call.cause = 'not-reachable';
      this.counters.failed += 1;
      this.emitCall(call, 'call.failed', { cause: 'not-reachable' });
      return call;
    }
    leg.endpoint = this.endpoint.sessions.get(sessionId);
    this.emitCall(call, 'call.originated', { endpointId, leg: leg.id });
    return call;
  }

  trunkFor(number) {
    const digits = String(number).replace(/\D/g, '');
    for (const trunk of this.trunks.values()) {
      if (!trunk.enabled) continue;
      if (!trunk.numbers.length) continue;
      if (trunk.numbers.some((prefix) => digits.startsWith(prefix.replace(/\D/g, '')))) return trunk;
    }
    return [...this.trunks.values()].find((trunk) => trunk.enabled);
  }

  /**
   * An INVITE reached the switch. The dialled address is the INVITE's `to`
   * field — `100@telno.local` — and `from` identifies the caller.
   */
  onIncoming(session, dialed) {
    const call = new Call({
      direction: 'inbound',
      from: stripEndpoint(session.peer),
      to: dialed || session.dialedTo || session.peer,
    });
    call.state = 'ringing';
    this.calls.set(call.id, call);
    this.counters.calls += 1;

    const leg = new Leg({ call, role: 'inbound', endpoint: session, ext: '' });
    session.callId = call.id;
    call.legs.push(leg);
    this.emitCall(call, 'call.incoming', { from: call.from, to: call.to });

    const decision = this.decide({ to: call.to, from: call.from, calls: this.activeCalls().length });
    call.route = decision.route || 'default';
    this.emitCall(call, 'call.routed', { route: call.route, actions: decision.actions });
    this.runActions(call, leg, decision.actions);
  }

  decide(context) {
    if (!this.router.doc) {
      return { matched: true, route: 'auto', actions: [{ answer: {} }, { bridge: { to: '*' } }] };
    }
    return this.router.decide(context);
  }

  runActions(call, leg, actions, index = 0) {
    const action = actions?.[index];
    if (!action || leg.isEnded || call.state === 'ended') return;
    const [name, argument] = firstAction([action]);
    const rest = () => this.runActions(call, leg, actions, index + 1);

    switch (name) {
      case 'reject': {
        this.counters.rejected += 1;
        this.endpoint.reject(leg.endpoint, typeof argument === 'number' ? reasonName(argument) : 'REJECTED');
        this.endCall(call, 'rejected');
        return;
      }
      case 'answer': {
        // A leg with no Cantus session behind it was originated by the control
        // API: there is no caller media to accept, so the switch is the one
        // answering. The rest of the list still runs, which is what makes
        // `answer -> bridge` work for a console-placed call as well as for an
        // inbound one.
        const accepted = leg.endpoint ? this.endpoint.accept(leg.endpoint) : true;
        if (!accepted) {
          this.endCall(call, 'no-capability');
          return;
        }
        leg.state = 'answered';
        leg.answeredAt = now();
        call.state = 'answered';
        call.answeredAt = now();
        this.counters.answered += 1;
        this.emitCall(call, 'call.answered', { leg: leg.id });
        if (argument?.bridge) {
          const target = String(argument.bridge);
          this.ringTargets(call, target, { timeout: argument.timeout || 25 });
        }
        rest();
        return;
      }
      case 'bridge': {
        const target = typeof argument === 'string' ? argument : argument?.to;
        const timeout = (typeof argument === 'object' && argument?.timeout) || 25;
        this.ringTargets(call, target || '*', { timeout });
        return;
      }
      case 'trunk': {
        // Dialling the outside world: the number is *called*, not rung. `bridge`
        // rings lines on this switch, so an outbound route that used it rang a
        // line named after the number and ended with `no-answer` — the call
        // never reached a gateway at all. `*` is the call's own target, which is
        // what the generated outbound routes use.
        const wanted = typeof argument === 'string' ? argument : argument?.to;
        const dialled = !wanted || wanted === '*' ? call.to : wanted;
        const trunk = this.trunkFor(dialled);
        if (!trunk) {
          this.endCall(call, 'no-route');
          return;
        }
        const endpointId = `${String(dialled).replace(/\D/g, '')}@${trunk.endpoint}`;
        const sessionId = this.endpoint.call(endpointId, {
          context: { callId: call.id, from: call.from, to: dialled, callerName: call.callerName || '' },
        });
        if (!sessionId) {
          this.endCall(call, 'not-reachable');
          return;
        }
        leg.endpoint = this.endpoint.sessions.get(sessionId);
        this.emitCall(call, 'call.originated', { endpointId, trunk: trunk.name });
        return;
      }
      case 'forward': {
        // A forward keeps the caller on the call and moves where it rings. That
        // is what a transfer is; hanging up and dialling again would drop the
        // person who asked for it.
        const target = typeof argument === 'string' ? argument : argument?.to;
        call.state = 'forwarded';
        this.emitCall(call, 'call.forwarded', { to: target });
        this.ringTargets(call, target, { timeout: argument?.timeout || 25 });
        return;
      }
      case 'play': {
        const file = typeof argument === 'string' ? argument : argument?.file;
        const timeout = typeof argument === 'object' ? argument?.timeout : undefined;
        this.playTo(leg, file);
        if (timeout) {
          // An IVR that never gives up is a caller stuck listening to a menu.
          clearTimeout(leg.ivrTimer);
          leg.ivrTimer = setTimeout(() => this.runDtmf(call, leg, 'timeout'), Number(timeout) * 1000);
          leg.ivrTimer.unref?.();
        }
        rest();
        return;
      }
      case 'record': {
        this.startRecording(call, typeof argument === 'string' ? argument : argument?.name);
        rest();
        return;
      }
      case 'pause': {
        setTimeout(rest, Number(argument?.ms || 1000));
        return;
      }
      case 'ari': {
        // The call stops belonging to this action list and belongs to an ARI
        // application — the hand-off Stasis() performs on the switch this
        // replaced. Deliberately terminal: the application answers, plays,
        // records and bridges through /ari from here, and running the rest of
        // the list afterwards would fight it for the same leg.
        const app = typeof argument === 'string' ? argument : argument?.app;
        if (!app) {
          this.endCall(call, 'server-error');
          return;
        }
        call.routeApp = String(app);
        call.state = 'stasis';
        this.emitCall(call, 'call.stasis', { app: String(app) });
        // Handing a call to an app with no connected client is a hang-up in
        // disguise: nothing will answer, and the caller would hear ringing
        // until the network gives up. Say so instead, with a cause the console
        // and the CDR can show.
        if (typeof this.ariAppAvailable === 'function' && !this.ariAppAvailable(call.routeApp)) {
          this.endCall(call, 'app-unavailable');
        }
        return;
      }
      default:
        rest();
    }
  }

  /**
   * Ring every endpoint that currently holds the target address — a browser
   * socket, a Cantus phone, and an ARI subscriber for an agent route — and
   * bridge whichever answers first. The rest are terminated, which is the
   * behaviour a parallel ring has in every PBX.
   */
  ringTargets(call, target, { timeout = 25 } = {}) {
    const targets = String(target) === '*' ? [...this.lines.keys()] : String(target).split(',');
    const ringable = [];
    for (const key of targets) {
      const line = this.lineForAddress(key);
      if (!line) continue;
      for (const socket of line.sockets) ringable.push({ kind: 'web', socket, line });
      for (const endpointId of line.cantus) ringable.push({ kind: 'cantus', endpointId, line });
    }
    if (!ringable.length) {
      this.emitCall(call, 'call.unanswered', { reason: 'no-endpoint', target });
      this.endCall(call, 'no-answer');
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.emitCall(call, 'call.unanswered', { reason: 'timeout', target });
      this.endCall(call, 'no-answer');
    }, Math.max(5, Number(timeout)) * 1000);

    const candidates = [];
    for (const entry of ringable) {
      const leg = new Leg({
        call,
        role: entry.kind === 'web' ? 'web' : 'cantus',
        ws: entry.kind === 'web' ? entry.socket : undefined,
        ext: entry.line.ext,
      });
      leg.state = 'ringing';
      call.legs.push(leg);
      candidates.push(leg);
      if (entry.kind === 'web') {
        entry.socket.sendJson({
          type: 'incoming',
          callId: call.id,
          from: call.from,
          to: call.to,
          ext: entry.line.ext,
          displayName: entry.line.displayName,
        });
      } else {
        // A second Cantus leg: a real call to that endpoint, so the remote phone
        // rings exactly as it would if it had been dialed directly.
        const sessionId = this.endpoint.call(entry.endpointId, {
          context: { callId: call.id, ext: entry.line.ext },
        });
        const ringing = this.endpoint.sessions.get(sessionId);
        if (ringing) leg.endpoint = ringing;
      }
      this.emitCall(call, 'call.ringing', { leg: leg.id, ext: entry.line.ext });
    }

    call.pending = { candidates, timer, settled };
    this.emitCall(call, 'call.bridged-ringing', { target, candidates: candidates.length });
  }

  /** The first leg to answer wins; the rest are released. */
  answerLeg(call, leg) {
    if (!call || !leg || leg.isEnded) return false;
    if (leg.state !== 'ringing') return false;
    leg.state = 'answered';
    leg.answeredAt = now();
    if (call.pending) {
      call.pending.settled = true;
      clearTimeout(call.pending.timer);
      for (const other of call.pending.candidates) {
        if (other === leg) continue;
        if (other.endpoint) this.endpoint.terminate(other.endpoint, 'NORMAL');
        if (other.ws) other.ws.sendJson({ type: 'cancelled', callId: call.id });
        other.state = 'ended';
      }
      call.pending = undefined;
    }
    if (leg.endpoint) this.endpoint.accept(leg.endpoint);
    // Answer the caller too. A bridged call has two legs; accepting only the
    // one somebody picked up leaves the inbound leg unanswered, so the switch
    // never sends ACCEPT to the gateway that brought the call in. The caller is
    // then held in silence by the carrier until it gives up — the line rings,
    // the handset shows a connected call, and the person who dialled hears
    // nothing. Only an inbound leg is answered here; a second line being rung
    // still answers for itself.
    for (const other of call.legs) {
      if (other === leg || other.isEnded) continue;
      if (other.role === 'inbound' && other.endpoint && !other.endpoint.accepted) {
        this.endpoint.accept(other.endpoint);
      }
    }
    call.state = 'answered';
    call.answeredAt = call.answeredAt || now();
    this.counters.answered += 1;
    this.emitCall(call, 'call.answered', { leg: leg.id, ext: leg.ext });
    return true;
  }

  endCall(call, cause = 'normal') {
    if (!call || call.state === 'ended') return;
    call.state = 'ended';
    call.endedAt = now();
    call.cause = cause;
    if (call.pending) {
      clearTimeout(call.pending.timer);
      for (const leg of call.pending.candidates) {
        if (leg.endpoint) this.endpoint.terminate(leg.endpoint, 'NORMAL');
        if (leg.ws) leg.ws.sendJson({ type: 'ended', callId: call.id, cause });
      }
      call.pending = undefined;
    }
    for (const leg of call.legs) {
      if (leg.isEnded) continue;
      if (leg.endpoint && !leg.endpoint.isEnded) this.endpoint.terminate(leg.endpoint, 'NORMAL');
      if (leg.ws) leg.ws.sendJson({ type: 'ended', callId: call.id, cause });
      leg.state = 'ended';
      leg.endedAt = now();
    }
    this.finishRecording(call);
    this.emitCall(call, 'call.ended', {
      cause,
      duration: call.durationSec,
      billsec: call.billsec,
      direction: call.direction,
      from: call.from,
      to: call.to,
    });
    this.emit('cdr', {
      callId: call.id,
      direction: call.direction,
      from: call.from,
      to: call.to,
      route: call.route || '',
      extension: call.answeredLeg?.ext || '',
      startedAt: new Date(call.startedAt).toISOString(),
      answeredAt: call.answeredAt ? new Date(call.answeredAt).toISOString() : null,
      endedAt: new Date(call.endedAt).toISOString(),
      duration: call.durationSec,
      billsec: call.billsec,
      disposition: call.answeredAt ? 'answered' : cause === 'no-answer' ? 'no-answer' : 'failed',
      hangupCause: cause,
      recording: call.recording,
    });
    setTimeout(() => this.calls.delete(call.id), 60_000).unref?.();
  }

  answeredLegOf(call) {
    return call.legs.find((leg) => leg.isAnswered && (leg.role === 'inbound' || leg.endpoint?.role === 'callee'));
  }

  /**
   * A keypress is a routing decision, not a notification: only routes that name
   * an `event` are candidates, so pressing 1 in a menu cannot re-run the route
   * that answered the call.
   */
  runDtmf(call, leg, value) {
    if (!call || !leg || call.state === 'ended') return false;
    if (leg.ivrTimer) {
      clearTimeout(leg.ivrTimer);
      leg.ivrTimer = undefined;
    }
    const decision = this.router.decideEvent({
      to: call.to,
      from: call.from,
      event: String(value),
      calls: this.activeCalls().length,
    });
    this.emitCall(call, 'call.dtmf-route', { event: String(value), route: decision.route || null });
    if (!decision.matched) return false;
    this.runActions(call, leg, decision.actions);
    return true;
  }

  hangup(callId, cause = 'normal') {
    const call = typeof callId === 'string' ? this.calls.get(callId) : callId;
    if (!call) return false;
    this.endCall(call, cause);
    return true;
  }

  // --------------------------------------------------------------------- media

  /**
   * Outbound media for a Cantus leg: whatever its peer leg most recently
   * received. When nothing is flowing the switch sends silence rather than
   * a tone, because a connected call with a tone in it reads as a fault.
   */
  mediaFor(session) {
    const leg = this.legOf(session);
    if (!leg) return FRAME;
    const peer = this.peerOf(leg);
    if (!peer) return null; // keepalive loopbacks are not audio
    if (peer.rx && now() - peer.rxAt < 400) return peer.rx;
    return FRAME;
  }

  peerOf(leg) {
    const call = leg.call;
    const answered = call.legs.filter((entry) => entry.isAnswered && entry !== leg);
    if (answered.length) return answered[0];
    return undefined;
  }

  onMedia(leg, payload) {
    if (!leg) return;
    leg.rx = payload;
    leg.rxAt = now();
    leg.received += 1;
    const call = leg.call;
    if (call.recordBuffer && leg.role !== 'web') this.appendRecording(call, payload);
    // Push straight to a browser leg: a WebSocket has no poll tick of its own
    // worth waiting for, and 20 ms of added latency is audible on a narrowband
    // call.
    const peer = this.peerOf(leg);
    if (peer?.ws) {
      peer.ws.send(Buffer.from(payload), { binary: true });
      // Remembered so the 20 ms ticker does not send a second frame — silence —
      // on top of this one. A browser that is fed twice plays both, and the
      // audio it hears is halved into noise.
      peer.pushedAt = now();
    }
  }

  /** Pacing for browser legs: they send and receive at the same 20 ms cadence. */
  webMediaTick() {
    for (const call of this.calls.values()) {
      if (call.state === 'ended') continue;
      for (const leg of call.legs) {
        if (!leg.ws || !leg.isAnswered) continue;
        // A leg the peer has just pushed to has its frame for this tick already.
        // The ticker is here to fill silence, not to interleave with real audio.
        if (leg.pushedAt && now() - leg.pushedAt < TIMERS.MEDIA_TICK) continue;
        const peer = this.peerOf(leg);
        const payload = peer?.rx && now() - peer.rxAt < 400 ? peer.rx : FRAME;
        leg.ws.send(Buffer.from(payload), { binary: true });
        leg.sent += 1;
      }
    }
  }

  // ------------------------------------------------------------------ playback

  /**
   * Play a WAV (or a prompt name) into one leg. The frames go out on the leg's
   * own media stream, so playback works on a call that is already connected and
   * needs no third party to mix it.
   */
  playTo(leg, file) {
    if (!leg) return false;
    const resolved = this.resolvePrompt(file);
    if (!resolved) {
      this.emit('error', new Error(`prompt not found: ${file}`));
      return false;
    }
    try {
      const pcm = readWavPcm(resolved);
      let offset = 0;
      const timer = setInterval(() => {
        if (leg.isEnded || offset >= pcm.length) {
          clearInterval(timer);
          return;
        }
        const chunk = pcm.subarray(offset, offset + 320);
        offset += 320;
        if (leg.endpoint) leg.rx = chunk; // a Cantus leg's media source reads rx
        if (leg.ws) leg.ws.send(Buffer.from(chunk), { binary: true });
      }, 20);
      timer.unref?.();
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  resolvePrompt(file) {
    if (!file) return undefined;
    const candidates = [
      file,
      join(this.prompts, `${file}.wav`),
      join(this.prompts, file),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  // ---------------------------------------------------------------- recording

  startRecording(call, name) {
    if (call.recordBuffer.length && call.recording) return call.recording;
    call.recordBuffer = [];
    call.recordBytes = 0;
    call.recordingName = String(name || call.id).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);
    const file = join(this.recordDir, `${call.recordingName}.wav`);
    call.recording = file;
    this.emitCall(call, 'call.recording', { file });
    return file;
  }

  appendRecording(call, payload) {
    if (payload.length > 4000) return;
    call.recordBuffer.push(Buffer.from(payload));
    call.recordBytes += payload.length;
    // Bound the in-memory buffer: a call that runs all day must not become a
    // memory leak, so it flushes to disk in one-second slices.
    if (call.recordBytes > PCM_RATE * 2 * 30) this.flushRecording(call);
  }

  flushRecording(call) {
    if (!call.recording || !call.recordBuffer.length) return;
    const pcm = Buffer.concat(call.recordBuffer);
    call.recordBuffer = [];
    call.recordBytes = 0;
    try {
      writeFileSync(call.recording, wavWrap(pcm), { flag: 'a' });
    } catch (err) {
      this.emit('error', err);
    }
  }

  finishRecording(call) {
    if (!call.recording) return;
    this.flushRecording(call);
    this.emitCall(call, 'call.recorded', { file: call.recording });
  }

  // ------------------------------------------------------------------- events

  emitCall(call, type, detail = {}) {
    const event = {
      type,
      callId: call.id,
      direction: call.direction,
      from: call.from,
      to: call.to,
      state: call.state,
      at: new Date().toISOString(),
      ...detail,
    };
    call.events.push(event);
    this.emit('event', event);
    this.emit(type, event);
  }

  onEndpointEvent(event) {
    this.emit('endpoint', event);
    switch (event.kind) {
      case 'accepted': {
        const session = this.endpoint.sessions.get(event.call);
        const leg = session ? this.legOf(session) : undefined;
        if (!leg || leg.role === 'inbound') return; // our own answer is handled by runActions
        if (leg.isEnded) return;
        leg.state = 'answered';
        leg.answeredAt = now();
        if (leg.call.pending) this.answerLeg(leg.call, leg);
        else {
          leg.call.state = 'answered';
          leg.call.answeredAt = now();
          this.counters.answered += 1;
          this.emitCall(leg.call, 'call.answered', { leg: leg.id, ext: leg.ext, codec: event.codec });
        }
        return;
      }
      case 'ended': {
        const session = this.endpoint.sessions.get(event.call);
        const leg = session ? this.legOf(session) : undefined;
        if (leg && !leg.isEnded) {
          leg.state = 'ended';
          leg.endedAt = now();
          this.emitCall(leg.call, 'call.leg-ended', { leg: leg.id, reason: event.reason, peer: !!event.peer });
          const live = leg.call.legs.some((entry) => !entry.isEnded && entry !== leg);
          if (!live) {
            const cause = event.reason === 'NORMAL' ? 'normal' : String(event.reason || 'normal').toLowerCase();
            this.endCall(leg.call, cause);
          }
        }
        return;
      }
      case 'rejected': {
        // A gateway refused the call we invited it to carry — no carrier on the
        // far side, a busy number, an unregistered trunk. Nothing else in this
        // switch listens for that frame, so an outbound call that was refused
        // one hop away went on ringing here until its own timer ran out, and the
        // operator saw a call that never failed even though it never left.
        const session = this.endpoint.sessions.get(event.call);
        const leg = session ? this.legOf(session) : undefined;
        if (!leg || leg.isEnded) return;
        leg.state = 'ended';
        leg.endedAt = now();
        const cause = String(event.reason || 'rejected').toLowerCase();
        this.emitCall(leg.call, 'call.leg-ended', { leg: leg.id, reason: event.reason, peer: !!event.peer });
        this.endCall(leg.call, cause);
        return;
      }
      case 'dtmf': {
        const session = this.endpoint.sessions.get(event.call);
        const leg = session ? this.legOf(session) : undefined;
        if (!leg) return;
        this.emitCall(leg.call, 'call.dtmf', { leg: leg.id, digit: event.digit });
        this.runDtmf(leg.call, this.answeredLegOf(leg.call) || leg, event.digit);
        return;
      }
      case 'path': {
        const session = this.endpoint.sessions.get(event.call);
        const leg = session ? this.legOf(session) : undefined;
        if (leg) this.emitCall(leg.call, 'call.path', { leg: leg.id, path: event.path, from: event.from || null });
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------- browser lines

  /**
   * Attach a browser softphone. The browser is a first-class line, not a proxy
   * for one: it registers, it rings, it carries its own 20 ms PCM frames over
   * the socket. Nothing about SIP is involved and there is no port to forward.
   */
  attachSocket(ws, { ext, remote = '' } = {}) {
    const line = this.lines.get(String(ext));
    if (!line) {
      ws.sendJson({ type: 'error', error: 'unknown-line', ext });
      ws.close(4404, 'unknown line');
      return undefined;
    }
    const identity = newId('web-');
    line.sockets.add(ws);
    this.webSockets.add(ws);

    ws.sendJson({
      type: 'registered',
      ext: line.ext,
      displayName: line.displayName,
      domain: this.domain,
      codec: 'pcm-s16/8000/1',
      identity,
    });
    this.emit('line', { kind: 'registered', ext: line.ext, transport: 'web', remote });

    const legFor = (callId) => {
      const call = this.calls.get(callId);
      if (!call) return undefined;
      return call.legs.find((leg) => leg.ws === ws && !leg.isEnded);
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const call = [...this.calls.values()].find((entry) => entry.legs.some((leg) => leg.ws === ws && leg.isAnswered));
        const leg = call?.legs.find((entry) => entry.ws === ws && entry.isAnswered);
        if (leg) this.onMedia(leg, Buffer.from(data));
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      this.onSocketMessage(ws, line, message, legFor);
    });

    ws.on('close', () => {
      line.sockets.delete(ws);
      this.webSockets.delete(ws);
      for (const call of this.calls.values()) {
        for (const leg of call.legs) {
          if (leg.ws !== ws || leg.isEnded) continue;
          leg.state = 'ended';
          leg.endedAt = now();
          if (!call.legs.some((entry) => entry !== leg && !entry.isEnded)) this.endCall(call, 'normal');
        }
      }
      this.emit('line', { kind: 'unregistered', ext: line.ext, transport: 'web' });
    });

    return { ext: line.ext, identity };
  }

  onSocketMessage(ws, line, message, legFor) {
    switch (message.type) {
      case 'call': {
        const target = String(message.to || '');
        if (!target) return;
        // `ws` and `ext` travel with the dial: the same socket that asked for
        // the call is the leg that carries it.
        this.originate({ from: line.ext, to: target, callerName: line.displayName, ws, ext: line.ext });
        return;
      }
      case 'answer': {
        const leg = legFor(message.callId);
        if (leg) this.answerLeg(leg.call, leg);
        return;
      }
      case 'hangup': {
        const leg = legFor(message.callId);
        if (leg) this.endCall(leg.call, 'normal');
        return;
      }
      case 'dtmf': {
        const leg = legFor(message.callId);
        if (leg?.endpoint) this.endpoint.sendDtmf(leg.endpoint, message.digit);
        const call = this.calls.get(message.callId);
        if (call) this.emitCall(call, 'call.dtmf', { leg: message.callId, digit: message.digit, local: true });
        return;
      }
      case 'register': {
        // A re-register after a reconnect: same line, new socket.
        line.sockets.add(ws);
        ws.sendJson({ type: 'registered', ext: line.ext, displayName: line.displayName, domain: this.domain });
        return;
      }
      case 'ping':
        ws.sendJson({ type: 'pong', at: Date.now() });
        return;
      default:
        return;
    }
  }

  /** Register a remote Cantus endpoint as a line (a desk phone on the wire). */
  registerCantusLine(ext, endpointId) {
    const line = this.lines.get(String(ext));
    if (!line) return false;
    if (!this.endpoint.peers.has(endpointId)) this.endpoint.peers.set(endpointId, { addr: undefined });
    return true;
  }
}

function stripEndpoint(address) {
  return String(address || '').split('@')[0];
}

function readWavPcm(file) {
  const buf = readFileSync(file);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

export { Router, RoutingError, reasonId, reasonName };
export const __testing = { readWavPcm, stripEndpoint };
