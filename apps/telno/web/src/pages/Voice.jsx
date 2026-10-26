import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Stat,
  Switch,
  Textarea,
  useToast,
} from '../ui.jsx';

const STATUS_LABEL = { active: 'Active', paused: 'Paused', draft: 'Draft' };
const STATUS_TONE = { active: 'success', paused: 'warning', draft: 'neutral' };

const BLANK = {
  name: '',
  voice: 'aria',
  language: 'en-US',
  model: 'telno-voice-1',
  greeting: '',
  prompt: '',
  number: '',
  status: 'draft',
  recordInbound: false,
  recordOutbound: false,
};

const recordingLabel = (agent) => {
  if (agent.recordInbound && agent.recordOutbound) return 'Recording both ways';
  if (agent.recordInbound) return 'Recording inbound';
  if (agent.recordOutbound) return 'Recording outbound';
  return 'Not recorded';
};

export default function Voice() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(BLANK);

  const load = async () => {
    try {
      const data = await api.get('/voice/agents');
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load voice agents', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEditor = (agent) => {
    setEditing(agent || 'new');
    setForm(
      agent
        ? {
            name: agent.name,
            voice: agent.voice,
            language: agent.language,
            model: agent.model,
            greeting: agent.greeting,
            prompt: agent.prompt,
            number: agent.number,
            status: agent.status,
            recordInbound: agent.recordInbound,
            recordOutbound: agent.recordOutbound,
          }
        : BLANK
    );
  };

  const setStatus = async (agent, status) => {
    setBusy(agent.id);
    try {
      const data = await api.patch(`/voice/agents/${agent.id}`, { status });
      setItems((list) => list.map((item) => (item.id === agent.id ? data.agent : item)));
      load();
      toast.success(`${agent.name} is ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (err) {
      toast.error('Could not update the agent', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (agent) => {
    if (!window.confirm(`Delete ${agent.name}? Calls already handled by it are not affected.`)) return;
    setBusy(agent.id);
    try {
      await api.del(`/voice/agents/${agent.id}`);
      setItems((list) => list.filter((item) => item.id !== agent.id));
      load();
      toast.success('Agent deleted');
    } catch (err) {
      toast.error('Could not delete the agent', err.message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      if (editing === 'new') {
        const data = await api.post('/voice/agents', form);
        setItems((list) => [...list, data.agent]);
        toast.success('Voice agent created', `${data.agent.name} starts as a draft.`);
      } else {
        const data = await api.patch(`/voice/agents/${editing.id}`, form);
        setItems((list) => list.map((item) => (item.id === editing.id ? data.agent : item)));
        toast.success('Agent updated', `${data.agent.name} saved.`);
      }
      setEditing(null);
      setForm(BLANK);
      load();
    } catch (err) {
      toast.error('Could not save the agent', err.message);
    } finally {
      setBusy('');
    }
  };

  const toggleRecording = (agent, key) =>
    api
      .patch(`/voice/agents/${agent.id}`, { [key]: !agent[key] })
      .then((data) => {
        setItems((list) => list.map((item) => (item.id === agent.id ? data.agent : item)));
        toast.success(
          `${agent.name}: ${recordingLabel(data.agent).toLowerCase()}`,
          'The switch is applied to the next call.'
        );
      })
      .catch((err) => toast.error('Could not change recording', err.message));

  return (
    <>
      <PageHeader
        title="Voice agents"
        subtitle="Personas that answer or place calls — edit the script, routing and recording policy"
        actions={<Button variant="primary" icon="plus" onClick={() => openEditor(null)}>New agent</Button>}
      />

      <div className="grid stats">
        <Stat label="Active" value={summary?.active ?? '—'} foot={`${summary?.total ?? 0} total`} />
        <Stat label="Calls handled" value={summary?.callsHandled ?? '—'} foot="Lifetime" />
        <Stat label="Avg handling" value={summary?.avgHandlingSec ? `${summary.avgHandlingSec}s` : '—'} foot="Answered calls" />
        <Stat label="Recording" value={items.filter((a) => a.recordInbound || a.recordOutbound).length} foot="Agents keeping audio" />
      </div>

      {loading ? (
        <Card><Loading rows={4} /></Card>
      ) : items.length ? (
        <div className="grid two">
          {items.map((agent) => (
            <Card
              key={agent.id}
              title={agent.name}
              subtitle={`${agent.voice} · ${agent.language} · ${agent.model}`}
              actions={<Badge tone={STATUS_TONE[agent.status]} dot={agent.status === 'active' ? 'live' : undefined}>{STATUS_LABEL[agent.status]}</Badge>}
            >
              <div className="stack">
                <p className="tiny muted">{agent.greeting || <span className="dim">No greeting yet.</span>}</p>
                <p className="tiny dim" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {agent.prompt || 'No script set — the agent will improvise.'}
                </p>
                <div className="row wrap" style={{ gap: 10 }}>
                  <span className="tiny dim">{agent.callsHandled.toLocaleString()} calls</span>
                  <span className="tiny dim">·</span>
                  <span className="tiny dim">{agent.avgHandlingSec ? `${agent.avgHandlingSec}s avg` : 'no data'}</span>
                  <span className="tiny dim">·</span>
                  <span className="tiny dim">{agent.number || 'no number'}</span>
                </div>
                <div className="row wrap" style={{ gap: 10 }}>
                  <Badge tone={agent.recordInbound || agent.recordOutbound ? 'warning' : 'neutral'}>
                    {recordingLabel(agent)}
                  </Badge>
                  <Switch
                    checked={agent.recordInbound}
                    onChange={() => toggleRecording(agent, 'recordInbound')}
                    label="In"
                  />
                  <Switch
                    checked={agent.recordOutbound}
                    onChange={() => toggleRecording(agent, 'recordOutbound')}
                    label="Out"
                  />
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                  {agent.status !== 'active' ? (
                    <Button size="sm" icon="play" loading={busy === agent.id} onClick={() => setStatus(agent, 'active')}>
                      Activate
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" icon="x" loading={busy === agent.id} onClick={() => setStatus(agent, 'paused')}>
                      Pause
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => openEditor(agent)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    loading={busy === agent.id}
                    onClick={() => remove(agent)}
                    aria-label={`Delete ${agent.name}`}
                  />
                  <span className="tiny dim right">{relativeTime(agent.updatedAt)}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="wave" title="No voice agents" action={<Button variant="primary" icon="plus" onClick={() => openEditor(null)}>Create one</Button>}>
            An agent binds a number to a script. Create one, attach a DID, then activate it.
          </Empty>
        </Card>
      )}

      {editing ? (
        <Modal
          title={editing === 'new' ? 'New voice agent' : `Edit ${editing.name}`}
          subtitle="Changes apply to the next call; recordings follow the two switches"
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'save'} disabled={!form.name.trim()} onClick={save}>
                {editing === 'new' ? 'Create agent' : 'Save changes'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid two">
              <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Reception — English" />
              <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </Select>
            </div>
            <div className="grid two">
              <Select label="Voice" value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })}>
                <option value="aria">aria</option>
                <option value="marcus">marcus</option>
                <option value="sofia">sofia</option>
                <option value="nora">nora</option>
              </Select>
              <Input label="Language" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="en-US" />
            </div>
            <div className="grid two">
              <Input label="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="telno-voice-1" />
              <Input
                label="Attach number"
                hint="Any format — resolves to an E.164 registry row."
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
                placeholder="+1 415 555 0123"
              />
            </div>
            <Input label="Greeting" value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} />
            <Textarea
              label="Script"
              rows={7}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="How the agent should behave, what it must not say, where to transfer."
              hint={`${form.prompt.length} / 2000 characters`}
            />
            <div className="stack" style={{ gap: 6 }}>
              <Switch
                checked={form.recordInbound}
                onChange={(value) => setForm({ ...form, recordInbound: value })}
                label="Record inbound calls"
              />
              <Switch
                checked={form.recordOutbound}
                onChange={(value) => setForm({ ...form, recordOutbound: value })}
                label="Record outbound calls"
              />
              <p className="tiny dim">
                Both off means never. Recording is announced in the greeting where the law requires it — the
                audio is stored on the data volume and played from the call log.
              </p>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
