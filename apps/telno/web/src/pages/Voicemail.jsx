import { useEffect, useRef, useState } from 'react';
import { api, duration, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Loading, PageHeader, Stat, Switch, useToast } from '../ui.jsx';

export default function Voicemail() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState('');
  const [uploadFor, setUploadFor] = useState('');
  const fileInput = useRef(null);

  const load = async () => {
    try {
      const data = await api.get(`/voicemails${unreadOnly ? '?unread=1' : ''}`);
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load voicemail', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadOnly]);

  const patch = async (message, body) => {
    setBusy(message.id);
    try {
      const data = await api.patch(`/voicemails/${message.id}`, body);
      setItems((list) => list.map((item) => (item.id === message.id ? data.voicemail : item)));
      load();
    } catch (err) {
      toast.error('Could not update the message', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (message) => {
    setBusy(message.id);
    try {
      await api.del(`/voicemails/${message.id}`);
      setItems((list) => list.filter((item) => item.id !== message.id));
      load();
      toast.success('Voicemail deleted');
    } catch (err) {
      toast.error('Could not delete the message', err.message);
    } finally {
      setBusy('');
    }
  };

  const pickAudio = (message) => {
    setUploadFor(message.id);
    fileInput.current?.click();
  };

  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !uploadFor) return;
    setBusy(uploadFor);
    try {
      await api.putFile(`/voicemails/${uploadFor}/audio`, file);
      toast.success('Audio attached', `${file.name} is now playable on this message.`);
      load();
    } catch (err) {
      toast.error('Could not attach the audio', err.message);
    } finally {
      setBusy('');
      setUploadFor('');
    }
  };

  return (
    <>
      <PageHeader
        title="Voicemail"
        subtitle="Messages recorded by extensions — listen here, transcripts come from the speech pass"
        actions={<Switch checked={unreadOnly} onChange={setUnreadOnly} label="Unread only" />}
      />

      <input ref={fileInput} type="file" accept="audio/*" hidden onChange={upload} aria-hidden="true" />

      <div className="grid stats">
        <Stat label="Unread" value={summary?.unread ?? '—'} foot={`${summary?.total ?? 0} stored`} tone={summary?.unread ? 'var(--accent)' : undefined} />
        <Stat label="Urgent" value={summary?.urgent ?? '—'} foot="Unread and flagged" tone={summary?.urgent ? 'var(--warning)' : undefined} />
        <Stat label="Minutes" value={summary?.minutes ?? '—'} foot="Total audio" />
        <Stat label="Mailboxes" value={new Set(items.map((item) => item.extension)).size} foot="Extensions with messages" />
      </div>

      {loading ? (
        <Card><Loading rows={4} /></Card>
      ) : items.length ? (
        <div className="stack">
          {items.map((message) => (
            <Card
              key={message.id}
              title={`${message.from || 'Unknown caller'} → ${message.extension}`}
              subtitle={`${duration(message.duration)} · ${relativeTime(message.receivedAt)}`}
              actions={
                <div className="row" style={{ gap: 6 }}>
                  {message.urgent ? <Badge tone="danger">Urgent</Badge> : null}
                  <Badge tone={message.listened ? 'neutral' : 'info'}>{message.listened ? 'Heard' : 'New'}</Badge>
                </div>
              }
            >
              <div className="stack">
                {message.recording ? (
                  <audio controls preload="none" src={message.audioUrl} style={{ width: '100%', height: 34 }} />
                ) : (
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="tiny dim">No audio stored for this message.</span>
                    <Button size="sm" variant="ghost" icon="paperclip" onClick={() => pickAudio(message)}>
                      Attach audio
                    </Button>
                  </div>
                )}
                <p className="tiny" style={{ lineHeight: 1.6 }}>
                  {message.transcript || <span className="dim">No transcript yet.</span>}
                </p>
                <div className="row wrap" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant={message.listened ? 'ghost' : 'primary'}
                    icon="check"
                    loading={busy === message.id}
                    onClick={() => patch(message, { listened: !message.listened })}
                  >
                    {message.listened ? 'Mark unread' : 'Mark heard'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="alert"
                    loading={busy === message.id}
                    onClick={() => patch(message, { urgent: !message.urgent })}
                  >
                    {message.urgent ? 'Clear urgent' : 'Flag urgent'}
                  </Button>
                  {message.recording ? (
                    <Button size="sm" variant="ghost" icon="paperclip" onClick={() => pickAudio(message)}>
                      Replace audio
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    loading={busy === message.id}
                    onClick={() => remove(message)}
                    aria-label="Delete voicemail"
                  />
                  <span className="tiny dim right mono">{message.fromE164}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="voicemail" title={unreadOnly ? 'No unread voicemail' : 'No voicemail yet'}>
            {unreadOnly ? 'Switch the filter off to see archived messages.' : 'Messages appear here when an extension does not answer.'}
          </Empty>
        </Card>
      )}
    </>
  );
}
