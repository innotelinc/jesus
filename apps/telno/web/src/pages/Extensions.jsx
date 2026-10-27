import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
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

export default function Extensions() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/extensions');
      setItems(data.items);
    } catch (err) {
      toast.error('Could not load extensions', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (row, field, value) => {
    try {
      await api.patch(`/extensions/${row.id}`, { [field]: value });
      load();
    } catch (err) {
      toast.error('Update failed', err.message);
    }
  };

  const rotate = async (row) => {
    try {
      const result = await api.post(`/extensions/${row.id}/rotate-secret`, {});
      setSecret({ extension: row.extension, secret: result.secret });
      load();
    } catch (err) {
      toast.error('Could not rotate secret', err.message);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete extension ${row.extension}?`)) return;
    try {
      await api.del(`/extensions/${row.id}`);
      toast.success('Extension deleted');
      load();
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Extensions"
        subtitle="SIP endpoints generated into pjsip.conf as they are saved"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New extension
          </Button>
        }
      />

      <Card bodyClass="tight">
        {loading ? (
          <div style={{ padding: 16 }}>
            <Loading rows={4} />
          </div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ext</th>
                  <th>Name</th>
                  <th>Direct number</th>
                  <th>Voicemail</th>
                  <th>DND</th>
                  <th>Forward to</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{row.extension}</td>
                    <td>
                      <div className="truncate">{row.displayName}</div>
                      {row.email ? <div className="tiny dim truncate">{row.email}</div> : null}
                    </td>
                    <td className="num tiny nowrap">
                      {row.number || <span className="dim">—</span>}
                    </td>
                    <td>
                      <Switch checked={row.voicemail} onChange={(value) => toggle(row, 'voicemail', value)} label="" />
                    </td>
                    <td>
                      <Switch checked={row.dnd} onChange={(value) => toggle(row, 'dnd', value)} label="" />
                    </td>
                    <td className="tiny mono">{row.forwardTo || <span className="dim">—</span>}</td>
                    <td>
                      <Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'active' : 'disabled'}</Badge>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(row, 'enabled', !row.enabled)}
                          title={row.enabled ? 'Disable' : 'Enable'}
                        >
                          {row.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button size="sm" variant="ghost" icon="key" onClick={() => rotate(row)} title="Rotate SIP secret" />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() => remove(row)}
                          aria-label={`Delete extension ${row.extension}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="users" title="No extensions yet">
            Create one to generate a SIP endpoint and voicemail box.
          </Empty>
        )}
      </Card>

      <p className="tiny dim">
        Saving an extension writes <span className="mono">pjsip.conf</span> and reloads the switch straight
        away — there is no apply step, and a change is live the moment it is saved.
      </p>

      {creating ? (
        <CreateExtension
          onClose={() => setCreating(false)}
          onSaved={(result) => {
            load();
            setSecret({ extension: result.extension.extension, secret: result.secret });
          }}
        />
      ) : null}

      {secret ? (
        <Modal title="SIP credentials" subtitle={`Extension ${secret.extension} — shown once`} onClose={() => setSecret(null)}>
          <p className="tiny muted">
            Configure the device with these credentials. The secret is stored hashed-in-config on the switch and is
            not retrievable later; rotate it if it leaks.
          </p>
          <div className="panel stack" style={{ gap: 8 }}>
            <div className="row">
              <span className="tiny dim" style={{ width: 90 }}>Username</span>
              <span className="mono">{secret.extension}</span>
            </div>
            <div className="row">
              <span className="tiny dim" style={{ width: 90 }}>Password</span>
              <span className="mono truncate">{secret.secret}</span>
              <Button
                size="sm"
                variant="ghost"
                icon="copy"
                className="right"
                onClick={() => {
                  navigator.clipboard?.writeText(`${secret.extension}:${secret.secret}`);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function CreateExtension({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ extension: '', displayName: '', email: '', number: '', voicemail: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/extensions', form);
      toast.success('Extension created', `Assign ${result.extension.extension} to a device`);
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New extension"
      subtitle="A SIP endpoint, voicemail box and optional DID"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Create</Button>
        </>
      }
    >
      <div className="grid two" style={{ gap: 12 }}>
        <Input
          label="Extension"
          value={form.extension}
          onChange={(event) => setForm({ ...form, extension: event.target.value })}
          placeholder="108"
          className="mono"
          hint="2–6 digits"
          autoFocus
        />
        <Input
          label="Display name"
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
          placeholder="Front desk"
        />
        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          placeholder="desk@example.com"
          hint="Voicemail notifications"
        />
        <Input
          label="Direct number"
          value={form.number}
          onChange={(event) => setForm({ ...form, number: event.target.value })}
          placeholder="+1 415 555 0123"
          className="mono"
          hint="Optional — links a registry row"
        />
      </div>
      <Switch
        checked={form.voicemail}
        onChange={(value) => setForm({ ...form, voicemail: value })}
        label="Create a voicemail box"
      />
      {error ? <p className="tiny" style={{ color: 'var(--danger)' }}>{error}</p> : null}
    </Modal>
  );
}
