/**
 * §9.7 over `cantus/tls`: a relay that is also the session.
 *
 * §4.4 used to refuse a relay path on the encrypted binding because a relay
 * terminates TCP and would read the media. Sealed records remove the reason:
 * the relay is reached over the same TLS 1.3 session, it resolves a route it
 * may read, and it forwards an AEAD envelope it may not. What this test adds
 * over `record.test.js` is the transport: reaching a relay over TLS is not the
 * same as reaching a peer over TLS, and the two used to be indistinguishable
 * to `relaySend`, which sent a wrapped datagram bare and lost it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CantusRelay } from '../src/relay.js';
import { CantusEndpoint } from '../src/endpoint.js';
import { devCertificate } from '../src/tls-binding.js';
import { encodeMedia, datagramKind, KIND_RECORD } from '../src/wire.js';
import { PATH_RELAY } from '../src/reach.js';
import { waitUntil } from './wait.js';

const SECRET = 'tls-relay-secret-value';

const dir = mkdtempSync(join(tmpdir(), 'cantus-tls-relay-'));
const relayCert = devCertificate({ dir: join(dir, 'relay'), commonName: 'relay.cantus.test' });
const endpointCert = devCertificate({ dir: join(dir, 'endpoint'), commonName: 'endpoint.cantus.test' });

function endpoint(id, extra = {}) {
  return new CantusEndpoint({
    id,
    secret: SECRET,
    transport: 'tls',
    bind: '127.0.0.1:0',
    allowTestProfile: true,
    tls: { peer: extra.relayAddr, cert: endpointCert.cert, key: endpointCert.key, pin: relayCert.pin },
    ...extra,
  });
}

test('sealed media crosses a relay reached over TLS 1.3', async (t) => {
  const relay = new CantusRelay({
    bind: '127.0.0.1:0',
    secret: SECRET,
    allowTestProfile: true,
    tls: { cert: relayCert.cert, key: relayCert.key, pin: endpointCert.pin },
  });
  await relay.start();
  t.after(() => relay.stop());
  assert.ok(relay.tlsSessions, 'the relay should be listening on the encrypted binding');

  const forwarded = [];
  const send = relay.sendto.bind(relay);
  relay.sendto = (dest, bytes) => {
    forwarded.push(Buffer.from(bytes));
    return send(dest, bytes);
  };

  const relayAddr = relay.addr;
  const ata = endpoint('ata@tls-relay.test', { relay: relayAddr, relayAddr });
  ata.onIncoming = (session) => ata.accept(session);
  let loudest = 0;
  ata.onInboundMedia = (session, media) => {
    for (let i = 0; i + 1 < media.payload.length; i += 2) {
      loudest = Math.max(loudest, Math.abs(media.payload.readInt16LE(i)));
    }
  };
  await ata.start();
  t.after(() => ata.stop());
  await waitUntil(() => ata.handle > 0, { label: 'the ATA to register over TLS' });

  const sw = endpoint('switch@tls-relay.test', {
    relay: relayAddr,
    relayAddr,
    mediaSource: () => Buffer.alloc(320),
  });
  await sw.start();
  t.after(() => sw.stop());
  await waitUntil(() => sw.handle > 0, { label: 'the switch to register over TLS' });

  const call = sw.call('ata@tls-relay.test');
  assert.ok(call, 'the call should be placed over the relay session');
  await waitUntil(() => sw.sessions.get(call)?.accepted, { label: 'the ATA to answer over TLS' });

  const session = sw.sessions.get(call);
  assert.ok(session.recordKey, 'the key exchange must survive the relayed INVITE/ACCEPT');

  // Reach cannot confirm a direct path through the relay session, so a call on
  // the encrypted binding must commit `relay` rather than send media bare.
  await waitUntil(() => session.committed === PATH_RELAY, { label: 'the call to commit the relay path' });

  const payload = Buffer.alloc(320, 0x7f);
  let mediaSeq = 0;
  await waitUntil(
    () => {
      mediaSeq += 1;
      const inner = encodeMedia({ stream: 0, tag: session.tag, seq: mediaSeq, ts: 0, codec: 2, flags: 0, payload });
      assert.equal(sw.sendSealed(session, inner), true);
      return loudest === 0x7f7f;
    },
    { label: 'the sealed frame to cross the TLS relay', interval: 20 }
  );

  assert.equal(loudest, 0x7f7f, 'the frame must arrive intact');
  assert.ok(relay.sealed > 0, 'the relay must have carried a record, not a media datagram');
  const records = forwarded.filter((bytes) => datagramKind(bytes) === KIND_RECORD);
  assert.ok(records.length > 0, 'every relayed frame on this binding is a record');
  for (const bytes of records) {
    assert.equal(bytes.includes(Buffer.alloc(8, 0x7f)), false, 'the relay must never see the media');
  }
  assert.equal(session.committed, PATH_RELAY, 'a TLS node must not commit a direct path through its relay');
});
