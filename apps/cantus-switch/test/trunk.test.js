/**
 * Outbound PSTN: the routing document's `trunk` action.
 *
 * This exists because the generated outbound route used `bridge`, which rings
 * *lines on this switch* — so dialling a mobile number from the console rang a
 * line named after the number, found nothing, and ended `no-answer`. The call
 * never reached a gateway, which looked like a carrier problem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Switch } from '../src/switch.js';
import { CantusEndpoint } from '../src/endpoint.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bootstrap(t, routes) {
  const sw = new Switch({
    domain: 'out.test',
    id: 'switch@out.test',
    secret: 'out-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes,
  });
  sw.setTrunk({ name: 'voipms', endpoint: 'voipms@gateway', numbers: ['14132642700'] });
  await sw.start();
  t.after(() => sw.stop());
  return sw;
}

test('a `trunk` action dials the number at the gateway endpoint', async (t) => {
  const sw = await bootstrap(t, {
    version: 1,
    routes: [{ name: 'outbound', when: { to: '+*' }, then: [{ trunk: { to: '*' } }] }],
  });

  const call = sw.originate({ from: '101@out.test', to: '+14134210134' });
  await sleep(80);

  assert.equal(call.route, 'outbound');
  const dialled = call.events.filter((event) => event.type === 'call.originated').at(-1);
  assert.equal(dialled.endpointId, '14134210134@voipms@gateway', 'the digits and the trunk endpoint');
  assert.equal(dialled.trunk, 'voipms');
  // A Cantus session exists on the leg, which is what the gateway answers.
  assert.ok(call.legs[0].endpoint, 'the trunk leg should hold a session');
});

test('a refused trunk leg ends the call instead of ringing forever', async (t) => {
  // The gateway is a separate process and says no for ordinary reasons: no
  // carrier, a busy number, a trunk nobody registered. That refusal has to end
  // the switch's call, or the caller keeps hearing ringing at a call that is
  // already dead.
  const sw = await bootstrap(t, {
    version: 1,
    routes: [{ name: 'outbound', when: { to: '+*' }, then: [{ trunk: { to: '*' } }] }],
  });

  const peer = new CantusEndpoint({
    id: 'voipms@gateway',
    secret: 'out-test',
    bind: '127.0.0.1:0',
    relay: sw.relay.addr,
    onEvent: () => {},
  });
  peer.onIncoming = (session) => peer.reject(session, 'UNAVAILABLE');
  await peer.start();
  t.after(() => peer.stop());
  await sleep(150);

  const call = sw.originate({ from: '101@out.test', to: '+14134210134' });
  await sleep(250);

  assert.equal(call.state, 'ended', 'a refused leg is not a live call');
  assert.equal(call.cause, 'unavailable');
});

test('an unknown action is refused when the document is loaded', async (t) => {
  // Guard the other direction: `trunk` is now valid, but a typo still fails
  // loudly at load time rather than at 2 a.m. during a call.
  const sw = await bootstrap(t, { version: 1, routes: [] });
  assert.throws(
    () => sw.setRoutes({ version: 1, routes: [{ name: 'x', when: { to: '+*' }, then: [{ trunkk: { to: '*' } }] }] }),
    /unknown action/
  );
});
