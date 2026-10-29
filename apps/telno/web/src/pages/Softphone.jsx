import { useCallback, useEffect, useRef, useState } from 'react';
import { api, prettyNumber } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Input, Loading, PageHeader, Select, Stat, Switch, useToast } from '../ui.jsx';
import { isSoftphoneWindow, openSoftphoneWindow } from '../softphoneWindow.js';
import { readLine, saveLine } from '../softphoneLine.js';
import { MASK_MODES } from '../voiceMask.js';
import { createLine } from '../cantus.js';
import VoicePanel from '../VoicePanel.jsx';
import { digitsFromSpeech, recognitionSupported, startDictation } from '../speech.js';
import { watchCalls } from '../native.js';
import {
  biometry,
  biometricsInApp,
  lockOnOpen,
  methodLabel,
  readLockPolicy,
  saveLockPolicy,
  unlockLine,
} from '../biometrics.js';

/**
 * Browser softphone.
 *
 * Signalling and media ride one WebSocket to the Cantus switch: a call is
 * registered on it, answered on it, and carries 20 ms frames of 8 kHz PCM in
 * both directions. There is no SDP, no ICE, no DTLS and no TURN — the protocol
 * opens one mapping at startup and keeps the call on it, so NAT traversal is a
 * property of the line rather than a negotiation this page can get wrong.
 *
 * This page does three things on top of that: it asks the platform for a
 * session, it runs the WebAudio graph for the line, and it reports presence so
 * the rest of the console knows the line is busy.
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



/** Turn a transport failure into something an operator can act on. */
function explain(error, status) {
  const message = String(error?.message || '');
  if (!message) return '';
  if (/WebSocket|1006|transport|connect|certificate/i.test(message)) {
    // The browser talks to this console's own origin; the console pipes the
    // socket to the switch on the private network. So a failure here is about
    // the switch, not about a certificate the browser has to trust.
    return `No Cantus line answered at ${status?.socketUrl || '/softphone/line'}. The console proxies this socket to the switch at its control address, so check that the switch container is up and that CANTUS_URL points at it${status?.switch?.problem ? ` (${status.switch.problem})` : ''}. (${message})`;
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
  // Face ID. The lock is read synchronously because the line registers on
  // mount: a lock that arrived a render later would have already let the
  // registration through. Both the state and the ref, because connect() reads
  // it outside the render.
  const [locked, setLocked] = useState(() => lockOnOpen());
  const lockedRef = useRef(locked);
  const [lockPolicy, setLockPolicy] = useState(() => readLockPolicy());
  const [biometryInfo, setBiometryInfo] = useState(() => ({ supported: false, biometryType: 'none', label: '', reason: '' }));
  // A passed voice check is a single-use ticket; it lives in a ref because
  // connect() needs it immediately, not on the next render.
  const voiceTicketRef = useRef('');
  const [voiceNeeded, setVoiceNeeded] = useState(false);

  const lineRef = useRef(null);
  const sessionRef = useRef(null);
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
  // Call progress and audio routing. A dial that says only "dialing" until it
  // connects leaves the operator unable to tell ringing from a dead line, so the
  // SIP responses are surfaced as words; and the remote audio is its own element
  // so volume and output device can be controlled at all.
  const [outcome, setOutcome] = useState(null);
  const [volume, setVolume] = useState(1);
  const [sinkId, setSinkId] = useState('');
  const remoteAudioRef = useRef(null);
  const outcomeAtRef = useRef({ at: 0, code: 0 });

  // Every way an outbound call can end without being answered, in plain words.
  const CALL_REFUSALS = {
    404: 'That number is not reachable',
    408: 'The other end never replied',
    480: 'Nobody answered',
    486: 'The line is busy',
    487: 'The call was cancelled',
    488: 'No compatible codec',
    503: 'The trunk is not available',
    603: 'The call was declined',
  };

  const reportOutcome = (code, fallback = 'The call did not connect') => {
    // The same refusal arrives twice — once as a SIP response and again when the
    // session terminates — and two identical errors read as two failures.
    if (Date.now() - outcomeAtRef.current.at < 4000 && outcomeAtRef.current.code === (code || 0)) return;
    outcomeAtRef.current = { at: Date.now(), code: code || 0 };
    const text = CALL_REFUSALS[code] || fallback;
    setOutcome({ code: code || 0, text });
    toast.error(text, code ? `The switch heard ${code}.` : 'No response from the far end.');
  };

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        mics: list.filter((d) => d.kind === 'audioinput'),
        cams: list.filter((d) => d.kind === 'videoinput'),
        outputs: list.filter((d) => d.kind === 'audiooutput'),
      });
    } catch {
      /* permission not granted yet: the pickers stay empty until it is */
    }
  }, []);

  /**
   * Route the call's audio to a chosen output.
   *
   * `setSinkId` is what makes a speakerphone a speakerphone: without it every
   * call plays into whichever device the browser picked, which on a laptop is a
   * headset nobody plugged in. A browser that does not implement it (Safari)
   * keeps the system default and says so instead of pretending.
   */
  const applyOutput = async (deviceId) => {
    const audio = remoteAudioRef.current;
    if (audio && typeof audio.setSinkId === 'function') {
      try {
        await audio.setSinkId(deviceId || '');
        setSinkId(deviceId || '');
      } catch (err) {
        toast.error('Could not switch output', err.message);
      }
      return;
    }
    setSinkId(deviceId || '');
  };

  /** Prefer a real speaker when there is one; otherwise cycle the outputs. */
  const toggleSpeaker = async () => {
    const outputs = devices.outputs || [];
    if (!outputs.length) return;
    const speaker = outputs.find((d) => /speaker|speakerphone|external|display/i.test(d.label || ''));
    const next = speaker && speaker.deviceId !== sinkId ? speaker : outputs.find((d) => d.deviceId !== sinkId) || outputs[0];
    await applyOutput(next?.deviceId || '');
  };

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

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
    try {
      lineRef.current?.hangup();
    } catch {
      /* already gone */
    }
    sessionRef.current = null;
    stopMedia();
    setCall(null);
    setMuted(false);
    setCameraOn(false);
    setSharing(false);
    setSecure(null);
    setElapsed(0);
    // Reset here too: a completed call must not make the next failed dial look
    // like it was answered, or the refusal would never be reported.
    startedAtRef.current = 0;
    sendPresence('idle', '');
    wsRef.current?.send(JSON.stringify({ type: 'bye' }));
  }, [sendPresence, stopMedia]);

  const disconnect = useCallback(async () => {
    await hangup();
    try {
      lineRef.current?.stop();
    } catch {
      /* ignore */
    }
    lineRef.current = null;
    sessionRef.current = null;
    setSession(null);
    setRegState('off');
    setConnectError('');
    wsRef.current?.close();
    wsRef.current = null;
  }, [hangup]);

  useEffect(() => () => {
    // Leaving the page must not leave the microphone hot.
    lineRef.current?.stop?.();
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
    // A locked line asks the platform for nothing, so there is no SIP secret to
    // leak and no endpoint to ring. The gate is here and not in the markup
    // because a hidden button is not a security boundary.
    if (lockedRef.current) {
      setConnectError('Locked — unlock with Face ID to bring this line up.');
      return;
    }
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

      // One socket, one line: signalling and 20 ms PCM frames share it. There is
      // no SDP to build, no ICE to fail, no DTLS to negotiate and no port to
      // forward — a call either has a path or the switch says why it does not.
      const line = await createLine({
        socketUrl: data.socketUrl,
        ticket: data.ticket,
        ext: data.extension.extension,
      });
      lineRef.current = line;
      // Kept for the rest of the page: a session-shaped handle it already
      // understands, so the teardown paths stay one implementation.
      sessionRef.current = line;

      const attachAudio = () => {
        if (remoteAudioRef.current && line.outputStream) {
          remoteAudioRef.current.srcObject = line.outputStream;
          remoteAudioRef.current.play?.().catch(() => {});
        }
        localStreamRef.current = line.localStream || null;
      };

      const established = (peer) => {
        startedAtRef.current = Date.now();
        setCall((current) => ({ ...(current || {}), state: 'incall', startedAt: Date.now(), peer: peer || current?.peer }));
        attachAudio();
        // The media rides a WebSocket to the switch, so "encrypted" is not a
        // negotiation that can fail: it is the transport this line is on.
        setSecure(true);
        sendPresence('incall', peer || '');
      };

      line.on('call', (current) => {
        if (!current) return;
        if (current.state === 'ringing' && current.direction === 'inbound') {
          setIncoming(true);
          setCall({ state: 'ringing', direction: 'inbound', peer: current.from || 'unknown' });
          sendPresence('ringing', current.from || '');
          return;
        }
        if (current.state === 'answered') {
          established(current.direction === 'outbound' ? current.to : current.from);
          return;
        }
        if (current.direction === 'outbound') {
          setCall({ state: 'ringing', direction: 'outbound', peer: current.to });
        }
      });

      line.on('ended', () => {
        sessionRef.current = null;
        lineRef.current = null;
        stopMedia();
        setCall(null);
        setIncoming(false);
        setSecure(null);
        setSharing(false);
        setMuted(false);
        sendPresence('idle', '');
      });

      line.on('error', (event) => {
        toast.error('Line error', event.message || event.error || 'the switch refused it');
      });

      line.on('state', ({ state, reason }) => {
        if (state === 'registered') {
          // A registration that lands is the only proof a reconnect worked.
          setRegState('registered');
          attemptsRef.current = 0;
          setReconnecting(false);
          return;
        }
        if (state === 'failed') {
          setRegState('failed');
          setConnectError(reason || 'The switch closed the connection');
          if (keepRef.current) scheduleReconnect(reason || 'the switch closed the connection');
        }
      });

      setRegState('registered');
      setSecure(true);
      attemptsRef.current = 0;
      setReconnecting(false);
      setSession(data);
      openSocket(data.ticket);
      toast.info('Softphone connecting', `Registering ${data.extension.extension} over Cantus`);
    } catch (err) {
      try {
        lineRef.current?.stop();
      } catch {
        /* never started */
      }
      lineRef.current = null;
      setSession(null);
      if (err?.code === 'voice_required') {
        // The line asked for a voice check and did not get one: say where the fix
        // is instead of blaming the switch.
        setVoiceNeeded(true);
        setConnectError('This line requires a voice check. Use Voice → Check my voice, then connect again.');
      } else {
        setConnectError(
          explain(err, status) ||
            `Could not open a Cantus line at ${status?.socketUrl || '/softphone/line'}. The console proxies it to the switch; check that the switch is running and reachable at its CANTUS_URL.`
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
    if (call?.state === 'incall' || call?.state === 'dialing' || call?.state === 'ringing') return;
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

  // First load of a kept line: register without being asked — unless the line is
  // locked, in which case opening it is what the face is for.
  useEffect(() => {
    if (!status || !keep || session || connecting || regState !== 'off' || locked) return;
    if (!extension || !extensions.length) return;
    connectRef.current?.({ auto: true });
    // Only when the inputs that decide it change; connecting is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, keep, extensions.length, extension, locked]);

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
    const line = lineRef.current;
    if (!line || !target) return;
    setCall({ state: 'dialing', direction: 'outbound', peer: target });
    setOutcome(null);
    setSecure(true);
    sendPresence('dialing', target);
    wsRef.current?.send(JSON.stringify({ type: 'dial', to: target }));
    try {
      // The switch decides what the number means: a line here, a trunk there,
      // or a rejection with a reason. The browser does not resolve numbers.
      line.dial(target);
    } catch (err) {
      setCall(null);
      // A space is only held for the parking timeout, so failing to reach one
      // means the caller went to voicemail — worth saying plainly.
      if (parked) toast.error('The call is no longer parked', 'It may have gone to voicemail already.');
      else toast.error('Call failed', err.message);
      sendPresence('idle', '');
    }
  };

  const placeCall = () => dialTarget(dial.trim());

  const answer = async () => {
    const line = lineRef.current;
    if (!line) return;
    setIncoming(false);
    try {
      line.answer();
    } catch (err) {
      toast.error('Could not answer', err.message);
    }
  };

  const decline = async () => {
    setIncoming(false);
    try {
      lineRef.current?.reject();
    } catch {
      /* already ended */
    }
    setCall(null);
    sessionRef.current = null;
    sendPresence('idle', '');
  };

  const toggleMute = () => {
    const next = !muted;
    lineRef.current?.setMuted(next);
    setMuted(next);
  };

  const toggleCamera = async () => {
    toast.info('Video is not available', 'A Cantus line carries 8 kHz audio on one socket; video needs a different standard.');
  };

  const shareScreen = async () => {
    toast.info('Screen sharing is not available', 'A Cantus line carries 8 kHz audio on one socket; screen share needs a different standard.');
  };

  const sendDtmf = async (digit) => {
    setDial((value) => (call ? value : value + digit));
    if (!call) return;
    // A keypress rides the same socket as the audio: one frame, no SIP INFO.
    lineRef.current?.sendDtmf(digit);
    wsRef.current?.send(JSON.stringify({ type: 'dtmf', digits: digit }));
  };

  /* ---------------------------------------------------------------- SCIF -- */

  // What this device can do, asked once. A phone with no face enrolled gets a
  // sentence saying so instead of a switch that fails when pressed.
  useEffect(() => {
    let canceled = false;
    biometry()
      .then((info) => {
        if (!canceled) setBiometryInfo(info);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);

  const biometryLabel = () => biometryInfo.label || 'Face ID';

  /** Recognize the person holding the phone, then bring the line up. */
  const unlockNow = async () => {
    const result = await unlockLine({ reason: 'Unlock this SCIF line' });
    if (!result.ok) {
      toast.error('Not unlocked', result.reason);
      return;
    }
    lockedRef.current = false;
    setLocked(false);
    toast.success(`Unlocked with ${methodLabel(result.method)}`, 'Bringing the line up…');
    connectRef.current?.({ auto: true });
  };

  /** Take the line down and require a face before it comes back. */
  const lockNow = async () => {
    lockedRef.current = true;
    setLocked(true);
    await disconnect();
    toast.info('Line locked', `${biometryLabel()} is required before it registers again.`);
  };

  /**
   * Turn the lock on or off for this install. Switching it on does not lock the
   * current call out — it applies to the next time the app opens, which is when
   * a lock is worth anything.
   */
  const setLockRequired = (value) => {
    setLockPolicy(saveLockPolicy({ required: value }));
    lockedRef.current = false;
    setLocked(false);
    toast.success(
      value ? `${biometryLabel()} required on open` : 'Biometric lock off',
      value ? 'The line stays down until a face is recognized.' : 'The line registers as soon as the app opens.'
    );
  };

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

  // Voice masking used to be a graph swapped into a peer connection's sender.
  // A Cantus line has its own capture graph (`cantus.js`), and that graph does
  // not yet take a mask — so this says so once per call instead of pretending.
  // The switch's side of SCIF (caller-ID withholding, no recording) is enforced
  // regardless; only the disguise itself is outstanding.
  useEffect(() => {
    if (!scif.enabled || scif.voiceMask === 'off' || call?.state !== 'incall') return undefined;
    toast.info(
      'Voice mask not applied',
      'The Cantus media graph does not carry a disguise yet. Caller ID is still withheld and nothing is recorded.'
    );
    return undefined;
  }, [scif.enabled, scif.voiceMask, call?.state, toast]);

  // SCIF refuses a call it cannot prove is protected. On a Cantus line the proof
  // is structural: the media shares the WebSocket the line registered on, so
  // there is no separate transport that could be plaintext. The badge is set on
  // registration, not negotiated after the answer.

  if (!status) return <Loading rows={4} />;

  const registered = regState === 'registered';
  const inCall = call?.state === 'incall' || call?.state === 'dialing';
  const switchUp = !!status.switch?.connected;

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
          value={secure === true ? 'Cantus / WSS' : '—'}
          foot={secure === true ? '8 kHz PCM on the signalling socket' : 'Set when the line registers'}
          tone={secure === true ? 'var(--success)' : undefined}
        />
        <Stat label="Signalling" value="WSS" foot={status.socketUrl} />
        <Stat
          label="NAT"
          value={status.switch?.connected ? 'Traversal always on' : 'Switch unreachable'}
          foot={
            status.switch?.connected
              ? `Relay registered${status.switch.node?.observed ? ` · ${status.switch.node.observed}` : ''}`
              : status.switch?.problem || 'No Cantus node has answered yet'
          }
          tone={status.switch?.connected ? undefined : 'var(--warning)'}
        />
      </div>

      {!switchUp ? (
        <Card title="The Cantus switch is not answering" subtitle="A line cannot register until it is">
          <p className="tiny muted">
            The console proxies this page's socket to the switch, so nothing here is a browser certificate
            problem. Start the switch (it is a service beside this one, at{' '}
            <code>{status.socketUrl}</code> behind the proxy) and check that <code>CANTUS_URL</code> names it.
            {status.switch?.problem ? ` Last error: ${status.switch.problem}.` : ''}
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

              {/*
                Locked: the dial controls are not rendered at all, rather than
                drawn and disabled. The line is not registered in this state, so
                there is nothing to dial and nothing that can ring.
              */}
              {locked ? (
                <div className="panel" style={{ padding: 14, borderColor: 'var(--accent)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <strong>Line locked</strong>
                      <p className="tiny dim" style={{ margin: '4px 0 0' }}>
                        This line stays down until {biometryLabel()} recognizes you. No session is minted in the
                        meantime, so nothing rings and nothing can be dialed.
                      </p>
                    </div>
                    <Button variant="primary" icon="shield" onClick={unlockNow}>
                      Unlock
                    </Button>
                  </div>
                </div>
              ) : (
                <>
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
                <span className="row" style={{ gap: 6, alignItems: 'center' }} title="Call volume">
                  <Icon name="volume" size={14} />
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.02"
                    value={volume}
                    onChange={(event) => setVolume(Number(event.target.value))}
                    aria-label="Call volume"
                    style={{ width: 96 }}
                  />
                </span>
                <Button
                  variant={sinkId ? 'primary' : 'ghost'}
                  icon="speaker"
                  onClick={toggleSpeaker}
                  disabled={!inCall || !(devices.outputs || []).length || typeof remoteAudioRef.current?.setSinkId !== 'function'}
                  title={
                    typeof remoteAudioRef.current?.setSinkId === 'function'
                      ? 'Route the call to another output device'
                      : 'This browser cannot choose an output device'
                  }
                >
                  Speaker
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
                </>
              )}

              <div className="softphone-stage">
                {/* Audio is its own element: volume and output device act on the call. */}
                <audio ref={remoteAudioRef} autoPlay playsInline />
                <video ref={remoteVideoRef} className="remote" autoPlay playsInline muted />
                <video ref={localVideoRef} className="local" autoPlay playsInline muted />
                {!call ? (
                  <div className="stage-hint">
                    <Icon name="phone" size={20} />
                    <span>Ready on {session.extension.extension}</span>
                    {outcome ? (
                      <span className="tiny" style={{ color: 'var(--danger)' }}>
                        Last call: {outcome.text}{outcome.code ? ` (${outcome.code})` : ''}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="stage-badge">
                    <Badge tone={call.state === 'incall' ? 'success' : 'warning'} dot={call.state === 'incall' ? 'live' : 'warn'}>
                      {call.state === 'incall'
                        ? fmtDuration(elapsed)
                        : call.state === 'ringing'
                          ? (call.direction === 'outbound' ? 'Ringing…' : 'Incoming')
                          : 'Dialing…'}
                    </Badge>
                    {call.direction === 'inbound' ? <Badge tone="info">inbound</Badge> : null}
                    {secure ? <Badge tone="success">Cantus / WSS</Badge> : null}
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
              <Switch
                checked={!!lockPolicy.required}
                label={`Require ${biometryLabel()} to unlock this line`}
                onChange={setLockRequired}
                disabled={!biometryInfo.supported}
              />
              {!biometryInfo.supported ? (
                <p className="tiny dim" style={{ margin: 0 }}>
                  {biometryInfo.reason ||
                    'Biometric unlock runs in the SCIF app on a phone with a face or fingerprint enrolled.'}
                </p>
              ) : biometricsInApp() ? (
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Button variant="ghost" size="sm" icon="shield" onClick={locked ? unlockNow : lockNow}>
                    {locked ? 'Unlock now' : 'Lock now'}
                  </Button>
                  <span className="tiny dim">
                    {locked ? 'This line is locked.' : `Locking takes the line down until ${biometryLabel()} passes.`}
                  </span>
                </div>
              ) : null}
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
