import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/Button';
import Input from '../components/Input';
import { CantusLine, type LineCall } from '../lib/cantusLine';
import { cn } from '../lib/utils';

type RegState = 'idle' | 'connecting' | 'registered' | 'failed';
type CallState = 'idle' | 'calling' | 'ringing' | 'active' | 'held';

interface LogEntry {
  time: string;
  text: string;
  kind: 'info' | 'ok' | 'err';
}

const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

// Phone-specific status chips. An idle phone is *not* an error — a generic
// StatusBadge would have shown two “Critical” chips for a phone that simply
// hasn't registered yet.
function RegChip({ state }: { state: RegState }) {
  const styles: Record<RegState, string> = {
    idle: 'border-muted-foreground/30 text-muted-foreground',
    connecting: 'border-warning/40 text-warning',
    registered: 'border-success/40 text-success',
    failed: 'border-danger/40 text-danger',
  };
  const labels: Record<RegState, string> = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    registered: 'Connected',
    failed: 'Not connected',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', styles[state])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {labels[state]}
    </span>
  );
}

function CallChip({ state }: { state: CallState }) {
  if (state === 'idle') return null;
  const styles: Record<Exclude<CallState, 'idle'>, string> = {
    calling: 'border-warning/40 text-warning',
    ringing: 'border-warning/40 text-warning',
    active: 'border-success/40 text-success',
    held: 'border-info/40 text-info',
  };
  const labels: Record<Exclude<CallState, 'idle'>, string> = {
    calling: 'Calling…',
    ringing: 'Ringing',
    active: 'On call',
    held: 'On hold',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', styles[state])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {labels[state]}
    </span>
  );
}

function fromLineCall(call: LineCall | null): CallState {
  if (!call) return 'idle';
  if (call.held) return 'held';
  if (call.state === 'ringing') return 'ringing';
  if (call.state === 'dialing') return 'calling';
  if (call.state === 'active') return 'active';
  return 'idle';
}

export default function Softphone() {
  // Connection settings. The socket is same-origin by default: this dashboard's
  // proxy forwards /ws to the voice plane's line socket, so the browser reuses
  // the certificate it already trusts and there is nothing to open in a
  // firewall. An absolute ws:// or wss:// URL is accepted instead, for a
  // console served without the proxy.
  const [socketPath, setSocketPath] = useState('/ws');
  const [extension, setExtension] = useState('101');
  // Only a deployment whose platform mints per-socket tickets needs this.
  const [ticket, setTicket] = useState('');

  const [regState, setRegState] = useState<RegState>('idle');
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteParty, setRemoteParty] = useState('');
  const [dialInput, setDialInput] = useState('');
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [incoming, setIncoming] = useState(false);
  const [failure, setFailure] = useState('');

  const lineRef = useRef<CantusLine | null>(null);
  const autoStartedRef = useRef(false);

  const pushLog = useCallback((text: string, kind: LogEntry['kind'] = 'info') => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [{ time: t, text, kind }, ...prev].slice(0, 40));
  }, []);

  const attach = useCallback((line: CantusLine) => {
    line.on('state', ({ state, displayName, reason }) => {
      if (state === 'registered') {
        setRegState('registered');
        setFailure('');
        setSocketPath(line.socketPath);
        setExtension(line.ext);
        pushLog(`Line ${line.ext}${displayName ? ` (${displayName})` : ''} is on the voice plane`, 'ok');
        return;
      }
      if (state === 'registering') {
        setRegState('connecting');
        pushLog(`Opening ${line.url}`);
        return;
      }
      if (state === 'failed') {
        setRegState('failed');
        setFailure(reason || 'the voice plane closed the line');
        pushLog(`Line closed: ${reason || 'no reason given'}`, 'err');
        setCallState('idle');
        setIncoming(false);
        setHeld(false);
        return;
      }
      setRegState('idle');
      setFailure('');
    });

    line.on('call', (call) => {
      setRemoteParty(call.remote);
      setCallState(fromLineCall(call));
      setIncoming(call.state === 'ringing');
      pushLog(
        call.state === 'ringing' ? `Incoming call from ${call.remote}` : `Calling ${call.remote}…`,
        'info',
      );
    });

    line.on('held', ({ held: onHold }) => {
      setHeld(onHold);
      setCallState((prev) => (prev === 'idle' ? prev : onHold ? 'held' : 'active'));
      pushLog(onHold ? 'Call on hold — the other party hears hold music' : 'Call resumed', 'info');
    });

    line.on('ended', ({ reason }) => {
      setCallState('idle');
      setIncoming(false);
      setHeld(false);
      setMuted(false);
      line.setMuted(false);
      setRemoteParty('');
      pushLog(`Call ended (${reason})`, 'info');
    });

    line.on('error', ({ error, message }) => {
      // The voice plane's own refusal, e.g. holding a call it cannot hold.
      setFailure(message);
      pushLog(`${error}: ${message}`, 'err');
    });
  }, [pushLog]);

  const connect = useCallback(async () => {
    if (lineRef.current) return lineRef.current;
    const line = new CantusLine({ socketPath, ext: extension, ticket });
    attach(line);
    lineRef.current = line;
    setRegState('connecting');
    try {
      await line.start();
    } catch (err) {
      lineRef.current = null;
      setRegState('failed');
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      pushLog(`Could not open the line: ${message}`, 'err');
      return null;
    }
    return line;
  }, [attach, socketPath, extension, ticket, pushLog]);

  const disconnect = useCallback(() => {
    lineRef.current?.stop();
    lineRef.current = null;
    setRegState('idle');
    setCallState('idle');
    setIncoming(false);
    setHeld(false);
    setRemoteParty('');
    pushLog('Line closed', 'info');
  }, [pushLog]);

  // Connect automatically on load, so the phone is live as soon as an operator
  // opens the page; the button is for reconnecting after a drop.
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const timer = window.setTimeout(() => { void connect(); }, 250);
    return () => window.clearTimeout(timer);
  }, [connect]);

  // One line per page: leaving the page closes the socket, which ends any call
  // that line was on rather than leaving a leg the voice plane keeps feeding.
  useEffect(() => () => {
    lineRef.current?.stop();
    lineRef.current = null;
  }, []);

  const dial = useCallback(async () => {
    const target = dialInput.trim();
    if (!target) return;
    const line = lineRef.current ?? (await connect());
    if (!line) return;
    setRemoteParty(target);
    setCallState('calling');
    try {
      await line.dial(target);
    } catch (err) {
      setCallState('idle');
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      pushLog(`Call failed: ${message}`, 'err');
    }
  }, [dialInput, connect, pushLog]);

  const answer = useCallback(async () => {
    try {
      await lineRef.current?.answer();
      setIncoming(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      pushLog(`Answer failed: ${message}`, 'err');
    }
  }, [pushLog]);

  const decline = useCallback(() => {
    lineRef.current?.hangup();
    setIncoming(false);
    setCallState('idle');
    setRemoteParty('');
  }, []);

  const hangup = useCallback(() => {
    lineRef.current?.hangup();
    setCallState('idle');
    setIncoming(false);
    setHeld(false);
    setRemoteParty('');
  }, []);

  const toggleMute = useCallback(() => {
    const line = lineRef.current;
    if (!line) return;
    const next = !muted;
    line.setMuted(next);
    setMuted(next);
    pushLog(next ? 'Microphone muted' : 'Microphone unmuted', 'info');
  }, [muted, pushLog]);

  const toggleHold = useCallback(() => {
    const line = lineRef.current;
    if (!line) return;
    // `held` is the voice plane's answer, so this asks for the opposite of what
    // the switch last said rather than of what the button last showed.
    if (held) line.unhold();
    else line.hold();
  }, [held]);

  const sendDTMF = useCallback((tone: string) => {
    lineRef.current?.sendDtmf(tone);
    pushLog(`Sent DTMF: ${tone}`, 'info');
  }, [pushLog]);

  const inCall = callState === 'active' || callState === 'held';
  const busy = callState !== 'idle' && callState !== 'ringing';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Softphone</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            In-browser line on the Cantus voice plane — connects as extension {extension}, dials and
            answers over one socket, and carries 20 ms frames of 8 kHz audio with no SIP, ICE or TURN
            in the path.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RegChip state={regState} />
          <CallChip state={callState} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* ── Connection panel ── */}
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-2xl border bg-card p-4 shadow-sm space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Connection</h2>
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="line-socket">Line socket</label>
              <Input
                id="line-socket"
                value={socketPath}
                onChange={(e) => setSocketPath(e.target.value)}
                placeholder="/ws"
                spellCheck={false}
                disabled={regState === 'registered'}
              />
              <p className="text-xs text-muted-foreground">
                Same-origin path, or a full ws:// or wss:// URL when this console is served without the
                proxy.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="line-ext">Extension</label>
                <Input
                  id="line-ext"
                  value={extension}
                  onChange={(e) => setExtension(e.target.value.replace(/\D/g, ''))}
                  placeholder="101"
                  disabled={regState === 'registered'}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="line-ticket">Ticket</label>
                <Input
                  id="line-ticket"
                  type="password"
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                  placeholder="optional"
                  disabled={regState === 'registered'}
                />
              </div>
            </div>
            {failure && regState !== 'registered' && (
              <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{failure}</p>
            )}
            {regState === 'registered' ? (
              <Button variant="outline" className="w-full" onClick={disconnect}>
                Disconnect
              </Button>
            ) : (
              <Button className="w-full" onClick={() => { void connect(); }} disabled={regState === 'connecting'}>
                {regState === 'connecting' ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </div>

          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Activity log</h2>
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
              {log.length === 0 && <p className="text-muted-foreground">No activity yet — the line connects on load.</p>}
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
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Dial</h2>
              {remoteParty && (callState === 'calling' || callState === 'active' || callState === 'held') && (
                <span className="text-sm font-medium">{remoteParty}</span>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <Input
                value={dialInput}
                onChange={(e) => setDialInput(e.target.value.replace(/[^\d*#+]/g, ''))}
                placeholder="Number or extension (e.g. 101, 8000)"
                className="h-10 text-base font-mono"
                disabled={busy}
              />
              {!inCall && callState !== 'calling' && (
                <Button className="h-10 px-6" onClick={() => { void dial(); }} disabled={!dialInput || busy || regState !== 'registered'}>
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
                  <div className="text-xs text-muted-foreground">Answer to start audio on this line.</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={decline}>Decline</Button>
                  <Button size="sm" className="bg-success hover:bg-success/90" onClick={() => { void answer(); }}>Answer</Button>
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
                <span className="ml-auto text-xs text-muted-foreground">
                  {held ? 'The caller is hearing hold music' : 'DTMF keys send during the call'}
                </span>
              </div>
            )}

            {/* Dial pad */}
            <div className="mt-4 grid grid-cols-3 gap-2 sm:max-w-xs">
              {DIAL_KEYS.map((key) => (
                <button
                  key={key}
                  disabled={regState !== 'registered' || busy}
                  onClick={() => {
                    if (inCall) { sendDTMF(key); return; }
                    setDialInput((prev) => prev + key);
                  }}
                  className="flex h-12 items-center justify-center rounded-lg border bg-background text-base font-semibold transition-colors hover:bg-muted disabled:opacity-40"
                >
                  {key}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-4 shadow-sm text-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Notes</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>The line connects on load to <span className="font-mono">{socketPath}</span>, which this console proxies to the voice plane's line socket. Nothing else has to be reachable from the browser.</li>
              <li>Hold is a change in what each side hears, not a second call: the caller gets hold music and this handset hears silence, so resuming always returns the same conversation.</li>
              <li>The microphone is opened on the first call or answer, not on registration — an operator watching a line is never met by a permission prompt.</li>
              <li>There is no SDP, no ICE candidate pair and no TURN allocation, so a call either has a path or the switch says why it does not.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
