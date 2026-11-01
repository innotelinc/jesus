/**
 * The smallest SIP user agent that a real trunk needs, and nothing more.
 *
 * Cantus carries one socket for signalling and media. A carrier speaks SIP over
 * UDP and RTP somewhere else, with digest authentication, tags and a dialog to
 * maintain. That gap is this file: REGISTER to keep the trunk reachable, INVITE
 * in both directions, ACK/BYE/CANCEL to close them, and SDP for one codec.
 *
 * Deliberately absent, because this trunk does not need them and a half-built
 * version would be worse than none: TCP/TLS transports, PRACK/100rel, session
 * timers, re-INVITE (an offer in a confirmed dialog is answered 491), forking,
 * and outbound proxying. Everything here is RFC 3261 over UDP with MD5 digest
 * auth, which is what VoIP.ms expects.
 */

import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';

const CRLF = '\r\n';

export const randomToken = (bytes = 8) => randomBytes(bytes).toString('hex');

/** A short, RFC-shaped branch/tag. */
export const branch = () => `z9hG4bK${randomToken(6)}`;

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');

/**
 * Split a SIP message into its start line, headers and body.
 *
 * Header names are case-insensitive and the compact forms are legal on the
 * wire, so both are folded here rather than at every call site.
 */
export function parseMessage(text) {
  const split = text.indexOf(`${CRLF}${CRLF}`);
  const headText = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 4);
  const lines = headText.split(CRLF).filter(Boolean);
  const startLine = lines.shift() || '';
  const headers = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  const get = (name) => headers.find((header) => header.name === name.toLowerCase())?.value;
  if (/^SIP\/2\.0\s+\d{3}/.test(startLine)) {
    const [, status, ...reason] = startLine.split(' ');
    return { type: 'response', status: Number(status), reason: reason.join(' '), headers, body, get };
  }
  const [method, uri] = startLine.split(' ');
  return { type: 'request', method, uri, headers, body, get };
}

export function buildRequest({ method, uri, headers, body = '' }) {
  const lines = [`${method} ${uri} SIP/2.0`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return Buffer.from(lines.join(CRLF) + CRLF + CRLF + body, 'utf8');
}

export function buildResponse({ status, reason, headers, body = '' }) {
  const lines = [`SIP/2.0 ${status} ${reason}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return Buffer.from(lines.join(CRLF) + CRLF + CRLF + body, 'utf8');
}

/**
 * Why a request cannot be from a carrier at all.
 *
 * §7.2 of the border profile: the trunk account is a credential, never an
 * identity, so nothing is authorised by a header — but a message missing the
 * headers a dialog is built from cannot be answered either, and a spliced
 * address (`002421220412287@switch@estate.local`) is what a scanner produces
 * by pasting our own domain into a URI it guessed.
 */
export function unroutable(message, text) {
  if (!text || text.length > 8192) return 'size';
  for (const header of ['call-id', 'from', 'to', 'via']) {
    if (!message.get(header)) return `missing-${header}`;
  }
  for (const value of [message.uri, message.get('from'), message.get('to')]) {
    if (!value) continue;
    const head = String(value).split('>')[0];
    if ((head.match(/@/g) || []).length > 1) return 'double-at';
  }
  return '';
}

/** The dynamic payload type this gateway offers for RFC 4733 keypresses. */
export const DTMF_PT = 101;

/**
 * Our media offer, encrypted when `crypto` is present.
 *
 * `RTP/SAVP` is the transport that says "SRTP or nothing": an encrypted carrier
 * answered `RTP/AVP` with 488, and an offer of `RTP/AVP` to an encrypted
 * sub-account was refused the same way. The `a=crypto` line carries the master
 * key for the media we send, which is what SDES means by putting a key in SDP.
 *
 * `telephone-event` is offered because a keypad digit is the one thing in-band
 * audio cannot carry: a carrier sends `#` as an RTP event, and a gateway that
 * did not advertise the event type would drop it and leave every IVR on the
 * PSTN side unable to take a menu choice.
 */
export function buildSdp({ address, port, crypto = '', dtmf = DTMF_PT }) {
  // `dtmf: 0` answers an offer that had no event type: adding one to an answer
  // would name a payload the far side never offered.
  const formats = dtmf ? `0 ${dtmf}` : '0';
  const lines = [
    'v=0',
    `o=cantus-gateway ${Date.now()} ${Date.now()} IN IP4 ${address}`,
    's=cantus-gateway',
    `c=IN IP4 ${address}`,
    't=0 0',
    crypto ? `m=audio ${port} RTP/SAVP ${formats}` : `m=audio ${port} RTP/AVP ${formats}`,
    'a=rtpmap:0 PCMU/8000',
  ];
  if (dtmf) lines.push(`a=rtpmap:${dtmf} telephone-event/8000`, `a=fmtp:${dtmf} 0-16`);
  lines.push('a=ptime:20', 'a=sendrecv');
  if (crypto) lines.push(`a=crypto:${crypto}`);
  lines.push('');
  return lines.join(CRLF);
}

/** Where the far side wants audio, from its SDP. */
export function parseSdpAddress(body, fallbackHost) {
  const text = String(body || '');
  // RTP/SAVP is the same media, encrypted: refusing it as "no audio" is what
  // made an encrypted carrier look like a codec problem.
  const media = /m=audio\s+(\d+)\s+RTP\/(AVP|SAVP)\s+([\d ]+)/.exec(text);
  const connection = /c=IN\s+IP4\s+([\d.]+)/.exec(text);
  if (!media) return null;
  // The far side picks its own dynamic payload type for keypresses, and the
  // number is only meaningful inside this SDP: matching our own constant here
  // is how an event arrives as audio, or not at all.
  const dtmf = /a=rtpmap:(\d+)\s+telephone-event\/8000/i.exec(text);
  return {
    port: Number(media[1]),
    host: connection ? connection[1] : fallbackHost,
    // Payload 0 must be offered; anything else would need a codec we do not carry.
    pcmu: media[3].split(/\s+/).includes('0'),
    secure: media[2] === 'SAVP',
    // The key for the media the far side sends, when it sent one.
    crypto: /^a=crypto:(.+)$/im.exec(text)?.[1]?.trim() || '',
    // `null` means the far side cannot send keypresses as events at all.
    dtmfType: dtmf ? Number(dtmf[1]) : null,
  };
}

/** The user part of a SIP URI: `sip:101@estate.local` → `101`. */
function userOf(uri) {
  const match = /sip:([^@>;]+)@/.exec(String(uri || ''));
  return match ? decodeURIComponent(match[1]) : '';
}

function authParams(header) {
  const params = {};
  const source = String(header || '');
  for (const match of source.matchAll(/([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return params;
}

/** RFC 2617 digest, MD5, with qop if the challenge asked for it. */
export function digestResponse({ username, password, realm, nonce, uri, method, qop, nc = '00000001', cnonce = randomToken(4), opaque, algorithm = 'MD5' }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/** Our address as the far side should see it. */
function localHost(configured) {
  return configured || '127.0.0.1';
}

export class SipTrunk {
  constructor({
    host,
    port = 5060,
    username = '',
    password = '',
    // What the carrier sees as the caller. Until now this was the sub-account
    // name, which is a login and not a number: a voice provider sets the
    // presented number per sub-account, so the one thing the platform knows —
    // the DID the trunk was given — could not reach the far end. Eleven digits
    // with no `+`, which is the form a North American carrier matches its own
    // numbers against.
    fromUser = '',
    domain = '',
    localSee = '',
    contactHost = '',
    localPort = 0,
    userAgent = 'cantus-gateway/1.0',
    registerSeconds = 300,
    // How long a REGISTER waits for the carrier before it is called a failure,
    // and how soon it is tried again. Without the first, a carrier that never
    // answers (wrong host, blocked UDP) hangs start() and the status port with
    // it; without the second, one bad minute at boot leaves the trunk down for
    // the length of the registration interval.
    registerTimeoutMs = 8_000,
    registerRetryMs = 15_000,
    onInvite = () => {},
    onCancel = () => {},
    onBye = () => {},
    onLog = () => {},
    // The other side of the border: local handsets. A PBX that only speaks to a
    // carrier is a trunk, not a phone system — an analog telephone adapter has
    // to be able to register here, so this socket is also a registrar. The map
    // is ext → password, and nothing else: an ATA's identity is the extension
    // its administrator configured, not a header it chose.
    ataUsers = new Map(),
    // A SIP socket sits on the public internet, so every byte that arrives is
    // untrusted and a burst is the normal case, not the exception. A carrier
    // sends a handful of messages per second; a hundred from one address is a
    // scan, and answering it is how a border becomes an amplifier.
    maxPerSecond = 25,
    burst = 50,
    abuseDrops = 200,
    blockMs = 30_000,
  } = {}) {
    this.ataUsers = ataUsers instanceof Map ? ataUsers : new Map(Object.entries(ataUsers || {}));
    // A registrar with no carrier is a working deployment: internal calls on a
    // box whose PSTN trunk is not configured yet. What cannot happen is neither.
    if (!host && !this.ataUsers.size) throw new Error('SipTrunk needs a host or at least one ATA user');
    this.host = host || '';
    this.contacts = new Map(); // ext → { addr, expires, contact, userAgent }
    this.port = Number(port);
    this.username = username;
    this.password = password;
    this.fromUser = String(fromUser || '').replace(/\D/g, '').slice(0, 15);
    this.domain = domain || host;
    this.contactHost = localHost(contactHost);
    this.localSee = localHost(localSee);
    this.localPort = Number(localPort) || 0;
    this.userAgent = userAgent;
    this.registerSeconds = registerSeconds;
    this.registerTimeoutMs = registerTimeoutMs;
    this.registerRetryMs = registerRetryMs;
    this.onInvite = onInvite;
    this.onCancel = onCancel;
    this.onBye = onBye;
    this.onLog = onLog;
    this.maxPerSecond = Math.max(1, Number(maxPerSecond) || 25);
    this.burst = Math.max(1, Number(burst) || 50);
    this.abuseDrops = Math.max(1, Number(abuseDrops) || 200);
    this.blockMs = Math.max(1000, Number(blockMs) || 30_000);
    // address → token bucket. Kept per source address, because the only
    // identity an unauthenticated datagram has is where it came from.
    this.sources = new Map();

    this.socket = null;
    this.bound = 0;
    this.calls = new Map(); // callId -> inbound or outbound dialog
    this.registerCSeq = 1;
    this.registerTimer = null;
    this.retryTimer = null;
    this.registerExpiresAt = 0;
    this.registered = false;
    this.lastRegisterError = '';
    this.retransmits = new Map();
  }

  log(entry) {
    this.onLog(entry);
  }

  async start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handle(buf.toString('utf8'), rinfo);
      } catch (err) {
        this.log({ kind: 'error', error: err.message });
      }
    });
    this.socket.on('error', (err) => this.log({ kind: 'error', error: err.message }));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.localPort, '0.0.0.0', () => {
        this.socket.off('error', reject);
        resolve();
      });
    });
    this.bound = this.socket.address().port;
    // The port on the wire has to be the one we actually bound (0 means "pick").
    if (!this.localPort) this.localPort = this.bound;
    this.log({ kind: 'listening', addr: `0.0.0.0:${this.bound}` });
    // Not awaited: a trunk that has not registered yet is a state /healthz
    // reports, not a reason for the status server to never bind.
    const kick = () => {
      this.register()
        .then((ok) => {
          if (ok) return;
          this.retryTimer = setTimeout(kick, this.registerRetryMs);
          if (this.retryTimer.unref) this.retryTimer.unref();
        })
        .catch((err) => {
          this.log({ kind: 'register-error', error: err.message });
          this.retryTimer = setTimeout(kick, this.registerRetryMs);
          if (this.retryTimer.unref) this.retryTimer.unref();
        });
    };
    if (this.username && this.host) kick();
    if (this.host) {
      this.registerTimer = setInterval(() => {
        this.register().catch((err) => this.log({ kind: 'register-error', error: err.message }));
      }, Math.max(30, this.registerSeconds - 60) * 1000);
      if (this.registerTimer.unref) this.registerTimer.unref();
    }
    return this;
  }

  stop() {
    clearInterval(this.registerTimer);
    clearTimeout(this.retryTimer);
    for (const timer of this.retransmits.values()) clearTimeout(timer);
    this.retransmits.clear();
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  get contactUri() {
    return `sip:${this.username || 'gateway'}@${this.contactHost}:${this.localPort}`;
  }

  /**
   * The user part of the From header on calls we place.
   *
   * `SIP_FROM_USER` when the trunk was told which number it owns, the login
   * otherwise: a carrier that ignores From still gets a valid dialog, and one
   * that honours it sees the DID rather than the sub-account name.
   */
  get presentedUser() {
    return this.fromUser || this.username || 'gateway';
  }

  /** REGISTER, retried once with digest when the carrier asks for credentials. */
  async register() {
    const callId = `${randomToken(8)}@${this.contactHost}`;
    const cseq = this.registerCSeq++;
    const uri = `sip:${this.domain}`;
    const attempt = (authorization) => {
      const headers = [
        ['Via', `SIP/2.0/UDP ${this.contactHost}:${this.localPort};branch=${branch()};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${this.username}@${this.domain}>;tag=${randomToken(4)}`],
        ['To', `<sip:${this.username}@${this.domain}>`],
        ['Call-ID', callId],
        ['CSeq', `${cseq} REGISTER`],
        ['Contact', `<${this.contactUri}>`],
        ['Expires', String(this.registerSeconds)],
        ['User-Agent', this.userAgent],
      ];
      if (authorization) headers.push(['Authorization', authorization]);
      return buildRequest({ method: 'REGISTER', uri, headers });
    };

    return new Promise((settle) => {
      // Every path out of here clears the deadline: a late answer to a REGISTER
      // already given up on must not register the trunk twice.
      const timer = setTimeout(() => {
        this.registered = false;
        this.lastRegisterError = `no answer from ${this.host}:${this.port}`;
        this.calls.delete(callId);
        this.log({ kind: 'register-timeout', host: this.host, port: this.port });
        settle(false);
      }, this.registerTimeoutMs);
      if (timer.unref) timer.unref();
      const resolve = (value) => {
        clearTimeout(timer);
        settle(value);
      };
      const call = {
        kind: 'register',
        callId,
        uri,
        attempts: 0,
        onResponse: (message) => {
          if (message.status === 401 || message.status === 407) {
            if (call.attempts >= 1) {
              this.registered = false;
              this.lastRegisterError = `register refused (${message.status})`;
              this.log({ kind: 'register-refused', status: message.status });
              return resolve(false);
            }
            call.attempts += 1;
            const challenge = authParams(message.get('www-authenticate') || message.get('proxy-authenticate'));
            const authorization = digestResponse({
              username: this.username,
              password: this.password,
              realm: challenge.realm || this.domain,
              nonce: challenge.nonce || '',
              uri,
              method: 'REGISTER',
              qop: challenge.qop ? 'auth' : undefined,
              opaque: challenge.opaque,
            });
            this.send(attempt(authorization));
            return undefined;
          }
          if (message.status >= 200 && message.status < 300) {
            this.registered = true;
            this.lastRegisterError = '';
            const contact = message.get('contact') || '';
            const expires = /expires=(\d+)/i.exec(contact);
            this.registerExpiresAt = Date.now() + Number(expires?.[1] || this.registerSeconds) * 1000;
            this.log({ kind: 'registered', expires: Number(expires?.[1] || this.registerSeconds) });
            this.calls.delete(callId);
            return resolve(true);
          }
          if (message.status >= 300) {
            this.registered = false;
            this.lastRegisterError = `${message.status} ${message.reason}`;
            this.log({ kind: 'register-failed', status: message.status, reason: message.reason });
            this.calls.delete(callId);
            return resolve(false);
          }
          return undefined;
        },
      };
      this.calls.set(callId, call);
      this.send(attempt());
    });
  }

  send(bytes) {
    if (!this.socket) return;
    try {
      this.socket.send(bytes, this.port, this.host);
    } catch (err) {
      this.log({ kind: 'error', error: err.message });
    }
  }

  reply(rinfo, request, status, reason, { toTag, body = '', extra = [] } = {}) {
    const headers = [];
    for (const header of request.headers) {
      if (['via', 'from', 'to', 'call-id', 'cseq'].includes(header.name)) {
        const value = header.name === 'to' && toTag && !/;tag=/.test(header.value) ? `${header.value};tag=${toTag}` : header.value;
        headers.push([header.name === 'call-id' ? 'Call-ID' : header.name === 'cseq' ? 'CSeq' : header.name.replace(/^./, (c) => c.toUpperCase()), value]);
      }
    }
    headers.push(['User-Agent', this.userAgent]);
    for (const pair of extra) headers.push(pair);
    if (body) headers.push(['Content-Type', 'application/sdp']);
    const message = buildResponse({ status, reason, headers, body });
    try {
      this.socket.send(message, rinfo.port, rinfo.address);
    } catch (err) {
      this.log({ kind: 'error', error: err.message });
    }
  }

  /** Place a call. Returns the dialog; media is the caller's business. */
  invite({ to, from, sdp, sdpAddress, timeoutMs = 32_000 }) {
    const callId = `${randomToken(8)}@${this.contactHost}`;
    const fromTag = randomToken(4);
    const dialled = String(to).replace(/[^\d+*#]/g, '');
    const uri = `sip:${dialled}@${this.domain}`;
    const call = {
      kind: 'outbound',
      callId,
      uri,
      dialled,
      fromTag,
      cseq: 1,
      state: 'calling',
      attempts: 0,
      remoteTag: '',
      target: { host: this.host, port: this.port },
      sdp,
      sdpAddress,
      to,
      from,
      onAnswered: null,
      onFailed: null,
      onRinging: null,
      timer: null,
    };

    const attempt = (authorization) => {
      const headers = [
        ['Via', `SIP/2.0/UDP ${this.contactHost}:${this.localPort};branch=${branch()};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${this.presentedUser}@${this.domain}>;tag=${fromTag}`],
        ['To', `<${uri}>`],
        ['Call-ID', callId],
        ['CSeq', `${call.cseq} INVITE`],
        ['Contact', `<${this.contactUri}>`],
        ['User-Agent', this.userAgent],
        ['Content-Type', 'application/sdp'],
      ];
      if (authorization) headers.push(['Authorization', authorization]);
      return buildRequest({ method: 'INVITE', uri, headers, body: call.sdp });
    };

    call.onResponse = (message) => {
      if ([100, 180, 183].includes(message.status)) {
        call.state = message.status === 180 ? 'ringing' : 'progress';
        call.remoteTag = /;tag=([^;]+)/.exec(message.get('to') || '')?.[1] || call.remoteTag;
        call.onRinging?.(call);
        return;
      }
      if (message.status === 401 || message.status === 407) {
        if (call.attempts >= 1) {
          this.finish(call, `auth refused (${message.status})`);
          return;
        }
        call.attempts += 1;
        call.cseq += 1;
        const challenge = authParams(message.get('www-authenticate') || message.get('proxy-authenticate'));
        const authorization = digestResponse({
          username: this.username,
          password: this.password,
          realm: challenge.realm || this.domain,
          nonce: challenge.nonce || '',
          uri,
          method: 'INVITE',
          qop: challenge.qop ? 'auth' : undefined,
          opaque: challenge.opaque,
        });
        call.remoteTag = /;tag=([^;]+)/.exec(message.get('to') || '')?.[1] || call.remoteTag;
        this.send(attempt(authorization));
        return;
      }
      if (message.status >= 200 && message.status < 300) {
        call.state = 'confirmed';
        call.remoteTag = /;tag=([^;]+)/.exec(message.get('to') || '')?.[1] || call.remoteTag;
        // In-dialog requests go to the Contact of the 200 when there is one.
        const contact = /<sip:([^@>]+)@([^:>;]+)(?::(\d+))?/.exec(message.get('contact') || '');
        if (contact) call.target = { host: contact[2], port: Number(contact[3] || 5060) };
        this.ack(call, message);
        clearTimeout(call.timer);
        this.retransmitStop(callId);
        const audio = parseSdpAddress(message.body, this.host);
        call.onAnswered?.(call, audio);
        return;
      }
      if (message.status >= 300) {
        this.finish(call, `${message.status} ${message.reason}`);
      }
    };

    this.calls.set(callId, call);
    this.send(attempt());
    this.retransmit(callId, () => this.send(attempt()), 500, 4);
    call.timer = setTimeout(() => this.finish(call, 'timeout'), timeoutMs);
    if (call.timer.unref) call.timer.unref();
    return call;
  }

  ack(call, response) {
    const uri = call.uri;
    const headers = [
      ['Via', `SIP/2.0/UDP ${this.contactHost}:${this.localPort};branch=${branch()};rport`],
      ['Max-Forwards', '70'],
      // Same From as the INVITE: an in-dialog request that renames the local
      // party is refused by carriers that check dialog identity.
      ['From', `<sip:${call.fromUser || this.presentedUser}@${this.domain}>;tag=${call.fromTag}`],
      ['To', `<${uri}>${call.remoteTag ? `;tag=${call.remoteTag}` : ''}`],
      ['Call-ID', call.callId],
      ['CSeq', `${call.cseq} ACK`],
      ['User-Agent', this.userAgent],
    ];
    const target = call.target || { host: this.host, port: this.port };
    this.sendTo(target, buildRequest({ method: 'ACK', uri, headers }));
    void response;
  }

  /** Answer an inbound INVITE. The media leg must already be bound. */
  answer(call, { sdp }) {
    if (call.kind !== 'inbound' || call.answered) return false;
    call.answered = true;
    call.state = 'confirmed';
    this.reply(call.rinfo, call.request, 200, 'OK', { toTag: call.localTag, body: sdp });
    return true;
  }

  /** Refuse an inbound INVITE before any media is bound. */
  reject(call, status, reason) {
    if (!call || call.kind !== 'inbound' || call.answered) return;
    this.reply(call.rinfo, call.request, status, reason, { toTag: call.localTag });
    this.calls.delete(call.callId);
    call.state = 'ended';
  }

  /** End a dialog in whichever direction it was opened. */
  bye(call) {
    if (!call || call.state === 'ended') return;
    call.state = 'ended';
    const uri = call.uri || `sip:${this.domain}`;
    const headers = [
      ['Via', `SIP/2.0/UDP ${this.contactHost}:${this.localPort};branch=${branch()};rport`],
      ['Max-Forwards', '70'],
      ['From', `<sip:${call.fromUser || this.presentedUser}@${this.domain}>;tag=${call.localTag || call.fromTag}`],
      ['To', `<${uri}>;tag=${call.remoteTag || ''}`],
      ['Call-ID', call.callId],
      ['CSeq', `${(call.cseq || 1) + 1} BYE`],
      ['User-Agent', this.userAgent],
    ];
    const target = call.target || { host: this.host, port: this.port };
    this.sendTo(target, buildRequest({ method: 'BYE', uri, headers }));
    call.cseq = (call.cseq || 1) + 1;
    clearTimeout(call.timer);
    this.calls.delete(call.callId);
  }

  sendTo(target, bytes) {
    if (!this.socket) return;
    try {
      this.socket.send(bytes, target.port, target.host);
    } catch (err) {
      this.log({ kind: 'error', error: err.message });
    }
  }

  retransmit(callId, fn, intervalMs, count) {
    let sent = 0;
    const tick = () => {
      if (!this.calls.has(callId) || sent >= count) {
        this.retransmits.delete(callId);
        return;
      }
      sent += 1;
      fn();
      this.retransmits.set(callId, setTimeout(tick, intervalMs * 2 ** sent));
    };
    this.retransmits.set(callId, setTimeout(tick, intervalMs));
  }

  retransmitStop(callId) {
    clearTimeout(this.retransmits.get(callId));
    this.retransmits.delete(callId);
  }

  finish(call, reason) {
    if (call.state === 'ended') return;
    call.state = 'ended';
    clearTimeout(call.timer);
    this.retransmitStop(call.callId);
    this.calls.delete(call.callId);
    call.onFailed?.(reason);
  }

  /**
   * Take one token for this source, or refuse the datagram.
   *
   * Nothing here is authenticated: a UDP source address is all a flood gives
   * you, and it can be spoofed. The bucket is therefore a bound on work, not on
   * a person — it stops one address from turning a ring into a busy loop, and
   * the table is swept so the defence is not itself a memory leak.
   */
  admit(rinfo) {
    const now = Date.now();
    let source = this.sources.get(rinfo.address);
    if (!source) {
      source = { tokens: this.burst, at: now, drops: 0, blockedUntil: 0, logged: 0 };
      this.sources.set(rinfo.address, source);
      if (this.sources.size > 4096) {
        // A spoofed-source flood creates a bucket per address, so the table is
        // swept by age rather than only by staleness: keeping only the oldest
        // 3000 by last activity is what stops the defence becoming the leak.
        const ordered = [...this.sources.entries()].sort((left, right) => left[1].at - right[1].at);
        for (const [key] of ordered.slice(0, Math.max(1, ordered.length - 3000))) this.sources.delete(key);
      }
    }
    if (source.blockedUntil > now) return false;
    source.tokens = Math.min(this.burst, source.tokens + ((now - source.at) / 1000) * this.maxPerSecond);
    source.at = now;
    if (source.tokens < 1) {
      source.drops += 1;
      if (source.drops >= this.abuseDrops) {
        source.blockedUntil = now + this.blockMs;
        source.drops = 0;
        this.log({ kind: 'sip-flood-blocked', from: rinfo.address, ms: this.blockMs });
      } else if (now - source.logged > 5000) {
        source.logged = now;
        this.log({ kind: 'sip-rate-limited', from: rinfo.address, drops: source.drops });
      }
      return false;
    }
    source.tokens -= 1;
    return true;
  }

  handle(text, rinfo) {
    if (!this.admit(rinfo)) return;
    const message = parseMessage(text);
    if (message.type === 'response') {
      const call = this.calls.get(message.get('call-id'));
      call?.onResponse?.(message);
      return;
    }

    const problem = unroutable(message, text);
    if (problem) {
      // Silence makes a carrier retry; a 400 ends the attempt and leaves a log
      // line naming what arrived. The flood in the call logs was repeated
      // garbage aimed at a userinfo with two @ in it, which no dialog can be.
      this.log({ kind: 'malformed', from: rinfo.address, reason: problem });
      if (message.method !== 'ACK') this.reply(rinfo, message, 400, 'Bad Request');
      return;
    }

    const remote = `${rinfo.address}:${rinfo.port}`;
    if (message.method === 'INVITE') {
      const denied = this.inviteSourceProblem(message, rinfo);
      if (denied) {
        this.log({ kind: 'invite-refused', from: rinfo.address, reason: denied });
        this.reply(rinfo, message, 403, 'Forbidden');
        return;
      }
      const callId = message.get('call-id') || randomToken(8);
      const existing = this.calls.get(callId);
      if (existing) {
        // A retransmitted INVITE is answered with the same final response.
        if (existing.answered) this.reply(rinfo, message, 200, 'OK', { toTag: existing.localTag, body: existing.sdp });
        return;
      }
      const call = {
        kind: 'inbound',
        callId,
        request: message,
        rinfo,
        uri: message.uri,
        remote,
        target: { host: rinfo.address, port: rinfo.port },
        localTag: randomToken(4),
        remoteTag: /;tag=([^;]+)/.exec(message.get('from') || '')?.[1] || '',
        fromUser: /sip:([^@>]+)/.exec(message.get('from') || '')?.[1] || '',
        cseq: 1,
        state: 'ringing',
        answered: false,
        sdp: '',
      };
      this.calls.set(callId, call);
      this.reply(rinfo, message, 100, 'Trying');
      this.reply(rinfo, message, 180, 'Ringing', { toTag: call.localTag });
      this.onInvite(call, parseSdpAddress(message.body, rinfo.address));
      return;
    }

    if (message.method === 'ACK') {
      const call = this.calls.get(message.get('call-id'));
      if (call) call.state = 'confirmed';
      return;
    }

    if (message.method === 'CANCEL') {
      this.reply(rinfo, message, 200, 'OK');
      const call = this.calls.get(message.get('call-id'));
      if (call) {
        call.state = 'ended';
        this.reply(rinfo, call.request, 487, 'Request Terminated', { toTag: call.localTag });
        this.calls.delete(call.callId);
        this.onCancel(call);
      }
      return;
    }

    if (message.method === 'BYE') {
      const call = this.calls.get(message.get('call-id'));
      this.reply(rinfo, message, 200, 'OK');
      if (call) {
        call.state = 'ended';
        this.calls.delete(call.callId);
        this.onBye(call);
      }
      return;
    }

    if (message.method === 'OPTIONS') {
      // A carrier's keepalive: answer 200 with no body rather than silence.
      this.reply(rinfo, message, 200, 'OK', { toTag: randomToken(4) });
      return;
    }

    if (message.method === 'REGISTER') {
      this.handleRegister(message, rinfo);
    }
  }

  /**
   * Who may call this socket.
   *
   * With a carrier configured this is the carrier's socket, and the border
   * profile (§7.2) already says a header is never an identity — the address is
   * what the network can vouch for, so that decision stays where it was. With no
   * carrier the socket is a registrar, and then the only callers it serves are
   * the handsets it registered: an INVITE from an extension nobody registered,
   * or from an address other than that extension's registration, is refused
   * instead of being bridged into the switch as a call.
   */
  inviteSourceProblem(message, rinfo) {
    if (this.host) return '';
    const from = userOf(message.get('from'));
    const contact = this.contacts.get(from);
    if (!contact) return `extension ${from || '(none)'} is not registered`;
    if (contact.expires <= Date.now()) {
      this.contacts.delete(from);
      return `extension ${from} registration expired`;
    }
    // Host, not port: a NATed handset can leave from a different source port
    // on each binding, and refusing that would break the handsets this exists
    // for. The address is what a spoofed datagram cannot choose.
    if (rinfo.address !== contact.addr.host) {
      return `extension ${from} calling from ${rinfo.address}, registered from ${contact.addr.host}`;
    }
    return '';
  }

  /** Contacts that have not expired, newest first. */
  get registeredAtas() {
    const now = Date.now();
    return [...this.contacts.values()].filter((entry) => entry.expires > now);
  }

  /**
   * A local handset registering. Digest, MD5, qop when the ATA answers with it.
   *
   * The first REGISTER is answered `401` with a nonce the ATA signs; the second
   * is checked against the password for the extension in `to`, and only then is
   * the contact stored. Nothing about the request's From or Contact decides
   * who the caller is (§7.2 of the border profile applies here too): the
   * extension is the identity and the password is the credential.
   */
  handleRegister(message, rinfo) {
    const ext = userOf(message.get('to')) || userOf(message.uri);
    const password = this.ataUsers.get(ext);
    const toTag = randomToken(4);
    if (!password) {
      this.log({ kind: 'ata-unknown', ext, from: rinfo.address });
      this.reply(rinfo, message, 403, 'Forbidden', { toTag });
      return;
    }

    const authorization = message.get('authorization');
    if (!authorization) {
      const nonce = randomToken(8);
      this.reply(rinfo, message, 401, 'Unauthorized', {
        toTag,
        extra: [['WWW-Authenticate', `Digest realm="${this.domain}", nonce="${nonce}", algorithm=MD5, qop="auth"`]],
      });
      return;
    }

    const params = authParams(authorization);
    const expected = digestResponse({
      username: ext,
      password,
      realm: this.domain,
      nonce: params.nonce || '',
      uri: params.uri || message.uri,
      method: 'REGISTER',
      qop: params.qop,
      nc: params.nc,
      cnonce: params.cnonce,
      opaque: params.opaque,
    });
    const want = /response="([^"]+)"/.exec(expected)?.[1];
    const got = /response="([^"]+)"/.exec(authorization)?.[1];
    if (params.username !== ext || !want || want !== got) {
      this.log({ kind: 'ata-auth-failed', ext, from: rinfo.address });
      this.reply(rinfo, message, 403, 'Forbidden', { toTag });
      return;
    }

    const contact = message.get('contact') || '';
    const uri = /<([^>]+)>/.exec(contact)?.[1] || contact;
    const asked = /expires=(\d+)/i.exec(contact)?.[1] ?? message.get('expires');
    const expires = asked === undefined ? this.registerSeconds : Number(asked);
    if (!Number.isFinite(expires) || expires <= 0) {
      this.contacts.delete(ext);
      this.log({ kind: 'ata-unregistered', ext, from: rinfo.address });
      this.reply(rinfo, message, 200, 'OK', { toTag, extra: [['Expires', '0']] });
      return;
    }

    // The address the datagram came from wins over the Contact URI: behind
    // NAT the two disagree, and the one that can actually receive is the one
    // that just spoke. `rport` is what makes an ATA on a home router work.
    const entry = {
      ext,
      addr: { host: rinfo.address, port: rinfo.port },
      contact: uri,
      userAgent: message.get('user-agent') || '',
      expires: Date.now() + expires * 1000,
    };
    this.contacts.set(ext, entry);
    this.log({ kind: 'ata-registered', ext, addr: `${entry.addr.host}:${entry.addr.port}`, expires });
    this.reply(rinfo, message, 200, 'OK', {
      toTag,
      extra: [
        ['Contact', `<${uri}>;expires=${expires}`],
        ['Expires', String(expires)],
      ],
    });
  }
}
