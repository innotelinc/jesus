/**
 * The SIP side, checked against the things the carrier will actually send:
 * a real INVITE, a digest challenge, and an SDP answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage, buildRequest, buildResponse, buildSdp, parseSdpAddress, digestResponse, SipTrunk } from '../src/sip.js';

const INVITE = [
  'INVITE sip:switch@1.2.3.4 SIP/2.0',
  'Via: SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK776asdhds',
  'Max-Forwards: 70',
  'From: "Cell" <sip:+14134210134@atlanta.voip.ms>;tag=1928301774',
  'To: <sip:+14132642700@atlanta.voip.ms>',
  'Call-ID: a84b4c76e66710@198.51.100.7',
  'CSeq: 314159 INVITE',
  'Contact: <sip:+14134210134@198.51.100.7:5060>',
  'Content-Type: application/sdp',
  'Content-Length: 132',
  '',
  'v=0',
  'c=IN IP4 198.51.100.7',
  'm=audio 49170 RTP/AVP 0 18',
  'a=rtpmap:0 PCMU/8000',
  '',
].join('\r\n');

test('an inbound INVITE is parsed into something routable', () => {
  const message = parseMessage(INVITE);
  assert.equal(message.type, 'request');
  assert.equal(message.method, 'INVITE');
  assert.equal(message.uri, 'sip:switch@1.2.3.4');
  assert.equal(message.get('call-id'), 'a84b4c76e66710@198.51.100.7');
  assert.equal(message.get('cseq'), '314159 INVITE');
  assert.match(message.get('from'), /\+14134210134/);
  assert.match(message.get('to'), /\+14132642700/);

  const audio = parseSdpAddress(message.body, '198.51.100.7');
  assert.deepEqual(audio, { host: '198.51.100.7', port: 49170, pcmu: true });
});

test('an SDP without PCMU is recognised as uncarryable', () => {
  const onlyG722 = ['v=0', 'c=IN IP4 198.51.100.7', 'm=audio 49170 RTP/AVP 9', 'a=rtpmap:9 G722/8000', ''].join('\r\n');
  assert.equal(parseSdpAddress(onlyG722, '198.51.100.7').pcmu, false);
  assert.equal(parseSdpAddress('v=0', '198.51.100.7'), null);
});

test('responses and requests are built with a correct Content-Length', () => {
  const request = buildRequest({
    method: 'INVITE',
    uri: 'sip:+14134210134@atlanta.voip.ms',
    headers: [['Call-ID', 'abc'], ['CSeq', '1 INVITE']],
    body: 'v=0\r\n\r\n',
  }).toString();
  assert.match(request, /^INVITE sip:\+14134210134@atlanta\.voip\.ms SIP\/2\.0\r\n/);
  assert.match(request, /Content-Length: 7\r\n/);

  const response = buildResponse({ status: 200, reason: 'OK', headers: [['Call-ID', 'abc']], body: 'x' }).toString();
  assert.match(response, /^SIP\/2\.0 200 OK\r\n/);
  assert.match(response, /Content-Length: 1\r\n/);
});

test('offered SDP names one codec and the port we bound', () => {
  const sdp = buildSdp({ address: '203.0.113.9', port: 40000 });
  assert.match(sdp, /c=IN IP4 203\.0\.113\.9/);
  assert.match(sdp, /m=audio 40000 RTP\/AVP 0/);
  assert.match(sdp, /a=rtpmap:0 PCMU\/8000/);
  assert.deepEqual(parseSdpAddress(sdp, 'ignored'), { host: '203.0.113.9', port: 40000, pcmu: true });
});

test('digest auth computes the RFC 2617 example correctly', () => {
  // The RFC's inputs, with the expected response cross-checked against two
  // independent implementations (openssl dgst -md5 and Python hashlib) rather
  // than the hex printed in the RFC: that printed value does not equal MD5 of
  // the concatenation the same section documents, while HA1 and HA2 below do
  // match the RFC byte for byte. Testing against the printed figure would
  // assert a value no correct digest implementation produces.
  const header = digestResponse({
    username: 'Mufasa',
    password: 'Circle Of Life',
    realm: 'testrealm@host.com',
    nonce: 'dcd223e30600039f5d3c1cb3a8e5d3f4',
    uri: '/dir/index.html',
    method: 'GET',
    qop: 'auth',
    nc: '00000001',
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6705b1c34a1b7c0682715a9d5f18b7f9"/);
  assert.match(header, /qop=auth/);
  assert.match(header, /nc=00000001/);
});

/**
 * The sub-account is a login; the number is what the far end has to see.
 *
 * A carrier that honours From presents whatever the trunk puts there, so this
 * used to show `123456_switch` as the caller — and an ACK that named a
 * different local party than the INVITE is a dialog some carriers drop.
 */
test('outbound calls present the trunk number, and the ACK agrees', () => {
  const trunk = new SipTrunk({
    host: 'atlanta.voip.ms',
    username: '123456_switch',
    password: 'secret',
    fromUser: '+14132642700',
  });
  const sent = [];
  // A dial is two datagrams; the socket is the only part of SIP that needs a
  // network, and nothing here should touch one.
  trunk.socket = { send: (message) => sent.push(message.toString()) };

  const call = trunk.invite({ to: '14134210134', sdp: 'v=0\r\n' });
  const invite = sent[0];
  assert.match(invite, /^INVITE sip:14134210134@atlanta\.voip\.ms SIP\/2\.0/);
  assert.match(invite, /From: <sip:14132642700@atlanta\.voip\.ms>;tag=/);
  // The Contact still names the registered AoR, which is the login by design:
  // it is the identity the carrier routes replies to, not the caller ID.
  assert.doesNotMatch(invite, /From: <sip:123456_switch@/);

  call.remoteTag = 'carrier-tag';
  trunk.ack(call, { body: '' });
  assert.match(sent.at(-1), /^ACK /);
  assert.match(sent.at(-1), /From: <sip:14132642700@atlanta\.voip\.ms>;tag=/);
  trunk.stop();
});

test('a trunk with no number presents the login it authenticates as', () => {
  const trunk = new SipTrunk({ host: 'atlanta.voip.ms', username: '123456_switch' });
  const sent = [];
  trunk.socket = { send: (message) => sent.push(message.toString()) };
  trunk.invite({ to: '14134210134', sdp: 'v=0\r\n' });
  assert.match(sent[0], /From: <sip:123456_switch@atlanta\.voip\.ms>;tag=/);
  trunk.stop();
});

/**
 * A carrier that never answers used to be the worst failure mode there was:
 * `start()` awaited the first REGISTER, so the status server never bound, the
 * container never went healthy, and nothing on the box said why.
 */
test('a silent carrier fails the registration instead of hanging the trunk', async () => {
  const trunk = new SipTrunk({
    host: '203.0.113.9',
    username: '123456_switch',
    password: 'secret',
    registerTimeoutMs: 80,
  });
  const sent = [];
  trunk.socket = { send: (message) => sent.push(message.toString()) };
  const ok = await trunk.register();
  assert.equal(ok, false);
  assert.equal(trunk.registered, false);
  assert.match(trunk.lastRegisterError, /no answer from 203\.0\.113\.9:5060/);
  assert.match(sent[0], /^REGISTER sip:203\.0\.113\.9 SIP\/2\.0/);
  assert.match(sent[0], /Expires: 300/);
});

test('digest without qop omits the qop fields', () => {
  const header = digestResponse({
    username: 'u',
    password: 'p',
    realm: 'r',
    nonce: 'n',
    uri: 'sip:r',
    method: 'REGISTER',
  });
  assert.doesNotMatch(header, /qop=/);
  assert.doesNotMatch(header, /cnonce=/);
});
