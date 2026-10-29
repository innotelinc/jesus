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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await sleep(120);

  const socket = fakeLineSocket();
  const call = sw.originate({ from: '101', to: '14134210134@line.test', ws: socket, ext: '101' });
  assert.equal(call.route, 'national');

  await sleep(250);
  const web = call.legs.find((leg) => leg.ws === socket);
  assert.ok(web, 'the dialling socket is a leg of its own call');
  assert.equal(web.state, 'answered');
  assert.ok(
    socket.sent.length > 2,
    'the browser must receive audio, or a call the carrier answered is silence on this side'
  );

  // Hanging up from the line ends the whole call, trunk leg included.
  sw.onSocketMessage(socket, sw.lines.get('101'), { type: 'hangup', callId: call.id }, (id) =>
    call.legs.find((leg) => leg.ws === socket && leg.call.id === id)
  );
  await sleep(80);
  assert.equal(call.state, 'ended');
});
