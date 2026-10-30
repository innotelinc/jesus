/**
 * RTP and the bridge. The RTP half runs over real sockets on loopback, because
 * the thing worth testing is that a packet written by one side is the audio
 * read by the other — not that a parser accepts its own output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RtpSession, PCMU, SAMPLES } from '../src/rtp.js';
import { Gateway, dialledNumber, sipUser } from '../src/gateway.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a 20 ms frame survives the trip to the carrier and back', async (t) => {
  const a = new RtpSession();
  const b = new RtpSession();
  t.after(() => {
    a.close();
    b.close();
  });
  await a.start();
  await b.start();
  a.to('127.0.0.1', b.port);
  b.to('127.0.0.1', a.port);

  // A ramp at half scale: far enough from 0 to survive µ-law's quantisation.
  const pcm = Buffer.alloc(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), i * 2);

  a.send(pcm);
  await sleep(80);

  assert.equal(b.received, 1, 'exactly one packet should have arrived');
  const received = b.nextFrame();
  assert.equal(received.length, SAMPLES * 2);

  let worst = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    worst = Math.max(worst, Math.abs(pcm.readInt16LE(i * 2) - received.readInt16LE(i * 2)));
  }
  // µ-law is logarithmic: the error is small in absolute terms at speech level.
  assert.ok(worst < 700, `µ-law round-trip error should stay small, got ${worst}`);
});

test('an empty queue answers with exactly one frame of silence', async (t) => {
  const session = new RtpSession();
  t.after(() => session.close());
  await session.start();
  const silence = session.nextFrame();
  assert.equal(silence.length, SAMPLES * 2);
  assert.ok(silence.every((byte) => byte === 0));
});

test('the payload type is PCMU and the sequence advances', async (t) => {
  const a = new RtpSession();
  const b = new RtpSession();
  t.after(() => {
    a.close();
    b.close();
  });
  await a.start();
  await b.start();
  a.to('127.0.0.1', b.port);
  const before = a.seq;
  a.send(Buffer.alloc(SAMPLES * 2));
  assert.equal(a.seq, (before + 1) & 0xffff);
  assert.equal(PCMU, 0);
});

/** A stand-in for the switch's endpoint, with the surface the gateway uses. */
function fakeEndpoint() {
  return {
    id: 'voipms@gateway',
    localAddr: '127.0.0.1:7453',
    ready: true,
    relay: '127.0.0.1:7444',
    sessions: new Map(),
    stats: {},
    calls: [],
    call(to) {
      this.calls.push(to);
      const id = `call-${this.calls.length}`;
      this.sessions.set(id, { call: id });
      return id;
    },
    accept(session) {
      this.accepted = session?.call ?? session;
    },
    reject(session, reason) {
      // The real endpoint takes the Session object; the test only needs its id.
      this.rejected = { id: session?.call ?? session, reason };
    },
    hangup(session, reason) {
      this.ended = { id: session?.call ?? session, reason };
    },
  };
}

function fakeTrunk() {
  return {
    host: 'atlanta.voip.ms',
    port: 5060,
    bound: 5060,
    registered: true,
    registerExpiresAt: 0,
    lastRegisterError: '',
    invites: [],
    invite({ to, sdp }) {
      this.invites.push({ to, sdp });
      const call = { kind: 'outbound', callId: 'sip-out-1', state: 'calling', answered: false };
      this.lastCall = call;
      return call;
    },
    answer(call, { sdp }) {
      this.answeredWith = sdp;
      call.answered = true;
    },
    reject(call, status, reason) {
      this.refused = { status, reason };
      call.answered = true;
    },
    bye(call) {
      this.byeCalled = true;
      call.state = 'ended';
    },
  };
}

function makeGateway(t) {
  const endpoint = fakeEndpoint();
  const trunk = fakeTrunk();
  const gateway = new Gateway({ endpoint, trunk, switchId: 'switch@estate.local', domain: 'estate.local', advertise: '203.0.113.9' });
  // Each leg holds a real RTP socket; a test that leaves one open keeps the
  // event loop alive and the runner never reports.
  t.after(() => {
    for (const leg of gateway.legs.values()) leg.rtp?.close();
  });
  return { gateway, endpoint, trunk };
}

test('an inbound DID becomes a Cantus call dialled at the DID', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t);
  const call = {
    kind: 'inbound',
    callId: 'sip-in-1',
    uri: 'sip:+14132642700@atlanta.voip.ms',
    request: {
      get: (name) =>
        ({
          to: '<sip:+14132642700@atlanta.voip.ms>',
          from: '<sip:+14134210134@atlanta.voip.ms>;tag=abc',
        })[name],
    },
    audio: { host: '127.0.0.1', port: 40000, pcmu: true },
    answered: false,
  };

  await gateway.onSipCall(call);

  // The routing document sees the DID, so it — not the gateway — picks the line.
  assert.deepEqual(endpoint.calls, ['+14132642700@switch@estate.local']);

  // Ringing is not answered: the carrier gets its 200 only when the switch accepts.
  assert.equal(trunk.answeredWith, undefined);
  gateway.onEndpointEvent({ kind: 'accepted', call: 'call-1' });
  assert.match(trunk.answeredWith, /m=audio \d+ RTP\/AVP 0/);
  assert.match(trunk.answeredWith, /c=IN IP4 203\.0\.113\.9/);
});

test('an inbound call the switch refuses is refused at the carrier', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t);
  const call = {
    kind: 'inbound',
    callId: 'sip-in-2',
    uri: 'sip:+14132642700@atlanta.voip.ms',
    request: { get: (name) => ({ to: '<sip:+14132642700@atlanta.voip.ms>', from: '<sip:+15550000000@x>;tag=a' })[name] },
    audio: { host: '127.0.0.1', port: 40001, pcmu: true },
    answered: false,
  };
  await gateway.onSipCall(call);
  gateway.onEndpointEvent({ kind: 'rejected', call: 'call-1' });
  assert.deepEqual(trunk.refused, { status: 480, reason: 'Temporarily Unavailable' });
});

test('a call the switch sends to the trunk dials the number and answers only after the carrier', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t);
  await gateway.onCantusCall({ call: 'call-9' }, '14134210134@voipms@gateway');

  assert.equal(trunk.invites.length, 1);
  assert.equal(trunk.invites[0].to, '14134210134');
  assert.match(trunk.invites[0].sdp, /m=audio \d+ RTP\/AVP 0/);
  assert.equal(endpoint.accepted, undefined, 'the Cantus side waits for the carrier');

  trunk.lastCall.onAnswered(trunk.lastCall, { host: '127.0.0.1', port: 40002, pcmu: true });
  assert.equal(endpoint.accepted, 'call-9');
});

test('a carrier that rejects the call rejects the Cantus leg with a reason', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t);
  await gateway.onCantusCall({ call: 'call-10' }, '14134210134@voipms@gateway');
  trunk.lastCall.onFailed('404 Not Found');
  // A wrong number is not the same failure as a policy refusal, and the switch
  // records the difference.
  assert.deepEqual(endpoint.rejected, { id: 'call-10', reason: 'NOT_FOUND' });
});

test('a carrier that never answers times out the Cantus leg', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t);
  await gateway.onCantusCall({ call: 'call-11' }, '14134210134@voipms@gateway');
  trunk.lastCall.onFailed('timeout');
  assert.deepEqual(endpoint.rejected, { id: 'call-11', reason: 'TIMEOUT' });
});

test('encryption can be switched between calls, and only the next call changes', async (t) => {
  const { gateway, trunk } = makeGateway(t);
  assert.equal(gateway.status().sip.srtp, false, 'plain RTP until somebody asks for encryption');

  assert.equal(gateway.setSrtp(true), true);
  assert.equal(gateway.status().sip.srtp, true, 'the status surface reports what the next call will offer');
  await gateway.onCantusCall({ call: 'call-20' }, '14134210134@voipms@gateway');
  assert.match(trunk.invites.at(-1).sdp, /m=audio \d+ RTP\/SAVP 0/);
  assert.match(trunk.invites.at(-1).sdp, /a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:/);

  // A call already up keeps the keys it negotiated — an offer cannot change
  // halfway through — so switching off shows up on the next INVITE.
  assert.equal(gateway.setSrtp(false), false);
  await gateway.onCantusCall({ call: 'call-21' }, '14134210134@voipms@gateway');
  assert.match(trunk.invites.at(-1).sdp, /m=audio \d+ RTP\/AVP 0/);
  assert.doesNotMatch(trunk.invites.at(-1).sdp, /a=crypto/);
});

test('addresses are read the way the switch writes them', () => {
  assert.equal(dialledNumber('14134210134@voipms@gateway'), '14134210134');
  assert.equal(dialledNumber('+14134210134@voipms@gateway'), '+14134210134');
  assert.equal(dialledNumber('voipms@gateway'), '');
  assert.equal(dialledNumber(''), '');
  assert.equal(sipUser('<sip:+14132642700@atlanta.voip.ms>'), '+14132642700');
  assert.equal(sipUser('nonsense'), '');
});

test('the RTP timestamp advances by the audio in the packet, not by a constant', async (t) => {
  const a = new RtpSession();
  const b = new RtpSession();
  t.after(() => {
    a.close();
    b.close();
  });
  await a.start();
  await b.start();
  a.to('127.0.0.1', b.port);
  b.to('127.0.0.1', a.port);

  // An upstream leg handing over 40 ms instead of 20: the old code advertised
  // 160 samples of time for 320 samples of audio, so the carrier played the
  // stream at double speed with overlapping packets.
  const frames = [];
  b.onFrame = (pcm) => frames.push(pcm);
  const before = a.ts;
  a.send(Buffer.alloc(320 * 2));
  await sleep(60);
  assert.equal(a.ts - before, 320, '320 samples take 320 samples of timestamp');

  // And an ordinary 20 ms frame still advances by 160.
  const mid = a.ts;
  a.send(Buffer.alloc(SAMPLES * 2));
  await sleep(60);
  assert.equal(a.ts - mid, SAMPLES);
});
