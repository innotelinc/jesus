/**
 * WebSocket, server and client, with no dependencies.
 *
 * The switch ships with nothing to install on purpose: a telephony core that
 * needs a package manager to start is a telephony core that fails on the day
 * the registry is unreachable. What is here is RFC 6455 as far as it is used —
 * text and binary frames, fragmentation, ping/pong, close, client masking. No
 * extensions and no compression, so there is nothing negotiated to disagree
 * about.
 */

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OPCODES = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload, { mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);

  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/** A framed WebSocket over an already-upgraded socket. */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { isClient = false, maxPayload = 8 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = undefined;
    this.closed = false;
    this.open = true;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish(1006, 'socket closed'));
    socket.on('error', (err) => this.finish(1011, err.message));
    socket.setNoDelay?.(true);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > this.maxPayload) {
        this.close(1009, 'frame too large');
        return;
      }
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }

      if (opcode === OPCODES.PING) {
        this.sendRaw(encodeFrame(OPCODES.PONG, payload));
        continue;
      }
      if (opcode === OPCODES.PONG) {
        this.emit('pong');
        continue;
      }
      if (opcode === OPCODES.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.finish(code, payload.subarray(2).toString('utf8'));
        return;
      }
      if (opcode === OPCODES.CONTINUATION) {
        this.fragments.push(payload);
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
      if (!fin) continue;
      const message = Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = undefined;
      this.emit('message', kind === OPCODES.TEXT ? message.toString('utf8') : message, kind === OPCODES.BINARY);
    }
  }

  sendRaw(bytes) {
    if (this.closed || !this.socket.writable) return false;
    try {
      this.socket.write(bytes);
      return true;
    } catch {
      return false;
    }
  }

  send(data, { binary = false } = {}) {
    const isBuffer = Buffer.isBuffer(data) || data instanceof Uint8Array;
    const opcode = binary || isBuffer ? OPCODES.BINARY : OPCODES.TEXT;
    return this.sendRaw(encodeFrame(opcode, data, { mask: this.isClient }));
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  ping() {
    return this.sendRaw(encodeFrame(OPCODES.PING, Buffer.alloc(0), { mask: this.isClient }));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendRaw(encodeFrame(OPCODES.CLOSE, payload, { mask: this.isClient }));
    this.finish(code, reason);
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.emit('close', code, reason);
  }
}

/**
 * Attach a WebSocket endpoint to an `http.Server` upgrade event.
 * `handler(connection, request, url)` runs once per accepted socket.
 */
export function createUpgradeHandler(handler) {
  return (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    const connection = new WebSocketConnection(socket);
    if (head && head.length) connection.onData(head);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      handler(connection, request, url);
    } catch (err) {
      connection.close(1011, err.message);
    }
  };
}

/** Minimal client, for tests and for services that dial the switch. */
export function connectWebSocket(url, { headers = {} } = {}) {
  const target = new URL(url);
  const key = randomBytes(16).toString('base64');
  const transport = target.protocol === 'wss:' ? tls : net;
  return new Promise((resolve, reject) => {
    const socket = transport.connect(Number(target.port || (target.protocol === 'wss:' ? 443 : 80)), target.hostname, () => {
      const path = `${target.pathname}${target.search}`;
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, value]) => `${k}: ${value}`),
        '\r\n',
      ];
      socket.write(lines.join('\r\n'));
    });
    socket.once('error', reject);
    let handshake = Buffer.alloc(0);
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = handshake.subarray(0, end).toString('utf8');
      if (!/HTTP\/1\.1 101/.test(head)) {
        reject(new Error(`websocket handshake failed: ${head.split('\r\n')[0]}`));
        socket.destroy();
        return;
      }
      socket.off('data', onData);
      const connection = new WebSocketConnection(socket, { isClient: true });
      const rest = handshake.subarray(end + 4);
      resolve(connection);
      // Deliver anything that arrived with the handshake on the next turn, so a
      // caller that awaits the connection can attach its listeners first and
      // still see the server's opening frame.
      if (rest.length) setImmediate(() => connection.onData(rest));
    };
    socket.on('data', onData);
  });
}
