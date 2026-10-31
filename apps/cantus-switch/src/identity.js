/**
 * Key-bound endpoint identity and message integrity.
 *
 * The normative profile is Ed25519 over TLS 1.3 / DTLS 1.3 (§10.2). What ships
 * here is the `sig-hmac-sha256` test profile, exactly as the Perl reference
 * stack does, so the two implementations interoperate byte for byte. A
 * deployment that terminates real carrier traffic should swap `sign`/`verify`
 * for Ed25519 and keep everything else.
 *
 * §10.2 is a MUST, not advice: the test profile is "permitted only on loopback.
 * A node MUST refuse the test profile on a non-loopback address." A shared key
 * that is also the source default is worse than a test profile — it is a
 * published key, so anyone who reads this repository can sign a `TERMINATE` and
 * a switch would obey it, or an `INVITE` and it would ring a phone. The guard
 * below therefore fails closed: a node that binds off loopback and has no key
 * of its own will not start, and the error names the section it violates. A
 * deployment that is knowingly running the test profile off loopback (because
 * Ed25519 is not implemented yet) must say so out loud with
 * `allowTestProfile`, which is what `CANTUS_ALLOW_TEST_PROFILE` sets.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { signingInput } from './wire.js';

/** The shipped default. Loopback-only by §10.2; a real deployment sets a key. */
export const TEST_SECRET = 'cantus-loopback';

/** True for the addresses a test profile may legally use. */
export function isLoopbackHost(host) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value === 'localhost') return true;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('127.')) return true;
  // A wildcard bind is not loopback: it accepts a packet from anywhere.
  return false;
}

/** Whether a configured secret is the published default (or absent). */
export function isTestSecret(secret) {
  if (secret === undefined || secret === null || secret === '') return true;
  if (Buffer.isBuffer(secret)) return secret.length < 32;
  return String(secret) === TEST_SECRET;
}

export class Identity {
  constructor({ name, secret, loopback = true, allowTestProfile = false } = {}) {
    if (!name) throw new Error('cantus: Identity needs a name');
    // The published default key is never acceptable off loopback, and no
    // environment variable may talk a node into using it: that is the one case
    // where "it works" means "anyone can forge a call".
    if (!loopback && String(secret) === TEST_SECRET) {
      throw new Error(
        `cantus: refusing to start ${name} on a non-loopback address with the published default key ` +
          '(Cantus 1.0 §10.2, §14: a shared, public key is not an identity). Set CANTUS_SECRET.'
      );
    }
    if (!loopback && isTestSecret(secret) && !allowTestProfile) {
      throw new Error(
        `cantus: refusing to start ${name} on a non-loopback address with the test-profile secret ` +
          '(Cantus 1.0 §10.2: sig-hmac-sha256 is permitted only on loopback). ' +
          'Set CANTUS_SECRET to a key of at least 32 bytes, or set CANTUS_ALLOW_TEST_PROFILE=1 ' +
          'to run the test profile knowingly.'
      );
    }
    this.name = name;
    this.secret = secret || createHash('sha256').update(`cantus/1-test-secret:${name}`).digest();
    this.allowTestProfile = allowTestProfile;
    // What this node actually is, so a deployment can report its posture rather
    // than infer it. The shipped signer is the test profile whether or not the
    // operator thinks so.
    this.profile = 'sig-hmac-sha256';
  }

  /** True when this node is running the test profile on a public address. */
  get nonConformant() {
    return !this.loopback && this.profile === 'sig-hmac-sha256';
  }

  /** 32-octet public key, derived from the shared secret (test profile). */
  get publicKey() {
    if (!this._pub) this._pub = createHash('sha256').update(Buffer.concat([Buffer.from('cantus/1-pub:'), keyBytes(this.secret)])).digest();
    return this._pub;
  }

  sign(type, fields) {
    return createHmac('sha256', keyBytes(this.secret)).update(signingInput(type, fields)).digest();
  }

  verify(type, fields, signature, peerSecret = this.secret) {
    if (!signature || !signature.length) return false;
    const want = createHmac('sha256', keyBytes(peerSecret)).update(signingInput(type, fields)).digest();
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  get shortKey() {
    return this.publicKey.toString('hex').slice(0, 16);
  }
}

function keyBytes(secret) {
  return Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
}
