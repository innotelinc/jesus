/**
 * Refusal codes at the SIP border.
 *
 * A carrier acts on the status it is given: 486 goes to call-forward-busy, 480
 * goes to the next branch, 404 is a wrong number. Cantus has always known the
 * difference; before these mappings existed the gateway erased it by answering
 * 480 to everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway, sipStatusFor, cantusReasonFor } from '../src/gateway.js';

test('every Cantus reason has the SIP status a carrier expects', () => {
  assert.deepEqual(sipStatusFor('BUSY'), [486, 'Busy Here']);
  assert.deepEqual(sipStatusFor('NOT_FOUND'), [404, 'Not Found']);
  assert.deepEqual(sipStatusFor('CANCELLED'), [487, 'Request Terminated']);
  assert.deepEqual(sipStatusFor('NO_CAPABILITY'), [488, 'Not Acceptable Here']);
  assert.deepEqual(sipStatusFor('GLARE'), [491, 'Request Pending']);
  assert.deepEqual(sipStatusFor('AUTH_FAILED'), [403, 'Forbidden']);
  // Capacity is busy, not a broken trunk: 503 would remove the carrier's
  // route instead of trying the next number.
  assert.deepEqual(sipStatusFor('LIMIT'), [486, 'Busy Here']);
  assert.deepEqual(sipStatusFor('TIMEOUT'), [408, 'Request Timeout']);
  assert.deepEqual(sipStatusFor(''), [480, 'Temporarily Unavailable']);
  assert.deepEqual(sipStatusFor('nonsense'), [480, 'Temporarily Unavailable']);
});

test("the carrier's status becomes the switch's reason", () => {
  assert.equal(cantusReasonFor('486 Busy Here'), 'BUSY');
  assert.equal(cantusReasonFor('404 Not Found'), 'NOT_FOUND');
  assert.equal(cantusReasonFor('488 Not Acceptable Here'), 'NO_CAPABILITY');
  assert.equal(cantusReasonFor('491 Request Pending'), 'GLARE');
  assert.equal(cantusReasonFor('503 Service Unavailable'), 'UNAVAILABLE');
  assert.equal(cantusReasonFor('408 Request Timeout'), 'TIMEOUT');
  assert.equal(cantusReasonFor('timeout'), 'TIMEOUT');
  assert.equal(cantusReasonFor(''), 'TIMEOUT');
  // A carrier's reason phrase is not parsed: two carriers sending 403 with
  // different wording must produce one reason.
  assert.equal(cantusReasonFor('403 Call barred by carrier'), 'REJECTED');
  assert.equal(cantusReasonFor('weird'), 'REJECTED');
});

function fakes() {
  const endpoint = {
    id: 'voipms@gateway',
    localAddr: '127.0.0.1:7453',
    ready: true,
    relay: '',
    sessions: new Map(),
    stats: {},
    calls: [],
    call(to) {
      this.calls.push(to);
      const id = `call-${this.calls.length}`;
      this.sessions.set(id, { call: id });
      return id;
    },
    accept() {},
    reject(session, reason) {
      this.rejected = { id: session?.call ?? session, reason };
    },
    hangup() {},
    sendDtmf() {},
  };
  const trunk = {
    host: 'atlanta.voip.ms',
    port: 5060,
    bound: 5060,
    registered: true,
    registerExpiresAt: 0,
    lastRegisterError: '',
    invites: [],
    invite({ to }) {
      this.invites.push({ to });
      const call = { kind: 'outbound', callId: 'sip-out-1', state: 'calling', answered: false };
      this.lastCall = call;
      return call;
    },
    answer() {},
    reject(call, status, reason) {
      this.refused = { status, reason };
    },
    bye() {},
  };
  return { endpoint, trunk };
}

function gatewayWith(t) {
  const { endpoint, trunk } = fakes();
  const gateway = new Gateway({
    endpoint,
    trunk,
    switchId: 'switch@estate.local',
    domain: 'estate.local',
    advertise: '203.0.113.9',
    // Test files run in parallel; a shared RTP range makes two gateways fight
    // over the same UDP port and the failure looks like a protocol bug.
    rtpStart: 41000,
    rtpEnd: 41063,
  });
  t.after(() => {
    for (const leg of gateway.legs.values()) leg.rtp?.close();
  });
  return { gateway, endpoint, trunk };
}

test('a busy line is refused as busy, and a wrong number as not found', async (t) => {
  const { gateway, endpoint, trunk } = gatewayWith(t);
  const call = {
    kind: 'inbound',
    callId: 'sip-in-reason',
    uri: 'sip:+14132642700@atlanta.voip.ms',
    request: { get: (name) => ({ to: '<sip:+14132642700@atlanta.voip.ms>', from: '<sip:+15550000000@x>;tag=a' })[name] },
    audio: { host: '127.0.0.1', port: 40000, pcmu: true },
    answered: false,
  };
  await gateway.onSipCall(call);
  const id = endpoint.calls.length ? `call-${endpoint.calls.length}` : '';

  gateway.onEndpointEvent({ kind: 'rejected', call: id, reason: 'BUSY' });
  assert.deepEqual(trunk.refused, { status: 486, reason: 'Busy Here' });
});

test('a carrier that says "no such number" tells the switch exactly that', async (t) => {
  const { gateway, endpoint, trunk } = gatewayWith(t);
  await gateway.onCantusCall({ call: 'call-40' }, '14134210134@voipms@gateway');
  trunk.lastCall.onFailed('404 Not Found');
  assert.deepEqual(endpoint.rejected, { id: 'call-40', reason: 'NOT_FOUND' });
});

test('at-capacity at the switch does not look like a dead trunk', async (t) => {
  const { gateway, endpoint, trunk } = gatewayWith(t);
  await gateway.onCantusCall({ call: 'call-41' }, '14134210134@voipms@gateway');
  trunk.lastCall.onFailed('503 Service Unavailable');
  assert.deepEqual(endpoint.rejected, { id: 'call-41', reason: 'UNAVAILABLE' });
});
