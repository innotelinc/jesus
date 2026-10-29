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
 * Pipe one accepted browser socket to the switch.
 *
 * Frames are forwarded as they arrive and not buffered into a playback queue:
 * a softphone's whole job is that the audio it sends is the audio that is
 * heard, and any queue here would be latency without a purpose.
 */
export function proxyToSwitch(socket, { ext, ticket }) {
  const url = switchLineUrl(ext, ticket);
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

  upstream.addEventListener('message', (event) => {
    try {
      if (typeof event.data === 'string') socket.send(event.data);
      else socket.send(event.data, { binary: true });
    } catch {
      closeBoth(1011, 'browser socket closed');
    }
  });

  upstream.addEventListener('close', (event) => {
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
    if (upstream.readyState !== 1) return; // OPEN
    try {
      upstream.send(isBinary ? data : String(data));
    } catch {
      closeBoth(1011, 'switch socket failed');
    }
  });

  socket.on('close', () => {
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
