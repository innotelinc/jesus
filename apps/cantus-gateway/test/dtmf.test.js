/**
 * Keypresses across the SIP border.
 *
 * A digit is the one part of a call that is not audio: the carrier sends it as
 * an RFC 4733 event, Cantus carries it as `INFO event=dtmf`, and the gateway is
 * the only place the two representations meet. These tests drive real UDP
 * sockets for the RTP half, because a parser that accepts its own output proves
 * nothing about what a carrier sends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { RtpSession, DTMF, dtmfEvent } from '../src/rtp.js';
import { buildSdp, parseSdpAddress } from '../src/sip.js';
import { Gateway } from '../src/gateway.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One RFC 4733 packet, the shape a carrier puts on the wire. */
function eventPacket({ type = DTMF, event = 5, ended = false, duration = 160, seq = 1, ts = 8000 } = {}) {
  const packet = Buffer.alloc(16);
  packet[0] = 0x80;
  packet[1] = type;
  packet.writeUInt16BE(seq, 2);
  packet.writeUInt32BE(ts, 4);
  packet.writeUInt32BE(0x1234, 8);
  packet[12] = event;
  packet[13] = (ended ? 0x80 : 0) | 0x0a;
  packet.writeUInt16BE(duration, 14);
  return packet;
}

function listen(t) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      t.after(() => socket.close());
      resolve(socket);
    });
  });
}

test('the keypad maps to the RFC 4733 event codes, and nothing else does', () => {
  assert.equal(dtmfEvent('5'), 5);
  assert.equal(dtmfEvent('*'), 10);
  assert.equal(dtmfEvent('#'), 11);
  assert.equal(dtmfEvent('d'), 15);
  assert.equal(dtmfEvent('flash'), null);
  assert.equal(dtmfEvent(''), null);
});

test('the offer advertises an event type, and an answer does not invent one', () => {
  const offer = buildSdp({ address: '203.0.113.9', port: 40000 });
  assert.match(offer, /m=audio 40000 RTP\/AVP 0 101/);
  assert.match(offer, /a=rtpmap:101 telephone-event\/8000/);
  assert.match(offer, /a=fmtp:101 0-16/);

  const refused = buildSdp({ address: '203.0.113.9', port: 40000, dtmf: 0 });
  assert.match(refused, /m=audio 40000 RTP\/AVP 0\r\n/);
  assert.doesNotMatch(refused, /telephone-event/);
});

test("the carrier's own event payload type is read from its SDP", () => {
  const sdp = [
    'v=0',
    'm=audio 41000 RTP/AVP 0 96',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:96 telephone-event/8000',
    'a=fmtp:96 0-16',
  ].join('\r\n');
  const audio = parseSdpAddress(sdp, '198.51.100.7');
  assert.equal(audio.pcmu, true);
  assert.equal(audio.dtmfType, 96);

  const plain = parseSdpAddress('v=0\r\nm=audio 41000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000', '198.51.100.7');
  assert.equal(plain.dtmfType, null, 'no event type means the far side cannot send digits');
});

test('a keypress sent as RTP arrives once, however many packets carry it', async (t) => {
  const sender = new RtpSession();
  const receiver = new RtpSession();
  t.after(() => {
    sender.close();
    receiver.close();
  });
  await sender.start();
  await receiver.start();
  sender.to('127.0.0.1', receiver.port);
  receiver.to('127.0.0.1', sender.port);

  const digits = [];
  receiver.onDtmf = (digit) => digits.push(digit);

  // A real burst: the start packet is repeated while the key is held, then one
  // packet with the end bit.
  sender.transmit(eventPacket({ event: 5, seq: 100 }));
  sender.transmit(eventPacket({ event: 5, seq: 101, duration: 320 }));
  sender.transmit(eventPacket({ event: 5, seq: 102, ended: true, duration: 480 }));
  sender.transmit(eventPacket({ event: 11, seq: 103, ts: 8320 }));

  await sleep(100);

  assert.deepEqual(digits, ['5', '#'], 'one digit per key, not one per packet');
  assert.equal(receiver.received, 0, 'a keypress is not counted as audio');
});

test('sending a digit writes an event the carrier can read', async (t) => {
  const carrier = await listen(t);
  const sender = new RtpSession();
  t.after(() => sender.close());
  await sender.start();
  sender.to('127.0.0.1', carrier.address().port);

  const packets = [];
  carrier.on('message', (buffer) => packets.push(buffer));

  assert.equal(sender.sendDtmf('7'), true);
  await sleep(80);

  assert.ok(packets.length >= 2, 'a keypress is a start packet and an end packet');
  const start = packets[0];
  assert.equal(start[1] & 0x7f, DTMF);
  assert.equal(start[12], 7);
  assert.equal(start[13] & 0x80, 0);
  assert.equal(packets.at(-1)[12], 7);
  assert.equal(packets.at(-1)[13] & 0x80, 0x80, 'the last packet ends the event');

  assert.equal(sender.sendDtmf('x'), false, 'something that is not a key is not sent');
});

/** The surface the gateway uses, with the Cantus side recording what it got. */
function fakeEndpoint() {
  return {
    id: 'voipms@gateway',
    localAddr: '127.0.0.1:7453',
    ready: true,
    relay: '',
    sessions: new Map(),
    stats: {},
    calls: [],
    dtmf: [],
    call(to) {
      this.calls.push(to);
      const id = `call-${this.calls.length}`;
      this.sessions.set(id, { call: id, isEnded: false });
      this.lastId = id;
      return id;
    },
    accept(session) {
      this.accepted = session?.call ?? session;
    },
    reject() {},
    hangup() {},
    sendDtmf(session, digit) {
      this.dtmf.push([session.call, digit]);
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
    invite({ to }) {
      this.invites.push({ to });
      const call = { kind: 'outbound', callId: 'sip-out-1', state: 'calling', answered: false };
      this.lastCall = call;
      return call;
    },
    answer() {},
    reject() {},
    bye() {},
  };
}

async function makeGateway(t) {
  const endpoint = fakeEndpoint();
  const trunk = fakeTrunk();
  const gateway = new Gateway({
    endpoint,
    trunk,
    switchId: 'switch@estate.local',
    domain: 'estate.local',
    advertise: '203.0.113.9',
    // Distinct from the other files' gateways: node runs test files in
    // parallel and two bindings of the same UDP port fail as a test error.
    rtpStart: 42000,
    rtpEnd: 42063,
  });
  t.after(() => {
    for (const leg of gateway.legs.values()) leg.rtp?.close();
  });
  return { gateway, endpoint, trunk };
}

test("a carrier's keypress reaches the switch as a Cantus INFO", async (t) => {
  const { gateway, endpoint } = await makeGateway(t);
  const call = {
    kind: 'inbound',
    callId: 'sip-in-dtmf',
    uri: 'sip:+14132642700@atlanta.voip.ms',
    request: { get: (name) => ({ to: '<sip:+14132642700@atlanta.voip.ms>', from: '<sip:+15550000000@x>;tag=a' })[name] },
    audio: { host: '127.0.0.1', port: 40000, pcmu: true, dtmfType: 96 },
    answered: false,
  };

  await gateway.onSipCall(call);
  const leg = gateway.legs.get(endpoint.lastId);
  assert.ok(leg, 'the inbound call has a leg');
  assert.equal(leg.rtp.dtmfType, 96, 'the carrier chose the payload type, not us');
  assert.match(leg.offer, /m=audio \d+ RTP\/AVP 0 96/, 'the answer names the type the carrier offered');

  leg.rtp.handle(eventPacket({ type: 96, event: 10 }));
  assert.deepEqual(endpoint.dtmf, [[endpoint.lastId, '*']], 'the digit arrives on the Cantus leg');
});

test("the switch's keypress is written to the carrier as an RTP event", async (t) => {
  const { gateway, endpoint } = await makeGateway(t);
  const carrier = await listen(t);
  const packets = [];
  carrier.on('message', (buffer) => packets.push(buffer));

  await gateway.onCantusCall({ call: 'call-9' }, '14134210134@voipms@gateway');
  assert.equal(gateway.trunk.invites[0].to, '14134210134');
  // The Cantus leg is accepted only after the carrier answers, which is when
  // the gateway first learns where to send media and events.
  const sipCall = gateway.trunk.lastCall;
  sipCall.onAnswered(sipCall, { host: '127.0.0.1', port: carrier.address().port, pcmu: true, dtmfType: 96 });
  assert.equal(endpoint.accepted, 'call-9');
  assert.equal(gateway.status().calls[0].direction, 'outbound');

  gateway.onEndpointEvent({ kind: 'dtmf', call: 'call-9', digit: '#' });
  await sleep(60);

  assert.ok(packets.length >= 1, 'the carrier got an event packet');
  assert.equal(packets[0][1] & 0x7f, 96, "the answered stream's type is used");
  assert.equal(packets[0][12], 11, '# is event 11');
});

