/**
 * Crypto engine backed by webcrypto-liner for legacy algorithm support.
 *
 * webcrypto-liner extends the native Web Crypto API with algorithms
 * like DES-EDE3-CBC (3DES) that are commonly found in S/MIME messages
 * and PKCS#12 files produced by legacy clients (Outlook, Thunderbird, etc.).
 *
 * Native Web Crypto calls are passed through to the real implementation;
 * liner only intercepts algorithms that the browser doesn't natively support.
 */

import * as pkijs from 'pkijs';

// webcrypto-liner exports a Crypto constructor at runtime that extends native
// Web Crypto with legacy algorithms (3DES, etc.). Its type declarations only
// expose the type alias, so we import the module dynamically and cast.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liner = require('webcrypto-liner') as {
  Crypto: { new (): Crypto };
  setCrypto: (subtle: SubtleCrypto) => void;
  nativeCrypto: Crypto | Record<string, never>;
};

let linerEngine: pkijs.CryptoEngine | null = null;
let linerCryptoInstance: Crypto | null = null;

function ensureLiner() {
  if (!linerCryptoInstance) {
    // In Node.js, webcrypto-liner can't auto-detect the native crypto
    // (it looks for self.crypto which doesn't exist). Feed it manually
    // so that native algorithms (RSA, AES, etc.) stay hardware-accelerated
    // and only truly missing algorithms (3DES) use the software fallback.
    if (
      typeof liner.nativeCrypto?.getRandomValues !== 'function' &&
      typeof globalThis.crypto?.subtle !== 'undefined'
    ) {
      liner.setCrypto(globalThis.crypto.subtle);
    }
    linerCryptoInstance = new liner.Crypto();
  }
  if (!linerEngine) {
    linerEngine = new pkijs.CryptoEngine({
      crypto: linerCryptoInstance,
      subtle: linerCryptoInstance.subtle,
      name: 'webcrypto-liner',
    });
  }
}

/** Get a PKI.js CryptoEngine with 3DES (and other legacy algorithm) support. */
export function getLinerCryptoEngine(): pkijs.CryptoEngine {
  ensureLiner();
  return linerEngine!;
}

/**
 * Run an async operation with the global PKI.js engine set to webcrypto-liner,
 * then restore the previous engine afterwards.
 *
 * Required for operations that use the global engine internally
 * (e.g. PFX.parseInternalValues for PKCS#12 import).
 */
export async function withLinerEngine<T>(fn: () => Promise<T>): Promise<T> {
  ensureLiner();

  // Save the current global engine so we can restore it
  const prev = pkijs.getEngine();

  pkijs.setEngine('webcrypto-liner', linerCryptoInstance!, linerEngine!);
  try {
    return await fn();
  } finally {
    // Restore the previous engine
    pkijs.setEngine(prev.name, prev.crypto as unknown as pkijs.CryptoEngine);
  }
}
