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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const socket = fakeLineSocket();
  sw.attachSocket(socket, { ext: '101' });
  await sleep(80);

  // The carrier's call: the gateway dials the DID at the switch.
  const session = peer.call('14132642700@switch@in.test', { context: { from: '14134210134' } });
  assert.ok(session, 'the gateway leg should be accepted by the relay');

  await sleep(200);
  const call = [...sw.calls.values()].find((entry) => entry.direction === 'inbound');
  assert.ok(call, 'the DID route should have created an inbound call');
  assert.equal(call.route, 'did-14132642700');

  const ringing = socket.inbox.find((message) => message.type === 'incoming');
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

  await sleep(150);
  assert.equal(call.state, 'answered');
  const accepted = peerEvents.filter((event) => event.kind === 'accepted');
  assert.ok(
    accepted.length > 0,
    'the gateway must be told the call is answered, or the carrier never gets a 200 OK'
  );
  assert.equal(accepted.at(-1).call, session);
});
