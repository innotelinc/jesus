import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  Loading,
  Modal,
  PageHeader,
  Select,
  Stat,
  Textarea,
  Input,
  useToast,
} from '../ui.jsx';

const STATUS_TONE = { delivered: 'success', sent: 'info', received: 'info', queued: 'warning', failed: 'danger' };

export default function Messages() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ channel: 'sms', to: '', body: '' });

  const load = async () => {
    try {
      const data = await api.get(`/messages${channel ? `?channel=${channel}` : ''}`);
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load messages', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const send = async () => {
    setBusy('new');
    try {
      const data = await api.post('/messages', form);
      setItems((list) => [data.message, ...list]);
      load();
      setOpen(false);
      setForm({ channel: 'sms', to: '', body: '' });
      toast.success(
        'Message queued',
        data.provider === 'console' ? 'No SMS provider configured — it stays queued.' : `Handed to ${data.provider}.`
      );
    } catch (err) {
      toast.error('Could not queue the message', err.message);
    } finally {
      setBusy('');
    }
  };

  const retry = async (message) => {
    setBusy(message.id);
    try {
      const data = await api.patch(`/messages/${message.id}`, { status: 'queued' });
      setItems((list) => list.map((item) => (item.id === message.id ? data.message : item)));
      load();
      toast.success('Requeued');
    } catch (err) {
      toast.error('Could not requeue the message', err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHeader
        title="Messages"
        subtitle="SMS, MMS and WhatsApp on the same numbers as voice — delivery is never assumed"
        actions={<Button variant="primary" icon="message" onClick={() => setOpen(true)}>Compose</Button>}
      />

      <div className="grid stats">
        <Stat label="Outbound" value={summary?.sent ?? '—'} foot="Queued and sent" />
        <Stat label="Inbound" value={summary?.received ?? '—'} foot="Replies received" />
        <Stat label="Failed" value={summary?.failed ?? '—'} foot="Provider rejected" tone={summary?.failed ? 'var(--danger)' : undefined} />
        <Stat label="Provider" value={summary?.provider ?? '—'} foot="Verification channel" />
      </div>

      <Card
        title="Threads"
        bodyClass="tight"
        actions={
          <select className="select" style={{ width: 150 }} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Filter by channel">
            <option value="">All channels</option>
            <option value="sms">SMS</option>
            <option value="mms">MMS</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="web">Web</option>
          </select>
        }
      >
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={5} /></div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>Channel</th>
                  <th>Counterpart</th>
                  <th>Message</th>
                  <th>When</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((message) => (
                  <tr key={message.id}>
                    <td>
                      <Icon name={message.direction === 'inbound' ? 'arrowDown' : 'arrowUp'} size={13} />
                    </td>
                    <td><span className="tiny mono">{message.channel}</span></td>
                    <td className="tiny num nowrap">{message.direction === 'inbound' ? message.from : message.to}</td>
                    <td className="tiny" style={{ maxWidth: 420 }}>{message.body}</td>
                    <td className="tiny dim nowrap">{relativeTime(message.sentAt)}</td>
                    <td><Badge tone={STATUS_TONE[message.status] || 'neutral'}>{message.status}</Badge></td>
                    <td className="align-right">
                      {message.status === 'failed' ? (
                        <Button size="sm" variant="ghost" icon="refresh" loading={busy === message.id} onClick={() => retry(message)}>
                          Requeue
                        </Button>
                      ) : (
                        <span className="tiny dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="message" title="No messages" action={<Button variant="primary" onClick={() => setOpen(true)}>Compose one</Button>}>
            Outbound messages are queued and only marked delivered when a provider confirms it.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="Compose message"
          subtitle="Numbers resolve to the registry; unknown numbers create a row"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'new'} disabled={!form.to.trim() || !form.body.trim()} onClick={send}>
                Queue message
              </Button>
            </>
          }
        >
          <div className="stack">
            <Select label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="sms">SMS</option>
              <option value="mms">MMS</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="web">Web</option>
            </Select>
            <Input label="To" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="+1 415 555 0111" />
            <Textarea
              label="Body"
              rows={4}
              maxLength={1600}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              hint={`${form.body.length}/1600 characters`}
            />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
