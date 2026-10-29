/**
 * The management side, exercised over real HTTP and real WebSocket frames:
 * status, the ARI surface's auth, the event socket, and a browser softphone
 * that rings, answers and starts receiving 20 ms media frames.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Switch } from '../src/switch.js';
import { CantusServer } from '../src/server.js';
import { connectWebSocket } from '../src/ws.js';
import { waitUntil } from './wait.js';

async function bootstrap({ controlToken = '', routes } = {}) {
  const switchRef = new Switch({
    domain: 'test.local',
    id: 'switch@test.local',
    secret: 'test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    controlToken,
    routes: routes || {
      version: 1,
      routes: [{ name: 'line-100', when: { to: '100*' }, then: [{ answer: {} }, { bridge: { to: '100' } }] }],
    },
  });
  switchRef.setLine({ ext: '100', displayName: 'Front desk' });
  await switchRef.start();
  const server = new CantusServer({
    switch: switchRef,
    host: '127.0.0.1',
    port: 0,
    controlToken,
    ari: undefined,
  });
  server.ari.username = 'dograh';
  server.ari.password = 'secret';
  await server.listen();
  return { switchRef, server };
}

test('control API reports the switch state', async (t) => {
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });
  const response = await fetch(`${server.url}/v1/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.transport, 'CANTUS');
  assert.ok(body.node.addr);
  assert.equal(body.lines[0].ext, '100');

  const health = await fetch(`${server.url}/healthz`);
  assert.equal((await health.json()).mode, 'relay');
});

test('the ARI surface refuses unauthenticated calls and answers authenticated ones', async (t) => {
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });

  const unauthorised = await fetch(`${server.url}/ari/asterisk/info`);
  assert.equal(unauthorised.status, 401);

  const auth = `Basic ${Buffer.from('dograh:secret').toString('base64')}`;
  const info = await fetch(`${server.url}/ari/asterisk/info`, { headers: { authorization: auth } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).system.engine, 'Cantus');

  const channels = await fetch(`${server.url}/ari/channels`, { headers: { authorization: auth } });
  assert.deepEqual(await channels.json(), []);
});

test('a browser softphone registers, rings and answers', async (t) => {
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });

  const ws = await connectWebSocket(`${server.url.replace('http', 'ws')}/ws/line?ext=100`);
  const messages = [];
  const media = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) media.push(data.length);
    else messages.push(JSON.parse(String(data)));
  });
  ws.sendJson({ type: 'hello' });
  await waitUntil(() => messages.length > 0, { label: 'the line to register' });
  assert.equal(messages[0].type, 'registered');
  assert.equal(messages[0].ext, '100');
  assert.equal(messages[0].codec, 'pcm-s16/8000/1');

  // Dialling the line from inside the switch rings the browser, not a SIP
  // proxy: there is no port to forward and no registration to refresh.
  switchRef.originate({ from: '998', to: '100@test.local' });
  const incoming = await waitUntil(
    () => messages.find((message) => message.type === 'incoming'),
    { label: 'the browser to be rung' }
  );
  assert.ok(incoming, 'the browser should have been rung');
  assert.equal(incoming.to, '100@test.local');

  ws.sendJson({ type: 'answer', callId: incoming.callId });
  await waitUntil(
    () => messages.some((message) => message.type === 'call.answered') || switchRef.calls.get(incoming.callId)?.answeredAt,
    { label: 'the call to be answered' }
  );
  assert.ok(messages.some((message) => message.type === 'call.answered') || switchRef.calls.get(incoming.callId).answeredAt);
  await waitUntil(() => media.length > 0, { label: 'the first media frame' });
  assert.ok(media.length > 0, 'answered line should be receiving 20 ms frames');
  assert.equal(media[0], 320, '20 ms of 8 kHz PCM16 is 320 octets');

  const call = switchRef.calls.get(incoming.callId);
  switchRef.hangup(call.id);
  await waitUntil(() => call.state === 'ended', { label: 'the hangup to end the call' });
  ws.close();
});

test('an async ticket verifier decides whether a line socket is attached', async (t) => {
  // The verifier asks the platform over HTTP, so it returns a promise. Using
  // that promise as the answer (`check.ok` on a pending promise is undefined)
  // refused every softphone socket with 4403 "invalid ticket", so no browser
  // ever registered against a real deployment.
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });

  server.verifyTicket = async (ticket) => (ticket === 'good' ? { ok: true, ext: '100' } : { ok: false, reason: 'ticket refused' });

  const accepted = await connectWebSocket(`${server.url.replace('http', 'ws')}/ws/line?ticket=good&ext=999`);
  const registered = await new Promise((resolve) => accepted.on('message', (data) => resolve(JSON.parse(String(data)))));
  assert.equal(registered.type, 'registered');
  assert.equal(registered.ext, '100', 'the verifier decides the extension, not the query string');
  accepted.close();

  const refused = await connectWebSocket(`${server.url.replace('http', 'ws')}/ws/line?ticket=bad&ext=100`);
  const closed = await new Promise((resolve) => refused.on('close', (code, reason) => resolve({ code, reason })));
  assert.equal(closed.code, 4403);
  assert.equal(closed.reason, 'ticket refused');
});

test('control token is enforced when one is configured', async (t) => {  const { switchRef, server } = await bootstrap({ controlToken: 'shhh' });
  t.after(() => {
    switchRef.stop();
    return server.close();
  });
  const denied = await fetch(`${server.url}/v1/status`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${server.url}/v1/status`, { headers: { authorization: 'Bearer shhh' } });
  assert.equal(allowed.status, 200);
});

test('a DID route hands the call to an ARI application', async (t) => {
  // The capstone/dograh path: an inbound number whose route ends in `ari`.
  // Before this existed the switch could only originate into an app, so an
  // inbound agent number rang nothing and hung up.
  const target = new Switch({
    domain: 'ari.test',
    id: 'switch@ari.test',
    secret: 'ari-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: {
      version: 1,
      routes: [
        { name: 'agent-did', when: { to: '2125551234*' }, then: [{ answer: {} }, { ari: { app: 'dograh' } }] },
        { name: 'everything-else', when: {}, then: [{ reject: 2 }] },
      ],
    },
  });
  target.setLine({ ext: '2125551234', displayName: 'Agent DID' });
  await target.start();

  const caller = new Switch({
    domain: 'ari.test',
    id: 'caller@ari.test',
    secret: 'ari-test',
    bind: '127.0.0.1:0',
    relayAddress: target.relay.addr,
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: { version: 1, routes: [] },
  });
  await caller.start();

  const server = new CantusServer({ switch: target, host: '127.0.0.1', port: 0, controlToken: '' });
  server.ari.username = 'dograh';
  server.ari.password = 'secret';
  await server.listen();

  t.after(async () => {
    caller.stop();
    target.stop();
    await server.close();
  });

  const auth = `Basic ${Buffer.from('dograh:secret').toString('base64')}`;
  const events = [];
  const ws = await connectWebSocket(`${server.url.replace('http', 'ws')}/ari/events?app=dograh`, {
    headers: { authorization: auth },
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) events.push(JSON.parse(String(data)));
  });
  await waitUntil(() => events.length > 0, { label: 'the ARI event socket to open' });
  assert.equal(events[0].type, 'SystemInfo');

  const call = caller.originate({ from: '5551234@ari.test', to: '2125551234@ari.test' });
  const start = await waitUntil(
    () => events.find((event) => event.type === 'StasisStart'),
    { label: 'the application to be handed the call' }
  );
  assert.ok(start, 'the application should have been handed the call');
  assert.equal(start.application, 'dograh');
  assert.match(start.channel.dialplan.exten, /^2125551234/);
  assert.equal(start.channel.dialplan.context, 'agent-did');
  // args are [dialled, caller]; the caller is what an agent greets by name.
  assert.ok(start.args[0].startsWith('2125551234'), `args should lead with the DID, got ${JSON.stringify(start.args)}`);
  assert.equal(start.args.length, 2, `args should carry the caller too, got ${JSON.stringify(start.args)}`);

  const routed = [...target.calls.values()].find((entry) => entry.routeApp);
  assert.ok(routed, 'the call should be owned by the application');
  assert.equal(routed.state, 'stasis');

  caller.hangup(call.id);
  await waitUntil(() => events.some((event) => event.type === 'StasisEnd'), {
    label: 'the application to be told it lost the channel',
  });
  assert.ok(events.some((event) => event.type === 'StasisEnd'), 'the application should be told it lost the channel');
  ws.close();
});

test('an originated call follows the routing document and names its route', async (t) => {
  // Dialling an agent number from the console is the same routing question as
  // an inbound DID: the document decides, and the call records which rule took
  // it. Before this, `originate` skipped the router entirely for anything that
  // was not a local line.
  const sw = new Switch({
    domain: 'route.test',
    id: 'switch@route.test',
    secret: 'route-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: {
      version: 1,
      routes: [{ name: 'agents', when: { to: '8000@*' }, then: [{ answer: {} }, { ari: { app: 'dograh' } }] }],
    },
  });
  await sw.start();
  t.after(() => sw.stop());

  const call = sw.originate({ from: 'console', to: '8000@route.test' });
  assert.equal(call.route, 'agents');
  const routed = call.events.find((event) => event.type === 'call.routed');
  assert.ok(routed, 'the call should report the route it took');
  assert.equal(routed.route, 'agents');
});

test('a hand-off to an ARI app with no client ends the call instead of parking it', async (t) => {
  const sw = new Switch({
    domain: 'noari.test',
    id: 'switch@noari.test',
    secret: 'noari',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
    routes: { version: 1, routes: [{ name: 'agents', when: { to: '8000@*' }, then: [{ ari: { app: 'dograh' } }] }] },
  });
  sw.ariAppAvailable = () => false;
  await sw.start();
  t.after(() => sw.stop());

  const call = sw.originate({ from: 'console', to: '8000@noari.test' });
  assert.equal(call.state, 'ended');
  assert.equal(call.cause, 'app-unavailable');
});

test('an originated call to a local line runs its route and rings the line', async (t) => {
  // The console's main button: originate 101, the document answers and bridges,
  // and the softphone on 101 rings. The route name reaches the console instead
  // of the call looking like an unmanaged direct ring.
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
      routes: [{ name: 'front-desk', when: { to: '101@*' }, then: [{ answer: {} }, { bridge: { to: '101' } }] }],
    },
  });
  sw.setLine({ ext: '101', displayName: 'Front desk' });
  await sw.start();
  t.after(() => sw.stop());

  const call = sw.originate({ from: 'console', to: '101@line.test' });
  assert.equal(call.route, 'front-desk');
  // Nothing is holding 101 open in this test, so the ring ends at once with a
  // cause rather than hanging — the same shape the console shows for a line
  // with no softphone attached.
  assert.equal(call.state, 'ended');
  assert.equal(call.cause, 'no-answer');
});

test('the line list says a phone is there, and why it left', async (t) => {
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });

  const handlers = new Map();
  const socket = {
    closed: false,
    send: () => {},
    sendJson: () => {},
    ping: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    close: () => {
      socket.closed = true;
      for (const handler of handlers.get('close') || []) handler(1000);
    },
  };

  switchRef.attachSocket(socket, { ext: '100' });
  let line = (await (await fetch(`${server.url}/v1/lines`)).json()).find((entry) => entry.ext === '100');
  assert.equal(line.registered, 1);
  assert.equal(line.online, true);
  assert.equal(line.lastChange.kind, 'registered');
  assert.ok(line.lastChange.at, 'the console needs a time to show');

  // The health check drops a phone that stopped answering; the console has to be
  // able to tell that apart from one that was never there.
  switchRef.forgetSocket(socket, switchRef.lines.get('100'), 'silent');
  line = (await (await fetch(`${server.url}/v1/lines`)).json()).find((entry) => entry.ext === '100');
  assert.equal(line.registered, 0);
  assert.equal(line.online, false);
  assert.equal(line.lastChange.kind, 'unregistered');
  assert.equal(line.lastChange.reason, 'silent');
});

test('a call reports the media counters a console needs for a rate', async (t) => {
  const { switchRef, server } = await bootstrap();
  t.after(() => {
    switchRef.stop();
    return server.close();
  });

  // No socket on the leg: the live ticker only feeds legs it can write to, and
  // this test is about the counters it reports, not about it writing. A socket
  // here made the counters move under the assertion between fixture and fetch.
  const browser = { role: 'web', ext: '100', ws: null, isAnswered: true, isEnded: false, received: 41, sent: 50, rx: null, rxAt: 0 };
  const carrier = { role: 'inbound', ext: '', ws: null, isAnswered: true, isEnded: false, received: 50, sent: 41, rx: null, rxAt: 0 };
  const call = { id: 'call-media', direction: 'inbound', from: 'voipms', to: '100@test.local', state: 'answered', route: 'did', events: [], legs: [carrier, browser], startedAt: Date.now(), answeredAt: Date.now() };
  browser.call = call;
  carrier.call = call;
  switchRef.calls.set(call.id, call);

  const body = await (await fetch(`${server.url}/v1/calls`)).json();
  const leg = body.find((entry) => entry.id === 'call-media').legs.find((entry) => entry.role === 'web');
  assert.equal(leg.sent, 50, 'frames written to the phone');
  assert.equal(leg.received, 41, 'frames arriving from it');
});
