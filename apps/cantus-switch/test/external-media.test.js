/**
 * The agent's audio path, end to end on this side of the socket.
 *
 * chan_websocket is two halves: Asterisk dials the URI a connection name
 * resolves to, then carries raw audio over binary frames. This file pins the
 * half the switch owns — the channel it creates, the MEDIA_START that declares
 * the terms, ulaw on the wire in both directions, and the bridge that decides
 * who hears whom. Every one of those was missing or wrong before: the request
 * was routed as a channel named "externalMedia" and answered 404, `ulaw` was
 * sent as if it were PCM, and a bridge was a 204 that paired nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Switch, Leg } from '../src/switch.js';
import { AriBridge } from '../src/ari.js';
import { createUpgradeHandler } from '../src/ws.js';
import { pcm16ToUlaw, ulawToPcm16, pcmFrame } from '../src/media.js';
import { waitUntil } from './wait.js';

const AUTH = `Basic ${Buffer.from('dograh:secret').toString('base64')}`;

function mediaSwitch() {
  const sw = new Switch({
    domain: 'media.test',
    id: 'switch@media.test',
    secret: 'media-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
  });
  return sw;
}

/** One answered inbound call — the shape a DID reaches the switch in. */
function answeredCall(sw) {
  const call = {
    id: 'call-media-1',
    direction: 'inbound',
    from: '14134210134',
    to: '14132642700@media.test',
    route: 'did-14132642700-after-hours',
    state: 'answered',
    startedAt: Date.now(),
    answeredAt: Date.now(),
    endedAt: 0,
    cause: '',
    legs: [],
    recording: '',
    recordingName: '',
    recordBuffer: [],
    recordBytes: 0,
    events: [],
  };
  const leg = new Leg({ call, role: 'inbound', ext: '14132642700' });
  leg.state = 'answered';
  leg.answeredAt = Date.now();
  call.legs.push(leg);
  sw.calls.set(call.id, call);
  return { call, leg };
}

/** A stand-in media endpoint: accepts the socket and records what arrives. */
async function mediaEndpoint() {
  const server = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  const peers = [];
  server.on(
    'upgrade',
    createUpgradeHandler((connection, request, url) => {
      const peer = { connection, url, text: [], audio: [] };
      connection.on('message', (data, isBinary) => {
        if (isBinary) peer.audio.push(Buffer.from(data));
        else peer.text.push(String(data));
      });
      peers.push(peer);
    })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/api/v1/telephony/ws/ari`,
    peers,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function bridge(sw, wsClients, { app = 'dograh' } = {}) {
  return new AriBridge({
    switch: sw,
    username: 'dograh',
    password: 'secret',
    app,
    wsClients,
  });
}

function request(path) {
  return {
    url: path,
    headers: { authorization: AUTH },
  };
}

const call = (ari, method, pathname, search = '') => {
  const url = new URL(`http://switch.test${pathname}${search ? `?${search}` : ''}`);
  return ari.handle(method, url.pathname, url, request(url.pathname + url.search));
};

test('externalMedia dials the named connection and declares ulaw', async (t) => {
  const sw = mediaSwitch();
  const endpoint = await mediaEndpoint();
  t.after(() => endpoint.close());
  const ari = bridge(sw, { dograh: endpoint.url });
  const { leg } = answeredCall(sw);
  const events = [];
  ari.subscribe('dograh', { sendJson: (message) => events.push(message), on: () => {} });

  const response = await call(
    ari,
    'POST',
    '/ari/channels/externalMedia',
    [
      'channelId=ext-1',
      'app=dograh',
      'external_host=dograh',
      'format=ulaw',
      'transport=websocket',
      'encapsulation=none',
      'connection_type=client',
      'direction=both',
      `transport_data=${encodeURIComponent('v(workflow_id=7,organization_id=2,workflow_run_id=42)')}`,
    ].join('&')
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.id, 'ext-1');
  assert.equal(response.body.state, 'Up');

  const peer = await waitUntil(() => endpoint.peers[0], { label: 'the media socket' });
  // The ids an agent runtime routes the call by only arrive through v().
  assert.equal(peer.url.searchParams.get('workflow_id'), '7');
  assert.equal(peer.url.searchParams.get('organization_id'), '2');
  assert.equal(peer.url.searchParams.get('workflow_run_id'), '42');
  const start = await waitUntil(() => peer.text[0], { label: 'MEDIA_START' });
  assert.match(start, /^MEDIA_START /);
  assert.match(start, /format:ulaw/);
  assert.match(start, /optimal_frame_size:160/);
  assert.equal(ari.findLeg('ext-1').isAnswered, true);
  assert.equal(leg.isAnswered, true);
  // The application waits for this before it bridges: a media channel nobody
  // announced is a pipeline that answers and a caller who hears nothing.
  const stasis = await waitUntil(
    () => events.find((event) => event.type === 'StasisStart' && event.channel?.id === 'ext-1'),
    { label: 'StasisStart for the media channel' }
  );
  assert.equal(stasis.channel.state, 'Up');

  ari.closeExternal('ext-1', 'test done');
});

test('an unconfigured external_host is refused with the setting to add', async () => {
  const sw = mediaSwitch();
  const ari = bridge(sw, {});
  answeredCall(sw);

  const response = await call(
    ari,
    'POST',
    '/ari/channels/externalMedia',
    'channelId=ext-2&external_host=dograh&format=ulaw'
  );

  assert.equal(response.status, 400);
  assert.match(response.body.message, /CANTUS_WS_CLIENTS=dograh=/);
});

test('a format the switch does not carry is refused by name', async () => {
  const sw = mediaSwitch();
  const ari = bridge(sw, { dograh: 'ws://127.0.0.1:1/never' });
  answeredCall(sw);

  const response = await call(
    ari,
    'POST',
    '/ari/channels/externalMedia',
    'channelId=ext-3&external_host=dograh&format=opus'
  );

  assert.equal(response.status, 400);
  assert.match(response.body.message, /format=opus/);
  assert.match(response.body.message, /ulaw/);
});

test('bridged audio crosses the socket as ulaw, both ways', async (t) => {
  const sw = mediaSwitch();
  const endpoint = await mediaEndpoint();
  t.after(() => endpoint.close());
  const ari = bridge(sw, { dograh: endpoint.url });
  const { leg } = answeredCall(sw);

  const created = await call(
    ari,
    'POST',
    '/ari/channels/externalMedia',
    'channelId=ext-4&external_host=dograh&format=ulaw&transport=websocket&connection_type=client&direction=both'
  );
  assert.equal(created.status, 200);
  const peer = await waitUntil(() => endpoint.peers[0], { label: 'the media socket' });

  const created_bridge = await call(ari, 'POST', '/ari/bridges', 'type=mixing&name=bridge-test');
  assert.equal(created_bridge.status, 200);
  const bridgeId = created_bridge.body.id;
  const added = await call(
    ari,
    'POST',
    `/ari/bridges/${bridgeId}/addChannel`,
    `channel=${encodeURIComponent(`${leg.id},ext-4`)}`
  );
  assert.equal(added.status, 204);
  assert.equal(sw.mediaPairs.get(leg.id), 'ext-4');
  assert.equal(sw.mediaPairs.get('ext-4'), leg.id);

  // The caller speaks: the agent must receive it as ulaw, not as PCM.
  const tone = pcmFrame({ hz: 440, amp: 8000 }).payload;
  sw.onMedia(leg, Buffer.from(tone));
  const frame = await waitUntil(
    () => peer.audio.find((payload) => payload.length === 160 && payload.some((byte) => byte !== 0xff && byte !== 0x7f)),
    { label: 'caller audio on the media socket' }
  );
  const heard = ulawToPcm16(frame);
  assert.ok(Math.abs(heard.readInt16LE(0) - tone.readInt16LE(0)) < 320, 'the first sample survives the codec');

  // The agent speaks: the caller must hear it, through the same pairing.
  const agentTone = Buffer.from(pcmFrame({ hz: 660, amp: 6000, phase: 1 }).payload);
  peer.connection.send(pcm16ToUlaw(agentTone), { binary: true });
  // Wait on the channel having received it, not on a 320-byte buffer: silence
  // is 320 bytes too, and waiting for the length would pass before the audio
  // arrived and then assert against the silence.
  const extLeg = ari.findLeg('ext-4');
  await waitUntil(() => extLeg.received >= 1, { label: 'the agent frame being decoded' });
  const toCaller = sw.audioTo(leg);
  assert.ok(toCaller && toCaller.length === agentTone.length, 'the caller hears a full frame');
  assert.ok(Math.abs(toCaller.readInt16LE(0) - agentTone.readInt16LE(0)) < 320);

  ari.closeExternal('ext-4', 'test done');
});

test('hanging up the media channel leaves the conversation up', async (t) => {
  const sw = mediaSwitch();
  const endpoint = await mediaEndpoint();
  t.after(() => endpoint.close());
  const ari = bridge(sw, { dograh: endpoint.url });
  const { call: callRef, leg } = answeredCall(sw);

  await call(
    ari,
    'POST',
    '/ari/channels/externalMedia',
    'channelId=ext-5&external_host=dograh&format=ulaw&transport=websocket&connection_type=client'
  );
  const peer = await waitUntil(() => endpoint.peers[0], { label: 'the media socket' });
  const createdBridge = await call(ari, 'POST', '/ari/bridges', 'type=mixing');
  await call(
    ari,
    'POST',
    `/ari/bridges/${createdBridge.body.id}/addChannel`,
    `channel=${encodeURIComponent(`${leg.id},ext-5`)}`
  );

  const closed = await call(ari, 'DELETE', '/ari/channels/ext-5');
  assert.equal(closed.status, 204);
  await waitUntil(() => peer.connection.closed, { label: 'the socket closing' });
  // The pairing is what a stale media channel would leave behind: a caller
  // hearing silence from a peer that is no longer there.
  assert.equal(sw.mediaPairs.get(leg.id), undefined);
  assert.equal(sw.mediaPairs.get('ext-5'), undefined);
  assert.equal(callRef.state, 'answered');
  assert.equal(leg.isAnswered, true);
});

test('the per-channel spelling says where externalMedia lives', async () => {
  const sw = mediaSwitch();
  const ari = bridge(sw, {});
  const { leg } = answeredCall(sw);

  const response = await call(ari, 'POST', `/ari/channels/${leg.id}/externalMedia`, 'external_host=dograh');
  assert.equal(response.status, 400);
  assert.match(response.body.message, /POST \/ari\/channels\/externalMedia/);
});
