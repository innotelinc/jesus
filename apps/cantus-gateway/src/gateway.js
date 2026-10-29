/**
 * The bridge: Cantus on one side, SIP and RTP on the other.
 *
 * Two directions, and they are not symmetrical:
 *
 *   carrier → switch   an INVITE for the DID arrives; the gateway calls into
 *                      the switch with the DID as the dialled address, so the
 *                      routing document — not this file — decides what rings.
 *   switch → carrier   the switch INVITEs `<number>@<trunk>@<gateway>` because
 *                      the call matched a trunk; the gateway dials the number
 *                      and answers the Cantus side only once the carrier does.
 *
 * Media is bridged per call, not per leg: the switch pulls one 20 ms frame from
 * the carrier's jitter queue on every media tick, and every frame the carrier
 * sends goes straight out as RTP. Nothing is buffered in between, because a
 * gateway that queues audio is a gateway that adds delay to every call.
 */

import { RtpSession, DTMF } from './rtp.js';
import { buildSdp } from './sip.js';
import { SrtpContext, cryptoAttribute, newKeyMaterial, parseCryptoAttribute } from './srtp.js';

const SILENCE = Buffer.alloc(320);

/**
 * Cantus reason code → the SIP status a carrier understands.
 *
 * A refusal is not just a refusal: a carrier routes `486 Busy Here` to
 * voicemail or call-forward-busy and treats `480 Temporarily Unavailable` as
 * "try the next branch". Sending 480 for everything threw that information
 * away at the border, so a switch that knew exactly why it declined a call
 * told the PSTN nothing.
 */
const SIP_BY_REASON = {
  UNSPECIFIED: [480, 'Temporarily Unavailable'],
  BUSY: [486, 'Busy Here'],
  NOT_FOUND: [404, 'Not Found'],
  REJECTED: [403, 'Forbidden'],
  UNAVAILABLE: [480, 'Temporarily Unavailable'],
  TIMEOUT: [408, 'Request Timeout'],
  NO_CAPABILITY: [488, 'Not Acceptable Here'],
  NOT_REACHABLE: [503, 'Service Unavailable'],
  BAD_REQUEST: [400, 'Bad Request'],
  GLARE: [491, 'Request Pending'],
  AUTH_FAILED: [403, 'Forbidden'],
  // Capacity is what a carrier understands as busy; a 503 would take the
  // trunk out of rotation instead of trying the next number.
  LIMIT: [486, 'Busy Here'],
  CANCELLED: [487, 'Request Terminated'],
  NORMAL: [200, 'OK'],
  TRANSPORT_ERROR: [503, 'Service Unavailable'],
  PATH_FAILED: [503, 'Service Unavailable'],
};

export const sipStatusFor = (reason) => SIP_BY_REASON[String(reason || '').toUpperCase()] || SIP_BY_REASON.UNSPECIFIED;

/** SIP status → the Cantus reason the switch records. */
const REASON_BY_STATUS = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'AUTH_FAILED'],
  [403, 'REJECTED'],
  [404, 'NOT_FOUND'],
  [407, 'AUTH_FAILED'],
  [408, 'TIMEOUT'],
  [480, 'UNAVAILABLE'],
  [486, 'BUSY'],
  [487, 'CANCELLED'],
  [488, 'NO_CAPABILITY'],
  [491, 'GLARE'],
  [503, 'UNAVAILABLE'],
  [600, 'BUSY'],
  [603, 'REJECTED'],
  [606, 'NO_CAPABILITY'],
]);

/**
 * The switch's reason for a call the carrier refused.
 *
 * `reason` arrives as `'486 Busy Here'` or `'timeout'`; the status is the only
 * part that is safe to parse, because the phrase after it is the carrier's own
 * wording and no two carriers agree on it.
 */
export const cantusReasonFor = (failure) => {
  const text = String(failure ?? '').trim();
  if (!text || text === 'timeout') return 'TIMEOUT';
  const status = Number(/^(\d{3})/.exec(text)?.[1]);
  return REASON_BY_STATUS.get(status) || 'REJECTED';
};

/** The first component of a Cantus address: `14155550100@trunk@gw`. */
export const dialledNumber = (address) => {
  const first = String(address || '').split('@')[0].trim();
  if (/^\+\d{6,15}$/.test(first)) return first;
  const digits = first.replace(/\D/g, '');
  return /^\d{6,15}$/.test(digits) ? digits : '';
};

/** The user part of a SIP URI, which is what the carrier dialled. */
export const sipUser = (uri) => {
  const match = /sip:([^@>;]+)@/.exec(String(uri || ''));
  return match ? decodeURIComponent(match[1]) : '';
};

export class Gateway {
  constructor({ endpoint, trunk, switchId, domain, advertise, carrier = true, rtpStart = 40000, rtpEnd = 40063, srtp = false, log = () => {} }) {
    if (!endpoint) throw new Error('Gateway needs a Cantus endpoint');
    if (!trunk) throw new Error('Gateway needs a SIP trunk');
    this.endpoint = endpoint;
    this.trunk = trunk;
    this.switchId = switchId;
    this.domain = domain;
    this.advertise = advertise;
    // A gateway with no carrier configured still serves: it rejects PSTN calls
    // with a cause instead of hanging them for the switch's ring timeout, and
    // /healthz says why. Refusing to boot would take the estate down with it.
    this.carrier = carrier;
    // Encrypted carrier legs (RTP/SAVP, SDES). Off by default because a trunk
    // that does not require it is simpler; a sub-account that does require it
    // answers 488 to plain RTP, which is exactly what VoIP.ms did.
    this.srtp = !!srtp;
    this.log = log;
    // callId (Cantus) and SIP Call-ID are different namespaces; each leg holds
    // both so either side ending the call can find the other.
    this.legs = new Map();
    this.startedAt = Date.now();
    this.counters = { inbound: 0, outbound: 0, answered: 0, failed: 0 };
    this.rtpStart = rtpStart;
    this.rtpEnd = Math.max(rtpStart, rtpEnd);
    this.rtpNext = rtpStart;
    this.bind();
  }

  get address() {
    return this.advertise;
  }

  bind() {
    this.endpoint.onIncoming = (session, dialedTo) => {
      this.onCantusCall(session, dialedTo);
    };
    this.endpoint.onInboundMedia = (session, media) => {
      const leg = this.legs.get(session.call);
      if (leg?.rtp) leg.rtp.send(media.payload);
    };
    this.endpoint.mediaSource = (session) => {
      const leg = this.legs.get(session.call);
      return leg?.rtp ? leg.rtp.nextFrame() : SILENCE;
    };
    this.trunk.onInvite = (call, audio) => {
      call.audio = audio;
      this.onSipCall(call);
    };
    this.trunk.onBye = (call) => {
      const leg = this.sipLeg(call);
      if (leg?.sessionId) this.endpoint.hangup(leg.sessionId, 'NORMAL');
      this.dropLeg(leg);
    };
    this.trunk.onCancel = (call) => {
      const leg = this.sipLeg(call);
      if (leg?.sessionId) this.endpoint.hangup(leg.sessionId, 'CANCELLED');
      this.dropLeg(leg);
    };
  }

  /** Route the switch's own events to the leg they belong to. */
  onEndpointEvent(event) {
    const leg = this.legs.get(event.call);
    if (!leg) return;
    if (event.kind === 'accepted') {
      this.counters.answered += 1;
      if (leg.sipCall && !leg.sipCall.answered) {
        this.trunk.answer(leg.sipCall, { sdp: leg.offer });
      }
      return;
    }
    if (event.kind === 'rejected') {
      this.counters.failed += 1;
      if (leg.sipCall && !leg.sipCall.answered) {
        const [status, phrase] = sipStatusFor(event.reason);
        this.trunk.reject(leg.sipCall, status, phrase);
      }
      this.dropLeg(leg);
      return;
    }
    if (event.kind === 'dtmf') {
      // A keypress arrived from the switch (a console pressing a digit, or an
      // IVR on the Cantus side prompting a PSTN caller). The carrier only
      // understands an RTP event, so the digit is carried across as one.
      leg.rtp?.sendDtmf(event.digit);
      return;
    }
    if (event.kind === 'ended') {
      if (leg.sipCall) this.trunk.bye(leg.sipCall);
      this.dropLeg(leg);
    }
  }

  /** The next port in the configured range, wrapping at the end. */
  nextRtpPort() {
    const port = this.rtpNext;
    this.rtpNext = port >= this.rtpEnd ? this.rtpStart : port + 1;
    return port;
  }

  sipLeg(call) {
    for (const leg of this.legs.values()) if (leg.sipCall === call) return leg;
    return undefined;
  }

  dropLeg(leg) {
    if (!leg) return;
    this.legs.delete(leg.sessionId);
    leg.rtp?.close();
  }

  /**
   * A call arrived from the carrier: make it a Cantus call into the switch.
   *
   * The DID is the dialled address, so the same routing document that handles a
   * softphone call decides this one too. The gateway never chooses a line.
   */
  async onSipCall(call) {
    const number = sipUser(call.request?.get('to')) || sipUser(call.uri);
    const audio = call.audio;
    if (!number) {
      this.trunk.reject(call, 484, 'Address Incomplete');
      return;
    }
    // An encrypted offer needs both halves of an SDES pair: their key to read
    // what they send, and a key of ours for what we send back.
    let srtp = null;
    let crypto = '';
    if (audio?.secure) {
      const remote = parseCryptoAttribute(audio.crypto);
      if (!remote || !this.srtp) {
        this.log({
          kind: 'call-in-refused',
          number,
          from: sipUser(call.request?.get('from')),
          codec: remote ? 'srtp-disabled' : 'unsupported-crypto',
          media: audio.host ? `${audio.host}:${audio.port}` : '',
          offer: String(audio.crypto || '').slice(0, 120),
        });
        this.trunk.reject(call, 488, 'Not Acceptable Here');
        return;
      }
      const ours = newKeyMaterial();
      crypto = cryptoAttribute(ours);
      srtp = { receive: new SrtpContext(remote), send: new SrtpContext(ours) };
    }
    if (!audio?.pcmu) {
      // Only PCMU was offered, so anything else is a codec we cannot carry.
      // Logged with what was actually offered: a carrier that wants SRTP or a
      // codec this gateway does not have is otherwise indistinguishable from a
      // carrier that never sent an INVITE at all.
      this.log({
        kind: 'call-in-refused',
        number,
        from: sipUser(call.request?.get('from')),
        codec: audio ? 'no-pcmu' : 'no-audio',
        media: audio ? `${audio.host}:${audio.port}` : '',
        offer: String(call.request?.body || '').split('\r\n').filter((line) => /^(m=|a=crypto|a=rtpmap)/.test(line)).join(' | '),
      });
      this.trunk.reject(call, 488, 'Not Acceptable Here');
      return;
    }

    const rtp = new RtpSession({
      port: this.nextRtpPort(),
      // The carrier names its own event payload type in the offer. Guessing
      // 101 is how a keypress ends up decoded as one frame of silence.
      dtmfType: audio.dtmfType || DTMF,
      onError: (err) => this.log({ kind: 'rtp-error', call: call.callId, error: err.message }),
    });
    await rtp.start();
    rtp.to(audio.host, audio.port);
    rtp.srtp = srtp;

    const to = `${number}@${this.switchId}`;
    const sessionId = this.endpoint.call(to, {
      context: { source: 'sip', from: sipUser(call.request?.get('from')), to: number, call: call.callId },
    });
    if (!sessionId) {
      rtp.close();
      this.trunk.reject(call, 503, 'Service Unavailable');
      return;
    }

    // The carrier's keypresses become Cantus `INFO event=dtmf`, which is what
    // the switch's IVR routes and DTMF events already listen for.
    rtp.onDtmf = (digit) => {
      const session = this.endpoint.sessions.get(sessionId);
      if (session) this.endpoint.sendDtmf(session, digit);
      this.log({ kind: 'dtmf-in', call: sessionId, digit });
    };

    const leg = {
      sessionId,
      sipCall: call,
      rtp,
      // Answer only with an event type the carrier actually offered.
      offer: buildSdp({ address: this.address, port: rtp.port, crypto, dtmf: audio.dtmfType || 0 }),
      direction: 'inbound',
      srtp,
    };
    call.audio = audio;
    this.legs.set(sessionId, leg);
    this.counters.inbound += 1;
    this.log({ kind: 'call-in', call: sessionId, number, from: sipUser(call.request?.get('from')) });
  }

  /**
   * The switch invited us for a number: dial it at the carrier.
   *
   * The Cantus side is accepted only after the carrier answers, so a failed
   * outbound call has a cause the switch can record instead of silence.
   */
  async onCantusCall(session, dialedTo) {
    const number = dialledNumber(dialedTo);
    if (!number) {
      this.endpoint.reject(session, 'REJECTED');
      return;
    }
    if (!this.carrier) {
      this.log({ kind: 'call-out-refused', call: session.call, number, reason: 'no carrier configured' });
      this.endpoint.reject(session, 'REJECTED');
      return;
    }

    const rtp = new RtpSession({
      port: this.nextRtpPort(),
      onError: (err) => this.log({ kind: 'rtp-error', call: session.call, error: err.message }),
    });
    await rtp.start();

    // Offering SAVP is a promise to encrypt; the key travels with the offer and
    // is ours until the answer brings theirs back.
    const ours = this.srtp ? newKeyMaterial() : null;
    const leg = { sessionId: session.call, sipCall: null, rtp, offer: '', direction: 'outbound', number, ours };
    this.legs.set(session.call, leg);
    this.counters.outbound += 1;

    const sipCall = this.trunk.invite({
      to: number,
      sdp: buildSdp({ address: this.address, port: rtp.port, crypto: ours ? cryptoAttribute(ours) : '' }),
    });
    leg.sipCall = sipCall;
    this.log({ kind: 'call-out', call: session.call, number });

    sipCall.onAnswered = (answered, audio) => {
      if (!audio?.pcmu) {
        this.trunk.bye(answered);
        this.endpoint.reject(session, 'NO_CAPABILITY');
        this.dropLeg(leg);
        return;
      }
      rtp.to(audio.host, audio.port);
      // The answered stream may name a different payload type than we offered.
      rtp.dtmfType = audio.dtmfType || rtp.dtmfType;
      if (ours) {
        const remote = parseCryptoAttribute(audio.crypto);
        if (remote) {
          rtp.srtp = { send: new SrtpContext(ours), receive: new SrtpContext(remote) };
        } else {
          // They accepted RTP/SAVP and then answered as if it were plain RTP.
          // Rather than encrypt into a stream nobody can read, say so and carry
          // plain audio — a call with a warning beats a call with no sound.
          this.log({ kind: 'srtp-missing', number, detail: 'answer had no crypto attribute' });
        }
      }
      answered.audio = audio;
      this.endpoint.accept(session);
    };
    sipCall.onFailed = (reason) => {
      if (this.legs.get(session.call) !== leg) return;
      this.counters.failed += 1;
      // The carrier's own words. Without them a refused call is "rejected" on
      // the switch and nothing anywhere says whether it was a wrong number, a
      // caller ID the trunk is not allowed to present, or a blocked account.
      this.log({ kind: 'call-out-failed', call: session.call, number, reason });
      // `491` means the carrier already has a dialog for this call, `404` that
      // the number does not exist. Both are causes the switch can act on, and
      // flattening them into REJECTED is how a wrong number and a glare start
      // to look like the same outage.
      this.endpoint.reject(session, cantusReasonFor(reason));
      this.dropLeg(leg);
    };
  }

  /**
   * Encrypt carrier legs, or stop encrypting them, from now on.
   *
   * A call that is already up keeps the keys it negotiated — an SDP offer
   * cannot be renegotiated halfway through a sentence — so what this changes is
   * the next INVITE in either direction. The caller (the console) flips the
   * carrier's sub-account setting too; a gateway that offers SAVP to a carrier
   * that no longer expects it is refused with 488, and so is the reverse.
   */
  setSrtp(enabled) {
    const next = !!enabled;
    if (next === this.srtp) return this.srtp;
    this.srtp = next;
    this.log({ kind: 'srtp-changed', enabled: next });
    return this.srtp;
  }

  status() {
    return {
      ok: true,
      cantus: {
        id: this.endpoint.id,
        ready: this.endpoint.ready,
        relay: this.endpoint.relay,
        addr: this.endpoint.localAddr,
        sessions: this.endpoint.sessions.size,
        stats: this.endpoint.stats,
      },
      sip: {
        server: `${this.trunk.host}:${this.trunk.port}`,
        // What the next call will offer: RTP/SAVP with an SDES key when true.
        srtp: this.srtp,
        registered: this.trunk.registered,
        expiresAt: this.trunk.registerExpiresAt || null,
        error: this.trunk.lastRegisterError || '',
        port: this.trunk.bound,
      },
      calls: [...this.legs.values()].map((leg) => ({
        call: leg.sessionId,
        direction: leg.direction,
        number: leg.number || '',
        sipState: leg.sipCall?.state || '',
        frames: { in: leg.rtp?.received || 0, out: leg.rtp?.sent || 0 },
      })),
      counters: this.counters,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}
