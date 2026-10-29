/**
 * The wire format is checked against bytes produced by the Perl reference
 * stack (`apps/cantus/lib/Cantus/Wire.pm`), not against itself. The hex below
 * was generated with:
 *
 *   perl -Ilib -MCantus::Wire -MCantus::Identity -MCantus::Caps -MCantus::Reach \
 *        -MCantus::Media -e '...'
 *
 * A change that breaks interoperability fails here before it reaches a call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TYPES,
  F,
  v,
  s,
  b,
  varint,
  readVarint,
  encodeMsg,
  decodeMsg,
  encodeMedia,
  decodeMedia,
  encodeRelay,
  decodeRelay,
  datagramKind,
  describe,
} from '../src/wire.js';
import { Identity } from '../src/identity.js';
import { encodeCaps, decodeCaps, negotiate, telephoneSet } from '../src/caps.js';
import { encodeCandidates, decodeCandidates, challenge, candidateToken } from '../src/reach.js';
import { encodeReport, decodeReport, linearToUlaw, ulawToLinear, wavWrap } from '../src/media.js';
import { Router } from '../src/router.js';
import { Session } from '../src/session.js';

test('varints round-trip at the boundaries', () => {
  for (const value of [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const encoded = varint(value);
    const { value: decoded, pos } = readVarint(encoded, 0);
    assert.equal(decoded, value);
    assert.equal(pos, encoded.length);
  }
});

test('INVITE bytes match the Perl reference stack', () => {
  const identity = new Identity({ name: 'a', secret: 's' });
  const fields = {
    [F.from]: s('a'),
    [F.to]: s('100'),
    [F.call]: s('c1'),
    [F.gen]: v(1),
    [F.nonce]: v(7),
  };
  fields[F.sig] = b(identity.sign(TYPES.INVITE, fields));
  const encoded = encodeMsg(TYPES.INVITE, fields);
  assert.equal(
    encoded.toString('hex'),
    'ca00030a016112033130301a02633120072a2086ed5f7adb6773be8c8c7eb6d197768ca7ca79eed4bb8945c8655ea35373ea403001'
  );
  const decoded = decodeMsg(encoded);
  assert.equal(decoded.type, TYPES.INVITE);
  assert.equal(decoded.fields[F.to].v.toString('utf8'), '100');
  assert.ok(identity.verify(TYPES.INVITE, { ...fields, [F.sig]: undefined }, decoded.fields[F.sig].v, 's'));
});

test('the derived public key matches the reference stack', () => {
  assert.equal(
    new Identity({ name: 'a', secret: 's' }).publicKey.toString('hex'),
    '8cbdbc18f93336ff478bdfb1a7d4daf0b94abc0638f11683f1d7be8f11b442bf'
  );
});

test('media, caps, candidates, relay and report bytes match', () => {
  const media = encodeMedia({
    stream: 0,
    tag: 4660,
    seq: 5,
    ts: 160,
    codec: 2,
    flags: 0,
    payload: Buffer.from([0x01, 0x00, 0xfe, 0xff, 0x2c, 0x01]),
  });
  assert.equal(media.toString('hex'), 'ca0100b42405a00102000100feff2c01');
  const decodedMedia = decodeMedia(media);
  assert.equal(decodedMedia.tag, 4660);
  assert.equal(decodedMedia.ts, 160);
  assert.equal(datagramKind(media), 1);

  assert.equal(
    encodeCaps([{ name: 'pcm-s16/8000/1', ptime: 20, bitrate: 128, params: {} }]).toString('hex'),
    '010e70636d2d7331362f383030302f3114800100'
  );
  assert.deepEqual(decodeCaps(encodeCaps(telephoneSet())), telephoneSet());

  assert.equal(
    encodeCandidates([{ kind: 0, ip: '127.0.0.1', port: 7443, priority: 100, token: Buffer.alloc(8) }]).toString('hex'),
    '0100093132372e302e302e31933a64080000000000000000'
  );

  assert.equal(encodeRelay(0, Buffer.from('ca0003', 'hex'), 'b').toString('hex'), 'ca02000162ca0003');
  assert.deepEqual(decodeRelay(Buffer.from('ca02000162ca0003', 'hex')), {
    route: 0,
    name: 'b',
    inner: Buffer.from('ca0003', 'hex'),
  });

  assert.equal(
    encodeReport({ loss_q8: 3, rtt_us: 0, jitter_us: 0, recv_kbps: 24, desired_kbps: 24, frames_lost: 2, recv_high: 99 }).toString('hex'),
    '03000018180263'
  );
  assert.equal(decodeReport(Buffer.from('03000018180263', 'hex')).recv_high, 99);
});

test('capability negotiation follows the caller order', () => {
  const agreed = negotiate(
    [{ name: 'opus/48000/1', ptime: 20 }, { name: 'pcm-s16/8000/1', ptime: 20 }],
    telephoneSet()
  );
  assert.equal(agreed.name, 'opus/48000/1');
  assert.equal(negotiate([{ name: 'g722/8000/1' }], telephoneSet()), undefined);
});

test('call, path and probe derivations are deterministic', () => {
  assert.equal(challenge('c1', 1).length, 16);
  assert.equal(candidateToken('c1', 1).length, 8);
  assert.notDeepEqual(challenge('c1', 1), challenge('c2', 1));
  assert.equal(describe(TYPES.INVITE, { [F.to]: s('100') }), 'INVITE to="100"');
});

test('the state machine refuses illegal transitions', () => {
  const session = new Session({ call: 'c1', role: 'caller', peer: 'p' });
  assert.equal(session.fire('accept_sent'), false);
  assert.equal(session.fire('invite_sent'), true);
  assert.equal(session.state, 'OFFERED');
  assert.equal(session.commitPath('direct'), false); // not accepted yet
  assert.equal(session.fire('accept_recv'), true);
  assert.equal(session.commitPath('direct'), true);
  assert.equal(session.state, 'ACTIVE');
  assert.equal(session.fire('terminate'), true);
  assert.equal(session.fire('terminate'), false);
  assert.equal(session.isEnded, true);
});

test('routing validates and decides first match', () => {
  const router = new Router({
    doc: {
      version: 1,
      default: { reject: 3 },
      routes: [
        { name: 'support', when: { to: 'support@*' }, then: [{ answer: {} }] },
        { name: 'ext', when: { to: '1*' }, then: [{ bridge: { to: '100' } }] },
      ],
    },
  });
  assert.equal(router.decide({ to: 'support@telno.local', from: '+1' }).route, 'support');
  assert.equal(router.decide({ to: '1555', from: '+1' }).route, 'ext');
  assert.deepEqual(router.decide({ to: 'nope', from: '+1' }).actions, [{ reject: 3 }]);
  assert.throws(() => router.load({ version: 1, routes: [{ name: 'x', when: { bogus: 1 }, then: [{ answer: {} }] }] }), /unknown predicate/);
  assert.throws(() => router.load({ version: 2, routes: [] }), /version must be 1/);
  assert.equal(Router.globMatch('100*', '100@telno.local'), true);
  assert.equal(Router.globMatch('100*', '101'), false);
});

/**
 * The generated dial plan spells lengths with `?`. When the matcher treated it
 * as a literal, `national` and the 1xx block were dead routes: an outbound call
 * matched nothing and the console showed an empty route name.
 */
test('`?` matches exactly one character in an address pattern', () => {
  const router = new Router({
    doc: {
      version: 1,
      default: { reject: 3 },
      routes: [
        { name: 'national', when: { to: '1??????????@*' }, then: [{ trunk: { to: '*' } }] },
        { name: 'internal-1xx', when: { to: '1??@*' }, then: [{ bridge: { to: '*' } }] },
        { name: 'park-retrieve', when: { to: '7???@*' }, then: [{ answer: {} }] },
      ],
    },
  });
  // A North American number the softphone dials, eleven digits and a domain.
  assert.equal(router.decide({ to: '14134210134@estate.local' }).route, 'national');
  assert.equal(router.decide({ to: '101@estate.local' }).route, 'internal-1xx');
  assert.equal(router.decide({ to: '7001@estate.local' }).route, 'park-retrieve');
  // Ten digits is not a national number, and 1xx is exactly three.
  assert.equal(router.decide({ to: '4134210134@estate.local' }).matched, false);
  assert.equal(router.decide({ to: '1011@estate.local' }).matched, false);
  assert.equal(Router.globMatch('1??@*', '10@x'), false);
  assert.equal(Router.globMatch('a?c', 'abc'), true);
  assert.equal(Router.globMatch('a?c', 'ac'), false);
});

test('g711 and WAV containers are well formed', () => {
  for (const sample of [-32768, -1000, -1, 0, 1, 1000, 32767]) {
    const decoded = ulawToLinear(linearToUlaw(sample));
    // G.711 is lossy; a round trip has to land within one quantisation step of
    // the original, which is what the codec is defined to preserve.
    assert.ok(Math.abs(decoded - sample) <= Math.max(64, Math.abs(sample) * 0.12), `${sample} -> ${decoded}`);
  }
  const wav = wavWrap(Buffer.alloc(320));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 320);
  assert.equal(wav.readUInt32LE(24), 8000);
});
