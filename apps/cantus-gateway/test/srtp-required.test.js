/**
 * "Secure first" is a property of the media, not a preference.
 *
 * With SRTP required the border has no plaintext path: an offer that is not
 * SDES-SRTP is answered 488 and never becomes a Cantus call, and an answer that
 * quietly drops the keys ends the call instead of carrying audio in the clear.
 * The reverse is tested too — a deployment that did not ask for keys still
 * bridges plain RTP, so this is an enforced choice rather than a broken default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/gateway.js';
import { cryptoAttribute, newKeyMaterial } from '../src/srtp.js';

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

function makeGateway(t, options = {}) {
  const endpoint = fakeEndpoint();
  const trunk = fakeTrunk();
  const gateway = new Gateway({
    endpoint,
    trunk,
    switchId: 'switch@estate.local',
    domain: 'estate.local',
    advertise: '203.0.113.9',
    ...options,
  });
  t.after(() => {
    for (const leg of gateway.legs.values()) leg.rtp?.close();
  });
  return { gateway, endpoint, trunk };
}

/** An inbound INVITE from the carrier, encrypted only when asked for. */
function inboundCall({ secure = false } = {}) {
  const audio = { host: '127.0.0.1', port: 40000, pcmu: true };
  if (secure) {
    audio.secure = true;
    audio.crypto = cryptoAttribute(newKeyMaterial());
  }
  return {
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
    audio,
    answered: false,
  };
}

test('required SRTP refuses a plaintext offer instead of bridging it', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t, { srtp: true, srtpRequired: true });
  const call = inboundCall();

  await gateway.onSipCall(call);

  assert.deepEqual(trunk.refused, { status: 488, reason: 'Not Acceptable Here' });
  assert.deepEqual(endpoint.calls, [], 'no Cantus call may be created for a cleartext leg');
  assert.equal(gateway.legs.size, 0, 'no RTP socket is opened for a refused call');
  assert.equal(trunk.answeredWith, undefined);
});

test('required SRTP still bridges an encrypted offer', async (t) => {
  const { gateway, endpoint } = makeGateway(t, { srtp: true, srtpRequired: true });
  const call = inboundCall({ secure: true });

  await gateway.onSipCall(call);

  assert.deepEqual(endpoint.calls, ['+14132642700@switch@estate.local']);
  assert.equal(gateway.legs.size, 1);
  const leg = [...gateway.legs.values()][0];
  assert.ok(leg.srtp, 'the leg must hold keys in both directions');
  assert.match(leg.offer, /RTP\/SAVP/, 'the answer must offer encrypted media');
});

test('required SRTP ends the call when the carrier answers without keys', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t, { srtp: true, srtpRequired: true });

  await gateway.onCantusCall({ call: 'call-9' }, '14134210134@voipms@gateway');
  assert.match(trunk.invites[0].sdp, /RTP\/SAVP 0/, 'the offer asks for encryption');

  // RTP/SAVP was accepted and then answered as if it were plain RTP.
  trunk.lastCall.onAnswered(trunk.lastCall, { host: '127.0.0.1', port: 40002, pcmu: true });

  assert.deepEqual(endpoint.rejected, { id: 'call-9', reason: 'NO_CAPABILITY' });
  assert.equal(endpoint.accepted, undefined, 'the Cantus leg is never accepted');
  assert.equal(trunk.byeCalled, true, 'the half-open carrier dialog is closed');
  assert.equal(gateway.legs.size, 0);
});

test('a deployment that did not require keys still bridges plain RTP', async (t) => {
  const { gateway, endpoint, trunk } = makeGateway(t, { srtp: false });

  await gateway.onCantusCall({ call: 'call-8' }, '14134210134@voipms@gateway');
  assert.match(trunk.invites[0].sdp, /RTP\/AVP 0/);
  trunk.lastCall.onAnswered(trunk.lastCall, { host: '127.0.0.1', port: 40003, pcmu: true });
  assert.equal(endpoint.accepted, 'call-8');
});

test('an enforced deployment cannot have encryption switched off from the console', (t) => {
  const { gateway } = makeGateway(t, { srtp: true, srtpEnforced: true });

  assert.equal(gateway.setSrtp(false), true, 'the switch refuses to turn encryption off');
  assert.equal(gateway.srtp, true);
  assert.equal(gateway.srtpRequired, true);
  // Turning it on again is still a no-op rather than an error.
  assert.equal(gateway.setSrtp(true), true);
});

test('without enforcement the console can still turn encryption off', (t) => {
  const { gateway } = makeGateway(t, { srtp: true });

  assert.equal(gateway.setSrtp(false), false);
  assert.equal(gateway.srtpRequired, false, 'a plaintext path exists again');
});
