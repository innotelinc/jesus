/**
 * The SIP side over real datagrams: a registrar that challenges, and a dialog
 * that is established, answered and torn down between two trunks on loopback.
 *
 * A parser that agrees with itself proves nothing. These two tests put actual
 * UDP on the wire, which is the only thing a carrier will ever do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { SipTrunk, parseMessage, buildResponse, buildSdp, parseSdpAddress } from '../src/sip.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('REGISTER answers a 401 challenge with digest and then registers', async (t) => {
  const seen = [];
  const registrar = dgram.createSocket('udp4');
  registrar.on('message', (buf, rinfo) => {
    const message = parseMessage(buf.toString());
    if (message.method !== 'REGISTER') return;
    seen.push(message);
    const headers = [
      ['Via', message.get('via')],
      ['From', message.get('from')],
      ['To', message.get('to')],
      ['Call-ID', message.get('call-id')],
      ['CSeq', message.get('cseq')],
      ['Contact', message.get('contact')],
    ];
    const authorization = message.get('authorization');
    if (!authorization) {
      headers.push(['WWW-Authenticate', 'Digest realm="atlanta.voip.ms", nonce="abc123", qop="auth", algorithm=MD5']);
      registrar.send(buildResponse({ status: 401, reason: 'Unauthorized', headers }), rinfo.port, rinfo.address);
      return;
    }
    headers.push(['Expires', '300']);
    registrar.send(buildResponse({ status: 200, reason: 'OK', headers }), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => registrar.bind(0, '127.0.0.1', resolve));
  const registrarPort = registrar.address().port;

  const trunk = new SipTrunk({
    host: '127.0.0.1',
    port: registrarPort,
    username: '123456_switch',
    password: 'not-a-real-password',
    domain: 'atlanta.voip.ms',
    contactHost: '127.0.0.1',
  });
  t.after(() => {
    trunk.stop();
    registrar.close();
  });

  await trunk.start();
  await sleep(80);

  assert.equal(trunk.registered, true, 'the second REGISTER should be accepted');
  assert.equal(seen.length, 2, 'one challenge, one authenticated retry');
  const authorization = seen[1].get('authorization');
  assert.match(authorization, /^Digest /);
  assert.match(authorization, /username="123456_switch"/);
  assert.match(authorization, /realm="atlanta\.voip\.ms"/);
  assert.match(authorization, /uri="sip:atlanta\.voip\.ms"/);
  assert.match(authorization, /qop=auth/);
  assert.match(authorization, /response="[0-9a-f]{32}"/);
});

test('an INVITE is answered with SDP and its audio address is parsed back', async (t) => {
  const carrier = new SipTrunk({ host: '127.0.0.1', localPort: 0, contactHost: '127.0.0.1' });
  await carrier.start();
  const gateway = new SipTrunk({
    host: '127.0.0.1',
    port: carrier.bound,
    contactHost: '127.0.0.1',
    localPort: 0,
  });
  t.after(() => {
    carrier.stop();
    gateway.stop();
  });

  const received = [];
  carrier.onInvite = (call, audio) => {
    received.push({ call, audio });
    carrier.answer(call, { sdp: buildSdp({ address: '198.51.100.20', port: 41000 }) });
  };

  await gateway.start();
  let answeredAudio;
  const call = gateway.invite({
    to: '14134210134',
    sdp: buildSdp({ address: '203.0.113.9', port: 40000 }),
    timeoutMs: 4000,
  });
  call.onAnswered = (_call, audio) => {
    answeredAudio = audio;
  };

  await sleep(150);

  assert.equal(received.length, 1, 'the carrier should have been INVITEd once');
  const [{ call: inboundCall, audio }] = received;
  assert.equal(parseSdpAddress(inboundCall.request.body, '').port, 40000, 'the offered port travels in SDP');
  assert.match(String(inboundCall.request.get('to')), /sip:14134210134@/);
  // What the callee is given is the *caller's* audio address, taken from the
  // offer — that is where its RTP has to go.
  assert.deepEqual(audio, { host: '203.0.113.9', port: 40000, pcmu: true }, 'the carrier sees PCMU offered');

  assert.deepEqual(answeredAudio, { host: '198.51.100.20', port: 41000, pcmu: true });
  assert.equal(call.state, 'confirmed');

  gateway.bye(call);
  await sleep(80);
  assert.equal(call.state, 'ended');
});
