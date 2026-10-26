import { useCallback, useEffect, useRef, useState } from 'react';
import { api, prettyNumber } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, Select, Stat, Switch, useToast } from '../ui.jsx';
import { isSoftphoneWindow, openSoftphoneWindow } from '../softphoneWindow.js';

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
  const [extension, setExtension] = useState('');
  const [session, setSession] = useState(null);
  const [regState, setRegState] = useState('off');
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
  const [settings, setSettings] = useState({ video: true, micId: '', camId: '' });
  const [devices, setDevices] = useState({ mics: [], cams: [] });
  const [inbox, setInbox] = useState([]);

  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const localStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const constraintsRef = useRef({ audio: true, video: false });
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const startedAtRef = useRef(0);
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
        const [statusData, extData] = await Promise.all([api.get('/softphone/status'), api.get('/extensions')]);
        setStatus(statusData);
        const enabled = (extData.items || []).filter((row) => row.enabled !== false);
        setExtensions(enabled);
        if (enabled[0]) setExtension(String(enabled[0].extension));
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
          setInbox((list) => [
            `${message.extension} ${message.phase}${message.caller ? ` · ${message.caller}` : ''}`,
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
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current?.close();
  }, []);

  /* -------------------------------------------------------------- connect -- */

  const connect = async () => {
    if (!extension) return;
    setConnecting(true);
    setConnectError('');
    try {
      const data = await api.post('/softphone/session', { extension });

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
          onInvite: (invitation) => {
            attach(invitation);
            setCall({ state: 'ringing', direction: 'inbound', peer: invitation.remoteIdentity?.uri?.user || 'unknown' });
            setIncoming(true);
            sendPresence('ringing', invitation.remoteIdentity?.uri?.user || '');
            // Answer with the same media preferences as an outgoing call.
            constraintsRef.current = constraints;
          },
          onDisconnect: (error) => {
            setRegState('failed');
            setConnectError(error?.message || 'The switch closed the connection');
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
      setConnectError(
        explain(err, status) ||
          `Could not reach the switch at ${status?.wssUrl}. Check that port ${status?.wssPort || 8089} is published and the certificate is trusted.`
      );
      setRegState('failed');
      toast.error('Softphone could not connect', err?.message || 'The switch did not answer');
    } finally {
      setConnecting(false);
    }
  };

  /* ---------------------------------------------------------------- calls -- */

  const placeCall = async () => {
    const ua = uaRef.current;
    const target = dial.trim();
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
      toast.error('Call failed', err.message);
      sendPresence('idle', '');
      await inviter.dispose?.();
    });
  };

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
            Generate one by applying the configuration (Telephony → Apply config), or point
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
              </div>
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
              {connectError ? (
                <p className="tiny" style={{ color: 'var(--danger)' }}>
                  {connectError}
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

              <input
                className="input mono"
                style={{ fontSize: '1.125rem', letterSpacing: '.04em' }}
                value={dial}
                onChange={(e) => setDial(e.target.value.replace(/[^\d+*#]/g, ''))}
                placeholder="Number or extension"
                inputMode="tel"
                aria-label="Destination"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !inCall) placeCall();
                }}
              />

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
