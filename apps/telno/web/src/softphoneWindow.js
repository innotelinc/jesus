/**
 * The softphone as its own window.
 *
 * A page's SIP registration lives and dies with the page: navigating the
 * console unmounts the softphone, the user agent closes and a call in progress
 * goes with it. A separate window has its own document and its own user agent,
 * so the line stays registered while you browse Billing, read a call log or open
 * the public directory.
 *
 * A window opened by a previous page load leaves no handle behind, and
 * `window.open` with a known name would reuse it — passing a URL would reload
 * it and drop the call. So the two sides talk over a BroadcastChannel: ask "is
 * anyone there", and only open a window when nothing answers.
 */

const NAME = 'telno-softphone';
const CHANNEL = 'telno-softphone';
// A phone, not a document: tall, narrow, and resizable so it can sit beside
// the console on a wide screen.
const FEATURES = 'popup=yes,width=400,height=800,left=120,top=60';

export const SOFTPHONE_WINDOW_PATH = '/softphone?window=1';

const canBroadcast = () => typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined';

/**
 * Resolves true when an existing softphone window answered, after asking it to
 * come forward. Bounded by a short timeout so a missing answer is not a delay.
 */
function announceToExisting(timeoutMs = 400) {
  return new Promise((resolve) => {
    if (!canBroadcast()) return resolve(false);
    const channel = new BroadcastChannel(CHANNEL);
    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      if (found) channel.postMessage({ type: 'focus' });
      channel.close();
      resolve(found);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.onmessage = (event) => {
      if (event.data?.type !== 'alive') return;
      clearTimeout(timer);
      finish(true);
    };
    channel.postMessage({ type: 'ping' });
  });
}

/**
 * Opens the softphone window, or brings the running one forward.
 *
 *   { opened: true }            a new window was created
 *   { opened: false, focused }  an existing window was focused, nothing reloaded
 *   { blocked: true }           the browser refused the popup
 */
export async function openSoftphoneWindow() {
  if (await announceToExisting()) return { opened: false, focused: true };

  const handle = window.open(SOFTPHONE_WINDOW_PATH, NAME, FEATURES);
  if (!handle) return { opened: false, blocked: true };
  try {
    handle.focus();
  } catch {
    /* focus is a courtesy; the window is open either way */
  }
  return { opened: true, handle };
}

export const isSoftphoneWindow = (search = window.location.search) =>
  new URLSearchParams(search).get('window') === '1';
