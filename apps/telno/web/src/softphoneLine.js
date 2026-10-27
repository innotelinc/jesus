/**
 * The line this browser keeps.
 *
 * A softphone that forgets which extension it was on, which microphone it used
 * and whether it should come back after a reload is not portable — it is a demo
 * that needs setting up every morning. This is the whole of that memory: one
 * localStorage key, per browser and per origin, never on the server.
 *
 * Deliberately not stored: the SIP password (the platform mints a short-lived
 * session per connection, so there is nothing worth keeping) and anything about
 * a call in progress.
 */

const KEY = 'telno.softphone.line';

const DEFAULTS = {
  extension: '',
  video: true,
  micId: '',
  camId: '',
  // Come back on its own after a reload, a dropped network or a switch restart.
  keep: true,
};

const safeParse = (raw) => {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export function readLine() {
  try {
    return { ...DEFAULTS, ...safeParse(window.localStorage.getItem(KEY)) };
  } catch {
    // Private mode or a blocked origin: the phone still works, it just forgets.
    return { ...DEFAULTS };
  }
}

export function saveLine(patch) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readLine(), ...patch }));
  } catch {
    /* see readLine */
  }
}

export function clearLine() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* see readLine */
  }
}
