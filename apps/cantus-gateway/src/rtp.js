/**
 * RTP for one call leg: one socket, one remote endpoint, PCMU only.
 *
 * The gateway's whole job is to translate between the two worlds it sits in.
 * Cantus carries 20 ms of PCM16 on the signalling socket; the carrier expects
 * 20 ms of G.711 µ-law in RTP packets. That is the only codec difference there
 * is, which is why this file is small: PCMU is 8000 Hz, 8 bits, no framing, no
 * comfort noise, no PLC and no renegotiation.
 *
 * Sequence numbers and timestamps are ours to own. Nothing downstream cares
 * what they were before the gateway, only that they advance by one and by 160.
 */

import dgram from 'node:dgram';

import { pcm16ToUlaw, ulawToPcm16 } from '../../cantus-switch/src/media.js';

/** Payload type 0 in the static table: PCMU, 8000 Hz, mono. */
export const PCMU = 0;

/** The dynamic payload type this gateway offers for RFC 4733 keypresses. */
export const DTMF = 101;

/** 20 ms at 8 kHz. */
export const SAMPLES = 160;
export const PCM16_BYTES = SAMPLES * 2;
const SILENCE = Buffer.alloc(PCM16_BYTES);

/** RFC 4733 event codes: the sixteen keys a telephone keypad can send. */
const EVENT_CODES = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15 };
const EVENT_KEYS = Object.fromEntries(Object.entries(EVENT_CODES).map(([key, code]) => [code, key]));

/**
 * RFC 4733 digit to event code, or `null` for something that is not a key.
 *
 * Cantus carries `INFO event=dtmf` for a digit; the carrier expects an event
 * number. Keeping the table in one place is what stops `*` from arriving as
 * `10` at one side and as a literal asterisk at the other.
 */
export const dtmfEvent = (digit) => {
  const key = String(digit ?? '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(EVENT_CODES, key) ? EVENT_CODES[key] : null;
};

export class RtpSession {
  constructor({ host = '0.0.0.0', port = 0, onFrame, onError, onDtmf, dtmfType = DTMF } = {}) {
    this.host = host;
    // A fixed range, because a firewall rule cannot allow "whatever the kernel
    // picked": the gateway asks for the next free port in the range instead.
    this.requestedPort = port;
    this.onFrame = onFrame || (() => {});
    this.onError = onError || (() => {});
    // A carrier may answer with a different dynamic payload type than we
    // offered; the SDP is what decides, not the constant above.
    this.onDtmf = onDtmf || (() => {});
    this.dtmfType = Number(dtmfType) || DTMF;
    // One keypress arrives as a burst of packets with the same event code, so
    // the last one seen is remembered and only a new start bit is reported.
    this.lastEvent = -1;
    this.socket = null;
    this.port = 0;
    this.remote = null;
    this.seq = Math.floor(Math.random() * 0xffff);
    this.ts = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    // One frame of playout: enough to absorb the jitter of a single late
    // packet, small enough that a caller does not hear the delay.
    this.queue = [];
    this.received = 0;
    this.sent = 0;
    // `{ send, receive }` of SrtpContext, attached when the SDP turns out to be
    // encrypted. SDES keys each direction separately: `send` holds the key we
    // put in our SDP, `receive` the one the far side gave us.
    this.srtp = null;
    this.dropped = 0;
  }

  /** Bind an ephemeral port and report the port the carrier should send to. */
  async start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this.handle(buf, rinfo));
    this.socket.on('error', (err) => this.onError(err));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.requestedPort, this.host, () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    this.port = this.socket.address().port;
    return this.port;
  }

  /** Where to send. Taken from the far side's SDP, not from its SIP source. */
  to(host, port) {
    this.remote = { host, port };
    return this;
  }

  handle(buf) {
    if (!buf || buf.length <= 12) return;
    let packet = buf;
    if (this.srtp?.receive) {
      // An unauthenticated packet is not audio. Dropping it here is the point of
      // the tag: a forged or replayed frame never reaches the switch.
      packet = this.srtp.receive.unprotect(buf);
      if (!packet) {
        this.dropped += 1;
        return;
      }
    }
    const type = packet[1] & 0x7f;
    if (type === this.dtmfType) {
      this.handleDtmf(packet.subarray(12));
      return;
    }
    if (type !== PCMU) return; // nothing else was negotiated, so nothing else arrives
    const payload = packet.subarray(12);
    this.received += 1;
    // A three-frame queue is about 60 ms of slack. Beyond that the audio is
    // stale, so the oldest frame is dropped rather than played late — the same
    // choice the switch makes on its own legs.
    if (this.queue.length > 3) this.queue.shift();
    this.queue.push(ulawToPcm16(payload));
  }

  /**
   * The next 20 ms toward Cantus.
   *
   * The switch pulls one frame per media tick; if the carrier is silent or a
   * packet is late, the answer is silence of exactly the right length. A short
   * frame would desynchronise the tag/timestamp the far end expects.
   */
  nextFrame() {
    return this.queue.shift() || SILENCE;
  }

  /**
   * Read one keypress out of an RFC 4733 packet.
   *
   * The event is reported once, on the packet that starts it. Every packet in
   * the burst repeats the same event number with a growing duration, and a
   * receiver that forwards each one would send a digit per packet — a caller
   * pressing `1` once would hear an IVR menu taken eleven times.
   */
  handleDtmf(payload) {
    if (payload.length < 4) return;
    const event = payload[0];
    const ended = (payload[1] & 0x80) !== 0;
    if (ended) {
      this.lastEvent = -1;
      return;
    }
    if (event === this.lastEvent) return;
    this.lastEvent = event;
    const digit = EVENT_KEYS[event];
    if (digit !== undefined) this.onDtmf(digit, { event, duration: payload.readUInt16BE(2) });
  }

  /** One RFC 4733 packet: header, event code, end bit, volume, duration. */
  dtmfPacket({ event, ended, duration }) {
    const packet = Buffer.alloc(16);
    packet[0] = 0x80; // version 2
    packet[1] = this.dtmfType;
    packet.writeUInt16BE(this.seq & 0xffff, 2);
    packet.writeUInt32BE(this.ts >>> 0, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    packet[12] = event;
    packet[13] = (ended ? 0x80 : 0x00) | 0x0a; // E bit, volume 10
    packet.writeUInt16BE(Math.min(0xffff, duration) & 0xffff, 14);
    this.seq = (this.seq + 1) & 0xffff;
    return packet;
  }

  /**
   * Send a keypress to the carrier.
   *
   * The start and end packets carry the same timestamp, so the duration field —
   * not the clock — says how long the key was held. The audio timestamp is left
   * where it was: a digit is not 20 ms of speech and must not consume its slot.
   */
  sendDtmf(digit, { duration = SAMPLES * 2 } = {}) {
    if (!this.socket || !this.remote) return false;
    const event = dtmfEvent(digit);
    if (event === null) return false;
    this.transmit(this.dtmfPacket({ event, ended: false, duration }));
    this.transmit(this.dtmfPacket({ event, ended: true, duration }));
    return true;
  }

  /** Send one frame of PCM16 to the carrier, as PCMU. */
  send(pcm16) {
    if (!this.socket || !this.remote) return;
    const payload = pcm16ToUlaw(pcm16);
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80; // version 2
    packet[1] = PCMU;
    packet.writeUInt16BE(this.seq & 0xffff, 2);
    packet.writeUInt32BE(this.ts >>> 0, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    payload.copy(packet, 12);
    this.seq = (this.seq + 1) & 0xffff;
    // The timestamp advances by the audio actually in the packet, not by a
    // constant. µ-law is one byte per sample at 8 kHz, so a payload that is not
    // 160 bytes (an upstream leg that sent 40 ms instead of 20) would otherwise
    // advertise 20 ms of time for 40 ms of audio and the carrier would play the
    // stream back at double speed with the packets overlapping.
    this.ts = (this.ts + payload.length) >>> 0;
    this.sent += 1;
    this.transmit(packet);
  }

  transmit(packet) {
    const outbound = this.srtp?.send ? this.srtp.send.protect(packet) : packet;
    try {
      this.socket.send(outbound, this.remote.port, this.remote.host);
    } catch (err) {
      this.onError(err);
    }
  }

  close() {
    this.queue = [];
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }
}
