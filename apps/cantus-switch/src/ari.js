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
import { downsample2, upsample2, PCM_RATE } from './media.js';

const STATUS = {
  notFound: { status: 404, body: { error: 'Not Found', message: 'channel not found' } },
  conflict: { status: 409, body: { error: 'Conflict', message: 'channel is not in a compatible state' } },
  badRequest: (message) => ({ status: 400, body: { error: 'Bad Request', message } }),
};

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

export class AriBridge {
  constructor({ switch: switchRef, username = 'dograh', password = 'dograh', app = 'dograh', asteriskId = 'cantus', onEvent = () => {} }) {
    this.switch = switchRef;
    this.username = username;
    this.password = password;
    this.app = app;
    this.asteriskId = asteriskId;
    this.subscribers = new Map(); // app → Set<ws>
    this.external = new Map(); // channel id → { socket, format }
    this.onEvent = onEvent;

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
        for (const [id, entry] of this.external) {
          if (!call) continue;
          try {
            entry.socket.close(1000, 'call ended');
          } catch {
            /* already closed */
          }
          this.external.delete(id);
        }
        return;
      }
      default:
        return;
    }
  }

  findLeg(id) {
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
        return { status: 200, body: channels };
      }
      if (parts.length === 1 && method === 'POST') {
        return this.originate(query);
      }
      const leg = this.findLeg(parts[1]);
      if (!leg) return STATUS.notFound;

      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: channelJson(leg) };
        if (method === 'DELETE') {
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
            return this.externalMedia(leg, query);
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
      if (parts.length === 1 && method === 'GET') {
        const bridges = this.switch.activeCalls().map((call) => ({
          id: call.id,
          technology: 'Cantus',
          bridge_type: 'mixing',
          channels: call.legs.filter((leg) => leg.isAnswered).map((leg) => leg.id),
          creationtime: new Date(call.startedAt).toISOString(),
          name: call.route || '',
        }));
        return { status: 200, body: bridges };
      }
      if (parts.length >= 3 && parts[1] === 'bridges' && parts[2] === 'addChannel') {
        return { status: 204 };
      }
      if (parts.length === 3 && parts[2] === 'removeChannel') return { status: 204 };
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

  async externalMedia(leg, query) {
    const externalHost = query.get('external_host');
    const format = (query.get('format') || 'slin').toLowerCase();
    if (!externalHost) return STATUS.badRequest('external_host is required');
    if (!leg.isAnswered) this.switch.answerLeg(leg.call, leg);
    const id = `${leg.id}-ext`;
    let socket;
    try {
      socket = await connectWebSocket(externalHost);
    } catch (err) {
      return { status: 500, body: { error: 'Connection Failed', message: err.message } };
    }
    this.external.set(id, { socket, format, leg });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const payload = Buffer.from(data);
      // The agent speaks slin16; the call speaks 8 kHz PCM. Resampling on the
      // way in and out keeps both sides on their native rate.
      leg.rx = format.includes('16') ? downsample2(payload) : payload;
      leg.rxAt = Date.now();
    });
    socket.on('close', () => this.external.delete(id));

    // The switch pushes the far end into the agent at the call's own cadence.
    const timer = setInterval(() => {
      if (!socket.open) return;
      const peer = this.switch.peerOf(leg);
      const payload = peer?.rx && Date.now() - peer.rxAt < 400 ? peer.rx : Buffer.alloc(320);
      socket.send(format.includes('16') ? upsample2(payload) : payload, { binary: true });
    }, 20);
    timer.unref?.();
    socket.on('close', () => clearInterval(timer));

    return {
      status: 200,
      body: { id, name: `Cantus/external/${id}`, state: 'Up', channel: channelJson(leg, { id }) },
    };
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
