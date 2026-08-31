import { useCallback, useEffect, useRef, useState } from 'react';
import { Web } from 'sip.js';
import Button from '../components/Button';
import Input from '../components/Input';
import StatusBadge from '../components/StatusBadge';
import { dashboardBaseUrl } from '../lib/config';
import { cn } from '../lib/utils';

const { SimpleUser } = Web;

type RegState = 'idle' | 'connecting' | 'registered' | 'failed';
type CallState = 'idle' | 'calling' | 'ringing' | 'active' | 'held';

interface LogEntry {
  time: string;
  text: string;
  kind: 'info' | 'ok' | 'err';
}

const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

// StatusBadge derives its label from the status value — pick statuses whose
// built-in labels read correctly for each phone state.
function regBadge(state: RegState) {
  switch (state) {
    case 'registered': return <StatusBadge status="resolved" size="sm" />;   // “Healthy”
    case 'connecting': return <StatusBadge status="pending" size="sm" />;    // “Warning”
    case 'failed': return <StatusBadge status="escalated" size="sm" />;      // “Critical”
    default: return <StatusBadge status="offline" size="sm" />;              // “Critical”
  }
}

function callBadge(state: CallState) {
  switch (state) {
    case 'active': return <StatusBadge status="resolved" size="sm" />;       // “Healthy”
    case 'held': return <StatusBadge status="pending" size="sm" />;          // “Warning”
    case 'calling': return <StatusBadge status="pending" size="sm" />;       // “Warning”
    case 'ringing': return <StatusBadge status="warning" size="sm" />;       // “Warning”
    default: return <StatusBadge status="offline" size="sm" />;              // “Critical”
  }
}

export default function Softphone() {
  // Connection settings (defaults match the durable test extension 102 that
  // pbx/entrypoint-dograh.sh provisions on every boot).
  const defaultServer = typeof window !== 'undefined'
    ? `wss://${window.location.hostname}:8089/ws`
    : 'wss://localhost:8089/ws';
  const [server, setServer] = useState(defaultServer);
  const [extension, setExtension] = useState('102');
  const [password, setPassword] = useState('webrtc-test-102');

  const [regState, setRegState] = useState<RegState>('idle');
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteParty, setRemoteParty] = useState('');
  const [dialInput, setDialInput] = useState('');
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [incoming, setIncoming] = useState(false);

  const simpleUserRef = useRef<InstanceType<typeof SimpleUser> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callStateRef = useRef<CallState>('idle');
  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);

  const pushLog = useCallback((text: string, kind: LogEntry['kind'] = 'info') => {
    const t = new Date().toLocaleTimeString();
    setLog(prev => [{ time: t, text, kind }, ...prev].slice(0, 40));
  }, []);

  // Pull the real coturn STUN/TURN endpoints + creds from the aggregator
  // (reads the stack .env), so the browser's ICE config matches the PBX.
  useEffect(() => {
    if (!dashboardBaseUrl) return;
    fetch(`${dashboardBaseUrl}/turnconfig`)
      .then(r => (r.ok ? r.json() : null))
      .then((cfg: { stunServers?: RTCIceServer[]; turnServers?: RTCIceServer[] } | null) => {
        if (!cfg) return;
        const list = [...(cfg.stunServers ?? []), ...(cfg.turnServers ?? [])];
        if (list.length) {
          setIceServers(list);
          pushLog('Loaded STUN/TURN ICE config from aggregator', 'ok');
        }
      })
      .catch(() => { /* aggregator unavailable — fall back to defaults */ });
  }, [dashboardBaseUrl, pushLog]);

  // Keep a ref mirror of callState so async SIP.js callbacks read fresh state.
  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  const ensureSimpleUser = useCallback(() => {
    if (simpleUserRef.current) return simpleUserRef.current;
    const host = (() => {
      try { return new URL(server).hostname; } catch { return window.location.hostname; }
    })();
    const su = new SimpleUser(server, {
      aor: `sip:${extension}@${host}`,
      media: {
        constraints: { audio: true, video: false },
        remote: { audio: audioRef.current ?? undefined },
      },
      userAgentOptions: {
        authorizationUsername: extension,
        authorizationPassword: password,
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: iceServers.length
              ? iceServers
              : [{ urls: `stun:${host}:3478` }],
          },
        },
      },
      delegate: {
        onServerConnect: () => pushLog(`WebSocket connected to ${server}`, 'ok'),
        onServerDisconnect: (error?: Error) => {
          pushLog(`WebSocket disconnected${error ? ` — ${error.message}` : ''}`, 'err');
          setRegState('idle');
        },
        onRegistered: () => {
          setRegState('registered');
          pushLog(`Registered as ${extension}@${host}`, 'ok');
        },
        onUnregistered: () => {
          setRegState('idle');
          pushLog('Unregistered', 'info');
        },
        onCallReceived: () => {
          setIncoming(true);
          setCallState('ringing');
          pushLog(`Incoming call from ${remoteParty || 'unknown'}`, 'info');
        },
        onCallAnswered: () => {
          setIncoming(false);
          setCallState('active');
          setHeld(false);
          pushLog('Call answered — audio active', 'ok');
        },
        onCallHangup: () => {
          setIncoming(false);
          setCallState('idle');
          setHeld(false);
          setMuted(false);
          pushLog('Call ended', 'info');
        },
        onCallHold: (isHeld) => {
          setHeld(isHeld);
          setCallState(isHeld ? 'held' : 'active');
          pushLog(isHeld ? 'Call on hold' : 'Call resumed', 'info');
        },
        onCallDTMFReceived: (tone: string) => pushLog(`Received DTMF: ${tone}`, 'info'),
      },
    });
    simpleUserRef.current = su;
    return su;
  }, [server, extension, password, iceServers, pushLog]);

  const connectAndRegister = useCallback(async () => {
    try {
      const su = ensureSimpleUser();
      setRegState('connecting');
      pushLog(`Connecting to ${server}…`);
      await su.connect();
      await su.register();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRegState('failed');
      pushLog(`Registration failed: ${msg}`, 'err');
    }
  }, [ensureSimpleUser, server, pushLog]);

  const unregister = useCallback(async () => {
    const su = simpleUserRef.current;
    if (!su) { setRegState('idle'); return; }
    try {
      await su.unregister();
      await su.disconnect();
    } catch (e) {
      pushLog(`Unregister error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
    simpleUserRef.current = null;
    setRegState('idle');
  }, [pushLog]);

  const call = useCallback(async () => {
    const target = dialInput.trim().replace(/^sip:/i, '');
    if (!target) return;
    const su = ensureSimpleUser();
    if (!(await su.isConnected())) {
      try {
        await su.connect();
      } catch (e) {
        pushLog(`Connect failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
    }
    setRemoteParty(target);
    setCallState('calling');
    setIncoming(false);
    pushLog(`Calling ${target}…`);
    try {
      await su.call(target);
    } catch (e) {
      setCallState('idle');
      pushLog(`Call failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }, [dialInput, ensureSimpleUser, pushLog]);

  const answer = useCallback(async () => {
    const su = simpleUserRef.current;
    if (!su) return;
    try {
      await su.answer();
    } catch (e) {
      pushLog(`Answer failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }, [pushLog]);

  const decline = useCallback(async () => {
    const su = simpleUserRef.current;
    if (!su) return;
    try {
      await su.decline();
    } catch (e) {
      pushLog(`Decline failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
    setIncoming(false);
    setCallState('idle');
  }, [pushLog]);

  const hangup = useCallback(async () => {
    const su = simpleUserRef.current;
    if (!su) return;
    try {
      await su.hangup();
    } catch (e) {
      pushLog(`Hangup error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
    setCallState('idle');
  }, [pushLog]);

  const toggleMute = useCallback(() => {
    const su = simpleUserRef.current;
    if (!su) return;
    if (muted) { su.unmute(); setMuted(false); pushLog('Microphone unmuted', 'info'); }
    else { su.mute(); setMuted(true); pushLog('Microphone muted', 'info'); }
  }, [muted, pushLog]);

  const toggleHold = useCallback(async () => {
    const su = simpleUserRef.current;
    if (!su) return;
    try {
      if (held) await su.unhold();
      else await su.hold();
    } catch (e) {
      pushLog(`Hold error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }, [held, pushLog]);

  const sendDTMF = useCallback(async (tone: string) => {
    const su = simpleUserRef.current;
    if (!su) return;
    try {
      await su.sendDTMF(tone);
      pushLog(`Sent DTMF: ${tone}`, 'info');
    } catch { /* ignore — tone sent via INFO */ }
  }, [pushLog]);

  // Teardown the SIP UA when leaving the page.
  useEffect(() => {
    return () => {
      const su = simpleUserRef.current;
      if (su) {
        try { su.disconnect(); } catch { /* noop */ }
        simpleUserRef.current = null;
      }
    };
  }, []);

  const inCall = callState === 'active' || callState === 'held';
  const busy = callState !== 'idle' && callState !== 'ringing';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Softphone</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            In-browser WebRTC phone — registers as extension {extension} over WSS and can place
            and receive calls through the PBX.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {regState === 'registered' ? regBadge('registered') : regBadge(regState)}
          {callBadge(callState)}
        </div>
      </div>

      {/* Hidden audio element — SIP.js attaches the remote stream here. */}
      <audio ref={audioRef} autoPlay className="hidden" />

      <div className="grid gap-6 lg:grid-cols-5">
        {/* ── Connection panel ── */}
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Connection</h2>
            <div className="space-y-2">
              <label className="block text-sm font-medium">WSS server</label>
              <Input value={server} onChange={e => setServer(e.target.value)} placeholder="wss://host:8089/ws" spellCheck={false} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-sm font-medium">Extension</label>
                <Input value={extension} onChange={e => setExtension(e.target.value.replace(/\D/g, ''))} placeholder="102" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Password</label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="webrtc-test-102" />
              </div>
            </div>
            {regState === 'registered' ? (
              <Button variant="outline" className="w-full" onClick={unregister}>
                Unregister
              </Button>
            ) : (
              <Button className="w-full" onClick={connectAndRegister} disabled={regState === 'connecting'}>
                {regState === 'connecting' ? 'Connecting…' : 'Register'}
              </Button>
            )}
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Activity log</h2>
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
              {log.length === 0 && <p className="text-muted-foreground">No activity yet — register to begin.</p>}
              {log.map((entry, i) => (
                <div key={i} className={cn('flex gap-2', entry.kind === 'err' ? 'text-danger' : entry.kind === 'ok' ? 'text-success' : 'text-muted-foreground')}>
                  <span className="shrink-0">{entry.time}</span>
                  <span className="truncate">{entry.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Dialer + call controls ── */}
        <div className="space-y-4 lg:col-span-3">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Dial</h2>
              {remoteParty && (callState === 'calling' || callState === 'active' || callState === 'held') && (
                <span className="text-sm font-medium">{remoteParty}</span>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <Input
                value={dialInput}
                onChange={e => setDialInput(e.target.value.replace(/[^\d*#+]/g, ''))}
                placeholder="Number or extension (e.g. 101, 8000)"
                className="h-10 text-base font-mono"
                disabled={busy}
              />
              {!inCall && callState !== 'calling' && (
                <Button className="h-10 px-6" onClick={call} disabled={!dialInput || busy}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                  Call
                </Button>
              )}
              {(inCall || callState === 'calling') && (
                <Button variant="destructive" className="h-10 px-6" onClick={hangup}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                  Hang up
                </Button>
              )}
            </div>

            {/* Incoming call banner */}
            {incoming && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-warning">Incoming call from {remoteParty || 'unknown'}</div>
                  <div className="text-xs text-muted-foreground">Answer to start audio (DTLS-SRTP over the WSS session).</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={decline}>Decline</Button>
                  <Button size="sm" className="bg-success hover:bg-success/90" onClick={answer}>Answer</Button>
                </div>
              </div>
            )}

            {/* In-call controls */}
            {inCall && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3">
                <Button variant={muted ? 'default' : 'outline'} size="sm" onClick={toggleMute}>
                  {muted ? 'Unmute' : 'Mute'}
                </Button>
                <Button variant={held ? 'default' : 'outline'} size="sm" onClick={toggleHold}>
                  {held ? 'Resume' : 'Hold'}
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">DTMF keys send via INFO during the call</span>
              </div>
            )}

            {/* Dial pad */}
            <div className="mt-4 grid grid-cols-3 gap-2 sm:max-w-xs">
              {DIAL_KEYS.map(key => (
                <button
                  key={key}
                  disabled={!regState || busy}
                  onClick={() => {
                    if (inCall) { sendDTMF(key); return; }
                    setDialInput(prev => prev + key);
                  }}
                  className="flex h-12 items-center justify-center rounded-lg border bg-background text-base font-semibold transition-colors hover:bg-muted disabled:opacity-40"
                >
                  {key}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm text-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Notes</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>The PBX WSS endpoint uses the FreePBX integration certificate — if the browser refuses to connect (self-signed cert), open <span className="font-mono">{defaultServer}</span> in a new tab, accept the certificate warning, then re-register here.</li>
              <li>STUN/TURN come from the host coturn (fetched via the aggregator) so remote clients behind NAT get a working media path.</li>
              <li>Media (audio) uses DTLS-SRTP with ICE; STUN/TURN point at the host coturn, so remote WebRTC clients behind NAT work too.</li>
              <li>Only one WebRTC session at a time — start a second browser tab for extension 101 (password <span className="font-mono">101</span>) to call yourself.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
