import { useCallback, useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  Input,
  Loading,
  Modal,
  PageHeader,
  Switch,
  useToast,
} from '../ui.jsx';

export default function Trunks() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/trunks');
      setItems(data.items);
    } catch (err) {
      toast.error('Could not load trunks', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (row, value) => {
    try {
      await api.patch(`/trunks/${row.id}`, { enabled: value });
      load();
    } catch (err) {
      toast.error('Update failed', err.message);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete trunk “${row.name}”? Outbound calls will fail until another trunk is enabled.`)) return;
    try {
      await api.del(`/trunks/${row.id}`);
      toast.success('Trunk deleted');
      load();
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Trunks"
        subtitle="Registrations, codecs and inbound context per carrier"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Add trunk
          </Button>
        }
      />

      {loading ? (
        <Loading rows={3} />
      ) : items.length ? (
        <div className="grid two">
          {items.map((trunk) => (
            <Card
              key={trunk.id}
              title={trunk.name}
              subtitle={`${trunk.provider} · ${trunk.host}`}
              actions={
                <Badge tone={trunk.enabled ? 'success' : 'neutral'}>{trunk.enabled ? 'enabled' : 'disabled'}</Badge>
              }
            >
              <dl className="kv">
                <dt>Username</dt>
                <dd className="mono">{trunk.username || '—'}</dd>
                <dt>Codecs</dt>
                <dd className="mono">{trunk.codecs}</dd>
                <dt>Context</dt>
                <dd className="mono">{trunk.context}</dd>
                <dt>Secret</dt>
                <dd>{trunk.hasSecret ? 'stored' : 'not set'}</dd>
                <dt>Updated</dt>
                <dd>{relativeTime(trunk.updatedAt)}</dd>
              </dl>
              <div className="row" style={{ marginTop: 14 }}>
                <Switch checked={trunk.enabled} onChange={(value) => toggle(trunk, value)} label="Enabled" />
                <div className="spacer" />
                <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(trunk)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="server" title="No trunks configured" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add the first trunk</Button>}>
            Without a trunk the switch can still register internal extensions, but outbound calls will fail.
          </Empty>
        </Card>
      )}

      {creating ? <CreateTrunk onClose={() => setCreating(false)} onSaved={load} /> : null}
    </>
  );
}

function CreateTrunk({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    provider: 'generic',
    host: '',
    username: '',
    secret: '',
    fromUser: '',
    codecs: 'ulaw,alaw',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/trunks', form);
      toast.success('Trunk added', 'Apply config to register it with the switch');
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add trunk"
      subtitle="Registration details for your carrier"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Save trunk</Button>
        </>
      }
    >
      <div className="grid two" style={{ gap: 12 }}>
        <Input
          label="Name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="primary"
          hint="Letters, digits, dot, dash"
          autoFocus
        />
        <Input
          label="Provider"
          value={form.provider}
          onChange={(event) => setForm({ ...form, provider: event.target.value })}
          placeholder="generic"
        />
        <Input
          label="Host"
          value={form.host}
          onChange={(event) => setForm({ ...form, host: event.target.value })}
          placeholder="sip.carrier.com"
          className="mono"
        />
        <Input
          label="Username"
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          placeholder="trunk-user"
          className="mono"
        />
        <Input
          label="Secret"
          type="password"
          value={form.secret}
          onChange={(event) => setForm({ ...form, secret: event.target.value })}
          placeholder="••••••••"
          autoComplete="new-password"
        />
        <Input
          label="From user"
          value={form.fromUser}
          onChange={(event) => setForm({ ...form, fromUser: event.target.value })}
          placeholder="optional"
          className="mono"
        />
        <Input
          label="Codecs"
          value={form.codecs}
          onChange={(event) => setForm({ ...form, codecs: event.target.value })}
          placeholder="ulaw,alaw"
          className="mono"
        />
      </div>
      {error ? <p className="tiny" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      <p className="tiny dim">
        <Icon name="shield" size={12} /> Secrets live in the database and are written into manager-only config on
        apply; the API never returns them.
      </p>
    </Modal>
  );
}
