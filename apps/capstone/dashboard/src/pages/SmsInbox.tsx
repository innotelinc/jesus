import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { api, type SmsInboxState, type SmsMessage } from '../lib/api';
import { markSmsRead } from '../lib/smsUnread';
import { cn } from '../lib/utils';

/**
 * The return path of the SMS node, as a workspace.
 *
 * Inbound replies arrive from the phone's poller (`POST /sms-inbound`, shared
 * secret) and are listed here; an answer leaves through the same phone
 * (`POST /sms-outbound`), never through `SMS_PROVIDER`, because the recipient
 * must see the SIM that wrote to them answer.
 *
 * The backend log is append-only and already in order, so conversations are
 * grouped in the order the phone reported and a reply lands at the end of its
 * thread without the page sorting timestamps whose timezone it cannot know.
 */

const POLL_MS = 15_000;

const directionOf = (message: SmsMessage): 'in' | 'out' =>
  message.direction === 'out' ? 'out' : 'in';

const peerOf = (message: SmsMessage): string =>
  (directionOf(message) === 'out' ? message.to : message.from) || '';

const timeOf = (message: SmsMessage): string =>
  message.received_at || message.sent_at || '';

interface Conversation {
  peer: string;
  messages: SmsMessage[];
  lastIndex: number;
}

export default function SmsInbox() {
  const [inbox, setInbox] = useState<SmsInboxState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setInbox(await api.smsInbox());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the SMS inbox');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const conversations = useMemo<Conversation[]>(() => {
    const grouped = new Map<string, Conversation>();
    (inbox?.messages ?? []).forEach((message, index) => {
      const peer = peerOf(message);
      if (!peer) return;
      const current = grouped.get(peer);
      if (current) {
        current.messages.push(message);
        current.lastIndex = index;
      } else {
        grouped.set(peer, { peer, messages: [message], lastIndex: index });
      }
    });
    return [...grouped.values()].sort((a, b) => b.lastIndex - a.lastIndex);
  }, [inbox]);

  const active = conversations.find(c => c.peer === selected) ?? conversations[0];
  const peers = conversations.map(c => c.peer).join(',');

  // A thread can disappear between polls (the log is bounded). Falling back to
  // the newest conversation is handled above; this clears a stale selection so
  // the reply goes to the thread actually on screen.
  useEffect(() => {
    if (selected && !peers.split(',').includes(selected)) setSelected(null);
  }, [peers, selected]);

  // A thread is read once it is the one on screen — that is what retracts the
  // sidebar badge. Keyed on the ids rather than the messages array, so the
  // fifteen-second poll writes nothing while the thread is unchanged.
  const activeInboundIds = (active?.messages ?? [])
    .filter(message => directionOf(message) === 'in' && message.id)
    .map(message => message.id)
    .join(',');

  useEffect(() => {
    if (activeInboundIds) markSmsRead(activeInboundIds.split(','));
  }, [activeInboundIds]);

  const send = async () => {
    if (!active || !draft.trim() || sending) return;
    setSending(true);
    setSendError('');
    setNotice('');
    try {
      const result = await api.sendSms(active.peer, draft.trim());
      setDraft('');
      setNotice(`Sent through the phone (${result.transport}).`);
      await load();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send the reply');
    } finally {
      setSending(false);
    }
  };

  const remaining = 1000 - draft.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SMS Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Replies the phone received, and answers sent back through it. Signs of life
            here mean the node&apos;s poller reached Capstone.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={sending}>
          Refresh
        </Button>
      </div>

      {inbox && !inbox.enabled && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Inbound forwarding is closed: <code className="rounded bg-background/60 px-1">CAPSTONE_SMS_INBOUND_TOKEN</code>{' '}
          is not set on the dashboard API, so the phone cannot deliver replies. Replies
          already delivered still list below.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !inbox ? (
        <div className="flex min-h-[30vh] items-center justify-center text-sm text-muted-foreground">
          Loading the inbox…
        </div>
      ) : conversations.length === 0 ? (
        <EmptyState
          title="No SMS yet"
          description={
            error
              ? 'The dashboard API could not be read. Fix the connection above and refresh.'
              : 'New replies appear here within a minute of reaching the phone. Send one from any handset and it will show up.'
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="rounded-2xl border bg-card p-2" aria-label="Conversations">
            <ul className="space-y-1">
              {conversations.map(conversation => {
                const last = conversation.messages[conversation.messages.length - 1];
                const isActive = active?.peer === conversation.peer;
                return (
                  <li key={conversation.peer}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(conversation.peer);
                        setSendError('');
                        setNotice('');
                      }}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'w-full rounded-xl px-3 py-2 text-left transition-colors',
                        isActive ? 'bg-primary/10' : 'hover:bg-muted',
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn('truncate text-sm font-medium', isActive && 'text-primary')}>
                          {conversation.peer}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {conversation.messages.length}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {directionOf(last) === 'out' ? 'You: ' : ''}
                        {last.body}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {active && (
            <div
              className="flex min-h-[420px] flex-col rounded-2xl border bg-card"
              aria-label={`Conversation with ${active.peer}`}
            >
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">{active.peer}</h2>
                  <p className="text-xs text-muted-foreground">
                    {active.messages.length} message{active.messages.length === 1 ? '' : 's'} in this thread
                  </p>
                </div>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  SMS
                </span>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 scrollbar-thin">
                {active.messages.map(message => {
                  const outbound = directionOf(message) === 'out';
                  return (
                    <div
                      key={message.id || `${peerOf(message)}-${message.body}`}
                      className={cn('flex flex-col', outbound ? 'items-end' : 'items-start')}
                    >
                      <div
                        className={cn(
                          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm',
                          outbound
                            ? 'border border-primary/20 bg-primary/10 text-foreground'
                            : 'bg-muted text-foreground',
                        )}
                      >
                        {message.body}
                      </div>
                      <span className="mt-1 text-[11px] text-muted-foreground">
                        {outbound ? 'Sent' : 'Received'}
                        {timeOf(message) ? ` · ${timeOf(message)}` : ''}
                        {outbound && message.transport ? ` · ${message.transport}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 border-t px-4 py-3">
                <label htmlFor="sms-reply" className="sr-only">
                  Reply to {active.peer}
                </label>
                <textarea
                  id="sms-reply"
                  rows={3}
                  value={draft}
                  onChange={event => {
                    setDraft(event.target.value);
                    setNotice('');
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={`Reply to ${active.peer}…`}
                  className="flex w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {sendError && (
                  <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
                    {sendError}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {notice || 'Sent from this phone’s SIM — Ctrl/⌘ + Enter sends.'}
                    {remaining < 0 && ' · too long'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{draft.length}/1000</span>
                    <Button
                      size="sm"
                      onClick={() => void send()}
                      disabled={sending || !draft.trim() || remaining < 0}
                    >
                      {sending ? 'Sending…' : 'Send reply'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
