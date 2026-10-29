/**
 * The browser side of a Cantus line, for the control center's softphone.
 *
 * One WebSocket carries registration, call control and 20 ms frames of 8 kHz
 * PCM16 in both directions. There is no SDP to build, no ICE to gather, no DTLS
 * to negotiate and no TURN server to run: the console is same-origin with the
 * switch's line socket through this dashboard's own proxy, so the only
 * certificate the browser sees is the one it already trusts.
 *
 * The wire contract is the switch's: `apps/cantus-switch/src/switch.js`
 * (`attachSocket`, `onSocketMessage`, `setHold`) is the reference, and the
 * telno console speaks the same protocol. Nothing here is invented locally —
 * in particular `held` is echoed by the switch rather than assumed, because a
 * hold the switch refused would otherwise show as held while the far end is
 * still live.
 */

/** 20 ms of 8 kHz PCM16 — the switch's own frame, not a negotiated one. */
const FRAME_SAMPLES = 160;

/**
 * `ScriptProcessorNode` only accepts 0 or a power of two from 256 to 16384.
 * Handing it one 20 ms frame (160) throws in every browser, so the graph runs
 * at the smallest legal block and frames are re-blocked on both sides of it.
 */
const BLOCK_SAMPLES = 256;

export type LineState = 'off' | 'registering' | 'registered' | 'failed';
export type CallState = 'dialing' | 'ringing' | 'active' | 'ended';

export interface LineCall {
  callId: string;
  direction: 'inbound' | 'outbound';
  /** The far end as the switch named it (a number, an extension or a trunk). */
  remote: string;
  state: CallState;
  /** Set by the switch, never hoped for locally. */
  held: boolean;
}

export interface LineEvents {
  state: { state: LineState; displayName?: string; codec?: string; reason?: string };
  call: LineCall;
  ended: { callId?: string; reason: string };
  held: { callId?: string; held: boolean };
  error: { error: string; message: string };
  level: { level: number };
}

type Listener = (payload: never) => void;

/** The slice of WebSocket this client needs, so a test can supply its own. */
export interface LineSocket {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, handler: (event: never) => void): void;
}

export interface LineOptions {
  /** Same-origin socket path, or an absolute ws(s):// URL. */
  socketPath?: string;
  ext: string;
  /** Single-use ticket when the platform mints one; empty for a bare line. */
  ticket?: string;
  /**
   * `false` builds the protocol only. The unit tests use it, because jsdom has
   * no WebAudio and the protocol is what has to be pinned down.
   */
  audio?: boolean;
  socketFactory?: (url: string) => LineSocket;
}

const OPEN = 1;

export class CantusLine {
  socketPath: string;
  ext: string;
  ticket: string;
  state: LineState = 'off';
  held = false;
  muted = false;
  call: LineCall | null = null;

  private audioEnabled: boolean;
  private socket: LineSocket | null = null;
  private closing = false;
  private factory: (url: string) => LineSocket;
  private context: AudioContext | null = null;
  private localStream: MediaStream | null = null;
  private player: ScriptProcessorNode | null = null;
  private capture: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private playQueue: Int16Array[] = [];
  private playCarry = new Float32Array(0);
  private listeners = new Map<keyof LineEvents, Set<Listener>>();

  constructor({ socketPath = '/ws', ext, ticket = '', audio = true, socketFactory }: LineOptions) {
    this.socketPath = socketPath;
    this.ext = ext;
    this.ticket = ticket;
    this.audioEnabled = audio;
    this.factory =
      socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as LineSocket);
  }

  on<K extends keyof LineEvents>(name: K, fn: (payload: LineEvents[K]) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn as Listener);
    return () => this.listeners.get(name)?.delete(fn as Listener);
  }

  private emit<K extends keyof LineEvents>(name: K, payload: LineEvents[K]) {
    for (const fn of this.listeners.get(name) || []) {
      try {
        (fn as (value: LineEvents[K]) => void)(payload);
      } catch (err) {
        console.error('[cantus] listener failed', err);
      }
    }
  }

  private setState(state: LineState, detail: Partial<LineEvents['state']> = {}) {
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  /** The URL the switch expects: path, then `ext`, then the ticket if any. */
  get url() {
    const base = /^wss?:\/\//.test(this.socketPath)
      ? this.socketPath
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.socketPath}`;
    const url = new URL(base);
    url.searchParams.set('ext', this.ext);
    if (this.ticket) url.searchParams.set('ticket', this.ticket);
    return url.toString();
  }

  /**
   * Open the line.
   *
   * Registration does not open the microphone: an operator who only wants to
   * watch a line, or who has not yet plugged in a headset, should not be met by
   * a permission prompt. The media graph is built on the first call or answer,
   * which is also a user gesture, so autoplay policy has nothing to object to.
   */
  async start() {
    this.setState('registering');
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.addEventListener('open', () => {
        settled = true;
        resolve();
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('the line socket could not be reached'));
        }
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') this.onControl(JSON.parse(event.data));
        else this.onAudio(new Int16Array(event.data as ArrayBuffer));
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        this.stopAudio();
        // A close this page asked for is the line going away quietly; any other
        // close is the switch refusing the line or losing it, and both are
        // failures an operator has to see rather than a phone that looks idle.
        if (this.closing) return;
        const reason = event?.reason || `closed (${event?.code ?? 1006})`;
        this.setState('failed', { reason });
        if (this.call) {
          this.call = null;
          this.held = false;
          this.emit('ended', { reason });
        }
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        }
      });
    });
    return this;
  }

  private onControl(message: Record<string, unknown>) {
    switch (message.type) {
      case 'registered':
        this.setState('registered', {
          displayName: message.displayName as string | undefined,
          codec: message.codec as string | undefined,
        });
        return;
      case 'dialing':
        // The id of the call this socket just placed lives on the switch; until
        // it arrives there is nothing to name in `hangup` or `hold`.
        if (this.call) {
          this.call.callId = String(message.callId || '');
          if (message.state === 'ended') {
            const reason = String(message.cause || 'failed');
            this.call = null;
            this.emit('ended', { reason });
            return;
          }
          this.emit('call', this.call);
        }
        return;
      case 'answered':
        // The far end picked up. Without this the dialling console never leaves
        // "Calling…", so its own hold and keypad had no connected call to act
        // on while audio was already flowing.
        if (this.call) {
          if (message.callId) this.call.callId = String(message.callId);
          this.call.state = 'active';
          this.emit('call', this.call);
        }
        return;
      case 'incoming':
        this.call = {
          callId: String(message.callId),
          direction: 'inbound',
          remote: String(message.from || 'unknown'),
          state: 'ringing',
          held: false,
        };
        this.emit('call', this.call);
        return;
      case 'cancelled':
      case 'ended':
        this.call = null;
        this.held = false;
        this.emit('ended', {
          callId: message.callId as string | undefined,
          reason: String(message.cause || message.reason || message.type),
        });
        return;
      case 'held':
        // The switch decides; the page shows what it decided.
        this.held = !!message.held;
        if (this.call) this.call.held = this.held;
        this.emit('held', { callId: message.callId as string | undefined, held: this.held });
        return;
      case 'error':
        this.emit('error', {
          error: String(message.error || 'error'),
          message: String(message.message || message.error || 'the line reported an error'),
        });
        return;
      default:
        return;
    }
  }

  // --------------------------------------------------------------------- audio

  private async ensureAudio() {
    if (!this.audioEnabled || this.context) return;
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextClass({ sampleRate: 8000 });
    this.context = context;

    // Playback: a buffer pulled by the audio clock, filled by the socket. A
    // frame that arrives late plays as silence instead of stalling the call,
    // and the 32 ms block carries the tail rather than dropping it.
    const player = context.createScriptProcessor(BLOCK_SAMPLES, 0, 1);
    player.onaudioprocess = (event) => {
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
        if (take < frame.length) {
          // The rest of the frame is carried as floats: the carry is already
          // scaled for the output buffer, so it is not a second PCM frame.
          const rest = frame.subarray(take);
          const carry = new Float32Array(rest.length);
          for (let i = 0; i < rest.length; i += 1) carry[i] = (rest[i] || 0) / 32768;
          this.playCarry = carry;
        }
      }
      if (written < out.length) out.fill(0, written);
    };
    player.connect(context.destination);
    this.player = player;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    player.connect(this.analyser);

    // Capture: the microphone, resampled into the graph's 8 kHz rate.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This origin cannot open a microphone: the softphone needs https:// or a loopback origin.',
      );
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream = stream;
    const source = context.createMediaStreamSource(stream);
    const capture = context.createScriptProcessor(BLOCK_SAMPLES, 1, 1);
    const pending: Float32Array[] = [];
    let pendingLength = 0;
    capture.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      // A held or muted line sends nothing. The switch also drops frames from a
      // held leg, so this is the courtesy, not the enforcement.
      if (this.muted || this.held) return;
      pending.push(input.slice(0));
      pendingLength += input.length;
      while (pendingLength >= FRAME_SAMPLES) {
        const frame = new Int16Array(FRAME_SAMPLES);
        let filled = 0;
        while (filled < FRAME_SAMPLES) {
          const head = pending[0];
          const take = Math.min(head.length, FRAME_SAMPLES - filled);
          for (let i = 0; i < take; i += 1) {
            frame[filled + i] = Math.max(-32768, Math.min(32767, Math.round(head[i] * 32767)));
          }
          filled += take;
          if (take === head.length) pending.shift();
          else pending[0] = head.slice(take);
        }
        pendingLength -= FRAME_SAMPLES;
        if (this.socket?.readyState === OPEN && this.call) this.socket.send(frame.buffer);
      }
    };
    source.connect(capture);
    // A capture node still has to be pulled by the graph to run, and Chrome
    // refuses to connect one with no outputs at all; the gain is zero so the
    // microphone is never played back into the room.
    const silent = context.createGain();
    silent.gain.value = 0;
    capture.connect(silent);
    silent.connect(context.destination);
    this.capture = capture;
  }

  private onAudio(samples: Int16Array) {
    if (this.playQueue.length > 40) this.playQueue.shift(); // never let latency grow
    this.playQueue.push(samples);
  }

  private stopAudio() {
    try {
      this.player?.disconnect();
      this.capture?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* already torn down */
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.context?.close?.().catch?.(() => undefined);
    this.context = null;
    this.player = null;
    this.capture = null;
    this.analyser = null;
    this.playQueue = [];
    this.playCarry = new Float32Array(0);
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

  // -------------------------------------------------------------- call control

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async dial(target: string) {
    const to = target.trim();
    if (!to) throw new Error('nothing to dial');
    if (!this.socket || this.socket.readyState !== OPEN) throw new Error('the line is not connected');
    await this.ensureAudio();
    this.call = { callId: '', direction: 'outbound', remote: to, state: 'dialing', held: false };
    this.emit('call', this.call);
    this.send({ type: 'call', to });
  }

  async answer() {
    const call = this.call;
    if (!call?.callId) return;
    await this.ensureAudio();
    call.state = 'active';
    this.send({ type: 'answer', callId: call.callId });
    this.emit('call', call);
  }

  /**
   * Hold: the other party hears music and this line hears nothing.
   *
   * Nothing is torn down, because hold changes what each side hears rather than
   * ending anything — which is why resume can always bring the conversation
   * back. `held` is not set here: the switch's `held` echo sets it.
   */
  hold() {
    if (!this.call?.callId) return;
    // The switch answers a hold on a call it cannot hold with `not-connected`,
    // so nothing here needs to guess whether the call is answered.
    this.send({ type: 'hold', callId: this.call.callId });
  }

  unhold() {
    if (!this.call?.callId) return;
    this.send({ type: 'unhold', callId: this.call.callId });
  }

  hangup() {
    const call = this.call;
    if (!call?.callId) {
      this.call = null;
      return;
    }
    this.send({ type: 'hangup', callId: call.callId });
    this.call = null;
  }

  sendDtmf(digit: string) {
    if (!this.call?.callId) return;
    this.send({ type: 'dtmf', callId: this.call.callId, digit });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  stop() {
    this.closing = true;
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
