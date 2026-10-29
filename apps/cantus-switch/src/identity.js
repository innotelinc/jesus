/**
 * Key-bound endpoint identity and message integrity.
 *
 * The normative profile is Ed25519 over TLS 1.3 / DTLS 1.3 (§10.2). What ships
 * here is the `sig-hmac-sha256` test profile, exactly as the Perl reference
 * stack does, so the two implementations interoperate byte for byte. A
 * deployment that terminates real carrier traffic should swap `sign`/`verify`
 * for Ed25519 and keep everything else.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { signingInput } from './wire.js';

export class Identity {
  constructor({ name, secret } = {}) {
    if (!name) throw new Error('cantus: Identity needs a name');
    this.name = name;
    this.secret = secret || createHash('sha256').update(`cantus/1-test-secret:${name}`).digest();
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
