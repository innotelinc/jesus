import { config } from '../config.js';

/**
 * The browser softphone's media socket, proxied to the Cantus switch.
 *
 * The browser opens `wss://<console host>/softphone/line?ticket=…` — the origin
 * the page was already loaded from, over a certificate it already trusts — and
 * this pipes the frames to the switch on the private network. The switch is
 * never published: it has no public TLS listener to configure, no self-signed
 * certificate for a browser to refuse, and no port range to forward. One
 * WebSocket carries signalling and 20 ms PCM16 frames in both directions, so
 * there is nothing left that a NAT can break.
 *
 * The platform still owns the decision: the ticket is single use, tied to an
 * account and a line, and is consumed here before the upstream socket is opened.
 */

const hostOf = (value) => String(value || '').split(',')[0].split(':')[0].trim();

/** Where the switch's line socket is, as seen from inside this container. */
export function switchLineUrl(ext, ticket) {
  const base = String(config.telephony.url || '').replace(/^http/, 'ws').replace(/\/+$/, '');
  const query = new URLSearchParams({ ext: String(ext), ticket: String(ticket || '') });
  if (config.telephony.token) query.set('token', config.telephony.token);
  return `${base}/ws/line?${query.toString()}`;
}

/** The URL the browser should open, given the host it reached us on. */
export const socketUrlFor = () => config.softphone.directUrl || config.softphone.socketUrl || '/softphone/line';

/**
 * The same-origin path the browser opens; the console proxies it to the switch.
 *
 * The route is mounted under `/api`, and the browser concatenates this value
 * onto the page's own origin, so the prefix has to be advertised: without it the
 * softphone opened `<origin>/softphone/line`, which nothing upgrades, and every
 * connection failed with "no Cantus line answered at /softphone/line". A
 * configured absolute (`ws://…`) URL is passed through untouched.
 *
 * Every screen that hands a socket URL to a browser uses this, so setup and the
 * softphone cannot advertise two different paths for the same socket.
 */
export function publicSocketUrl() {
  const url = socketUrlFor();
  if (!url || url.startsWith('ws') || url.startsWith('/api/')) return url;
  return `/api${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * How long a browser may go without proving it is still there.
 *
 * The switch pings the upstream socket, and `ws` answers those pings on this
 * side at the protocol layer — the proxy is healthy even when the browser
 * behind it is a closed laptop lid. So the switch cannot see a dead browser
 * through this hop: the proxy has to judge the browser itself and take the
 * upstream down, which is what tells the switch the line is gone.
 */
export const BROWSER_PING_MS = 10_000;
export const BROWSER_DEAD_MS = 30_000;

/**
 * Watch one browser socket and call `onDead` when it stops answering.
 *
 * `check` is exposed so a test can drive the clock instead of sleeping: in
 * service it runs from the interval, and any frame from the browser counts as
 * proof of life, not just a pong — a browser sending 20 ms audio has no reason
 * to be doubted.
 */
export function watchBrowser(socket, { pingMs = BROWSER_PING_MS, deadMs = BROWSER_DEAD_MS, now = Date.now, onDead = () => {} } = {}) {
  let lastSeen = now();
  let stopped = false;

  const touch = () => {
    lastSeen = now();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off?.('pong', touch);
  };

  const check = (at = now()) => {
    if (stopped) return false;
    if (at - lastSeen > deadMs) {
      stop();
      try {
        onDead();
      } catch {
        /* the caller closes both sockets; a throw here must not kill the tick */
      }
      return false;
    }
    if (socket.readyState === 1) {
      try {
        socket.ping();
      } catch {
        /* a socket that cannot be pinged will fail the next deadline */
      }
    }
    return true;
  };

  socket.on('pong', touch);
  const timer = setInterval(() => check(), pingMs);
  timer.unref?.();

  return { stop, touch, check };
}

/**
 * Pipe one accepted browser socket to the switch.
 *
 * Frames are forwarded as they arrive and not buffered into a playback queue:
 * a softphone's whole job is that the audio it sends is the audio that is
 * heard, and any queue here would be latency without a purpose.
 */
export function proxyToSwitch(socket, { ext, ticket }) {
  const url = switchLineUrl(ext, ticket);
  // Declared before the sockets so every close path can stop it.
  let watch;
  let upstream;
  try {
    upstream = new WebSocket(url, { headers: config.telephony.token ? { authorization: `Bearer ${config.telephony.token}` } : {} });
  } catch (err) {
    socket.close(1011, `switch unreachable: ${err.message}`);
    return;
  }

  let closed = false;
  const closeBoth = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    watch?.stop();
    try {
      upstream.close(code, reason);
    } catch {
      /* already gone */
    }
    try {
      socket.close(code, reason);
    } catch {
      /* already gone */
    }
  };

  upstream.addEventListener('open', () => {
    if (!config.softphone.proxy) return;
  });

  // A browser that stops answering takes the upstream with it: the switch then
  // drops the line on its own close handler instead of ringing a phone that is
  // no longer there, and a held call ends instead of hanging in silence.
  watch = watchBrowser(socket, { onDead: () => closeBoth(4408, 'browser stopped answering') });

  upstream.addEventListener('message', (event) => {
    try {
      if (typeof event.data === 'string') socket.send(event.data);
      else socket.send(event.data, { binary: true });
    } catch {
      closeBoth(1011, 'browser socket closed');
    }
  });

  upstream.addEventListener('close', (event) => {
    watch?.stop();
    if (closed) return;
    closed = true;
    try {
      socket.close(event.code === 1006 ? 1011 : event.code, event.reason || 'switch closed the line');
    } catch {
      /* already gone */
    }
  });

  upstream.addEventListener('error', () => {
    closeBoth(1011, 'switch unreachable');
  });

  socket.on('message', (data, isBinary) => {
    watch?.touch();
    if (upstream.readyState !== 1) return; // OPEN
    try {
      upstream.send(isBinary ? data : String(data));
    } catch {
      closeBoth(1011, 'switch socket failed');
    }
  });

  socket.on('close', () => {
    watch?.stop();
    if (closed) return;
    closed = true;
    try {
      upstream.close(1000, 'browser closed the line');
    } catch {
      /* already gone */
    }
  });

  socket.on('error', () => closeBoth(1011, 'browser socket error'));
}

export { hostOf };
