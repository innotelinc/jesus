/**
 * A call placed from a browser line.
 *
 * The softphone dials over its own socket, the switch routes the number to a
 * trunk, and the gateway answers. What this file pins down is the part that was
 * missing: the socket that dialled is a leg of the call, so audio from the
 * carrier has somewhere to go and a hangup has a call to end. Before that, the
 * call was answered by the far end while the browser sat in silence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Switch } from '../src/switch.js';
import { CantusEndpoint } from '../src/endpoint.js';
import { waitUntil } from './wait.js';

function fakeLineSocket() {
  const sent = [];
  const text = [];
  return {
    sent,
    text,
    send: (payload) => sent.push(Buffer.from(payload)),
    sendJson: (message) => text.push(message),
    close: () => {},
    on: () => {},
  };
}

/** A line socket that behaves like the switch's own WebSocketConnection. */
function lineSocket({ answers = true } = {}) {
  const handlers = new Map();
  const socket = {
    closed: false,
    pinged: 0,
    closeCode: 0,
    sent: [],
    text: [],
    send: (payload) => socket.sent.push(Buffer.from(payload)),
    sendJson: (message) => socket.text.push(message),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
    ping: () => {
      socket.pinged += 1;
      // A browser answers at the protocol layer, without the page running.
      if (answers) socket.emit('pong');
    },
    close: (code = 1000) => {
      socket.closed = true;
      socket.closeCode = code;
      socket.emit('close', code);
    },
  };
  return socket;
}

function lineSwitch() {
  const sw = new Switch({
    domain: 'line.test',
    id: 'switch@line.test',
    secret: 'line-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
  });
  sw.setLine({ ext: '101', displayName: 'Demo Owner' });
  return sw;
}

function incomingCall(sw, id = 'call-stale') {
  const call = {
    id,
    direction: 'inbound',
    from: 'voipms',
    to: '14132642700@line.test',
    state: 'ringing',
    startedAt: Date.now(),
    events: [],
    legs: [],
  };
  sw.calls.set(call.id, call);
  return call;
}

test('re-sending the line document does not unregister a phone', () => {
  const sw = lineSwitch();
  const socket = lineSocket();
  sw.attachSocket(socket, { ext: '101' });
  assert.equal(sw.status().lines.find((line) => line.ext === '101').registered, 1);

  // The platform re-sends its document every 30 s; the phone never moves.
  for (let round = 0; round < 3; round += 1) {
    sw.setLine({ ext: '101', displayName: 'Demo Owner', numbers: ['+14132642700'] });
    const line = sw.lines.get('101');
    assert.equal(line.sockets.has(socket), true, 'the socket survives the refresh');
  }

  const status = sw.status().lines.find((line) => line.ext === '101');
  assert.equal(status.registered, 1, 'the line is still registered afterwards');
  assert.deepEqual(status.numbers, ['+14132642700'], 'and the new numbers were taken');

  const call = incomingCall(sw, 'call-after-sync');
  sw.ringTargets(call, '101', { timeout: 30 });
  assert.equal(call.legs.filter((leg) => leg.state === 'ringing').length, 1);
  sw.endCall(call, 'normal');
});

test('a line socket that stops answering is dropped, not rung', () => {
  const sw = lineSwitch();
  const dead = lineSocket({ answers: false });
  const live = lineSocket();
  sw.attachSocket(dead, { ext: '101' });
  sw.attachSocket(live, { ext: '101' });

  // The dead one was last seen over a minute ago; the live one answers the ping.
  sw.socketSeen.set(dead, Date.now() - 61_000);
  sw.lineHealthTick();

  assert.equal(dead.closed, true, 'a silent socket is closed');
  assert.equal(dead.closeCode, 4408);
  assert.equal(live.closed, false, 'a socket that answers the ping stays');
  const sockets = sw.lines.get('101').sockets;
  assert.equal(sockets.size, 1, 'the line keeps exactly the socket that answered');
  assert.equal(sockets.has(live), true);

  // The next call rings the phone that is there, once.
  const call = incomingCall(sw);
  sw.ringTargets(call, '101', { timeout: 30 });
  const ringing = call.legs.filter((leg) => leg.state === 'ringing');
  assert.equal(ringing.length, 1, `one ringing leg, got ${ringing.length}`);
  assert.equal(ringing[0].ws, live);
  sw.endCall(call, 'normal');
});

test('a dead socket is not rung even before the health check runs', () => {
  const sw = lineSwitch();
  const dead = lineSocket({ answers: false });
  const live = lineSocket();
  sw.attachSocket(dead, { ext: '101' });
  sw.attachSocket(live, { ext: '101' });
  sw.socketSeen.set(dead, Date.now() - 45_000);

  const call = incomingCall(sw, 'call-early');
  sw.ringTargets(call, '101', { timeout: 30 });
  const ringing = call.legs.filter((leg) => leg.state === 'ringing');
  assert.equal(ringing.length, 1, 'bridging must not wait on a phone that is gone');
  assert.equal(ringing[0].ws, live);
  sw.endCall(call, 'normal');
});

test('a line that keeps answering is never dropped', () => {
  const sw = lineSwitch();
  const socket = lineSocket();
  sw.attachSocket(socket, { ext: '101' });

  for (let round = 0; round < 10; round += 1) sw.lineHealthTick();
  assert.equal(socket.closed, false);
  assert.equal(socket.pinged, 10, 'a ping every round, so an idle line still proves itself');
  assert.equal(sw.lines.get('101').sockets.size, 1);
});

test('a call ringing a socket that goes silent ends instead of timing out', () => {
  const sw = lineSwitch();
  const socket = lineSocket({ answers: false });
  sw.attachSocket(socket, { ext: '101' });
  const call = incomingCall(sw, 'call-ring');
  sw.ringTargets(call, '101', { timeout: 30 });
  assert.equal(call.legs.filter((leg) => leg.state === 'ringing').length, 1);

  sw.socketSeen.set(socket, Date.now() - 61_000);
  sw.lineHealthTick();
  assert.equal(call.state, 'ended', 'the caller is not left listening to a ringback nobody can answer');
});

test('a line that dials learns its call id, and when the call connects', () => {
  const sw = lineSwitch();
  sw.setLine({ ext: '102', displayName: 'Second' });
  const caller = lineSocket();
  const callee = lineSocket();
  sw.attachSocket(caller, { ext: '101' });
  sw.attachSocket(callee, { ext: '102' });

  const legFor = (ws) => (callId) => {
    const call = sw.calls.get(callId);
    return call?.legs.find((leg) => leg.ws === ws && !leg.isEnded);
  };

  // The console dials another line on the same switch.
  sw.onSocketMessage(caller, sw.lines.get('101'), { type: 'call', to: '102' }, legFor(caller));
  const dialing = caller.text.find((message) => message.type === 'dialing');
  assert.ok(dialing, 'the dialling socket is told the id of the call it placed');
  assert.equal(typeof dialing.callId, 'string');

  const incoming = callee.text.find((message) => message.type === 'incoming');
  assert.equal(incoming.callId, dialing.callId, 'and it is the same call the other line rings for');

  // Until the far end answers, the caller's console has nothing to hold: the
  // switch says so rather than pretending.
  assert.equal(
    caller.text.some((message) => message.type === 'answered'),
    false,
    'no answered frame while the call is still ringing'
  );

  const call = sw.calls.get(dialing.callId);
  const ringing = call.legs.find((leg) => leg.ws === callee && leg.state === 'ringing');
  assert.ok(ringing, 'the callee has a ringing leg');
  sw.answerLeg(call, ringing);

  const answered = caller.text.find((message) => message.type === 'answered');
  assert.ok(
    answered,
    'the socket that dialled must learn the call connected, or its console sits on "Calling…" for the whole conversation'
  );
  assert.equal(answered.callId, call.id);
  assert.ok(
    callee.text.some((message) => message.type === 'answered'),
    'and the line that answered is confirmed rather than left guessing'
  );

  // Now the console can hold the call it dialled, with the id it was given.
  const callerLeg = call.legs.find((leg) => leg.ws === caller);
  assert.equal(sw.setHold(callerLeg, true), true, 'a dialled call can be held once it connects');
  assert.deepEqual(
    caller.text.filter((message) => message.type === 'held').map((message) => message.held),
    [true]
  );

  sw.onSocketMessage(caller, sw.lines.get('101'), { type: 'unhold', callId: call.id }, legFor(caller));
  assert.deepEqual(
    caller.text.filter((message) => message.type === 'held').map((message) => message.held),
    [true, false],
    'and resuming is the same call, not a new one'
  );

  sw.endCall(call, 'normal');
});

test('a call cancelled while ringing ends for both lines', () => {
  const sw = lineSwitch();
  sw.setLine({ ext: '102', displayName: 'Second' });
  const caller = lineSocket();
  const callee = lineSocket();
  sw.attachSocket(caller, { ext: '101' });
  sw.attachSocket(callee, { ext: '102' });

  const legFor = (ws) => (callId) => {
    const call = sw.calls.get(callId);
    return call?.legs.find((leg) => leg.ws === ws && !leg.isEnded);
  };

  sw.onSocketMessage(caller, sw.lines.get('101'), { type: 'call', to: '102' }, legFor(caller));
  const { callId } = caller.text.find((message) => message.type === 'dialing');

  // The `dialing` frame is what makes this possible: without the id, a stop
  // button had no call to name and the far line kept ringing.
  sw.onSocketMessage(caller, sw.lines.get('101'), { type: 'hangup', callId }, legFor(caller));
  assert.equal(sw.calls.get(callId).state, 'ended');
  const farewell = callee.text.filter(
    (message) => message.callId === callId && (message.type === 'ended' || message.type === 'cancelled')
  );
  assert.ok(
    farewell.length > 0,
    'the line that was ringing is told the call is gone, instead of ringing until its timeout'
  );
});

test('a line that dials carries the audio of the call it placed', async (t) => {
  const sw = new Switch({
    domain: 'line.test',
    id: 'switch@line.test',
    secret: 'line-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: {
      version: 1,
      default: { reject: 3 },
      // The route telno generates for a national number.
      routes: [{ name: 'national', when: { to: '1??????????@*' }, then: [{ trunk: { to: '*' } }] }],
    },
  });
  sw.setLine({ ext: '101', displayName: 'Demo Owner' });
  sw.setTrunk({ name: 'voipms', endpoint: 'voipms@gateway', numbers: ['14132642700'] });
  await sw.start();
  t.after(() => sw.stop());

  // The gateway: a Cantus endpoint that answers whatever is dialled at it.
  const peer = new CantusEndpoint({
    id: 'voipms@gateway',
    secret: 'line-test',
    bind: '127.0.0.1:0',
    relay: sw.relay.addr,
    onEvent: () => {},
  });
  peer.onIncoming = (session) => peer.accept(session);
  await peer.start();
  t.after(() => peer.stop());
  await waitUntil(() => peer.handle, { label: 'the gateway to register with the relay' });

  const socket = fakeLineSocket();
  const call = sw.originate({ from: '101', to: '14134210134@line.test', ws: socket, ext: '101' });
  assert.equal(call.route, 'national');

  const web = call.legs.find((leg) => leg.ws === socket);
  assert.ok(web, 'the dialling socket is a leg of its own call');
  await waitUntil(() => web.state === 'answered' && socket.sent.length > 2, {
    label: 'the carrier to answer and the line to receive audio',
  });
  assert.equal(web.state, 'answered');
  assert.ok(
    socket.sent.length > 2,
    'the browser must receive audio, or a call the carrier answered is silence on this side'
  );

  // Hanging up from the line ends the whole call, trunk leg included.
  sw.onSocketMessage(socket, sw.lines.get('101'), { type: 'hangup', callId: call.id }, (id) =>
    call.legs.find((leg) => leg.ws === socket && leg.call.id === id)
  );
  await waitUntil(() => call.state === 'ended', { label: 'the hangup to end the call' });
  assert.equal(call.state, 'ended');
});
