import { WebSocket } from 'ws';
import { config } from '../config.js';

/**
 * The switch's SIP WebSocket, served from the app's own origin.
 *
 * chan_pjsip listens for SIP over TLS on its own port (`SOFTPHONE_WSS_PORT`,
 * 8089 by default) with the certificate Asterisk was given. On a fresh install
 * that certificate is self-signed — the console reaches the switch over loopback
 * where nothing checks it — and a browser will not open a `wss://` connection to
 * a name it cannot verify. Chrome offers no "proceed anyway" for a WebSocket, so
 * the softphone fails at the handshake with ERR_CERT_AUTHORITY_INVALID while
 * every other page on the site works. Publishing the port is not enough, and a
 * proxy that terminates TLS in front of the app does not help either: that
 * certificate is served by the app's name on 443, and the SIP port is a
 * different port behind a different certificate.
 *
 * So this relays it. The browser opens `wss://<console host>/ws` — the origin
 * the page was already loaded from, over the certificate it already trusts —
 * and the app pipes the bytes to the switch on loopback, where the self-signed
 * certificate is between two processes in the same container and nothing is
 * exposed by ignoring it.
 *
 * Signaling only. Audio and video are DTLS-SRTP straight to the switch's RTP
 * ports; they never pass through here, so a relayed call costs one extra socket
 * and no media hop.
 *
 * Set `SOFTPHONE_WSS_RELAY=false` to go back to advertising the switch's own
 * port directly — which is right for a deployment that has installed a real
 * certificate on that listener.
 */

const hostOf = (value) => String(value || '').split(',')[0].split(':')[0].trim();

/** Where the switch's WSS listener is, as seen from inside this container. */
export const relayTarget = () =>
  config.softphone.wssInternal || `wss://127.0.0.1:${config.softphone.wssPort}/ws`;

/** The URL the browser should use, given the host it reached us on. */
export const relayUrlFor = (host) => `wss://${host}/ws`;

export function registerWssRelay(app) {
  if (!config.softphone.relay) return;

  app.get('/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = '';
      }
      // Same-origin only, the same rule the console's own socket uses: another
      // site must not be able to reach the switch through this container.
      const allowed = [
        hostOf(request.headers['x-forwarded-host'] || request.headers.host),
        hostOf(config.publicUrl.replace(/^https?:\/\//, '')),
      ].filter(Boolean);
      if (!allowed.some((host) => originHost === host || originHost.endsWith(`.${host}`))) {
        socket.close(4403, 'origin not allowed');
        return;
      }
    }

    let upstream;
    try {
      upstream = new WebSocket(relayTarget(), {
        // Loopback to the switch in this same container. Its certificate is the
        // self-signed one the browser just refused; verifying it here would only
        // re-refuse it, and this hop never leaves the container's network
        // namespace.
        rejectUnauthorized: false,
        handshakeTimeout: 5000,
        headers: { 'user-agent': 'telno-wss-relay/1.0' },
      });
    } catch (err) {
      console.warn(`[wss-relay] could not open a socket to ${relayTarget()}: ${err.message}`);
      socket.close(1011, 'switch unreachable');
      return;
    }

    let closed = false;
    const closeUpstream = () => {
      if (closed) return;
      closed = true;
      try {
        upstream.close();
      } catch {
        /* already gone */
      }
    };

    // SIP speaks first and does not wait: a client that sends REGISTER the
    // instant its socket opens would otherwise have that frame dropped while the
    // loopback connection is still being made.
    const pending = [];
    upstream.on('open', () => {
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });

    upstream.on('message', (data, isBinary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
    });

    upstream.on('error', (err) => {
      console.warn(`[wss-relay] switch unreachable at ${relayTarget()}: ${err.message}`);
      closed = true;
      try {
        socket.close(1011, 'switch unreachable');
      } catch {
        /* already gone */
      }
    });

    upstream.on('close', () => {
      try {
        // 1006 is "no close frame", which is not a code a close() accepts.
        socket.close(closed ? 1000 : 1011, 'switch closed the line');
      } catch {
        /* already gone */
      }
    });

    socket.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 32) pending.push([data, isBinary]);
    });

    socket.on('close', closeUpstream);
    socket.on('error', closeUpstream);
  });
}
