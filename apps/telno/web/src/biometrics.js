/**
 * The page's half of Face ID.
 *
 * A line can be set to stay down until the phone recognizes its owner. That is
 * one thing and one thing only — a native biometric prompt — so everything here
 * is honest about what the current device can do:
 *
 *   app on an iPhone with a face enrolled   → a real Face ID prompt
 *   app on a phone with no face enrolled    → the device passcode, if allowed
 *   a browser tab anywhere                  → nothing. There is no Face ID in a
 *                                             tab, so the lock is ignored rather
 *                                             than pretending.
 *
 * The lock setting itself lives in localStorage, like the rest of this
 * browser's memory of the line: it decides whether *this* install asks for a
 * face on open, and it is never a substitute for the platform's own checks —
 * the SIP session, the voiceprint and the switch policy are all decided on the
 * server.
 */

const KEY = 'telno.scif.lock';

const plugins = () => (typeof window !== 'undefined' && window.Capacitor?.Plugins) || {};

export const biometricsBridge = () => plugins().ScifBiometrics || null;

/** True only inside the wrapped app, where a face can actually be asked for. */
export const biometricsInApp = () => !!biometricsBridge();

const safeParse = (raw) => {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export function readLockPolicy() {
  try {
    return { required: safeParse(window.localStorage.getItem(KEY)).required === true };
  } catch {
    // Private mode or a blocked origin: the line still works, it just does not
    // remember that it should have been locked.
    return { required: false };
  }
}

export function saveLockPolicy(patch) {
  const next = { ...readLockPolicy(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* see readLockPolicy */
  }
  return next;
}

/**
 * Should this page open locked? Asked synchronously, before the first render,
 * because the line registers on mount — a lock that arrives a moment later
 * would have already let the registration through.
 */
export const lockOnOpen = () => readLockPolicy().required && biometricsInApp();

/** What this device can do, for the settings card to describe accurately. */
export async function biometry() {
  const bridge = biometricsBridge();
  if (!bridge) {
    return {
      supported: false,
      biometryType: 'none',
      label: '',
      reason: 'Face ID unlock runs in the SCIF app on a phone. A browser tab cannot ask for a face.',
    };
  }
  try {
    const info = await bridge.available();
    return {
      supported: !!info?.supported,
      biometryType: info?.biometryType || 'none',
      label: info?.label || '',
      reason: info?.reason || '',
    };
  } catch (err) {
    return { supported: false, biometryType: 'none', label: '', reason: err?.message || 'Biometrics are unavailable' };
  }
}

/**
 * Ask, and report what actually happened. A refusal is returned rather than
 * thrown: "you were not recognized" is an answer the screen needs to show.
 */
export async function unlockLine({ reason, allowPasscode = true } = {}) {
  const bridge = biometricsBridge();
  if (!bridge) {
    return { ok: false, method: 'none', reason: 'This browser has no biometric unlock. Open the SCIF app to unlock the line.' };
  }
  try {
    const result = await bridge.authenticate({
      reason: reason || 'Unlock this line',
      allowPasscode,
    });
    return { ok: true, method: result?.method || 'biometric' };
  } catch (err) {
    return { ok: false, method: 'none', reason: err?.message || 'Not unlocked' };
  }
}

/** \"face\" → \"Face ID\" for a message a person reads. */
export function methodLabel(method) {
  if (method === 'face') return 'Face ID';
  if (method === 'touch') return 'Touch ID';
  if (method === 'passcode') return 'your passcode';
  return 'biometrics';
}
