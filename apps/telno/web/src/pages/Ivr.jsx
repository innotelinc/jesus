import { useCallback, useEffect, useState } from 'react';
import { api, prettyNumber } from '../api.js';
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

const blankOption = () => ({ digit: '', target: '', label: '' });

export default function Ivr() {
  const toast = useToast();
  const [flows, setFlows] = useState([]);
  const [extensions, setExtensions] = useState([]);
  const [dids, setDids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [ivr, exts, numbers] = await Promise.all([
        api.get('/ivr'),
        api.get('/extensions'),
        api.get('/numbers?limit=50&status=active'),
      ]);
      setFlows(ivr.items);
      setExtensions(exts.items);
      setDids(numbers.items.filter((n) => n.extension));
    } catch (err) {
      toast.error('Could not load routing', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (flow) => {
    if (!window.confirm(`Delete the “${flow.name}” menu?`)) return;
    try {
      await api.del(`/ivr/${flow.id}`);
      toast.success('Menu deleted');
      load();
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Call routing"
        subtitle="Inbound DIDs, menus and destinations generated into extensions.conf"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing({})}>
            New menu
          </Button>
        }
      />

      <div className="grid two">
        <Card title="Inbound DIDs" subtitle="A registry number assigned to an extension rings it directly" bodyClass="tight">
          {dids.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Rings</th>
                    <th>Entity</th>
                  </tr>
                </thead>
                <tbody>
                  {dids.map((did) => (
                    <tr key={did.id}>
                      <td className="num tiny nowrap">{did.display || prettyNumber(did.e164)}</td>
                      <td className="mono tiny">{did.extension}</td>
                      <td className="tiny muted truncate" style={{ maxWidth: 160 }}>{did.name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="numbers" title="No DIDs mapped">
              Assign a number to an extension in the registry to route inbound calls.
            </Empty>
          )}
        </Card>

        <Card title="How it resolves" subtitle="Generated dialplan, in order">
          <ol className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0, fontSize: '0.8125rem' }}>
            <li className="muted">Inbound call lands in <span className="mono">from-trunk</span>.</li>
            <li className="muted">The number is looked up in <span className="mono">registry</span>.</li>
            <li className="muted">A match rings its extension; a menu plays its prompt.</li>
            <li className="muted">No match answers with <span className="mono">ss-noservice</span>.</li>
          </ol>
          <p className="tiny dim" style={{ marginTop: 12 }}>
            Everything above is generated from this database — there is no separate dialplan to maintain.
          </p>
        </Card>
      </div>

      {loading ? (
        <Loading rows={3} />
      ) : flows.length ? (
        <div className="grid two">
          {flows.map((flow) => (
            <Card
              key={flow.id}
              title={flow.name}
              subtitle={`Ext ${flow.extension}`}
              actions={<Badge tone={flow.enabled ? 'success' : 'neutral'}>{flow.enabled ? 'live' : 'disabled'}</Badge>}
            >
              <p className="tiny muted" style={{ marginBottom: 10 }}>{flow.greeting}</p>
              <div className="stack" style={{ gap: 5 }}>
                {flow.options.length ? (
                  flow.options.map((option) => (
                    <div key={option.digit} className="row tiny" style={{ gap: 8 }}>
                      <span className="badge accent mono">{option.digit}</span>
                      <span className="truncate">{option.label || `Extension ${option.target}`}</span>
                      <Icon name="chevron" size={11} className="right dim" />
                      <span className="mono dim">{option.target}</span>
                    </div>
                  ))
                ) : (
                  <p className="tiny dim">No options — callers hear the greeting and time out.</p>
                )}
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(flow)}>Edit</Button>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(flow)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="branch" title="No menus yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing({})}>Create a menu</Button>}>
            A menu answers a number, plays a prompt and routes each digit to an extension.
          </Empty>
        </Card>
      )}

      {editing ? (
        <FlowDialog
          flow={editing}
          extensions={extensions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            load();
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function FlowDialog({ flow, extensions, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: flow.name || '',
    extension: flow.extension || '',
    greeting: flow.greeting || 'Thanks for calling. Press 1 for sales, 2 for support.',
    timeoutDest: flow.timeoutDest || '',
    enabled: flow.enabled ?? true,
    options: flow.options?.length ? flow.options : [blankOption()],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setOption = (index, patch) => {
    const options = form.options.map((option, i) => (i === index ? { ...option, ...patch } : option));
    setForm({ ...form, options });
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = { ...form, options: form.options.filter((option) => option.digit && option.target) };
      if (flow.id) await api.patch(`/ivr/${flow.id}`, payload);
      else await api.post('/ivr', payload);
      toast.success(flow.id ? 'Menu updated' : 'Menu created');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={flow.id ? `Edit ${flow.name}` : 'New call menu'}
      subtitle="Digits map to extensions or other destinations"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Save menu</Button>
        </>
      }
    >
      <div className="grid two" style={{ gap: 12 }}>
        <Input
          label="Menu name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Main menu"
          autoFocus
        />
        <Input
          label="Menu extension"
          value={form.extension}
          onChange={(event) => setForm({ ...form, extension: event.target.value })}
          placeholder="200"
          className="mono"
          hint="Dialled internally or mapped to a DID"
          disabled={!!flow.id}
        />
      </div>

      <Input
        label="Greeting text"
        value={form.greeting}
        onChange={(event) => setForm({ ...form, greeting: event.target.value })}
        hint="Record the audio as custom/telno-<extension> on the switch"
      />

      <div>
        <span className="field-label">Options</span>
        <div className="stack" style={{ gap: 8, marginTop: 6 }}>
          {form.options.map((option, index) => (
            <div key={index} className="row" style={{ gap: 8 }}>
              <input
                className="input mono"
                style={{ width: 52, textAlign: 'center' }}
                value={option.digit}
                maxLength={1}
                onChange={(event) => setOption(index, { digit: event.target.value.replace(/\D/g, '') })}
                aria-label={`Digit for option ${index + 1}`}
                placeholder="1"
              />
              <input
                className="input"
                value={option.label}
                onChange={(event) => setOption(index, { label: event.target.value })}
                placeholder="Option label"
                aria-label={`Label for option ${index + 1}`}
              />
              <select
                className="select mono"
                style={{ width: 130 }}
                value={option.target}
                onChange={(event) => setOption(index, { target: event.target.value })}
                aria-label={`Destination for option ${index + 1}`}
              >
                <option value="">Destination…</option>
                {extensions.map((ext) => (
                  <option key={ext.id} value={ext.extension}>
                    {ext.extension} · {ext.displayName}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove option"
                onClick={() => setForm({ ...form, options: form.options.filter((_, i) => i !== index) })}
              >
                <Icon name="x" size={13} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          style={{ marginTop: 8 }}
          onClick={() => setForm({ ...form, options: [...form.options, blankOption()] })}
          disabled={form.options.length >= 9}
        >
          Add option
        </Button>
      </div>

      <Select
        label="If the caller does not choose"
        value={form.timeoutDest}
        onChange={(event) => setForm({ ...form, timeoutDest: event.target.value })}
      >
        <option value="">Play goodbye and hang up</option>
        {extensions.map((ext) => (
          <option key={ext.id} value={ext.extension}>
            Ring {ext.extension} · {ext.displayName}
          </option>
        ))}
      </Select>

      <Switch checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} label="Enabled" />
      {error ? <p className="tiny" style={{ color: 'var(--danger)' }}>{error}</p> : null}
    </Modal>
  );
}
