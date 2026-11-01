/**
 * The registrar half of the border: a local handset's REGISTER.
 *
 * A gateway that only speaks to a carrier is a trunk, not a phone system. These
 * tests drive the same `handle()` a datagram reaches, so what is asserted is the
 * behaviour an ATA sees: challenged once, accepted only with the right password,
 * and reachable at the address it registered from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SipTrunk, parseMessage, buildRequest, digestResponse } from '../src/sip.js';

function registrar({ users = [['101', 'front-desk']] } = {}) {
  const trunk = new SipTrunk({ host: '', domain: 'estate.local', ataUsers: new Map(users) });
  const replies = [];
  trunk.reply = (rinfo, request, status, reason, options = {}) => {
    replies.push({ status, reason, extra: options.extra || [] });
  };
  return { trunk, replies };
}

function register({ ext = '101', authorization = '', port = 5062 } = {}) {
  const headers = [
    ['Via', `SIP/2.0/UDP 127.0.0.1:${port};branch=z9hG4bK${Math.random().toString(16).slice(2)};rport`],
    ['From', `<sip:${ext}@estate.local>;tag=ata`],
    ['To', `<sip:${ext}@estate.local>`],
    ['Call-ID', `ata-${port}@estate.local`],
    ['CSeq', '1 REGISTER'],
    ['Contact', `<sip:${ext}@127.0.0.1:${port}>;expires=300`],
    ['Expires', '300'],
  ];
  if (authorization) headers.push(['Authorization', authorization]);
  return { text: buildRequest({ method: 'REGISTER', uri: 'sip:estate.local', headers }).toString('utf8'), rinfo: { address: '127.0.0.1', port } };
}

function challengeOf(replies) {
  const header = replies.find((entry) => entry.status === 401)?.extra.find(([name]) => name === 'WWW-Authenticate')?.[1];
  assert.ok(header, 'the first REGISTER must be challenged');
  const params = {};
  for (const match of header.matchAll(/([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g)) params[match[1].toLowerCase()] = match[2] ?? match[3];
  return params;
}

test('an unauthenticated REGISTER is challenged, then accepted with digest', () => {
  const { trunk, replies } = registrar();
  const first = register();
  trunk.handle(first.text, first.rinfo);

  assert.equal(replies[0].status, 401);
  assert.equal(trunk.contacts.size, 0, 'nothing is stored before the password is proved');

  const challenge = challengeOf(replies);
  const authorization = digestResponse({
    username: '101',
    password: 'front-desk',
    realm: challenge.realm,
    nonce: challenge.nonce,
    uri: 'sip:estate.local',
    method: 'REGISTER',
    qop: challenge.qop ? 'auth' : undefined,
    nc: '00000001',
    cnonce: 'ata1',
  });
  const second = register({ authorization });
  trunk.handle(second.text, second.rinfo);

  assert.equal(replies.at(-1).status, 200);
  const contact = trunk.contacts.get('101');
  assert.ok(contact, 'the extension should be registered');
  assert.equal(contact.addr.port, 5062, 'the address the datagram came from is the one that can receive');
  assert.equal(trunk.registeredAtas.length, 1);
});

test('the wrong password is refused, and is not a retry', () => {
  const { trunk, replies } = registrar();
  const first = register();
  trunk.handle(first.text, first.rinfo);
  const challenge = challengeOf(replies);
  const authorization = digestResponse({
    username: '101',
    password: 'not-the-password',
    realm: challenge.realm,
    nonce: challenge.nonce,
    uri: 'sip:estate.local',
    method: 'REGISTER',
  });
  const second = register({ authorization });
  trunk.handle(second.text, second.rinfo);
  assert.equal(replies.at(-1).status, 403);
  assert.equal(trunk.contacts.size, 0);
});

test('an extension nobody configured cannot register at all', () => {
  const { trunk, replies } = registrar();
  const attempt = register({ ext: '999' });
  trunk.handle(attempt.text, attempt.rinfo);
  assert.equal(replies.at(-1).status, 403);
  assert.equal(trunk.contacts.size, 0);
});

test('an ATA can unregister with expires 0', () => {
  const { trunk, replies } = registrar();
  const first = register();
  trunk.handle(first.text, first.rinfo);
  const challenge = challengeOf(replies);
  const authorization = digestResponse({
    username: '101',
    password: 'front-desk',
    realm: challenge.realm,
    nonce: challenge.nonce,
    uri: 'sip:estate.local',
    method: 'REGISTER',
    qop: challenge.qop ? 'auth' : undefined,
  });
  trunk.handle(register({ authorization }).text, register().rinfo);
  assert.ok(trunk.contacts.has('101'));

  const headers = [
    ['Via', 'SIP/2.0/UDP 127.0.0.1:5062;branch=z9hG4bKbye;rport'],
    ['From', '<sip:101@estate.local>;tag=ata'],
    ['To', '<sip:101@estate.local>'],
    ['Call-ID', 'ata-bye@estate.local'],
    ['CSeq', '2 REGISTER'],
    ['Contact', '<sip:101@127.0.0.1:5062>;expires=0'],
    ['Expires', '0'],
    ['Authorization', authorization],
  ];
  trunk.handle(buildRequest({ method: 'REGISTER', uri: 'sip:estate.local', headers }).toString('utf8'), { address: '127.0.0.1', port: 5062 });
  assert.equal(trunk.contacts.size, 0);
  assert.equal(replies.at(-1).status, 200);
});

test('a registrar with no carrier still starts', async () => {
  const trunk = new SipTrunk({ host: '', domain: 'estate.local', ataUsers: new Map([['101', 'front-desk']]) });
  await trunk.start();
  assert.ok(trunk.bound > 0, 'the SIP socket must be bound even with no carrier');
  trunk.stop();
  assert.throws(() => new SipTrunk({}), /host or at least one ATA user/);
});

// Keep the parser import honest: a REGISTER is a request, not a response.
test('a REGISTER parses as a request', () => {
  const message = parseMessage(register().text);
  assert.equal(message.type, 'request');
  assert.equal(message.method, 'REGISTER');
});
