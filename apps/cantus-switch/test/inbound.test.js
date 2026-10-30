/**
 * Inbound PSTN: the DID route rings a line, and answering it answers the caller.
 *
 * Two things are checked here, and the second one is the bug this file exists
 * for. The gateway brings a call in as a Cantus leg; the switch rings the line;
 * the line answers. The switch used to accept only the leg that was picked up,
 * so the gateway never got ACCEPT and never sent `200 OK` to the carrier: the
 * handset said "connected" and the person who dialled heard silence until the
 * carrier timed the call out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Switch } from '../src/switch.js';
import { CantusEndpoint } from '../src/endpoint.js';
import { waitUntil } from './wait.js';

async function bootstrap(t) {
  const sw = new Switch({
    domain: 'in.test',
    id: 'switch@in.test',
    secret: 'in-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: {
      version: 1,
      default: { reject: 3 },
      // The route telno generates for a DID that belongs to extension 101.
      routes: [{ name: 'did-14132642700', when: { to: '14132642700*' }, then: [{ bridge: { to: '101', timeout: 20 } }] }],
    },
  });
  sw.setLine({ ext: '101', displayName: 'Demo Owner', numbers: ['+14132642700'] });
  await sw.start();
  t.after(() => sw.stop());
  return sw;
}

/** A browser line's socket, reduced to what the switch touches. */
function fakeLineSocket() {
  const inbox = [];
  return {
    inbox,
    sendJson: (message) => inbox.push(message),
    send: () => {},
    close: () => {},
    on: () => {},
  };
}

test('answering the line answers the caller that came in through the gateway', async (t) => {
  const sw = await bootstrap(t);
  const peerEvents = [];
  const peer = new CantusEndpoint({
    id: 'voipms@gateway',
    secret: 'in-test',
    bind: '127.0.0.1:0',
    relay: sw.relay.addr,
    onEvent: (event) => peerEvents.push(event),
  });
  await peer.start();
  t.after(() => peer.stop());
  // The switch and the gateway both have to be known to the relay before a call
  // between them means anything; a sleep here was a guess at how long that takes.
  await waitUntil(() => peer.handle, { label: 'the gateway to register with the relay' });

  const socket = fakeLineSocket();
  sw.attachSocket(socket, { ext: '101' });

  // The carrier's call: the gateway dials the DID at the switch.
  const session = peer.call('14132642700@switch@in.test', { context: { from: '14134210134' } });
  assert.ok(session, 'the gateway leg should be accepted by the relay');

  const call = await waitUntil(
    () => [...sw.calls.values()].find((entry) => entry.direction === 'inbound'),
    { label: 'the DID route to create an inbound call' }
  );
  assert.ok(call, 'the DID route should have created an inbound call');
  assert.equal(call.route, 'did-14132642700');

  const ringing = await waitUntil(
    () => socket.inbox.find((message) => message.type === 'incoming'),
    { label: 'line 101 to ring' }
  );
  assert.ok(ringing, 'line 101 should be ringing');
  assert.match(ringing.to, /^14132642700/);
  // Known limit: Cantus has no field for caller identity on an INVITE (field 8
  // is defined for REJECT/TERMINATE/INFO), so the line sees the endpoint that
  // brought the call in rather than the number that dialled. Passing the
  // carrier's From through would be a protocol change, not a tweak here.
  assert.equal(ringing.from, 'voipms');

  // Somebody picks up.
  const leg = call.legs.find((entry) => entry.ws === socket);
  assert.ok(leg, 'the web leg is on the call');
  assert.equal(sw.answerLeg(call, leg), true);

  assert.equal(call.state, 'answered');
  await waitUntil(() => peerEvents.some((event) => event.kind === 'accepted'), {
    label: 'the gateway to be told the call is answered',
  });
  const accepted = peerEvents.filter((event) => event.kind === 'accepted');
  assert.ok(
    accepted.length > 0,
    'the gateway must be told the call is answered, or the carrier never gets a 200 OK'
  );
  assert.equal(accepted.at(-1).call, session);
});

test('a call from the carrier arrives ringing, so an agent can answer it', () => {
  // ARI's answer path goes through `answerLeg`, which only answers a leg that is
  // ringing. An inbound leg that stayed `new` turned the agent's answer into a
  // 200 with nothing behind it: the pipeline ran, the carrier kept ringing.
  const sw = new Switch({
    domain: 'inaring.test',
    id: 'switch@inaring.test',
    secret: 'in-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: {
      version: 1,
      default: { reject: 3 },
      routes: [{ name: 'did-ari', when: { to: '14132642700*' }, then: [{ ari: { app: 'dograh' } }] }],
    },
  });
  sw.onIncoming({ peer: 'voipms@gateway', dialedTo: '14132642700@inaring.test' }, '14132642700@inaring.test');

  const call = [...sw.calls.values()][0];
  const leg = call.legs.find((entry) => entry.role === 'inbound');
  assert.equal(leg.state, 'ringing');
  assert.equal(call.route, 'did-ari');
});
