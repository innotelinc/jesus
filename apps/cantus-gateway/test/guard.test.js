/**
 * What the border refuses, and why it costs nothing to refuse it.
 *
 * The SIP socket is the only place in the deployment that accepts bytes from
 * outside the estate (border profile §7), so it has to survive being shouted at:
 * a flood must not become a ring, and a request that cannot be a dialog must be
 * answered once with 400 rather than ignored into a retransmission storm.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SipTrunk, unroutable } from '../src/sip.js';

/** A trunk with a socket stub: the guard is testable without binding UDP. */
function trunk(options = {}) {
  const logs = [];
  const sent = [];
  const answered = [];
  const t = new SipTrunk({
    host: 'sip.example.net',
    port: 5060,
    domain: 'example.net',
    contactHost: '127.0.0.1',
    onLog: (entry) => logs.push(entry),
    onInvite: (call) => answered.push(call.callId),
    ...options,
  });
  t.localPort = 5060;
  t.socket = {
    send: (buffer, port, address) => sent.push({ text: buffer.toString('utf8'), port, address }),
  };
  return { t, logs, sent, answered };
}

const invite = ({ userinfo = '14135551212', uri = 'sip:14135551212@example.net' } = {}) =>
  [
    `INVITE ${uri} SIP/2.0`,
    'Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK1',
    `From: <sip:${userinfo}@example.net>;tag=abc123`,
    'To: <sip:14135551212@example.net>',
    'Call-ID: 8f1c@203.0.113.9',
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

test('a spliced userinfo is refused with 400 and never rings', () => {
  const { t, logs, sent, answered } = trunk();
  // The shape seen in the call log: a number pasted onto our own domain, twice.
  t.handle(invite({ userinfo: '002421220412287@switch' }), { address: '203.0.113.9', port: 5060 });
  assert.deepEqual(answered, [], 'a malformed INVITE must not reach the switch');
  assert.equal(sent.length, 1, 'one refusal, not a retransmission storm');
  assert.match(sent[0].text, /^SIP\/2\.0 400 Bad Request/);
  assert.equal(logs.at(-1).kind, 'malformed');
  assert.equal(logs.at(-1).reason, 'double-at');
});

test('a dialog without the headers it is built from is refused', () => {
  const { t, sent } = trunk();
  const text = invite().replace(/^Call-ID:.*\r\n/m, '');
  t.handle(text, { address: '203.0.113.9', port: 5060 });
  assert.match(sent[0].text, /^SIP\/2\.0 400 Bad Request/);
});

test('unroutable names the first thing that is wrong', () => {
  const message = (value) => ({
    uri: value,
    get: (name) => ({ 'call-id': 'a@b', from: '<sip:1@example.net>', to: '<sip:2@example.net>', via: 'SIP/2.0/UDP 1.2.3.4' })[name],
  });
  assert.equal(unroutable(message('sip:1@example.net'), 'x'), '');
  assert.equal(unroutable(message('sip:1@2@example.net'), 'x'), 'double-at');
  assert.equal(unroutable(message('sip:1@example.net'), ''), 'size');
  assert.equal(unroutable(message('sip:1@example.net'), 'x'.repeat(9000)), 'size');
});

test('a flood is dropped instead of answered', () => {
  const { t, logs, sent } = trunk({ maxPerSecond: 5, burst: 10, abuseDrops: 5, blockMs: 60_000 });
  const options = [
    'OPTIONS sip:example.net SIP/2.0',
    'Via: SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK2',
    'From: <sip:scanner@example.net>;tag=x',
    'To: <sip:example.net>',
    'Call-ID: flood@198.51.100.7',
    'CSeq: 1 OPTIONS',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  for (let i = 0; i < 400; i += 1) t.handle(options, { address: '198.51.100.7', port: 5060 });
  assert.ok(sent.length <= 11, `burst is 10, so no more than that is answered; got ${sent.length}`);
  assert.ok(
    logs.some((entry) => entry.kind === 'sip-rate-limited' || entry.kind === 'sip-flood-blocked'),
    'the guard must say it dropped traffic'
  );
  assert.equal(t.sources.get('198.51.100.7').blockedUntil > Date.now(), true, 'sustained abuse is blocked outright');
});

test('the source table does not grow without bound', () => {
  const { t } = trunk({ burst: 1, maxPerSecond: 1 });
  const text = 'OPTIONS sip:example.net SIP/2.0\r\nCall-ID: a@b\r\nFrom: <sip:1@example.net>\r\nTo: <sip:2@example.net>\r\nVia: SIP/2.0/UDP 1.2.3.4\r\n\r\n';
  for (let i = 0; i < 4200; i += 1) {
    t.handle(text, { address: `198.51.${Math.floor(i / 256)}.${i % 256}`, port: 5060 });
  }
  assert.ok(t.sources.size <= 4097, `swept table stays bounded, got ${t.sources.size}`);
});
