/**
 * The browser side of a Cantus line.
 *
 * One WebSocket carries everything: registration, call control, and 20 ms
 * frames of 8 kHz PCM16 in both directions. There is no SDP to build, no ICE to
 * fail, no DTLS to negotiate and no TURN server to pay for — a call either has
 * a path or the switch says why it does not.
 *
 * Audio is a WebAudio graph at the switch's own rate. Capture is resampled to
 * 8 kHz by the graph, playback is fed from a ring buffer that is paced by the
 * same 20 ms timer the switch uses, so latency stays flat instead of growing at
 * the rate of the clocks' disagreement.
 */

const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;

// `createScriptProcessor` only accepts 0 or a power of two from 256 to 16384.
// Handing it one 20 ms frame (160) throws a TypeError in every browser, so the
// graph runs at the smallest legal block and frames are re-blocked on both
// sides of it: capture accumulates into whole 160-sample frames before sending,
// playback carries the tail of a frame into the next block.
const BLOCK_SAMPLES = 256; // 32 ms at 8 kHz

export class CantusLine {
  constructor({ socketUrl, ticket, ext, sampleRate = 8000 } = {}) {
    this.socketUrl = socketUrl;
    this.ticket = ticket;
    this.ext = ext;
    this.sampleRate = sampleRate;
    this.state = 'off';
    this.muted = false;
    this.call = null;
    this.socket = null;
    this.context = null;
    this.playQueue = [];
    this.playBuffer = new Float32Array(FRAME_SAMPLES * 8);
    this.playRead = 0;
    this.playWrite = 0;
    this.analyser = null;
    this.outputStream = null;
    this.localStream = null;
    this.listeners = { state: new Set(), incoming: new Set(), call: new Set(), ended: new Set(), error: new Set() };
  }

  on(name, fn) {
    this.listeners[name]?.add(fn);
    return () => this.listeners[name]?.delete(fn);
  }

  emit(name, payload) {
    for (const fn of this.listeners[name] || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[cantus] listener failed', err);
      }
    }
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  get socketUrlForBrowser() {
    const base = this.socketUrl.startsWith('ws')
      ? this.socketUrl
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.socketUrl}`;
    const url = new URL(base);
    url.searchParams.set('ticket', this.ticket);
    url.searchParams.set('ext', this.ext);
    return url.toString();
  }

  async start() {
    this.setState('registering');
    await this.openAudio();
    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.socketUrlForBrowser);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';

      socket.addEventListener('open', () => {
        settled = true;
        resolve();
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('the switch refused the socket'));
        }
      });
      socket.addEventListener('close', (event) => {
        this.stopAudio();
        this.setState(this.state === 'off' ? 'off' : 'failed', { reason: event.reason || `closed (${event.code})` });
        this.emit('ended', { reason: event.reason || 'closed' });
        if (!settled) {
          settled = true;
          reject(new Error(event.reason || 'the switch closed the socket'));
        }
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') this.onControl(JSON.parse(event.data));
        else this.onAudio(new Int16Array(event.data));
      });
    });
    return this;
  }

  onControl(message) {
    switch (message.type) {
      case 'registered':
        this.setState('registered', { codec: message.codec, displayName: message.displayName });
        return;
      case 'incoming':
        this.call = { ...message, state: 'ringing', direction: 'inbound' };
        this.emit('incoming', message);
        this.emit('call', this.call);
        return;
      case 'cancelled':
        this.call = null;
        this.emit('ended', { callId: message.callId, reason: 'cancelled' });
        return;
      case 'ended':
        this.call = null;
        this.emit('ended', { callId: message.callId, reason: message.cause || 'ended' });
        return;
      case 'error':
        this.emit('error', message);
        return;
      default:
        return;
    }
  }

  /** Outbound audio: 20 ms of PCM16, straight from the media graph. */
  onAudio(samples) {
    if (this.playQueue.length > 40) this.playQueue.shift(); // never let latency grow
    this.playQueue.push(samples);
  }

  // ------------------------------------------------------------------- audio --

  async openAudio() {
    if (this.context) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass({ sampleRate: this.sampleRate });

    // Playback: a buffer pulled by the audio clock, with the media socket
    // filling it. This is what keeps a call from stuttering when a frame arrives
    // late: a missing frame plays as silence, not as a gap in time. The block is
    // 32 ms and a frame is 20 ms, so what does not fit is carried, never dropped.
    this.player = this.context.createScriptProcessor(BLOCK_SAMPLES, 0, 1);
    this.playCarry = new Float32Array(0);
    this.player.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      let written = 0;
      if (this.playCarry.length) {
        const take = Math.min(this.playCarry.length, out.length);
        out.set(this.playCarry.subarray(0, take), 0);
        this.playCarry = this.playCarry.subarray(take);
        written = take;
      }
      while (written < out.length) {
        const frame = this.playQueue.shift();
        if (!frame || !frame.length) break;
        const take = Math.min(frame.length, out.length - written);
        for (let i = 0; i < take; i += 1) out[written + i] = (frame[i] || 0) / 32768;
        written += take;
        if (take < frame.length) this.playCarry = frame.subarray(take);
      }
      if (written < out.length) out.fill(0, written);
    };
    this.player.connect(this.context.destination);

    // Local monitoring stream for the page's own volume and speaker controls.
    const destination = this.context.createMediaStreamDestination();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.player.connect(this.analyser);
    this.analyser.connect(destination);
    this.outputStream = destination.stream;

    // Capture: the microphone, resampled into the graph's 8 kHz rate.
    //
    // A browser only exposes `navigator.mediaDevices` in a secure context, and
    // `ALLOW_INSECURE_PUBLIC_URL` deliberately permits a plain-HTTP deployment.
    // There the property is simply absent, so the raw failure was "Cannot read
    // properties of undefined (reading 'getUserMedia')" — which names neither
    // the cause nor the remedy, and reads like a crash rather than "this origin
    // cannot open a microphone".
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error(
        'The browser withholds media capture on this origin: the softphone needs https:// or localhost, not plain HTTP.'
      );
      this.emit('error', { error: 'insecure-origin', message: error.message });
      throw error;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      this.emit('error', { error: 'microphone', message: err.message });
      throw err;
    }
    const source = this.context.createMediaStreamSource(this.localStream);
    // One output, muted: a capture node still has to be pulled by the graph to
    // run, and Chrome refuses to connect a ScriptProcessorNode that has no
    // outputs at all ("cannot connect … with 0 output channels"), which aborted
    // registration before the socket was ever opened.
    this.capture = this.context.createScriptProcessor(BLOCK_SAMPLES, 1, 1);
    let pending = [];
    let pendingLength = 0;
    this.capture.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      if (this.muted) return;
      pending.push(input.slice(0));
      pendingLength += input.length;
      while (pendingLength >= FRAME_SAMPLES) {
        const frame = new Int16Array(FRAME_SAMPLES);
        let filled = 0;
        while (filled < FRAME_SAMPLES) {
          const head = pending[0];
          const take = Math.min(head.length, FRAME_SAMPLES - filled);
          for (let i = 0; i < take; i += 1) frame[filled + i] = Math.max(-32768, Math.min(32767, Math.round(head[i] * 32767)));
          filled += take;
          if (take === head.length) pending.shift();
          else pending[0] = head.slice(take);
        }
        pendingLength -= FRAME_SAMPLES;
        if (this.socket?.readyState === WebSocket.OPEN && this.call) this.socket.send(frame.buffer);
      }
    };
    source.connect(this.capture);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.silent = silent;
    this.capture.connect(silent);
    silent.connect(this.context.destination);
  }

  stopAudio() {
    try {
      this.player?.disconnect();
      this.capture?.disconnect();
      this.analyser?.disconnect();
      this.silent?.disconnect();
    } catch {
      /* already torn down */
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.context?.close?.().catch?.(() => {});
    this.context = null;
    this.playQueue = [];
    this.playCarry = new Float32Array(0);
  }

  setMuted(muted) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  // -------------------------------------------------------------- call control --

  dial(target) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('the line is not connected');
    this.call = { state: 'dialing', direction: 'outbound', to: target };
    this.emit('call', this.call);
    this.socket.send(JSON.stringify({ type: 'call', to: target }));
  }

  answer() {
    if (!this.call?.callId) return;
    this.call.state = 'answered';
    this.socket.send(JSON.stringify({ type: 'answer', callId: this.call.callId }));
    this.emit('call', this.call);
  }

  reject() {
    this.hangup();
  }

  hangup() {
    if (!this.call?.callId) {
      this.call = null;
      return;
    }
    this.socket?.send(JSON.stringify({ type: 'hangup', callId: this.call.callId }));
    this.call = null;
  }

  sendDtmf(digit) {
    if (!this.call?.callId) return;
    this.socket?.send(JSON.stringify({ type: 'dtmf', callId: this.call.callId, digit }));
  }

  /** 0..1 room level, for the call's own meter. */
  level() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
    return Math.min(1, peak / 90);
  }

  stop() {
    this.hangup();
    try {
      this.socket?.close(1000, 'line stopped');
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.stopAudio();
    this.setState('off');
  }
}

export async function createLine(options) {
  const line = new CantusLine(options);
  await line.start();
  return line;
}
