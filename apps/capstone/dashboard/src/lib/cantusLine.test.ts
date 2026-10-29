import { describe, expect, it } from 'vitest';
import { CantusLine, type LineSocket } from './cantusLine';

/**
 * A WebSocket that records what the client sends and lets a test play the
 * switch. The protocol is the part that has to be right: an operator's Hold
 * button is a JSON message and a switch's echo, nothing more.
 */
class FakeSocket implements LineSocket {
  readyState = 1;
  binaryType = 'arraybuffer';
  sent: (string | ArrayBuffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, ((event: never) => void)[]>();

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  addEventListener(type: string, handler: (event: never) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  emit(type: string, payload: unknown = {}) {
    for (const handler of this.handlers.get(type) || []) {
      (handler as (event: unknown) => void)(payload);
    }
  }

  /** Control frames the client sent, parsed. */
  get control(): Record<string, unknown>[] {
    return this.sent.filter((entry): entry is string => typeof entry === 'string').map((entry) => JSON.parse(entry));
  }

  get last(): Record<string, unknown> | undefined {
    const control = this.control;
    return control[control.length - 1];
  }
}

async function registeredLine(ext = '101') {
  const socket = new FakeSocket();
  const line = new CantusLine({ ext, audio: false, socketFactory: () => socket });
  const started = line.start();
  socket.emit('open');
  await started;
  socket.emit('message', { data: JSON.stringify({ type: 'registered', ext, displayName: 'Reception', codec: 'pcm-s16/8000/1' }) });
  return { line, socket };
}

/** An answered call, the state hold applies to. */
async function liveCall() {
  const { line, socket } = await registeredLine();
  socket.emit('message', {
    data: JSON.stringify({ type: 'incoming', callId: 'call-1', from: '14132642700', to: '101' }),
  });
  await line.answer();
  return { line, socket };
}

function message(type: string, payload: Record<string, unknown> = {}) {
  return { data: JSON.stringify({ type, ...payload }) };
}

describe('Cantus line', () => {
  it('asks the switch for the extension, and the ticket when there is one', async () => {
    const socket = new FakeSocket();
    const line = new CantusLine({
      ext: '101',
      ticket: 't-123',
      audio: false,
      socketFactory: () => socket,
    });
    const url = new URL(line.url);
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('ext')).toBe('101');
    expect(url.searchParams.get('ticket')).toBe('t-123');

    const started = line.start();
    socket.emit('open');
    await started;
    socket.emit('message', message('registered', { ext: '101' }));
    expect(line.state).toBe('registered');
  });

  it('registers without touching the microphone', async () => {
    // An operator who only watches a line should not be met by a permission
    // prompt; the media graph is built on the first call or answer instead.
    const defined = 'mediaDevices' in navigator;
    const { line } = await registeredLine();
    expect(line.state).toBe('registered');
    expect('mediaDevices' in navigator).toBe(defined);
  });

  it('dials through the socket and takes the answer as the call', async () => {
    const { line, socket } = await registeredLine();
    await line.dial('8000');
    expect(socket.last).toEqual({ type: 'call', to: '8000' });

    socket.emit('message', message('incoming', { callId: 'call-9', from: '101' }));
    expect(line.call).toMatchObject({ callId: 'call-9', direction: 'inbound', state: 'ringing' });

    await line.answer();
    expect(socket.last).toEqual({ type: 'answer', callId: 'call-9' });
    expect(line.call?.state).toBe('active');
  });

  it('takes the call id the switch mints, and connects when the far end answers', async () => {
    const { line, socket } = await registeredLine();
    const states: string[] = [];
    line.on('call', (call) => states.push(call.state));

    await line.dial('102');
    // The id is the switch's, so a hangup during ringback has a call to name.
    socket.emit('message', message('dialing', { callId: 'call-7', to: '102', state: 'ringing' }));
    expect(line.call).toMatchObject({ callId: 'call-7', state: 'dialing' });
    line.hangup();
    expect(socket.last).toEqual({ type: 'hangup', callId: 'call-7' });

    await line.dial('103');
    socket.emit('message', message('dialing', { callId: 'call-8', to: '103', state: 'ringing' }));
    socket.emit('message', message('answered', { callId: 'call-8', from: '101', to: '103' }));
    expect(line.call).toMatchObject({ callId: 'call-8', state: 'active' });
    expect(states).toContain('active');

    // A connected call is exactly what hold needs, whichever way it was made.
    line.hold();
    expect(socket.last).toEqual({ type: 'hold', callId: 'call-8' });
  });

  it('gives up on a call the switch could not route', async () => {
    const { line, socket } = await registeredLine();
    const reasons: string[] = [];
    line.on('ended', ({ reason }) => reasons.push(reason));

    await line.dial('9999');
    socket.emit('message', message('dialing', { callId: 'call-x', to: '9999', state: 'ended', cause: 'no-route' }));

    expect(reasons).toEqual(['no-route']);
    expect(line.call).toBeNull();
  });

  it('holds and resumes the call it is on', async () => {
    const { line, socket } = await liveCall();
    const states: boolean[] = [];
    line.on('held', ({ held }) => states.push(held));

    line.hold();
    expect(socket.last).toEqual({ type: 'hold', callId: 'call-1' });
    // Nothing is claimed until the switch says so.
    expect(line.held).toBe(false);

    socket.emit('message', message('held', { callId: 'call-1', held: true }));
    expect(line.held).toBe(true);

    line.unhold();
    expect(socket.last).toEqual({ type: 'unhold', callId: 'call-1' });
    socket.emit('message', message('held', { callId: 'call-1', held: false }));

    expect(states).toEqual([true, false]);
    expect(line.held).toBe(false);
    // The call was never torn down, which is why resume cannot lose it.
    expect(line.call).toMatchObject({ callId: 'call-1', state: 'active' });
  });

  it('surfaces a refused hold instead of showing a held call that is not', async () => {
    const { line, socket } = await registeredLine();
    const errors: string[] = [];
    line.on('error', ({ error }) => errors.push(error));

    // Nothing to hold: the switch answers `not-connected`.
    line.hold();
    expect(socket.last).toBeUndefined();
    socket.emit('message', message('error', { error: 'not-connected', message: 'Only a connected call can be held.' }));

    expect(errors).toEqual(['not-connected']);
    expect(line.held).toBe(false);
  });

  it('sends digits, ends the call, and forgets it on a hangup from either side', async () => {
    const { line, socket } = await liveCall();
    line.sendDtmf('5');
    expect(socket.last).toEqual({ type: 'dtmf', callId: 'call-1', digit: '5' });

    let ended: string | undefined;
    line.on('ended', ({ reason }) => (ended = reason));
    socket.emit('message', message('ended', { callId: 'call-1', cause: 'normal' }));
    expect(ended).toBe('normal');
    expect(line.call).toBeNull();

    // A local hangup stops the line from sending more media for that call.
    const second = await liveCall();
    second.line.hangup();
    expect(second.socket.last).toEqual({ type: 'hangup', callId: 'call-1' });
    expect(second.line.call).toBeNull();
  });

  it('reports a refused socket instead of pretending to be registered', async () => {
    const socket = new FakeSocket();
    const line = new CantusLine({ ext: '404', audio: false, socketFactory: () => socket });
    const started = line.start();
    socket.emit('open');
    await started;

    socket.emit('close', { code: 4404, reason: 'unknown line' });
    expect(line.state).toBe('failed');
  });
});
