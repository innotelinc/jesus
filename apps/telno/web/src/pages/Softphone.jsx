import { useCallback, useEffect, useRef, useState } from 'react';
import { api, prettyNumber } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Input, Loading, PageHeader, Select, Stat, Switch, useToast } from '../ui.jsx';
import { isSoftphoneWindow, openSoftphoneWindow } from '../softphoneWindow.js';
import { readLine, saveLine } from '../softphoneLine.js';
import { MASK_MODES, createVoiceMask } from '../voiceMask.js';
import VoicePanel from '../VoicePanel.jsx';
import { digitsFromSpeech, recognitionSupported, startDictation } from '../speech.js';
import { watchCalls } from '../native.js';

/**
 * Browser softphone.
 *
 * Signaling is SIP over secure WebSocket straight to the switch
 * (chan_pjsip), and media is DTLS-SRTP negotiated end to end — the platform is
 * never in the media path. This page does three things on top of that: it asks
 * the platform for a session, it drives the WebRTC peer connection, and it
 * reports presence so the rest of the console knows the line is busy.
 *
 * sip.js is loaded on demand: it is ~120 kB that only this screen needs.
 */

const DIALPAD = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

/**
 * Follow the DTLS handshake to its conclusion.
 *
 * A single sample shortly after the answer reads "new"/"connecting" or
 * nothing at all, so the badge would claim a call is unencrypted — or unknown —
 * for a call that becomes encrypted a second later. Poll until the transport
 * reports a final state, and stop as soon as it is connected.
 */
function watchEncryption(pc, onState) {
  if (!pc) return () => {};
  let stopped = false;
  let timer = null;
  const deadline = Date.now() + 20000;

  const tick = async () => {
    if (stopped) return;
    let dtls = '';
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'transport' && report.dtlsState) dtls = report.dtlsState;
      });
    } catch {
      /* stats unavailable on this tick */
    }
    if (dtls) onState(dtls === 'connected');
    if (dtls === 'connected' || dtls === 'failed' || dtls === 'closed' || Date.now() > deadline) {
      stopped = true;
      return;
    }
    timer = setTimeout(tick, 750);
  };

  const start = setTimeout(tick, 500);
  return () => {
    stopped = true;
    clearTimeout(start);
    clearTimeout(timer);
  };
}

/** Turn a transport failure into something an operator can act on. */
function explain(error, status) {
  const message = String(error?.message || '');
  if (!message) return '';
  if (/WebSocket|1006|transport|connect|certificate/i.test(message)) {
    // A browser will not let a user "continue anyway" for WSS, so the only two
    // fixes are trusting the certificate or installing a real one. Say that,
    // and name the fingerprint the switch is actually presenting.
    const fingerprint = status?.tls?.fingerprint ? ` Switch certificate: ${status.tls.fingerprint}.` : '';
    return `No trusted secure WebSocket answered at ${status?.wssUrl}. Publish port ${
      status?.wssPort || 8089
    }, confirm Asterisk is running, and add the switch certificate to the browser's trusted roots (Chrome offers no bypass for WSS) or serve a real one with SOFTPHONE_TLS_CERT.${fingerprint} (${message})`;
  }
  return message;
}

const fmtDuration = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export default function Softphone() {
  const toast = useToast();
  // Opened as its own window: no console around it, and its registration is not
  // tied to whatever page the operator navigates to next.
  const [standalone] = useState(() => isSoftphoneWindow());
  const [status, setStatus] = useState(null);
  const [extensions, setExtensions] = useState([]);
  // The line this browser had last: the same extension and devices come back
  // after a reload, which is the difference between a phone and a demo.
  const [extension, setExtension] = useState(() => readLine().extension);
  const [session, setSession] = useState(null);
  const [regState, setRegState] = useState('off');
  // The parking space a call answered on the phone is waiting in, and the dial
  // that joins it. Both are refs because the answer and the registration that
  // makes dialing possible can arrive in either order.
  const parkSpaceRef = useRef('');
  const dialRef = useRef(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [dial, setDial] = useState('');
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [incoming, setIncoming] = useState(false);
  const [secure, setSecure] = useState(null);
  const [peers, setPeers] = useState([]);
  const [settings, setSettings] = useState(() => {
    const line = readLine();
    return { video: line.video, micId: line.micId, camId: line.camId };
  });
  const [keep, setKeep] = useState(() => readLine().keep !== false);
  const [reconnecting, setReconnecting] = useState(false);
  const [devices, setDevices] = useState({ mics: [], cams: [] });
  const [inbox, setInbox] = useState([]);
  // SCIF: the secure profile of this line, applied by the switch and by this
  // browser. The URL can arm it for the window — that is how the installed app
  // opens — and the line keeps the setting once it has been saved.
  const [scif, setScif] = useState(() => ({
    enabled: new URLSearchParams(window.location.search).get('scif') === '1',
    callerId: { mode: 'own', number: '', presentation: 'allowed' },
    voiceMask: 'off',
    maskText: false,
  }));
  const [scifSaving, setScifSaving] = useState(false);
  // A passed voice check is a single-use ticket; it lives in a ref because
  // connect() needs it immediately, not on the next render.
  const voiceTicketRef = useRef('');
  const [voiceNeeded, setVoiceNeeded] = useState(false);

  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const localStreamRef = useRef(null);
  // The mask graph currently in the outbound audio path, and the original track
  // it replaced so "off" can put the real microphone back.
  const maskRef = useRef(null);
  const armedRef = useRef(new URLSearchParams(window.location.search).get('scif') === '1');
  const cameraTrackRef = useRef(null);
  const constraintsRef = useRef({ audio: true, video: false });
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const startedAtRef = useRef(0);
  // Reconnection state: one timer, an attempt count and the latest connect.
  const connectRef = useRef(null);
  const reconnectTimer = useRef(null);
  const attemptsRef = useRef(0);
  const keepRef = useRef(keep);
  const callRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        mics: list.filter((d) => d.kind === 'audioinput'),
        cams: list.filter((d) => d.kind === 'videoinput'),
      });
    } catch {
      /* permission not granted yet: the pickers stay empty until it is */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [statusData, extData] = await Promise.all([
          api.get('/softphone/status'),
          // A customer has no reach into the switch inventory, so the console's
          // extension list is not theirs to read; their own lines come from the
          // customer endpoint instead, in the same shape.
          api.get('/extensions').catch(async () => {
            const me = await api.get('/me');
            return {
              items: (me.lines || []).map((line) => ({
                id: line.id,
                extension: line.extension,
                displayName: line.displayName,
                enabled: line.enabled,
                voicemail: line.voicemail,
              })),
            };
          }),
        ]);
        setStatus(statusData);
        const enabled = (extData.items || []).filter((row) => row.enabled !== false);
        setExtensions(enabled);
        // Keep the remembered extension when it still exists; otherwise fall
        // back to the first one so the screen is usable on a fresh browser.
        const remembered = readLine().extension;
        const stillThere = enabled.some((row) => String(row.extension) === String(remembered));
        if (stillThere) setExtension(String(remembered));
        else if (enabled[0]) setExtension(String(enabled[0].extension));
      } catch (err) {
        toast.error('Could not load the softphone', err.message);
      }
    })();
    loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!call?.startedAt || call.state === 'ended') return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 500);
    return () => clearInterval(timer);
  }, [call?.startedAt, call?.state]);

  /* ------------------------------------------------------ window handshake -- */

  // Answer the console when it asks whether a softphone window is already open,
  // so reopening focuses this one instead of loading a second copy over it.
  useEffect(() => {
    if (!standalone || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel('telno-softphone');
    channel.onmessage = (event) => {
      if (event.data?.type === 'ping') channel.postMessage({ type: 'alive' });
      if (event.data?.type === 'focus') window.focus();
    };
    return () => channel.close();
  }, [standalone]);

  // A popout there is no handle to, so the console asks over the channel: it is
  // the only way to reopen without reloading a window that may be on a call.
  const popOut = async () => {
    const result = await openSoftphoneWindow();
    if (result.blocked) {
      toast.error('The window was blocked', 'Allow popups for this site, then try again');
      return;
    }
    if (result.focused) {
      toast.success('Softphone window is already open', 'Brought it forward — this page stays as it is');
      return;
    }
    toast.success('Softphone opened in its own window', 'It stays registered while you browse the console');
  };

  /* ------------------------------------------------------ presence socket -- */

  const sendPresence = useCallback((state, peer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state, peer }));
  }, []);

  const openSocket = useCallback(
    (ticket) => {
      if (!status?.webSocket) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${window.location.host}/api/softphone/ws?ticket=${encodeURIComponent(ticket)}`);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'presence') setPeers(message.operators || []);
        if (message.type === 'line') {
          // A parked call is the one state worth spelling out: the caller is
          // holding, and dialing the space is what takes them.
          const what = message.phase === 'parked' && message.space ? `waiting in ${message.space}` : message.phase;
          setInbox((list) => [
            `${message.extension} ${what}${message.caller ? ` · ${message.caller}` : ''}`,
            ...list,
          ].slice(0, 4));
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
      };
    },
    [status?.webSocket]
  );

  /* ------------------------------------------------------------- teardown -- */

  const stopMedia = useCallback(() => {
    // The mask graph must not outlive the call: an AudioContext left open keeps
    // the tab's audio pipeline awake and holds the microphone indicator on.
    const mask = maskRef.current;
    maskRef.current = null;
    mask?.mask.stop();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    cameraTrackRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  const hangup = useCallback(async () => {
    const session = sessionRef.current;
    try {
      if (session?.state === 'Established') await session.bye();
      else if (session) await session.cancel?.();
    } catch {
      /* already gone */
    }
    sessionRef.current = null;
    pcRef.current = null;
    stopMedia();
    setCall(null);
    setMuted(false);
    setCameraOn(false);
    setSharing(false);
    setSecure(null);
    setElapsed(0);
    sendPresence('idle', '');
    wsRef.current?.send(JSON.stringify({ type: 'bye' }));
  }, [sendPresence, stopMedia]);

  const disconnect = useCallback(async () => {
    await hangup();
    try {
      await uaRef.current?.unregister();
      await uaRef.current?.stop();
    } catch {
      /* ignore */
    }
    uaRef.current = null;
    sessionRef.current = null;
    setSession(null);
    setRegState('off');
    setConnectError('');
    wsRef.current?.close();
    wsRef.current = null;
  }, [hangup]);

  useEffect(() => () => {
    // Leaving the page must not leave the microphone hot.
    sessionRef.current?.bye?.().catch?.(() => {});
    uaRef.current?.stop?.();
    maskRef.current?.mask.stop();
    maskRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current?.close();
  }, []);

  /* -------------------------------------------------------------- connect -- */

  /**
   * Bring a dropped line back on its own. Backoff is deliberately slow at the
   * top and capped: a switch restart takes a few seconds, and a softphone that
   * hammers a dead socket is noise in a log rather than a recovery.
   */
  const scheduleReconnect = useCallback((reason) => {
    if (!keepRef.current || reconnectTimer.current) return;
    if (callRef.current && callRef.current.state !== 'ended') return;
    attemptsRef.current += 1;
    if (attemptsRef.current > 8) {
      setReconnecting(false);
      setRegState('failed');
      setConnectError(`The line stayed down after 8 attempts (${reason}). Connect manually when the switch is back.`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** attemptsRef.current);
    setReconnecting(true);
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connectRef.current?.({ auto: true });
    }, delay);
  }, []);

  /**
   * Dial by voice: recognition turns what was said into digits, and the dial
   * field is filled rather than called, so a misheard word is visible before it
   * becomes a call.
   */
  const dictateNumber = () => {
    if (!recognitionSupported()) {
      toast.error('No speech recognition', 'This browser has none. Chrome, Edge and Safari do.');
      return;
    }
    toast.info('Listening', 'Say a number — “call one oh one”.');
    startDictation({
      onFinal: (text) => {
        const digits = digitsFromSpeech(text);
        if (!digits) {
          toast.error('Nothing dialable heard', text ? `Heard “${text}”.` : 'Try again a little closer to the microphone.');
          return;
        }
        setDial(digits);
      },
      onError: (message) => toast.error('Could not listen', message),
    });
  };

  const connect = async ({ auto = false } = {}) => {
    if (!extension) return;
    setConnecting(!auto);
    setConnectError('');
    try {
      const data = await api.post('/softphone/session', { extension, voiceTicket: voiceTicketRef.current || undefined });
      // Spent by the server, whatever happened next.
      voiceTicketRef.current = '';
      setVoiceNeeded(false);
      if (data.scif) setScif(data.scif);
      // The installed SCIF app opens with `scif=1`: arm the line itself, so the
      // promise holds for the handset too and survives this browser.
      if (armedRef.current && data.scif && !data.scif.enabled) {
        api
          .post('/softphone/scif', { extension, scif: true })
          .then((result) => {
            setScif(result.scif);
            toast.success('SCIF armed on this line', 'Caller ID is withheld and recording is off at the switch.');
          })
          .catch(() => {
            /* the session still works; the operator can arm it by hand */
          });
      }

      const sip = await import('sip.js');
      const { UserAgent, Registerer } = sip;
      const domain = new URL(data.wssUrl.replace(/^wss:/, 'https:')).hostname;

      const constraints = {
        audio: settings.micId ? { deviceId: { exact: settings.micId } } : true,
        video: settings.video && settings.camId ? { deviceId: { exact: settings.camId } } : settings.video,
      };

      const attach = (sipSession) => {
        sessionRef.current = sipSession;
        sipSession.stateChange.addListener((state) => {
          if (state === 'Established') {
            startedAtRef.current = Date.now();
            setCall((current) => ({ ...current, state: 'incall', startedAt: Date.now() }));
            sendPresence('incall', sipSession.remoteIdentity?.uri?.user || '');
            const pc = sipSession.sessionDescriptionHandler?.peerConnection;
            pcRef.current = pc;
            if (pc) {
              const remote = new MediaStream();
              pc.getReceivers().forEach((receiver) => {
                if (receiver.track) remote.addTrack(receiver.track);
              });
              if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remote;
                remoteVideoRef.current.play?.().catch(() => {});
              }
              const local = new MediaStream();
              pc.getSenders().forEach((sender) => sender.track && local.addTrack(sender.track));
              localStreamRef.current = local;
              if (localVideoRef.current) localVideoRef.current.srcObject = local;
              // DTLS state is the honest answer to "is this call encrypted".
              watchEncryption(pc, setSecure);
            }
          }
          if (state === 'Terminated') {
            sessionRef.current = null;
            pcRef.current = null;
            stopMedia();
            setCall(null);
            setSecure(null);
            setSharing(false);
            setMuted(false);
            sendPresence('idle', '');
          }
        });
      };

      const ua = new UserAgent({
        uri: UserAgent.makeURI(data.sip.uri),
        transportOptions: { server: data.wssUrl },
        authorizationUsername: data.sip.authUser,
        authorizationPassword: data.sip.password,
        // A self-signed switch certificate is the normal case on first boot; a
        // production deployment should install a real one and drop this.
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: data.iceServers,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
          },
        },
        logLevel: 'error',
        delegate: {
          onDisconnect: (error) => {
            setRegState('failed');
            setConnectError(error?.message || 'The switch closed the connection');
            // A closed transport is exactly the case a kept line should recover
            // from without a human clicking anything.
            scheduleReconnect(error?.message || 'the switch closed the connection');
          },
          onInvite: (invitation) => {
            attach(invitation);
            setCall({ state: 'ringing', direction: 'inbound', peer: invitation.remoteIdentity?.uri?.user || 'unknown' });
            setIncoming(true);
            sendPresence('ringing', invitation.remoteIdentity?.uri?.user || '');
            // Answer with the same media preferences as an outgoing call.
            constraintsRef.current = constraints;
          },
        },
      });

      // Start and register first: a session that never reaches the switch must
      // leave the screen in its setup state, not a dialpad that cannot dial.
      await ua.start();
      const registerer = new Registerer(ua);
      registerer.stateChange.addListener((state) => {
        setRegState(
          state === 'Registered' ? 'registered' : state === 'Unregistered' ? 'off' : 'registering'
        );
        if (state === 'Registered') {
          // A registration that lands is the only proof a reconnect worked.
          attemptsRef.current = 0;
          setReconnecting(false);
        }
        // A registration that drops while nothing was asked for is a lost line.
        if (state === 'Unregistered' && keepRef.current) scheduleReconnect('the switch unregistered the line');
      });
      await registerer.register();

      uaRef.current = ua;
      setRegState('registering');
      setSession(data);
      openSocket(data.ticket);
      toast.info('Softphone connecting', `Registering ${data.extension.extension} over ${data.wssUrl}`);
    } catch (err) {
      try {
        await uaRef.current?.stop();
      } catch {
        /* never started */
      }
      uaRef.current = null;
      setSession(null);
      if (err?.code === 'voice_required') {
        // The line asked for a voice check and did not get one: say where the fix
        // is instead of blaming the switch.
        setVoiceNeeded(true);
        setConnectError('This line requires a voice check. Use Voice → Check my voice, then connect again.');
      } else {
        setConnectError(
          explain(err, status) ||
            `Could not reach the switch at ${status?.wssUrl}. Check that port ${status?.wssPort || 8089} is published and the certificate is trusted.`
        );
      }
      setRegState('failed');
      if (auto) {
        // Silent by design: an automatic retry must not stack up toasts.
        scheduleReconnect(err?.message || 'the switch did not answer');
      } else {
        toast.error('Softphone could not connect', err?.message || 'The switch did not answer');
      }
    } finally {
      setConnecting(false);
    }
  };

  /**
   * In the native app: register this phone for calls, and come back online when
   * one is answered from the lock screen. A browser has no such bridge, so this
   * does nothing there.
   */
  useEffect(() => {
    if (!session) return undefined;
    return watchCalls({
      extension: session.extension.extension,
      onIncoming: (call) => {
        // The switch parks a call it cannot hand to a registered phone, and the
        // push carries the space it is waiting in.
        if (call?.parkingSpace) parkSpaceRef.current = String(call.parkingSpace);
        toast.info('Incoming call', call?.display || call?.from || 'Ringing on this phone');
      },
      onAnswered: () => {
        toast.success(
          'Answered on the phone',
          parkSpaceRef.current ? `Joining the call in ${parkSpaceRef.current}…` : 'Joining the line…'
        );
        // The app was suspended; CallKit is now holding the audio session. A
        // registration that lapsed while asleep is rebuilt here.
        if (!sessionRef.current) connectRef.current?.({ auto: true });
      },
      onEnded: () => {
        // Declined, or the caller gave up: nothing left to join.
        parkSpaceRef.current = '';
      },
      onError: (message) => toast.error('Native calls', message),
    });
  }, [session]);

  // Joining the parked call. Answering CallKit does not by itself put the audio
  // anywhere: the line has to register and then dial the space, and that dial is
  // what bridges the caller in. Answering into silence is the bug this closes.
  useEffect(() => {
    const space = parkSpaceRef.current;
    if (!space || regState !== 'registered') return;
    if (call?.state === 'incall' || call?.state === 'dialing') return;
    // Claimed before dialing: the space is one attempt, not a number to redial
    // every time the call state changes.
    parkSpaceRef.current = '';
    setDial(space);
    dialRef.current?.(space, { parked: true });
  }, [regState, call]);

  // The reconnect timer and the online listener both need the current connect.
  useEffect(() => {
    connectRef.current = connect;
  });
  // The parked-call join dials from an effect, so it needs the current dial.
  useEffect(() => {
    dialRef.current = dialTarget;
  });
  useEffect(() => {
    keepRef.current = keep;
    if (!keep) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      setReconnecting(false);
    }
  }, [keep]);
  useEffect(() => {
    callRef.current = call;
  }, [call]);

  // Remember the line: extension, devices, video and whether to come back.
  useEffect(() => {
    saveLine({ extension, video: settings.video, micId: settings.micId, camId: settings.camId, keep });
  }, [extension, settings, keep]);

  // First load of a kept line: register without being asked.
  useEffect(() => {
    if (!status || !keep || session || connecting || regState !== 'off') return;
    if (!extension || !extensions.length) return;
    connectRef.current?.({ auto: true });
    // Only when the inputs that decide it change; connecting is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, keep, extensions.length, extension]);

  // A laptop that slept, a VPN that reconnected, a Wi-Fi that came back: all of
  // these are the browser telling us it is worth trying again.
  useEffect(() => {
    const onOnline = () => {
      if (keepRef.current && regState !== 'registered') scheduleReconnect('the network came back');
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [regState, scheduleReconnect]);

  // A registered phone on a docked laptop should not be put to sleep by the
  // screen timeout; the browser may refuse, which is not an error worth showing.
  useEffect(() => {
    if (regState !== 'registered' || !('wakeLock' in navigator)) return undefined;
    let lock = null;
    let canceled = false;
    navigator.wakeLock
      .request('screen')
      .then((granted) => {
        if (canceled) granted.release?.();
        else lock = granted;
      })
      .catch(() => {});
    return () => {
      canceled = true;
      lock?.release?.().catch?.(() => {});
    };
  }, [regState]);

  useEffect(
    () => () => {
      clearTimeout(reconnectTimer.current);
    },
    []
  );

  /* ---------------------------------------------------------------- calls -- */

  /**
   * Dial something on this line.
   *
   * The number is an argument rather than read from the pad because two things
   * dial: the operator, and the phone answering a call that is already parked —
   * that one dials the parking space the push named.
   */
  const dialTarget = async (target, { parked = false } = {}) => {
    const ua = uaRef.current;
    if (!ua || !target) return;
    const sip = await import('sip.js');
    const domain = new URL(session.wssUrl.replace(/^wss:/, 'https:')).hostname;
    const media = {
      audio: settings.micId ? { deviceId: { exact: settings.micId } } : true,
      video: settings.video ? (settings.camId ? { deviceId: { exact: settings.camId } } : true) : false,
    };
    const inviter = new sip.Inviter(ua, sip.UserAgent.makeURI(`sip:${target}@${domain}`), {
      sessionDescriptionHandlerOptions: { constraints: media },
    });
    constraintsRef.current = media;
    setCall({ state: 'dialing', direction: 'outbound', peer: target });
    setSecure(null);
    sendPresence('dialing', target);
    wsRef.current?.send(JSON.stringify({ type: 'dial', to: target, video: settings.video }));

    inviter.stateChange.addListener(async (state) => {
      if (state === 'Established') {
        startedAtRef.current = Date.now();
        setCall((current) => ({ ...current, state: 'incall', startedAt: Date.now() }));
        sendPresence('incall', target);
        const pc = inviter.sessionDescriptionHandler?.peerConnection;
        pcRef.current = pc;          if (pc) {
          const remote = new MediaStream();
          pc.getReceivers().forEach((receiver) => receiver.track && remote.addTrack(receiver.track));
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remote;
            remoteVideoRef.current.play?.().catch(() => {});
          }
          const local = new MediaStream();
          pc.getSenders().forEach((sender) => sender.track && local.addTrack(sender.track));
          localStreamRef.current = local;
          if (localVideoRef.current) localVideoRef.current.srcObject = local;
          watchEncryption(pc, setSecure);
          setCameraOn(media.video !== false);
        }
      }
      if (state === 'Terminated') {
        sessionRef.current = null;
        stopMedia();
        setCall(null);
        setSecure(null);
        setSharing(false);
        setMuted(false);
        sendPresence('idle', '');
      }
    });
    sessionRef.current = inviter;
    inviter.invite().catch(async (err) => {
      setCall(null);
      // A space is only held for the parking timeout, so failing to reach one
      // means the caller went to voicemail — worth saying plainly.
      if (parked) {
        toast.error('The call is no longer parked', 'It may have gone to voicemail already.');
      } else {
        toast.error('Call failed', err.message);
      }
      sendPresence('idle', '');
      await inviter.dispose?.();
    });
  };

  const placeCall = () => dialTarget(dial.trim());

  const answer = async () => {
    const invitation = sessionRef.current;
    if (!invitation) return;
    setIncoming(false);
    try {
      await invitation.accept({
        sessionDescriptionHandlerOptions: { constraints: constraintsRef.current || { audio: true, video: false } },
      });
    } catch (err) {
      toast.error('Could not answer', err.message);
    }
  };

  const decline = async () => {
    setIncoming(false);
    try {
      await sessionRef.current?.reject();
    } catch {
      /* already ended */
    }
    setCall(null);
    sessionRef.current = null;
    sendPresence('idle', '');
  };

  const toggleMute = () => {
    const pc = pcRef.current;
    if (!pc) return;
    const next = !muted;
    pc.getSenders()
      .filter((sender) => sender.track?.kind === 'audio')
      .forEach((sender) => (sender.track.enabled = !next));
    setMuted(next);
  };

  const toggleCamera = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    if (cameraOn) {
      pc.getSenders()
        .filter((sender) => sender.track?.kind === 'video')
        .forEach((sender) => (sender.track.enabled = false));
      setCameraOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: settings.camId ? { deviceId: { exact: settings.camId } } : true,
      });
      const track = stream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else await pc.addTrack(track, stream);
      cameraTrackRef.current = track;
      setCameraOn(true);
    } catch (err) {
      toast.error('Camera unavailable', err.message);
    }
  };

  const shareScreen = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      if (sharing) {
        const original = cameraTrackRef.current;
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && original) await sender.replaceTrack(original);
        setSharing(false);
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else await pc.addTrack(track, stream);
      track.onended = () => setSharing(false);
      setSharing(true);
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast.error('Screen share failed', err.message);
    }
  };

  const sendDtmf = async (digit) => {
    setDial((value) => (call ? value : value + digit));
    const session = sessionRef.current;
    if (!call || !session?.info) return;
    try {
      await session.info({
        requestOptions: { body: { contentDisposition: 'render', contentType: 'application/dtmf-relay', content: `Signal=${digit}\r\nDuration=160` } },
      });
      wsRef.current?.send(JSON.stringify({ type: 'dtmf', digits: digit }));
    } catch {
      /* a keypress that cannot be sent must not break the call */
    }
  };

  /* ---------------------------------------------------------------- SCIF -- */

  const saveScif = async (patch) => {
    if (!extension) return;
    setScifSaving(true);
    try {
      const result = await api.post('/softphone/scif', { extension, ...patch });
      setScif(result.scif);
      toast.success(
        'SCIF updated',
        result.applied ? 'Switch configuration written and reloaded.' : 'Saved for this line.'
      );
    } catch (err) {
      toast.error('Could not save the SCIF setting', err.message);
    } finally {
      setScifSaving(false);
    }
  };

  // Put the mask into the outbound audio path, or take it out. The sender's own
  // track is kept, so "off" restores the real microphone exactly rather than a
  // second-hand copy of it.
  useEffect(() => {
    const pc = pcRef.current;
    if (!pc) return undefined;
    const wanted = scif.enabled ? scif.voiceMask : 'off';
    const sender = maskRef.current?.sender || pc.getSenders().find((entry) => entry.track?.kind === 'audio');
    if (!sender) return undefined;

    if (wanted === 'off') {
      const current = maskRef.current;
      if (!current) return undefined;
      maskRef.current = null;
      current.mask.stop();
      current.sender.replaceTrack(current.original).catch(() => {});
      return undefined;
    }
    if (maskRef.current) {
      // A different disguise on a live call: the graph stays, the ratio changes.
      maskRef.current.mask.setMode(wanted);
      return undefined;
    }

    let cancelled = false;
    const original = sender.track;
    createVoiceMask(original, wanted)
      .then(async (mask) => {
        if (cancelled) {
          await mask.stop();
          return;
        }
        await sender.replaceTrack(mask.track);
        maskRef.current = { sender, original, mask };
      })
      .catch((err) => toast.error('Voice masking is unavailable', err.message));
    return () => {
      cancelled = true;
    };
  }, [scif.enabled, scif.voiceMask, call?.state, toast]);

  // SCIF refuses a call it cannot prove is encrypted. DTLS settles within a
  // second on a healthy path, so a call still unverified after seven is a call
  // that was never going to be.
  useEffect(() => {
    if (!scif.enabled || call?.state !== 'incall' || secure === true) return undefined;
    const timer = setTimeout(() => {
      toast.error('Call ended — media is not encrypted', 'SCIF refuses a call unless DTLS-SRTP is established.');
      hangup();
    }, 7000);
    return () => clearTimeout(timer);
  }, [scif.enabled, call?.state, secure, hangup, toast]);

  if (!status) return <Loading rows={4} />;

  const registered = regState === 'registered';
  const inCall = call?.state === 'incall' || call?.state === 'dialing';
  const tlsReady = status.tls?.ready;

  return (
    <>
      <PageHeader
        title="Softphone"
        subtitle={
          standalone
            ? 'This window holds the line — close it to release the extension'
            : 'Encrypted audio and video in the browser — the switch is the media gateway'
        }
        actions={
          <>
            {registered ? (
              <Button variant="ghost" icon="logout" onClick={disconnect}>
                Disconnect
              </Button>
            ) : null}
            {standalone ? (
              <Button variant="ghost" icon="x" onClick={() => window.close()} title="Close this window">
                Close window
              </Button>
            ) : (
              <Button variant="ghost" icon="external" onClick={popOut} title="Open the softphone in its own window">
                Open in a window
              </Button>
            )}
          </>
        }
      />

      <div className="grid stats">
        <Stat
          label="Registration"
          value={registered ? 'Registered' : regState === 'failed' ? 'Failed' : regState === 'registering' ? 'Connecting' : 'Offline'}
          foot={registered ? `Extension ${session?.extension?.extension}` : 'Not registered yet'}
          tone={registered ? 'var(--success)' : regState === 'failed' ? 'var(--danger)' : undefined}
        />
        <Stat
          label="Media"
          value={secure === true ? 'DTLS-SRTP' : secure === false ? 'Plain' : '—'}
          foot={
            secure === true
              ? 'Browser leg encrypted'
              : secure === false
                ? 'No DTLS on this leg'
                : 'Checked when the call connects'
          }
          tone={secure === true ? 'var(--success)' : secure === false ? 'var(--danger)' : undefined}
        />
        <Stat label="Signaling" value="WSS" foot={status.wssUrl} />
        <Stat
          label="Relay"
          value={status.ice?.relay ? 'TURN' : status.ice?.turn ? 'TURN (no secret)' : 'STUN only'}
          foot={status.ice?.relay ? 'Time-limited credentials' : 'Add TURN_URLS + TURN_SECRET for hard NATs'}
          tone={status.ice?.relay ? undefined : 'var(--warning)'}
        />
      </div>

      {!tlsReady ? (
        <Card title="The switch has no TLS certificate" subtitle="WebSocket signaling cannot start until it does">
          <p className="tiny muted">
            Generate one by saving any extension, which rewrites the switch configuration, or point
            <code> SOFTPHONE_TLS_CERT</code> and <code>SOFTPHONE_TLS_KEY</code> at a real certificate.
            Browsers will refuse an encrypted WebSocket to a host with no certificate at all.
          </p>
        </Card>
      ) : null}

      <div className="grid two">
        <Card
          title="Line"
          subtitle={session ? `${session.extension.displayName} · ${session.extension.number || 'no DID'}` : 'Pick the extension to answer on'}
          actions={
            <Badge tone={registered ? 'success' : regState === 'failed' ? 'danger' : 'neutral'} dot={registered ? 'live' : undefined}>
              {registered ? 'Live' : regState === 'failed' ? 'Error' : 'Idle'}
            </Badge>
          }
        >
          {!session ? (
            <div className="stack">
              <Select label="Extension" value={extension} onChange={(e) => setExtension(e.target.value)}>
                {extensions.length ? (
                  extensions.map((row) => (
                    <option key={row.id || row.extension} value={row.extension}>
                      {row.extension} · {row.displayName || row.display_name}
                    </option>
                  ))
                ) : (
                  <option value="">No extensions configured</option>
                )}
              </Select>
              <div className="row wrap" style={{ gap: 12 }}>
                <Switch
                  checked={settings.video}
                  onChange={(value) => setSettings({ ...settings, video: value })}
                  label="Allow video"
                  disabled={!status.video}
                />
                <Switch
                  checked={keep}
                  onChange={setKeep}
                  label="Keep this line registered"
                />
              </div>
              <p className="tiny dim" style={{ margin: 0 }}>
                {keep
                  ? 'This browser comes back on its own: after a reload, a dropped network or a switch restart, and it remembers this extension and these devices.'
                  : 'The line ends when this page does. Turn this on to have it register again by itself.'}
              </p>
              <div className="row wrap" style={{ gap: 8 }}>
                <Select
                  label="Microphone"
                  value={settings.micId}
                  onChange={(e) => setSettings({ ...settings, micId: e.target.value })}
                >
                  <option value="">System default</option>
                  {devices.mics.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </Select>
                <Select
                  label="Camera"
                  value={settings.camId}
                  onChange={(e) => setSettings({ ...settings, camId: e.target.value })}
                  disabled={!settings.video}
                >
                  <option value="">System default</option>
                  {devices.cams.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </Select>
              </div>
              <Button variant="primary" icon="phone" loading={connecting} disabled={!extension || !status.enabled} onClick={connect}>
                Connect softphone
              </Button>
              {reconnecting ? (
                <p className="tiny" style={{ color: 'var(--warning)' }}>
                  The line dropped — reconnecting automatically.
                </p>
              ) : null}
              {connectError ? (
                <p className="tiny" style={{ color: 'var(--danger)' }}>
                  {connectError}
                </p>
              ) : null}
              {voiceNeeded ? (
                <p className="tiny" style={{ color: 'var(--warning)' }}>
                  A voice check is required on this line. The Voice card on the right records it and connects you
                  when it passes.
                </p>
              ) : null}
              <p className="tiny dim">
                Registration goes to <span className="mono">{status.wssUrl}</span> using the extension's own
                credentials. The switch has no DTLS, ICE or AVPF switch to turn off: the generated endpoint is
                DTLS-SRTP only.
              </p>
            </div>
          ) : (
            <div className="stack">
              {incoming ? (
                <div className="panel" style={{ padding: 12, borderColor: 'var(--accent)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <strong>Incoming call</strong>
                      <p className="tiny dim">{prettyNumber(call?.peer) || call?.peer}</p>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Button variant="primary" size="sm" icon="phone" onClick={answer}>
                        Answer
                      </Button>
                      <Button variant="ghost" size="sm" onClick={decline}>
                        Decline
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  className="input mono"
                  style={{ fontSize: '1.125rem', letterSpacing: '.04em', flex: 1 }}
                  value={dial}
                  onChange={(e) => setDial(e.target.value.replace(/[^\d+*#]/g, ''))}
                  placeholder="Number or extension"
                  inputMode="tel"
                  aria-label="Destination"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !inCall) placeCall();
                  }}
                />
                <Button
                  variant="ghost"
                  icon="mic"
                  aria-label="Dial by voice"
                  title="Say a number, e.g. “call one oh one”"
                  disabled={!registered || !status.voice?.recognition}
                  onClick={dictateNumber}
                >
                  Say it
                </Button>
              </div>

              <div className="dialpad" role="group" aria-label="Keypad">
                {DIALPAD.map(([digit, letters]) => (
                  <button key={digit} className="key" type="button" onClick={() => sendDtmf(digit)}>
                    <span>{digit}</span>
                    <small>{letters}</small>
                  </button>
                ))}
              </div>

              <div className="row wrap" style={{ gap: 8 }}>
                <Button variant="primary" icon="phone" disabled={!dial || inCall || !registered} onClick={placeCall}>
                  Call
                </Button>
                <Button variant="ghost" icon={muted ? 'micOff' : 'mic'} onClick={toggleMute} disabled={!inCall}>
                  {muted ? 'Unmute' : 'Mute'}
                </Button>
                <Button variant="ghost" icon={cameraOn ? 'video' : 'videoOff'} onClick={toggleCamera} disabled={!inCall || !status.video}>
                  Camera
                </Button>
                <Button variant="ghost" icon="screen" onClick={shareScreen} disabled={!inCall}>
                  {sharing ? 'Stop share' : 'Share screen'}
                </Button>
                <Button variant="danger" icon="x" onClick={hangup} disabled={!call}>
                  Hang up
                </Button>
              </div>

              <div className="softphone-stage">
                <video ref={remoteVideoRef} className="remote" autoPlay playsInline />
                <video ref={localVideoRef} className="local" autoPlay playsInline muted />
                {!call ? (
                  <div className="stage-hint">
                    <Icon name="phone" size={20} />
                    <span>Ready on {session.extension.extension}</span>
                  </div>
                ) : (
                  <div className="stage-badge">
                    <Badge tone={call.state === 'incall' ? 'success' : 'warning'} dot={call.state === 'incall' ? 'live' : 'warn'}>
                      {call.state === 'incall' ? fmtDuration(elapsed) : call.state}
                    </Badge>
                    {call.direction === 'inbound' ? <Badge tone="info">inbound</Badge> : null}
                    {secure ? <Badge tone="success">DTLS-SRTP</Badge> : null}
                    {scif.enabled ? <Badge tone="info">SCIF</Badge> : null}
                    {reconnecting ? <Badge tone="warning" dot="warn">reconnecting</Badge> : null}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title="This line" subtitle="Policy the switch enforces for the number">
            {session ? (
              <dl className="kv">
                <dt>Extension</dt>
                <dd className="mono">{session.extension.extension}</dd>
                <dt>Number</dt>
                <dd className="mono">{session.extension.number || '—'}</dd>
                <dt>Recording in</dt>
                <dd>
                  {session.recording?.inbound ? (
                    <Badge tone="warning">mixed to disk</Badge>
                  ) : (
                    <Badge tone="neutral">off</Badge>
                  )}
                </dd>
                <dt>Recording out</dt>
                <dd>
                  {session.recording?.outbound ? (
                    <Badge tone="warning">mixed to disk</Badge>
                  ) : (
                    <Badge tone="neutral">off</Badge>
                  )}
                </dd>
                <dt>Decided by</dt>
                <dd className="tiny">
                  {session.recording?.agent ? `Voice agent “${session.recording.agent}”` : 'No agent on this number'}
                </dd>
                <dt>Encryption</dt>
                <dd className="tiny">DTLS-SRTP, mandatory on this endpoint</dd>
              </dl>
            ) : (
              <Empty icon="shield" title="Connect to see policy">
                Recording follows the voice agent attached to the extension's number.
              </Empty>
            )}
          </Card>

          <Card
            title="SCIF"
            subtitle="Secure profile the switch enforces on this line"
            actions={
              <Badge tone={scif.enabled ? 'success' : 'neutral'} dot={scif.enabled ? 'live' : undefined}>
                {scif.enabled ? 'Armed' : 'Off'}
              </Badge>
            }
          >
            <div className="stack">
              <Switch
                checked={scif.enabled}
                label="SCIF mode — withhold identity, never record"
                onChange={(value) => saveScif({ scif: value })}
              />
              <div className="grid two">
                <Select
                  label="Caller ID"
                  value={scif.callerId?.mode || 'own'}
                  onChange={(event) => saveScif({ callerIdMode: event.target.value })}
                  disabled={!scif.enabled || scifSaving}
                >
                  <option value="own">Show this line's number</option>
                  <option value="anonymous">Withhold it (anonymous)</option>
                  <option value="custom">Present another number</option>
                </Select>
                <Select
                  label="Voice mask"
                  value={scif.voiceMask || 'off'}
                  onChange={(event) => saveScif({ voiceMask: event.target.value })}
                  disabled={!scif.enabled || scifSaving}
                >
                  {MASK_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </Select>
              </div>
              {scif.callerId?.mode === 'custom' ? (
                <Input
                  label="Number to present"
                  defaultValue={scif.callerId.number}
                  placeholder="+14155550100"
                  onBlur={(event) => saveScif({ callerIdNumber: event.target.value })}
                  disabled={!scif.enabled || scifSaving}
                  hint="Applied by the switch, so it holds on every device on this line."
                />
              ) : null}
              <Switch
                checked={!!scif.maskText}
                label="Mask numbers and addresses in voicemail and messages"
                onChange={(value) => saveScif({ maskText: value })}
                disabled={!scif.enabled || scifSaving}
              />
              <p className="tiny dim" style={{ margin: 0 }}>
                {scif.enabled
                  ? 'Media must be DTLS-SRTP or the call is ended. This line is never recorded, caller ID follows the setting above, and the voice mask runs on the microphone in this browser before anything is sent.'
                  : 'Off. Turning this on withholds your number, stops recording on this line at the switch, and enables the voice mask and text masking.'}
              </p>
            </div>
          </Card>

          <VoicePanel
            extension={extension}
            onTicket={(ticket) => {
              voiceTicketRef.current = ticket;
              toast.success('Voice check passed', 'Opening the line…');
              connectRef.current?.();
            }}
          />

          <Card title="Operators online" subtitle="Presence over the platform socket">
            {peers.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {peers.map((peer) => (
                  <div key={peer.email} className="live-call">
                    <span className={`dot ${peer.state === 'idle' ? 'live' : 'warn'}`} />
                    <span className="truncate">{peer.email}</span>
                    <span className="right tiny dim">
                      {peer.extension} · {peer.state}
                      {peer.peer ? ` · ${peer.peer}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="users" title="No one else is on the line">
                Open the softphone in another tab to see presence here.
              </Empty>
            )}
            {inbox.length ? (
              <div className="stack" style={{ gap: 4, marginTop: 10 }}>
                {inbox.map((line, index) => (
                  <span key={`${line}-${index}`} className="tiny dim mono">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title="Connecting a hard NAT" subtitle="When both sides are behind symmetric NAT">
            <p className="tiny muted">
              STUN is enough on a normal network. For a carrier-grade NAT, run coturn with the shared
              secret and set <code>TURN_URLS</code> and <code>TURN_SECRET</code>: the platform then issues
              per-session, expiring credentials and the browser relays media without ever holding your key.
            </p>
            <p className="tiny dim mono" style={{ marginTop: 8 }}>
              turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
