/**
 * `cantus/tls` (§4.4, §9.6): the binding that carries media.
 *
 * The conformance list in §15 asks for a datagram that arrives intact, and for
 * cleartext, TLS 1.2, an unpinned key and an oversize frame each to be refused.
 * It also asks that the exporter differ between sessions and that a signature
 * made under one does not verify under another — which is the property that
 * makes "the keys are bound to the handshake" testable rather than aspirational.
 *
 * These are real sockets and real certificates. `openssl` makes the key pairs
 * because Node has no certificate builder; everything after that is `node:tls`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CantusEndpoint } from '../src/endpoint.js';
import { listen, connect, devCertificate, frame } from '../src/tls-binding.js';
import { TYPES, F, s, decodeMsg } from '../src/wire.js';
import { waitUntil } from './wait.js';

const dir = mkdtempSync(join(tmpdir(), 'cantus-tls-'));
const serverCert = devCertificate({ dir: join(dir, 'server'), commonName: 'server.cantus.test' });
const clientCert = devCertificate({ dir: join(dir, 'client'), commonName: 'client.cantus.test' });

/** A listener that trusts exactly one pin, plus the session it last accepted. */
async function listenerFor(t, { faults = [] } = {}) {
  const seen = { session: undefined };
  const listener = await listen({
    host: '127.0.0.1',
    port: 0,
    cert: serverCert.cert,
    key: serverCert.key,
    pin: clientCert.pin,
    onSession: (session) => {
      seen.session = session;
      session.on('fault', (reason) => faults.push(reason));
    },
  });
  listener.errors.on('fault', (reason) => faults.push(reason));
  t.after(() => listener.close());
  return { listener, seen, faults };
}

test('a datagram crosses a TLS 1.3 session intact', async (t) => {
  const { listener, seen } = await listenerFor(t);
  const client = await connect({
    host: '127.0.0.1',
    port: listener.port,
    pin: serverCert.pin,
    cert: clientCert.cert,
    key: clientCert.key,
  });
  t.after(() => client.close());

  assert.equal(client.protocol, 'TLSv1.3');
  await waitUntil(() => seen.session?.binding, { label: 'the server session to finish its handshake' });

  const arrived = new Promise((resolve) => seen.session.once('datagram', resolve));
  client.send(Buffer.from('cantus/1 hello', 'utf8'));
  assert.equal((await arrived).toString('utf8'), 'cantus/1 hello');

  // Both ends exported the same session secret, which is what §10.2 signs over.
  assert.equal(client.binding.length, 32);
  assert.ok(client.binding.equals(seen.session.binding), 'the two ends must derive the same binding');
});

test('cleartext Cantus over a TLS port is refused', async (t) => {
  const faults = [];
  const { listener, seen } = await listenerFor(t, { faults });
  const socket = net.connect(listener.port, '127.0.0.1');
  socket.on('error', () => {});
  socket.write(frame(Buffer.from('cantus/1 HELLO', 'utf8')));

  await waitUntil(() => faults.length > 0 || seen.session?.closed, { label: 'the peer to be refused' });
  assert.equal(seen.session?.binding, undefined, 'no session may complete without a handshake');
  socket.destroy();
});

test('TLS 1.2 is refused rather than accepted at a lower grade', async (t) => {
  const { listener } = await listenerFor(t);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port: listener.port,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      });
      socket.once('secureConnect', () => resolve());
      socket.once('error', reject);
    })
  );
});

test('a peer that is not the pinned key is refused', async (t) => {
  const { listener } = await listenerFor(t);
  await assert.rejects(
    connect({
      host: '127.0.0.1',
      port: listener.port,
      // The client presents a valid certificate; it is simply not the pinned one.
      pin: clientCert.pin,
      cert: clientCert.cert,
      key: clientCert.key,
    }),
    /pinned key mismatch/
  );
});

test('a frame over the §13 ceiling closes the session', async (t) => {
  const faults = [];
  const { listener } = await listenerFor(t, { faults });
  const client = await connect({
    host: '127.0.0.1',
    port: listener.port,
    pin: serverCert.pin,
    cert: clientCert.cert,
    key: clientCert.key,
  });
  t.after(() => client.close());

  const header = Buffer.alloc(4);
  header.writeUInt16BE(1200, 0); // over 1150, before a single payload octet
  client.socket.write(header);

  await waitUntil(() => faults.some((reason) => /exceeds/.test(reason)), { label: 'the oversize frame to be refused' });
  assert.equal(client.closed, true);
});

test('a call and its audio cross the encrypted binding, and only this session', async (t) => {
  const secret = 'tls-end-to-end-secret-value';
  const ataEvents = [];
  const switchEvents = [];

  const ata = new CantusEndpoint({
    id: 'ata@tls.test',
    secret,
    transport: 'tls',
    bind: '127.0.0.1:0',
    allowTestProfile: true,
    tls: { cert: serverCert.cert, key: serverCert.key, pin: clientCert.pin },
    onEvent: (event) => ataEvents.push(event),
  });
  await ata.start();
  ata.onIncoming = (session) => ata.accept(session);
  t.after(() => ata.stop());

  const sw = new CantusEndpoint({
    id: 'switch@tls.test',
    secret,
    transport: 'tls',
    bind: '127.0.0.1:0',
    allowTestProfile: true,
    peerSecrets: { 'ata@tls.test': secret },
    tls: { peer: `127.0.0.1:${ata.tlsPort}`, cert: clientCert.cert, key: clientCert.key, pin: serverCert.pin },
    onEvent: (event) => switchEvents.push(event),
  });
  await sw.start();
  t.after(() => sw.stop());

  // On this binding an address is a formality — the session decides the route —
  // but `call()` still requires a peer entry to consider a name dialable.
  sw.peers.set('ata@tls.test', { addr: '127.0.0.1:1' });
  const call = sw.call('ata@tls.test');
  assert.ok(call, 'the call should be placed');

  await waitUntil(() => switchEvents.some((event) => event.kind === 'accepted'), { label: 'the ATA to answer' });
  await waitUntil(() => ata.stats.receivedFrames > 0, { label: 'audio to arrive at the ATA' });
  assert.ok(sw.channelBinding.equals(ata.channelBinding), 'one session, one binding');

  // A message signed under a different session's exporter must not verify here.
  const hello = decodeMsg(ata.makeMessage(TYPES.HELLO, { [F.from]: s('ata@tls.test') }));
  assert.equal(sw.verifyMessage(hello.type, hello.fields), true, 'signed by this session');
  const original = sw.channelBinding;
  sw.channelBinding = Buffer.alloc(32, 7);
  assert.equal(sw.verifyMessage(hello.type, hello.fields), false, 'a different session must not verify');
  sw.channelBinding = original;

  // The switch's own view of the call is what an operator would read.
  const session = sw.sessions.get(call);
  assert.equal(session.accepted, true);
  assert.ok(session.sent > 0, 'the switch should have sent media on the encrypted path');
});
