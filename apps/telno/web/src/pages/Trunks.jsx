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
  Select,
  Switch,
  useToast,
} from '../ui.jsx';

/**
 * Where a carrier wants to be dialled, without making an operator look it up.
 *
 * The POP is not cosmetic: it is the nearest of the carrier's media servers, and
 * picking the far one adds a coast of latency to every call. The list is the
 * carrier's own, short enough to choose from rather than type.
 */
const VOIPMS_POPS = [
  ['atlanta', 'Atlanta'],
  ['chicago', 'Chicago'],
  ['dallas', 'Dallas'],
  ['denver', 'Denver'],
  ['houston', 'Houston'],
  ['losangeles', 'Los Angeles'],
  ['miami', 'Miami'],
  ['newyork', 'New York'],
  ['seattle', 'Seattle'],
  ['tampa', 'Tampa'],
  ['washington', 'Washington'],
  ['montreal', 'Montreal'],
  ['toronto', 'Toronto'],
  ['vancouver', 'Vancouver'],
];

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
  const [kind, setKind] = useState('voipms');
  const [pop, setPop] = useState('atlanta');
  const [form, setForm] = useState({
    name: 'voip.ms',
    provider: 'voipms',
    host: 'atlanta.voip.ms',
    username: '',
    secret: '',
    fromUser: '',
    codecs: 'ulaw,alaw',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** The preset fills what the carrier documents; the operator fills what only
   *  they know. Switching back to generic leaves their typing alone. */
  const chooseKind = (value) => {
    setKind(value);
    if (value === 'voipms') {
      setForm((current) => ({
        ...current,
        name: current.name || 'voip.ms',
        provider: 'voipms',
        host: `${pop}.voip.ms`,
        codecs: 'ulaw,alaw',
      }));
    } else {
      setForm((current) => ({ ...current, provider: 'generic' }));
    }
  };

  const choosePop = (value) => {
    setPop(value);
    setForm((current) => ({ ...current, host: `${value}.voip.ms` }));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      // VoIP.ms authenticates the outbound call as the account or sub-account,
      // so the From user is the username unless an operator says otherwise.
      const payload = { ...form, fromUser: form.fromUser || (kind === 'voipms' ? form.username : '') };
      const result = await api.post('/trunks', payload);
      toast.success(
        'Trunk added',
        result.applied?.error
          ? `Saved, but the switch did not reload: ${result.applied.error}`
          : 'Written to pjsip.conf and registered with the switch'
      );
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
        <Select label="Carrier" value={kind} onChange={(event) => chooseKind(event.target.value)}>
          <option value="voipms">VoIP.ms — fill the rest in</option>
          <option value="generic">Another carrier — I know the details</option>
        </Select>
        <Input
          label="Name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="primary"
          hint="Letters, digits, dot, dash"
          autoFocus
        />
        {kind === 'voipms' ? (
          <Select label="Media server (POP)" value={pop} onChange={(event) => choosePop(event.target.value)}>
            {VOIPMS_POPS.map(([value, label]) => (
              <option key={value} value={value}>{label} — {value}.voip.ms</option>
            ))}
          </Select>
        ) : (
          <Input
            label="Provider"
            value={form.provider}
            onChange={(event) => setForm({ ...form, provider: event.target.value })}
            placeholder="generic"
          />
        )}
        <Input
          label="Host"
          value={form.host}
          onChange={(event) => setForm({ ...form, host: event.target.value })}
          placeholder="sip.carrier.com"
          className="mono"
          hint={kind === 'voipms' ? 'Set by the POP above; edit it if the carrier moved you' : undefined}
        />
        <Input
          label="Username"
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          placeholder={kind === 'voipms' ? '100001' : 'trunk-user'}
          className="mono"
          hint={
            kind === 'voipms'
              ? 'The main account (6 digits) or a sub-account such as 100001_telno'
              : undefined
          }
        />
        <Input
          label="Secret"
          type="password"
          value={form.secret}
          onChange={(event) => setForm({ ...form, secret: event.target.value })}
          placeholder="••••••••"
          autoComplete="new-password"
          hint={
            kind === 'voipms'
              ? 'The SIP password for that account — Main Menu → Sub Accounts, not the portal password'
              : undefined
          }
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
