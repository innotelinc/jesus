import { useEffect, useMemo, useState } from 'react';
import { api, relativeTime, duration } from '../api.js';
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
  Textarea,
  useToast,
} from '../ui.jsx';

/**
 * Marketing: outbound campaigns worked by the voice agents.
 *
 * The screen follows the pipeline the API enforces — list, script, queue,
 * disposition, grade, report — so there is never a state in the UI that the
 * platform cannot act on. Dialing is shown honestly: when the switch is
 * simulated the run returns the batch and says the softphone has to place the
 * calls, rather than pretending a call happened.
 */

const STATUS_TONE = { draft: 'neutral', running: 'success', paused: 'warning', completed: 'neutral' };
const OUTCOMES = [
  ['interested', 'Interested'],
  ['callback', 'Callback agreed'],
  ['not-interested', 'Not interested'],
  ['wrong-number', 'Wrong number'],
  ['do-not-call', 'Do not call again'],
  ['voicemail', 'Voicemail'],
  ['no-answer', 'No answer'],
  ['busy', 'Busy'],
  ['failed', 'Call failed'],
];

const gradeTone = (grade) => (grade >= 70 ? 'success' : grade >= 40 ? 'warning' : 'danger');

export default function Marketing() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ name: '', template: 'renewal', goal: '', script: '', agentId: '', dialerExtension: '' });
  const [importText, setImportText] = useState('');
  const [disposition, setDisposition] = useState(null);
  const [outcomeForm, setOutcomeForm] = useState({ outcome: 'interested', transcript: '', durationSec: 0 });
  const [reportEmail, setReportEmail] = useState('');
  const [report, setReport] = useState(null);

  const loadOverview = async () => {
    try {
      const data = await api.get('/marketing/overview');
      setOverview(data);
      if (!selected && data.campaigns.length) setSelected(data.campaigns[0].id);
    } catch (err) {
      toast.error('Could not load marketing', err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id) => {
    if (!id) return;
    try {
      setDetail(await api.get(`/marketing/campaigns/${id}`));
    } catch (err) {
      toast.error('Could not load the campaign', err.message);
    }
  };

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setReport(null);
    setDetail(null);
    loadDetail(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const template = useMemo(
    () => overview?.templates?.find((entry) => entry.id === form.template) || null,
    [overview, form.template]
  );

  const patch = async (id, body, note = 'Campaign saved') => {
    try {
      const data = await api.patch(`/marketing/campaigns/${id}`, body);
      setDetail((current) => (current ? { ...current, campaign: data.campaign } : current));
      loadOverview();
      toast.success(note);
      loadDetail(id);
      return true;
    } catch (err) {
      toast.error('Could not save the campaign', err.message);
      return false;
    }
  };

  const create = async () => {
    setBusy('create');
    try {
      const data = await api.post('/marketing/campaigns', {
        name: form.name,
        template: form.template,
        goal: form.goal || template?.goal,
        script: form.script || template?.script,
        agentId: form.agentId || undefined,
        dialerExtension: form.dialerExtension || undefined,
      });
      setCreating(false);
      setForm({ name: '', template: 'renewal', goal: '', script: '', agentId: '', dialerExtension: '' });
      await loadOverview();
      setSelected(data.campaign.id);
      toast.success('Campaign created', 'Import a list, then set it to running.');
    } catch (err) {
      toast.error('Could not create the campaign', err.message);
    } finally {
      setBusy('');
    }
  };

  const importList = async () => {
    if (!importText.trim() || !detail) return;
    setBusy('import');
    try {
      const data = await api.post(`/marketing/campaigns/${detail.campaign.id}/contacts`, { text: importText });
      const { added, duplicates, optedOut, invalid } = data.report;
      toast.success(
        `${added} contact${added === 1 ? '' : 's'} added`,
        [duplicates ? `${duplicates} already on the list` : '', optedOut ? `${optedOut} opted out` : '', invalid ? `${invalid} unreadable` : '']
          .filter(Boolean)
          .join(' · ') || 'Every line parsed cleanly.'
      );
      setImportText('');
      loadDetail(detail.campaign.id);
      loadOverview();
    } catch (err) {
      toast.error('Could not import the list', err.message);
    } finally {
      setBusy('');
    }
  };

  const runBatch = async (limit = 10) => {
    if (!detail) return;
    setBusy('run');
    try {
      const data = await api.post(`/marketing/campaigns/${detail.campaign.id}/run`, { limit });
      const count = data.batch.length;
      toast.success(
        `${count} contact${count === 1 ? '' : 's'} claimed`,
        data.telephony.simulate
          ? 'The switch is simulated: dial these from the softphone, then record the outcome here.'
          : 'Dial these from the dialer extension, then record each outcome here.'
      );
      if (data.batch.length === 1) {
        setDisposition(data.batch[0]);
        setOutcomeForm({ outcome: 'interested', transcript: '', durationSec: 0 });
      }
      loadDetail(detail.campaign.id);
      loadOverview();
    } catch (err) {
      toast.error('Could not claim a batch', err.message);
    } finally {
      setBusy('');
    }
  };

  const recordOutcome = async () => {
    if (!disposition) return;
    setBusy('outcome');
    try {
      const data = await api.post(`/marketing/contacts/${disposition.id}/outcome`, outcomeForm);
      toast.success(
        data.contact?.grade === null || data.contact?.grade === undefined
          ? 'Outcome recorded'
          : `Graded ${data.contact.grade}/100`,
        (data.contact?.reasons || []).slice(0, 2).join(' · ') || 'Recorded and graded.'
      );
      setDisposition(null);
      loadDetail(detail.campaign.id);
    } catch (err) {
      toast.error('Could not record the outcome', err.message);
    } finally {
      setBusy('');
    }
  };

  const suggest = async () => {
    if (!detail) return;
    setBusy('suggest');
    try {
      const data = await api.post('/marketing/suggest', {
        goal: detail.campaign.goal || 'Renew a subscription',
        script: detail.campaign.script,
      });
      if (!data.ok) {
        toast.error('No model configured', data.fallback?.note || data.error);
        return;
      }
      await patch(detail.campaign.id, { script: data.suggestion.script }, 'Script rewritten');
      toast.success('Script updated', (data.suggestion.tips || []).slice(0, 2).join(' · '));
    } catch (err) {
      toast.error('Could not get a suggestion', err.message);
    } finally {
      setBusy('');
    }
  };

  const makeReport = async (email) => {
    if (!detail) return;
    setBusy('report');
    try {
      const data = await api.post(`/marketing/campaigns/${detail.campaign.id}/report`, { email: email || undefined });
      setReport(data.report);
      const delivery = data.report.delivery || {};
      if (email) {
        if (delivery.delivered) toast.success('Report sent', `Delivered by ${delivery.channel}.`);
        else toast.error('Report built, not delivered', delivery.error || 'No email provider is configured.');
      } else {
        toast.success('Report built', 'Download it here or send it by email.');
      }
      loadDetail(detail.campaign.id);
    } catch (err) {
      toast.error('Could not build the report', err.message);
    } finally {
      setBusy('');
    }
  };

  const download = async (reportId) => {
    try {
      const res = await fetch(`/api/marketing/reports/${reportId}/download`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${detail?.campaign?.name || 'campaign'}-report.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Could not download the report', err.message);
    }
  };

  if (loading) {
    return (
      <Card>
        <Loading rows={4} />
      </Card>
    );
  }

  const campaign = detail?.campaign;
  const totals = detail?.totals;

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle="Outbound campaigns over the voice agents — list, script, grade, report"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" icon="refresh" onClick={() => (campaign ? loadDetail(campaign.id) : loadOverview())}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New campaign
            </Button>
          </div>
        }
      />

      <div className="grid stats">
        <Stat label="Campaigns" value={overview?.campaigns?.length ?? 0} foot="All time" />
        <Stat label="Dialed" value={totals?.dialed ?? overview?.totals?.dialed ?? 0} foot="Contacts claimed" />
        <Stat label="Leads" value={totals?.leads ?? 0} foot={`Grade ${campaign?.gradeThreshold ?? 60}+`} />
        <Stat
          label="Average grade"
          value={totals ? totals.averageGrade : '—'}
          foot={overview?.ai?.configured ? `Graded by ${overview.ai.model}` : 'Rule grader (no model key)'}
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 18, alignItems: 'start' }}>
        <Card title="Campaigns" subtitle={`${overview?.campaigns?.length ?? 0} total`} bodyClass="stack">
          {overview?.campaigns?.length ? (
            overview.campaigns.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="nav-item"
                aria-current={entry.id === selected ? 'page' : undefined}
                style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' }}
                onClick={() => setSelected(entry.id)}
              >
                <div className="stack" style={{ gap: 2 }}>
                  <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
                    <strong className="truncate">{entry.name}</strong>
                    <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
                  </div>
                  <span className="tiny dim">
                    {entry.counts.completed}/{entry.counts.total} worked · {entry.counts.queued} queued
                  </span>
                </div>
              </button>
            ))
          ) : (
            <Empty icon="wave" title="No campaigns yet">
              Start from a template: it brings a goal, a script and coaching notes you can edit.
            </Empty>
          )}
        </Card>

        <div className="stack">
          {!campaign ? (
            <Card>
              <Empty icon="wave" title="Choose a campaign">
                Or create one to import a list and start dialing.
              </Empty>
            </Card>
          ) : (
            <>
              <Card
                title={campaign.name}
                subtitle={`${campaign.template || 'custom'} · ${campaign.goal || 'no goal set'}`}
                actions={
                  <div className="row" style={{ gap: 6 }}>
                    <Badge tone={STATUS_TONE[campaign.status]}>{campaign.status}</Badge>
                    <Select
                      aria-label="Campaign status"
                      value={campaign.status}
                      onChange={(event) => patch(campaign.id, { status: event.target.value }, `Campaign ${event.target.value}`)}
                      style={{ width: 130 }}
                    >
                      <option value="draft">Draft</option>
                      <option value="running">Running</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                    </Select>
                  </div>
                }
              >
                <div className="stack">
                  <div className="row wrap" style={{ gap: 14 }}>
                    <span className="tiny dim">{campaign.counts.total} contacts</span>
                    <span className="tiny dim">{campaign.counts.queued} queued</span>
                    <span className="tiny dim">{campaign.counts.calling} in progress</span>
                    <span className="tiny dim">{campaign.counts.completed} completed</span>
                    <span className="tiny dim">{campaign.counts.blocked} blocked</span>
                    <span className="tiny dim">Last run {campaign.lastRunAt ? relativeTime(campaign.lastRunAt) : 'never'}</span>
                  </div>

                  <div className="grid two">
                    <Select
                      label="Voice agent"
                      value={campaign.agentId}
                      onChange={(event) => patch(campaign.id, { agentId: event.target.value }, 'Agent changed')}
                    >
                      <option value="">No agent (manual)</option>
                      {overview?.agents?.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.status}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Dialer extension"
                      hint="The line that places the calls"
                      value={campaign.dialerExtension}
                      onChange={(event) => patch(campaign.id, { dialerExtension: event.target.value }, 'Dialer set')}
                    >
                      <option value="">None</option>
                      {overview?.dialers?.map((dialer) => (
                        <option key={dialer.extension} value={dialer.extension}>
                          {dialer.extension} · {dialer.displayName}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <Textarea
                    label="Script"
                    rows={7}
                    defaultValue={campaign.script}
                    onBlur={(event) => {
                      if (event.target.value !== campaign.script) patch(campaign.id, { script: event.target.value }, 'Script saved');
                    }}
                    hint="Saved when you leave the field. The grader reads this against the goal."
                  />

                  <div className="row wrap" style={{ gap: 8 }}>
                    <Button size="sm" icon="play" loading={busy === 'run'} disabled={campaign.status !== 'running'} onClick={() => runBatch(10)}>
                      Claim 10 to call
                    </Button>
                    <Button size="sm" variant="ghost" icon="sparkle" loading={busy === 'suggest'} onClick={suggest}>
                      Rewrite with AI
                    </Button>
                    <Input
                      label=""
                      aria-label="Lead threshold"
                      type="number"
                      min="0"
                      max="100"
                      value={campaign.gradeThreshold}
                      style={{ width: 90 }}
                      onChange={(event) => patch(campaign.id, { gradeThreshold: Number(event.target.value) }, 'Threshold saved')}
                    />
                    <span className="tiny dim">lead threshold</span>
                  </div>
                  {campaign.status !== 'running' ? (
                    <p className="tiny" style={{ color: 'var(--warning)', margin: 0 }}>
                      Set the campaign to running before claiming a batch.
                    </p>
                  ) : null}
                </div>
              </Card>

              <Card
                title="Contacts"
                subtitle={`${campaign.counts.total} on the list`}
                actions={
                  <Button size="sm" variant="ghost" icon="upload" onClick={() => setImportText((value) => value || ' ')}>
                    Import
                  </Button>
                }
              >
                <div className="stack">
                  <Textarea
                    label="Import a list"
                    rows={4}
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    placeholder={'Dana Reed, (415) 555-0132\ndana@example.com, +1 415 555 0144\n+44 20 7946 0018'}
                    hint="One person per line: name and number in any format, an optional email. Duplicates and opt-outs are dropped."
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <Button size="sm" loading={busy === 'import'} disabled={!importText.trim()} onClick={importList}>
                      Add to campaign
                    </Button>
                  </div>

                  {detail?.contacts?.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Number</th>
                            <th>Status</th>
                            <th>Outcome</th>
                            <th>Grade</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {detail.contacts.map((contact) => (
                            <tr key={contact.id}>
                              <td>{contact.name || <span className="dim">—</span>}</td>
                              <td className="mono tiny">{contact.number}</td>
                              <td>
                                <Badge tone={contact.status === 'do_not_call' ? 'danger' : contact.status === 'completed' ? 'success' : 'neutral'}>
                                  {contact.status.replace(/_/g, ' ')}
                                </Badge>
                              </td>
                              <td className="tiny">{contact.outcome || <span className="dim">—</span>}</td>
                              <td>
                                {contact.grade === null || contact.grade === undefined ? (
                                  <span className="dim tiny">—</span>
                                ) : (
                                  <Badge tone={gradeTone(contact.grade)}>{contact.grade}</Badge>
                                )}
                              </td>
                              <td>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon="edit"
                                  onClick={() => {
                                    setDisposition(contact);
                                    setOutcomeForm({
                                      outcome: contact.outcome || 'interested',
                                      transcript: contact.transcript || '',
                                      durationSec: contact.durationSec || 0,
                                    });
                                  }}
                                >
                                  Record
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty icon="inbox" title="No contacts yet">
                      Paste a list above. Numbers are de-duplicated against the campaign and the platform-wide opt-out list.
                    </Empty>
                  )}
                </div>
              </Card>

              <Card
                title="Report"
                subtitle={
                  overview?.ai?.configured
                    ? `Graded by ${overview.ai.model}; the summary is written from the totals`
                    : 'Graded by rules until an LLM key is added in Settings'
                }
              >
                <div className="stack">
                  <div className="grid two">
                    <Stat label="Leads" value={totals?.leads ?? 0} foot={`Grade ${totals?.threshold ?? 60}+`} />
                    <Stat label="Talk time" value={duration(totals?.totalTalkSeconds ?? 0)} foot={`${totals?.completed ?? 0} completed`} />
                  </div>

                  {totals?.byOutcome?.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Disposition</th>
                            <th>Calls</th>
                          </tr>
                        </thead>
                        <tbody>
                          {totals.byOutcome.map((entry) => (
                            <tr key={entry.outcome}>
                              <td>{entry.outcome.replace(/-/g, ' ')}</td>
                              <td>{entry.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                    <Input
                      label="Email the report to"
                      type="email"
                      value={reportEmail}
                      onChange={(event) => setReportEmail(event.target.value)}
                      placeholder="you@company.com"
                    />
                    <Button size="sm" variant="ghost" loading={busy === 'report'} onClick={() => makeReport('')}>
                      Build PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon="message"
                      loading={busy === 'report'}
                      disabled={!reportEmail.trim()}
                      onClick={() => makeReport(reportEmail.trim())}
                    >
                      Send by email
                    </Button>
                  </div>

                  {report ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <Button size="sm" icon="download" onClick={() => download(report.id)}>
                          Download PDF
                        </Button>
                        <span className="tiny dim">
                          {Math.round(report.bytes / 1024)} KB · built {report.generatedAt}
                          {report.delivery?.delivered ? ` · emailed via ${report.delivery.channel}` : ''}
                        </span>
                      </div>
                      {report.narrative?.text ? <p className="tiny muted" style={{ whiteSpace: 'pre-line' }}>{report.narrative.text}</p> : null}
                    </div>
                  ) : null}

                  {detail?.reports?.length ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <span className="tiny dim">Earlier reports</span>
                      {detail.reports.map((entry) => (
                        <div key={entry.id} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                          <span className="tiny">
                            {relativeTime(entry.createdAt)} · {entry.totals?.leads ?? 0} leads
                            {entry.sentTo ? ` · ${entry.sentTo}` : ''}
                          </span>
                          <Button size="sm" variant="ghost" icon="download" onClick={() => download(entry.id)}>
                            PDF
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      {creating ? (
        <Modal
          title="New campaign"
          subtitle="A template brings a goal and a script you can edit"
          onClose={() => setCreating(false)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === 'create'} disabled={form.name.trim().length < 3} onClick={create}>
                Create campaign
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input
              label="Name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Q4 renewal — west coast"
            />
            <Select label="Template" value={form.template} onChange={(event) => setForm({ ...form, template: event.target.value })}>
              {overview?.templates?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
            {template ? (
              <p className="tiny dim" style={{ margin: 0 }}>
                {template.goal}
              </p>
            ) : null}
            <Textarea
              label="Goal"
              rows={2}
              value={form.goal || template?.goal || ''}
              onChange={(event) => setForm({ ...form, goal: event.target.value })}
              hint="What a good call achieves. The grader is held to this, not to a generic idea of interest."
            />
            <Textarea
              label="Script"
              rows={6}
              value={form.script || template?.script || ''}
              onChange={(event) => setForm({ ...form, script: event.target.value })}
            />
            <div className="grid two">
              <Select label="Voice agent" value={form.agentId} onChange={(event) => setForm({ ...form, agentId: event.target.value })}>
                <option value="">No agent (manual)</option>
                {overview?.agents?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Dialer extension"
                value={form.dialerExtension}
                onChange={(event) => setForm({ ...form, dialerExtension: event.target.value })}
              >
                <option value="">None</option>
                {overview?.dialers?.map((dialer) => (
                  <option key={dialer.extension} value={dialer.extension}>
                    {dialer.extension} · {dialer.displayName}
                  </option>
                ))}
              </Select>
            </div>
            {template ? (
              <div className="stack" style={{ gap: 4 }}>
                <span className="tiny dim">Coaching notes</span>
                {template.tips.map((tip) => (
                  <span key={tip} className="tiny">
                    · {tip}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {disposition ? (
        <Modal
          title={`Outcome for ${disposition.name || disposition.number}`}
          subtitle="What happened on the call. This is what the grader reads."
          onClose={() => setDisposition(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setDisposition(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === 'outcome'} onClick={recordOutcome}>
                Record and grade
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid two">
              <Select
                label="Disposition"
                value={outcomeForm.outcome}
                onChange={(event) => setOutcomeForm({ ...outcomeForm, outcome: event.target.value })}
              >
                {OUTCOMES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <Input
                label="Call length (seconds)"
                type="number"
                min="0"
                value={outcomeForm.durationSec}
                onChange={(event) => setOutcomeForm({ ...outcomeForm, durationSec: Number(event.target.value) })}
              />
            </div>
            <Textarea
              label="Transcript or notes"
              rows={8}
              value={outcomeForm.transcript}
              onChange={(event) => setOutcomeForm({ ...outcomeForm, transcript: event.target.value })}
              placeholder="Customer: …&#10;Agent: …"
              hint="A transcript grades far better than a one-word disposition. Do-not-call adds the number to the platform opt-out list."
            />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
