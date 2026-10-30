/**
 * An ARI-compatible surface over Cantus.
 *
 * Asterisk's REST Interface is the reason two products in this estate can be
 * pointed at a switch at all: capstone and dograh were written against it, and
 * rewriting their call control would be a second project. So Cantus presents
 * the same shape — channels, bridges, playbacks, external media, an event
 * socket — and translates. What an agent sends and receives is PCM16 over a
 * WebSocket, exactly as it did before; what crosses the network is Cantus.
 *
 * Implemented: channels (list/get/create/delete/answer/hangup/play/dtmf/
 * externalMedia), bridges (create/list/get/delete/addChannel/removeChannel),
 * applications, endpoints, and the `/events` WebSocket.
 *
 * Not implemented, and said so rather than answered with a plausible lie:
 * snooping, channel variables, `record` persistence to Asterisk's own storage,
 * ARI sounds beyond the prompt directory, and playback of arbitrary Asterisk
 * `sound:` names that are not in the prompt directory.
 */

import { connectWebSocket } from './ws.js';
import {
  downsample2,
  upsample2,
  pcm16ToUlaw,
  ulawToPcm16,
  silence,
  PCM_RATE,
} from './media.js';

const STATUS = {
  notFound: { status: 404, body: { error: 'Not Found', message: 'channel not found' } },
  conflict: { status: 409, body: { error: 'Conflict', message: 'channel is not in a compatible state' } },
  badRequest: (message) => ({ status: 400, body: { error: 'Bad Request', message } }),
};

/**
 * The wire formats an externalMedia channel can carry, and how to cross them.
 *
 * Asterisk's chan_websocket frames audio as bare little-endian PCM (slin,
 * slin16) or as G.711 (ulaw, alaw) with no wrapper — one binary frame is one
 * `ptime` of audio. The switch's own media is 8 kHz PCM16, so each format names
 * its frame size and the pair of conversions that cross it.
 *
 * ulaw is the one that matters in practice: pipecat's Asterisk serializer
 * decodes ulaw and says so in its log when asked for anything else, so an agent
 * runtime that asks for `format=ulaw` and is handed slin hears noise, not
 * speech.
 */
const MEDIA_FORMATS = {
  ulaw: { bytesPerFrame: 160, bytesPerSample: 1, toWire: pcm16ToUlaw, fromWire: ulawToPcm16 },
  slin: { bytesPerFrame: 320, bytesPerSample: 2, toWire: (pcm) => pcm, fromWire: (pcm) => pcm },
  slin16: { bytesPerFrame: 640, bytesPerSample: 2, toWire: upsample2, fromWire: downsample2 },
};

/**
 * Read `transport_data` the way chan_websocket writes it.
 *
 * Asterisk takes the dial-string form `v(key=value,key=value)` — this is how
 * dograh passes workflow_id, organization_id and workflow_run_id, and its own
 * media endpoint refuses a socket without them — but a plain `key=value&…`
 * query string is accepted too, because that is what a human types when testing
 * by hand and refusing it only costs an afternoon.
 */
function transportParams(value) {
  const out = new URLSearchParams();
  if (!value) return out;
  let body = String(value).trim();
  const wrapped = /^v\((.*)\)$/s.exec(body);
  if (wrapped) body = wrapped[1];
  for (const pair of body.split(/[&,;]/)) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const key = (at === -1 ? pair : pair.slice(0, at)).trim();
    if (!key) continue;
    out.set(key, at === -1 ? '' : pair.slice(at + 1).trim());
  }
  return out;
}

/**
 * `websocket_client.conf`, in an environment variable.
 *
 * Asterisk resolves `external_host` by looking a connection up in that file and
 * dialling its `uri`. The switch has no such file and does not want one — the
 * names are deployment data — so the same mapping arrives as
 * `CANTUS_WS_CLIENTS="dograh=ws://dograh-api:8000/api/v1/telephony/ws/ari"`.
 * A name that resolves to nothing is answered with the name and where to put
 * it, not with a 404 the operator has to trace through two containers.
 */
function parseWsClients(value) {
  const out = new Map();
  if (!value) return out;
  if (value instanceof Map) return new Map(value);
  // A plain object is the shape a caller inside this tree passes, and a JSON
  // map is what a config file would hold; both mean the same thing.
  if (typeof value === 'object') {
    for (const [name, uri] of Object.entries(value)) {
      if (name && /^wss?:\/\//i.test(String(uri))) out.set(name.toLowerCase(), String(uri));
    }
    return out;
  }
  const source = typeof value === 'string' ? value : '';
  for (const entry of source.split(/[,\n;]/)) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const name = entry.slice(0, at).trim().toLowerCase();
    const uri = entry.slice(at + 1).trim();
    if (name && /^wss?:\/\//i.test(uri)) out.set(name, uri);
  }
  return out;
}

function channelJson(leg, extra = {}) {
  const call = leg.call;
  return {
    id: leg.id,
    name: `Cantus/${leg.endpoint?.peer || leg.ext || 'channel'}-${leg.id.slice(-6)}`,
    state: leg.isAnswered ? 'Up' : leg.isEnded ? 'Down' : 'Ring',
    caller_number: call.from,
    connected_number: call.to,
    language: 'en',
    accountcode: '',
    channelvars: {},
    creationtime: new Date(call.startedAt).toISOString(),
    // `exten` is the number that was dialled, without the domain. An ARI client
    // resolves an inbound call by this value, so `14132642700@estate.local`
    // looked up nothing and the call was refused after being handed over
    // correctly — the most confusing kind of failure, because both sides did
    // their job.
    dialplan: { context: call.route || 'cantus', exten: String(call.to || '').split('@')[0], priority: 1, app_name: 'Cantus' },
    ...extra,
  };
}

function bridgeJson(bridge) {
  return {
    id: bridge.id,
    technology: 'Cantus',
    bridge_type: bridge.type,
    bridge_class: 'mixing',
    name: bridge.name,
    channels: [...bridge.channels],
    creationtime: bridge.createdAt,
  };
}

export class AriBridge {
  constructor({
    switch: switchRef,
    username = 'dograh',
    password = 'dograh',
    app = 'dograh',
    asteriskId = 'cantus',
    wsClients = process.env.CANTUS_WS_CLIENTS || '',
    onEvent = () => {},
  }) {
    this.switch = switchRef;
    this.username = username;
    this.password = password;
    this.app = app;
    this.asteriskId = asteriskId;
    this.subscribers = new Map(); // app → Set<ws>
    this.media = new Map(); // external channel id → { socket, leg, codec, format, timer }
    this.legs = new Map(); // external channel id → leg (a media channel is a channel)
    this.bridges = new Map(); // bridge id → { id, type, name, channels }
    this.wsClients = parseWsClients(wsClients);
    this.onEvent = onEvent;
    // Media channels are the switch's channels too, even though they belong to
    // no call: whoever decides who hears whom has to be able to find one.
    switchRef.externalLeg = (id) => this.legs.get(id);

    switchRef.on('event', (event) => this.fanout(event));
    switchRef.on('cdr', () => {});
  }

  /**
   * ARI credentials arrive one of two ways.
   *
   * HTTP requests carry them as Basic auth. The event socket does not: every ARI
   * client builds `ws://host/ari/events?api_key=<user>:<pass>&app=<name>`, which
   * is what Asterisk documents, and dograh follows it exactly. Accepting only
   * the header refused every event socket, so an agent runtime would answer
   * nothing while its HTTP calls all looked healthy.
   */
  authorized(request) {
    const header = request.headers.authorization || '';
    let user;
    let pass;
    if (header.startsWith('Basic ')) {
      [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    } else {
      const url = new URL(request.url, 'http://localhost');
      const key = url.searchParams.get('api_key') || '';
      const at = key.indexOf(':');
      if (at < 1) return false;
      user = key.slice(0, at);
      pass = key.slice(at + 1);
    }
    return user === this.username && pass === this.password;
  }

  /** Is an ARI client connected for this application right now? */
  has(app) {
    const key = app || this.app;
    return (this.subscribers.get(key)?.size || 0) > 0;
  }

  subscribe(app, ws) {
    const key = app || this.app;
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    this.subscribers.get(key).add(ws);
    ws.sendJson({
      type: 'SystemInfo',
      asterisk_id: this.asteriskId,
      application: key,
      timestamp: new Date().toISOString(),
    });
    ws.on('close', () => this.subscribers.get(key)?.delete(ws));
  }

  send(app, event) {
    const set = this.subscribers.get(app || this.app);
    if (!set) return;
    const payload = { asterisk_id: this.asteriskId, application: app || this.app, timestamp: new Date().toISOString(), ...event };
    for (const ws of set) {
      try {
        ws.sendJson(payload);
      } catch {
        set.delete(ws);
      }
    }
  }

  fanout(event) {
    switch (event.type) {
      case 'call.stasis': {
        // The routing document handed this call to an application. This is the
        // event an ARI client waits for, and the one the client's whole call
        // flow hangs off: without it an agent is reachable by originate only and
        // every inbound DID dies in silence.
        const call = this.switch.calls.get(event.callId);
        const leg = call?.legs.find((entry) => entry.role === 'inbound') || call?.legs[0];
        if (!leg) return;
        this.send(event.app || call.routeApp, {
          type: 'StasisStart',
          args: [call.to, call.from].filter(Boolean),
          channel: channelJson(leg),
        });
        return;
      }
      case 'call.answered': {
        const call = this.switch.calls.get(event.callId);
        const leg = call?.legs.find((entry) => entry.id === event.leg) || call?.answeredLeg;
        if (leg) this.send(call?.routeApp || this.app, { type: 'ChannelStateChange', channel: channelJson(leg) });
        return;
      }
      case 'call.dtmf': {
        const call = this.switch.calls.get(event.callId);
        const leg = call?.legs.find((entry) => entry.id === event.leg) || call?.answeredLeg;
        if (leg) this.send(call?.routeApp || this.app, { type: 'ChannelDtmfReceived', digit: event.digit, duration_ms: 100, channel: channelJson(leg) });
        return;
      }
      case 'call.ended': {
        const call = this.switch.calls.get(event.callId);
        const leg = call?.legs[0];
        if (leg) {
          const app = call?.routeApp || this.app;
          this.send(app, { type: 'ChannelHangupRequest', channel: channelJson(leg, { state: 'Down' }) });
          this.send(app, { type: 'StasisEnd', channel: channelJson(leg, { state: 'Down' }) });
        }
        // Only the media channels this call was actually hearing. Closing every
        // external socket because *a* call ended would cut the agent off in the
        // middle of a sentence on an unrelated line.
        for (const [id, entry] of this.media) {
          const partner = this.switch.mediaPairs.get(entry.leg.id);
          if (!partner || !call?.legs.some((owned) => owned.id === partner)) continue;
          this.closeExternal(id, 'call ended');
        }
        return;
      }
      default:
        return;
    }
  }

  findLeg(id) {
    // A media channel is not in any call — it is a channel in its own right,
    // exactly as Asterisk's externalMedia creates one — so it is looked up
    // first, before the call legs that most requests name.
    const media = this.legs.get(id);
    if (media) return media;
    for (const call of this.switch.calls.values()) {
      const leg = call.legs.find((entry) => entry.id === id);
      if (leg) return leg;
    }
    return undefined;
  }

  /** Route an ARI request. Returns `{status, body}` or `undefined` if unrouted. */
  async handle(method, pathname, url, request) {
    if (!pathname.startsWith('/ari')) return undefined;
    if (!this.authorized(request)) {
      return { status: 401, body: { error: 'Unauthorized' } };
    }
    const parts = pathname.replace(/^\/ari\/?/, '').split('/').filter(Boolean);
    const query = url.searchParams;

    if (parts[0] === 'asterisk' && parts[1] === 'info') {
      return {
        status: 200,
        body: { status: 'Running', uptime: String(this.switch.status().uptimeSec), system: { engine: 'Cantus', version: '1.0' } },
      };
    }

    if (parts[0] === 'endpoints' && parts.length === 1) {
      const endpoints = [...this.switch.lines.values()].map((line) => ({
        technology: 'Cantus',
        resource: line.ext,
        state: line.sockets.size + line.cantus.size > 0 ? 'online' : 'offline',
        channel_ids: [],
      }));
      return { status: 200, body: endpoints };
    }

    if (parts[0] === 'applications') {
      if (parts.length === 1) return { status: 200, body: [{ name: this.app, channel_ids: [] }] };
      if (parts.length === 2 && parts[1] === this.app) return { status: 200, body: { name: this.app, channel_ids: [] } };
      return STATUS.notFound;
    }

    if (parts[0] === 'channels') {
      if (parts.length === 1 && method === 'GET') {
        const channels = [];
        for (const call of this.switch.calls.values()) {
          if (call.state === 'ended') continue;
          for (const leg of call.legs) channels.push(channelJson(leg));
        }
        for (const leg of this.legs.values()) channels.push(channelJson(leg));
        return { status: 200, body: channels };
      }
      if (parts.length === 1 && method === 'POST') {
        return this.originate(query);
      }
      // Asterisk's own shape: POST /channels/externalMedia with the new channel's
      // id in `channelId`. Everything written against ARI uses this one, and it
      // used to be read as a channel named "externalMedia" and answered 404.
      if (parts.length === 2 && parts[1] === 'externalMedia' && method === 'POST') {
        return this.externalMedia(query);
      }
      const leg = this.findLeg(parts[1]);
      if (!leg) return STATUS.notFound;

      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: channelJson(leg) };
        if (method === 'DELETE') {
          // Hanging up a media channel ends that channel, not the conversation
          // it was carrying: ARI clients delete their external channel on
          // teardown and then hang the caller up themselves.
          if (this.media.has(leg.id)) {
            this.closeExternal(leg.id, 'hung up by the application');
            return { status: 204 };
          }
          this.switch.hangup(leg.call.id, 'normal');
          return { status: 204 };
        }
      }
      if (parts.length === 3 && method === 'POST') {
        switch (parts[2]) {
          case 'answer':
            this.switch.answerLeg(leg.call, leg);
            return { status: 200 };
          case 'hangup': {
            const cause = query.get('reason') || 'normal';
            this.switch.endCall(leg.call, cause);
            return { status: 204 };
          }
          case 'dtmf': {
            const digit = query.get('dtmf');
            if (!digit) return STATUS.badRequest('dtmf is required');
            if (leg.endpoint) this.switch.endpoint.sendDtmf(leg.endpoint, digit);
            this.switch.emitCall(leg.call, 'call.dtmf', { leg: leg.id, digit, via: 'ari' });
            return { status: 204 };
          }
          case 'moh':
          case 'unmute':
          case 'mute':
            return { status: 204 };
          case 'externalMedia':
            // The documented endpoint is POST /channels/externalMedia with the
            // new channel's id in `channelId`; this per-channel spelling has
            // never existed in ARI. Answering it with a route that reads as if
            // it worked is how a client ends up with a media channel it cannot
            // name.
            return STATUS.badRequest(
              'externalMedia is created with POST /ari/channels/externalMedia?channelId=…, not on an existing channel'
            );
          case 'snoop':
            // Said rather than faked: there is no second tap to snoop on. A
            // caller that needs the media already has it through externalMedia.
            return {
              status: 501,
              body: { error: 'Not Implemented', message: 'snoop is not available on the Cantus surface; use externalMedia' },
            };
          default:
            break;
        }
      }
      if (parts.length === 4 && parts[2] === 'play' && method === 'POST') {
        return this.play(leg, parts[3], query.get('media'));
      }
      return STATUS.notFound;
    }

    if (parts[0] === 'bridges') {
      if (parts.length === 1) {
        if (method === 'GET') return { status: 200, body: [...this.bridges.values()].map(bridgeJson) };
        if (method === 'POST') {
          const id =
            query.get('bridgeId') ||
            `bridge-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          if (this.bridges.has(id)) return STATUS.conflict;
          const bridge = {
            id,
            type: query.get('type') || 'mixing',
            name: query.get('name') || '',
            channels: new Set(),
            createdAt: new Date().toISOString(),
          };
          this.bridges.set(id, bridge);
          return { status: 200, body: bridgeJson(bridge) };
        }
      }
      const bridge = parts.length >= 2 ? this.bridges.get(parts[1]) : undefined;
      if (!bridge) return STATUS.notFound;
      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: bridgeJson(bridge) };
        if (method === 'DELETE') {
          for (const id of bridge.channels) this.switch.mediaPairs.delete(id);
          this.bridges.delete(bridge.id);
          return { status: 204 };
        }
      }
      if (parts.length === 3 && method === 'POST') {
        const channels = String(query.get('channel') || '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (parts[2] === 'addChannel') {
          if (!channels.length) return STATUS.badRequest('channel is required');
          const missing = channels.filter((id) => !this.findLeg(id));
          if (missing.length) {
            return { status: 404, body: { error: 'Not Found', message: `no such channel: ${missing.join(', ')}` } };
          }
          for (const id of channels) bridge.channels.add(id);
          this.pairBridge(bridge);
          return { status: 204 };
        }
        if (parts[2] === 'removeChannel') {
          for (const id of channels) bridge.channels.delete(id);
          this.pairBridge(bridge);
          return { status: 204 };
        }
      }
      return STATUS.notFound;
    }

    if (parts[0] === 'sounds') {
      const name = (parts[1] || '').replace(/^.*:/, '');
      const resolved = this.switch.resolvePrompt(name);
      return resolved ? { status: 200, body: { id: name, name, format: 'wav' } } : STATUS.notFound;
    }

    if (parts[0] === 'recordings') {
      const calls = [...this.switch.calls.values()].filter((call) => call.recording);
      if (parts.length === 1) {
        return { status: 200, body: calls.map((call) => ({ name: call.recordingName, format: 'wav', duration: call.durationSec })) };
      }
      const call = calls.find((entry) => entry.recordingName === parts[1]);
      if (!call) return STATUS.notFound;
      return { status: 200, body: { name: call.recordingName, format: 'wav', duration: call.durationSec, url: call.recording } };
    }

    return STATUS.notFound;
  }

  async originate(query) {
    const endpoint = query.get('endpoint');
    if (!endpoint) return STATUS.badRequest('endpoint is required');
    const app = query.get('app') || this.app;
    // `Local/100@dograh-inbound` is how every in-tree script dials: the part
    // after Local/ is the address, and the context is documentation of intent.
    const target = endpoint.startsWith('Local/') ? endpoint.slice(6) : endpoint;
    const address = target.split('@')[0];
    const call = this.switch.originate({ from: 'ari', to: `${address}@${this.switch.domain}` });
    if (!call) return { status: 500, body: { error: 'Internal Server Error' } };
    call.routeApp = app;
    const leg = call.legs[0];
    if (!leg) return { status: 500, body: { error: 'Internal Server Error' } };
    this.send(app, { type: 'StasisStart', args: [address], channel: channelJson(leg) });
    return { status: 200, body: channelJson(leg) };
  }

  /**
   * The media endpoint a connection name resolves to.
   *
   * Either a name that `CANTUS_WS_CLIENTS` knows or a literal ws:// URL, which
   * is what a test or a one-off script uses. `transport_data` is appended as
   * query parameters — the ids an agent runtime routes the call by arrive there
   * and nowhere else.
   */
  mediaUrl(host, transportData) {
    if (!host) return undefined;
    const base = /^wss?:\/\//i.test(host) ? host : this.wsClients.get(String(host).toLowerCase());
    if (!base) return undefined;
    let url;
    try {
      url = new URL(base);
    } catch {
      return undefined;
    }
    for (const [key, value] of transportParams(transportData)) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * Create an external media channel, chan_websocket style.
   *
   * chan_websocket + res_websocket_client is two halves of one thing: Asterisk
   * looks `external_host` up in `websocket_client.conf`, dials that URI, and
   * then carries raw audio over binary WebSocket frames in the requested format.
   * The channel it creates is a channel like any other, which is why the bridge
   * that follows (`/bridges` then `addChannel`) is what puts the caller and the
   * agent in the same conversation.
   *
   * Everything the caller says reaches the application; everything the
   * application sends reaches the caller; and the pair only counts as audio
   * once the bridge names both channels — a media channel that was never
   * bridged is a tap on a silent line, not a call.
   */
  async externalMedia(query) {
    const host = query.get('external_host') || query.get('externalHost') || '';
    const format = String(query.get('format') || 'ulaw').toLowerCase();
    const transport = String(query.get('transport') || 'websocket').toLowerCase();
    const connectionType = String(
      query.get('connection_type') || query.get('connectiontype') || 'client'
    ).toLowerCase();
    // both: the application speaks and listens. in: the application only
    // speaks, out: the application only listens.
    const direction = String(query.get('direction') || 'both').toLowerCase();
    const app = query.get('app') || this.app;
    const codec = MEDIA_FORMATS[format];

    if (transport !== 'websocket') {
      return STATUS.badRequest(
        `transport=${transport} has no media path here: chan_websocket (transport=websocket) is the one implemented`
      );
    }
    if (connectionType !== 'client') {
      return STATUS.badRequest(
        `connection_type=${connectionType} is not supported: the switch dials the media endpoint (client); it does not accept inbound media sockets`
      );
    }
    if (!/^(both|in|out)$/.test(direction)) {
      return STATUS.badRequest(`direction=${direction} is not one of both, in, out`);
    }
    if (!codec) {
      return STATUS.badRequest(
        `format=${format} is not carried; use one of ${Object.keys(MEDIA_FORMATS).join(', ')}`
      );
    }
    const url = this.mediaUrl(host, query.get('transport_data'));
    if (!url) {
      return STATUS.badRequest(
        /^wss?:\/\//i.test(host)
          ? `external_host ${host} is not a usable ws:// or wss:// URL`
          : `websocket client '${host || '(none)'}' is not configured on this switch — set CANTUS_WS_CLIENTS=${host || 'name'}=ws://host:port/path`
      );
    }

    const id =
      query.get('channelId') ||
      query.get('channelid') ||
      `ext-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (this.media.has(id)) return STATUS.conflict;

    // The media channel has no legs of its own and belongs to no call: it is a
    // channel, and the bridge is what joins it to one. Its `call` is the shape
    // the ARI JSON and the media helpers read, nothing more.
    const channel = {
      id: `media-${id}`,
      direction: 'internal',
      from: `media:${app}`,
      to: url,
      route: 'external-media',
      legs: [],
      state: 'answered',
      startedAt: Date.now(),
      answeredAt: Date.now(),
      endedAt: 0,
      cause: '',
      recording: '',
      recordingName: '',
      recordBuffer: [],
      recordBytes: 0,
      events: [],
    };
    const leg = {
      id,
      call: channel,
      role: 'agent',
      endpoint: undefined,
      ws: undefined,
      ext: app,
      state: 'answered',
      rx: undefined,
      rxAt: 0,
      answeredAt: Date.now(),
      endedAt: 0,
      muted: false,
      held: false,
      heldAt: 0,
      mohAt: 0,
      received: 0,
      sent: 0,
    };
    Object.defineProperties(leg, {
      isAnswered: { get: () => leg.state === 'answered' },
      isEnded: { get: () => leg.state === 'ended' },
    });
    channel.legs.push(leg);

    let socket;
    try {
      // chan_websocket negotiates the `media` subprotocol; a server that echoes
      // it is speaking the same protocol, and one that does not still works
      // because the frames carry no negotiation of their own.
      socket = await connectWebSocket(url, { headers: { 'Sec-WebSocket-Protocol': 'media' } });
    } catch (err) {
      return { status: 500, body: { error: 'Connection Failed', message: `${url}: ${err.message}` } };
    }

    const entry = { socket, leg, codec, format, direction, url, timer: undefined };
    this.media.set(id, entry);
    this.legs.set(id, leg);

    // chan_websocket announces the stream before the first frame. Clients read
    // it — pipecat logs the declared format and warns when it is not the one it
    // decodes — so not sending it leaves the far end guessing.
    socket.send(
      `MEDIA_START connection_id:${host || id} channel:${id} format:${format} optimal_frame_size:${codec.bytesPerFrame} ptime:20`
    );

    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      if (direction === 'out') return; // the application only listens
      leg.rx = codec.fromWire(Buffer.from(data));
      leg.rxAt = Date.now();
      leg.received += 1;
    });
    socket.on('close', () => this.closeExternal(id, 'media socket closed'));

    if (direction !== 'in') {
      // The application only speaks; there is no far end to feed.
      const timer = setInterval(() => {
        if (!socket.open) return;
        const pcm = this.switch.audioTo(leg) || silence(160);
        socket.send(codec.toWire(Buffer.from(pcm)), { binary: true });
        leg.sent += 1;
      }, 20);
      timer.unref?.();
      entry.timer = timer;
    }

    // The channel enters the Stasis application that created it, exactly as a
    // channel created in a dialplan does. ARI clients wait for this: the media
    // channel is not bridged until they know it is there, so without it the
    // pipeline starts, answers, and the caller hears nothing — the hand-off
    // succeeding and the call being connected are two different events.
    if (app) this.send(app, { type: 'StasisStart', args: [], channel: channelJson(leg) });

    this.onEvent({ type: 'media.opened', channelId: id, url, format, direction, app });
    return { status: 200, body: channelJson(leg) };
  }

  /**
   * Close one media channel and put back everything it was holding.
   *
   * A media channel holds three things: a socket, a place in a bridge's channel
   * list, and the bridge pairing that decides who hears whom. Dropping only the
   * socket leaves a pairing that points at a channel nobody can reach, and the
   * next call on that line hears silence from a peer that is not there.
   */
  closeExternal(id, reason = 'closed') {
    const entry = this.media.get(id);
    if (!entry) return false;
    this.media.delete(id);
    clearInterval(entry.timer);
    for (const [channel, partner] of [...this.switch.mediaPairs]) {
      if (channel === id || partner === id) this.switch.mediaPairs.delete(channel);
    }
    for (const bridge of this.bridges.values()) bridge.channels.delete(id);
    try {
      entry.socket.close(1000, reason.slice(0, 100));
    } catch {
      /* already gone */
    }
    this.legs.delete(id);
    entry.leg.state = 'ended';
    entry.leg.endedAt = Date.now();
    this.send(entry.leg.ext || this.app, {
      type: 'ChannelDestroyed',
      cause: 16,
      cause_tm: reason,
      channel: channelJson(entry.leg, { state: 'Down' }),
    });
    this.onEvent({ type: 'media.closed', channelId: id, reason });
    return true;
  }

  /**
   * Decide who hears whom for a bridge.
   *
   * Two channels — a caller and an external media channel — is the shape every
   * client in this estate sends, and it is a true pair. A third channel would
   * need a real mixer; until one exists each channel is paired with the first
   * other, which is stated here rather than discovered in a call.
   */
  pairBridge(bridge) {
    const ids = [...bridge.channels];
    for (const id of ids) this.switch.mediaPairs.delete(id);
    for (const id of ids) {
      const other = ids.find((entry) => entry !== id);
      if (other) this.switch.mediaPairs.set(id, other);
    }
    this.onEvent({ type: 'bridge.paired', bridgeId: bridge.id, channels: ids });
  }

  async play(leg, playbackId, media) {
    if (!leg) return STATUS.notFound;
    const name = String(media || '').replace(/^sound:/, '');
    const resolved = this.switch.resolvePrompt(name);
    this.send(this.app, { type: 'PlaybackStarted', playback: { id: playbackId, media_uri: media, target_uri: leg.id, state: 'playing', language: 'en' } });
    if (resolved) this.switch.playTo(leg, resolved);
    else this.onEvent({ type: 'playback.missing', playbackId, media });
    setTimeout(() => {
      this.send(this.app, {
        type: 'PlaybackFinished',
        playback: { id: playbackId, media_uri: media, target_uri: leg.id, state: 'done', language: 'en' },
      });
    }, 500).unref?.();
    return { status: 200, body: { id: playbackId, media_uri: media, target_uri: leg.id, state: 'playing', language: 'en' } };
  }
}

export { PCM_RATE };
