/**
 * `cantus/tls` — the encrypted transport binding (spec §4.4).
 *
 * Cantus carries media inside the transport and defines no in-band keying
 * (§9.6), so confidentiality is a property of *where* a datagram travels, not of
 * what it contains. This module is that "where": a TLS 1.3 session on port 7443
 * carrying the same length-prefixed datagrams as `cantus/tcp` (§4.2).
 *
 * Three things here are load-bearing and none of them are defaults of `tls`:
 *
 *   1. **TLS 1.3 only.** `minVersion` and `maxVersion` are both TLSv1.3, and the
 *      negotiated protocol is checked again after the handshake. A 1.2 session
 *      is refused rather than quietly accepted at a lower grade.
 *   2. **Pinned to the endpoint, not a domain.** A public CA proves who owns a
 *      name, which is not the question a phone call asks. The peer certificate's
 *      SubjectPublicKeyInfo is hashed and compared with the pin published for
 *      that `EndpointId` (§10.1); there is no path where "valid certificate"
 *      alone is accepted.
 *   3. **Channel-bound.** Both ends export the same 32 octets
 *      (`cantus/1-binding`) from the session and fold them into every §10.2
 *      signature. An interposer that terminates TLS and re-originates it gets
 *      two different exports, so its forwarded `INVITE` fails authentication
 *      instead of being read and passed on.
 *
 * Frames are `len:u16 || datagram`, and the §13 ceiling applies to the datagram.
 * A frame longer than 1150 octets closes the session: on a stream there is no
 * way to resynchronise after a length that the peer should never have sent.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

/** The only ALPN protocol this version speaks. */
export const ALPN = 'cantus/1';
/** RFC 5705/9266 exporter label. Distinct from the ALPN on purpose. */
export const EXPORTER_LABEL = 'cantus/1-binding';
export const EXPORTER_LENGTH = 32;
/** §13: a datagram is at most 1150 octets, and the length prefix is not one. */
export const MAX_FRAME = 1150;
export const DEFAULT_PORT = 7443;

/** TLS 1.3 with no downgrade path and no extensions we do not use. */
export function tls13Options(extra = {}) {
  return {
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ALPNProtocols: [ALPN],
    // No session resumption tickets on a binding whose identity is the session:
    // a resumed session would reuse an exporter the peer never proved it holds.
    session: undefined,
    ...extra,
  };
}

/** SHA-256 over the certificate's SubjectPublicKeyInfo, hex. This is the pin. */
export function spkiPin(cert) {
  const x509 = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  const der = x509.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** Constant-time-ish comparison of two hex pins. */
export function pinsMatch(a, b) {
  if (!a || !b) return false;
  return createHash('sha256').update(String(a).toLowerCase()).digest().equals(createHash('sha256').update(String(b).toLowerCase()).digest());
}

/** `len:u16 || datagram`. Throws rather than truncate: a clipped frame is a lie. */
export function frame(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (body.length > MAX_FRAME) {
    throw new Error(`cantus/tls: ${body.length} octets exceeds the §13 ceiling of ${MAX_FRAME}`);
  }
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** One TLS session carrying Cantus datagrams. */
export class TlsBinding extends EventEmitter {
  constructor(socket, { pin, server = false, maxFrame = MAX_FRAME } = {}) {
    super();
    this.socket = socket;
    this.pin = pin;
    this.server = server;
    this.maxFrame = maxFrame;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.binding = undefined;

    socket.setNoDelay(true);
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });

    // The peer's key is checked before anything is read, and the protocol is
    // re-checked because `minVersion` is a negotiation hint, not a result.
    //
    // A server-side socket is already past its handshake when `createServer`
    // hands it over, so waiting for `secure` would wait forever and leave the
    // pin unverified — the one failure mode that looks like success.
    // A client socket answers `getProtocol()` with the requested version before
    // it has connected, and a server socket is handed over already secure but
    // a turn before Node records the ALPN. Neither is a reason to check a
    // half-built session, so the gate is the ALPN itself: once it is a string
    // the handshake has finished, and on a client it starts as null.
    // Synchronous when the answer is already known: a server-side socket is
    // complete before it is handed over, and deferring the export by a turn
    // would let the first datagram arrive before the binding it is signed under
    // exists — which reads as an authentication failure, not a timing bug.
    const ready = () => this.onSecure();
    if (typeof socket.alpnProtocol === 'string') this.onSecure();
    else {
      socket.once('secureConnect', ready);
      socket.once('secure', ready);
    }
    socket.on('data', (chunk) => this.onData(chunk));
  }

  get remote() {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
  }

  get protocol() {
    return this.socket.getProtocol ? this.socket.getProtocol() : undefined;
  }

  onSecure() {
    if (this.secured) return;
    this.secured = true;
    if (this.protocol !== 'TLSv1.3') {
      this.fail(`refusing ${this.protocol || 'an unknown protocol'}: cantus/tls is TLS 1.3 only (§4.4)`);
      return;
    }
    if (!this.socket.alpnProtocol || this.socket.alpnProtocol !== ALPN) {
      this.fail(`refusing ALPN ${this.socket.alpnProtocol || 'none'}: expected ${ALPN}`);
      return;
    }
    if (this.pin) {
      const peer = this.socket.getPeerX509Certificate?.();
      if (!peer) {
        this.fail('no peer certificate to pin');
        return;
      }
      const actual = spkiPin(peer);
      if (!pinsMatch(actual, this.pin)) {
        this.fail(`pinned key mismatch: expected ${String(this.pin).slice(0, 16)}…, peer presented ${actual.slice(0, 16)}…`);
        return;
      }
      this.peerPin = actual;
    }
    // Exported once, from the finished handshake, and never renegotiated.
    this.binding = this.socket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL);
    this.emit('secure', { binding: this.binding, remote: this.remote });
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const length = this.buffer.readUInt16BE(0);
      if (length > this.maxFrame) {
        // A stream cannot resynchronise past a length that never happens, so
        // closing is the only honest answer (§13).
        this.fail(`frame of ${length} octets exceeds ${this.maxFrame}`);
        return;
      }
      if (this.buffer.length < 2 + length) return;
      const body = this.buffer.subarray(2, 2 + length);
      this.buffer = this.buffer.subarray(2 + length);
      this.emit('datagram', body, this.remote);
    }
  }

  send(bytes) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(frame(bytes));
      return true;
    } catch (err) {
      this.fail(err.message);
      return false;
    }
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('fault', reason);
    this.socket.destroy();
  }

  close() {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Listen for `cantus/tls` sessions.
 *
 * Resolves once the listener is bound, with `binding.port` giving the real port
 * when 0 was asked for — the same contract as a `dgram` socket, so a test can
 * use an ephemeral port and a deployment can still state 7443.
 */
export function listen({ host = '0.0.0.0', port = DEFAULT_PORT, cert, key, pin, onSession } = {}) {
  if (!cert || !key) throw new Error('cantus/tls: a listener needs cert and key (§4.4)');
  // Sessions are tracked so `close()` can end them. `tls.Server.close()` stops
  // accepting but waits for live sockets, and a test that leaves one behind
  // would hang at teardown rather than fail.
  const sessions = new Set();
  const server = tls.createServer(
    tls13Options({
      cert,
      key,
      // A pin is only checkable if the peer is asked for its certificate. With
      // `requestCert: false` the server never receives one, and every session
      // would then be refused for having nothing to pin — a failure that looks
      // like a bad key. Chain validation stays off because the trust decision
      // is the pin (§4.4), not a public CA.
      requestCert: Boolean(pin),
      rejectUnauthorized: false,
    }),
    (socket) => {
      const session = new TlsBinding(socket, { pin, server: true });
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
      onSession?.(session);
    }
  );
  const errors = new EventEmitter();
  server.on('tlsClientError', (err) => errors.emit('fault', err.message));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 is a request for an ephemeral port, not an absent one: treating it
    // as falsy would silently bind the fixed port a test asked to avoid.
    const bindPort = port === undefined || port === null || port === '' ? DEFAULT_PORT : Number(port);
    server.listen(bindPort, host === 'localhost' ? '127.0.0.1' : host, () => {
      server.off('error', reject);
      server.on('error', (err) => errors.emit('fault', err.message));
      resolve({
        server,
        errors,
        port: server.address().port,
        address: server.address().address,
        // `close()` alone waits for every open session, which a test that
        // deliberately leaves a half-handshaked peer behind would never finish.
        close: () =>
          new Promise((done) => {
            for (const session of sessions) session.socket.destroy();
            sessions.clear();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Dial one `cantus/tls` peer and resolve with the established session. */
export function connect({ host, port = DEFAULT_PORT, pin, cert, key, timeout = 4000, servername } = {}) {
  return new Promise((resolve, reject) => {
    const options = tls13Options({
      host,
      port,
      pin,
      servername: servername || undefined,
      // Presenting our own key is optional on the dialling side; when it is
      // absent the peer still has our §10.2 signature to authenticate.
      cert: cert || undefined,
      key: key || undefined,
      rejectUnauthorized: false, // the pin is the trust decision (§4.4)
    });
    const socket = tls.connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`cantus/tls: no session with ${host}:${port} within ${timeout} ms`));
    }, timeout);
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    socket.once('error', (err) => finish(err));
    const session = new TlsBinding(socket, { pin });
    session.once('secure', ({ binding }) => finish(undefined, Object.assign(session, { binding })));
    session.once('fault', (reason) => finish(new Error(`cantus/tls: ${reason}`)));
  });
}

/**
 * A self-signed certificate for a development or test node.
 *
 * Production supplies its own cert and key and publishes the pin in the
 * discovery record (§10.1); this exists so a loopback test does not need a CA,
 * and it refuses to be silent about where the file came from. Node has no
 * certificate builder, so this calls the `openssl` that ships with the platform.
 */
export function devCertificate({ dir, commonName = 'cantus.local' } = {}) {
  const target = dir || `${process.env.TMPDIR || '/tmp'}/cantus-tls`;
  mkdirSync(target, { recursive: true });
  const keyPath = `${target}/key.pem`;
  const certPath = `${target}/cert.pem`;
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec',
        '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-nodes', '-days', '2',
        '-subj', `/CN=${commonName}`,
        '-keyout', keyPath,
        '-out', certPath,
      ],
      { stdio: 'ignore' }
    );
  }
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  return { cert, key, pin: spkiPin(cert), certPath, keyPath };
}
