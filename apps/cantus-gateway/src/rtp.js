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

/** 20 ms at 8 kHz. */
export const SAMPLES = 160;
export const PCM16_BYTES = SAMPLES * 2;
const SILENCE = Buffer.alloc(PCM16_BYTES);

export class RtpSession {
  constructor({ host = '0.0.0.0', port = 0, onFrame, onError } = {}) {
    this.host = host;
    // A fixed range, because a firewall rule cannot allow "whatever the kernel
    // picked": the gateway asks for the next free port in the range instead.
    this.requestedPort = port;
    this.onFrame = onFrame || (() => {});
    this.onError = onError || (() => {});
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
    if (type !== PCMU) return; // nothing else was offered, so nothing else arrives
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

  /** Send 20 ms of PCM16 to the carrier, as PCMU. */
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
    this.ts = (this.ts + SAMPLES) >>> 0;
    this.sent += 1;
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
