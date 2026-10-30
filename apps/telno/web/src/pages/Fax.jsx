import { Fragment, useEffect, useRef, useState } from 'react';
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
  Stat,
  Tabs,
  Textarea,
  useToast,
} from '../ui.jsx';

const TONE = { received: 'success', sent: 'success', queued: 'warning', sending: 'warning', failed: 'danger' };

const BLANK = { to: '', subject: '', pages: 1, body: '' };

export default function Fax() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [engine, setEngine] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(BLANK);
  const [file, setFile] = useState(null);
  const fileInput = useRef(null);

  const load = async () => {
    try {
      const data = await api.get(`/faxes${tab ? `?direction=${tab}` : ''}`);
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load fax history', err.message);
    } finally {
      setLoading(false);
    }
    // The engine and the routing are what make this screen honest: without a
    // loaded res_fax, a queued fax would just sit there with no explanation.
    api.get('/fax/engine').then((data) => setEngine(data.engine)).catch(() => {});
    api
      .get('/numbers?limit=100')
      .then((data) => setNumbers(data.items || []))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const send = async () => {
    setBusy('new');
    try {
      const data = await api.post('/faxes', {
        to: form.to,
        subject: form.subject,
        pages: form.pages,
        body: form.body,
        document: file?.name || '',
      });
      if (file) {
        await api.putFile(`/faxes/${data.fax.id}/attachment`, file);
      }
      setOpen(false);
      setForm(BLANK);
      setFile(null);
      load();
      toast.success('Fax queued', file ? `${file.name} attached.` : 'Sent as a plain-text page.');
    } catch (err) {
      toast.error('Could not queue the fax', err.message);
    } finally {
      setBusy('');
    }
  };

  /** Hand the document to the switch. No carrier API is involved. */
  const sendNow = async (fax) => {
    setBusy(fax.id);
    try {
      const data = await api.post(`/faxes/${fax.id}/send`, {});
      setItems((list) => list.map((item) => (item.id === fax.id ? data.fax : item)));
      load();
      toast.success('Fax handed to the switch', 'res_fax dials the trunk and transmits the document.');
    } catch (err) {
      toast.error('The fax did not send', err.message);
      load();
    } finally {
      setBusy('');
    }
  };

  /** Which numbers answer as a fax machine. */
  const setFaxMode = async (number, faxMode) => {
    try {
      const data = await api.patch(`/numbers/${number.id}`, { faxMode });
      setNumbers((list) => list.map((item) => (item.id === number.id ? data.number : item)));
      toast.success(`Fax routing: ${faxMode}`, 'The dialplan was regenerated for this number.');
    } catch (err) {
      toast.error('Could not change fax routing', err.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Fax"
        subtitle="Inbound documents and outbound sends — a plain-text page or an uploaded document"
        actions={<Button variant="primary" icon="printer" onClick={() => setOpen(true)}>Send fax</Button>}
      />

      <div className="grid stats">
        <Stat label="Inbound" value={summary?.inbound ?? '—'} foot="Received documents" />
        <Stat label="Outbound" value={summary?.outbound ?? '—'} foot="Queued and sent" />
        <Stat label="In flight" value={summary?.queued ?? '—'} foot="Queued or sending" />
        <Stat label="Failed" value={summary?.failed ?? '—'} foot="Carrier rejected" tone={summary?.failed ? 'var(--danger)' : undefined} />
      </div>

      <div className="grid two">
        <Card
          title="Fax engine"
          subtitle="The switch is the fax machine — no carrier fax API and no per-page fee"
          actions={<Badge tone={engine?.ready ? 'success' : 'warning'}>{engine?.ready ? 'Ready' : 'Needs attention'}</Badge>}
        >
          <dl className="kv">
            <dt>Transport</dt>
            <dd className="tiny">{engine?.transport || '…'}</dd>
            {/* What is actually missing, one line each. Asterisk's res_fax and
                spandsp are named nowhere: this estate has no Asterisk on the
                call path, so reporting them "not loaded" described a machine
                that does not exist instead of the fax machine that is absent. */}
            {(engine?.checks || []).map((check) => (
              <Fragment key={check.id}>
                <dt>{check.label}</dt>
                <dd className={`tiny mono ${check.state === 'ready' ? '' : 'bad'}`}>{check.detail}</dd>
              </Fragment>
            ))}
            <dt>Station ID</dt>
            <dd className="tiny mono">{engine?.stationId || '—'}</dd>
          </dl>
          <p className="tiny dim">{engine?.note || 'Checking the switch…'}</p>
        </Card>

        <Card
          title="Which numbers answer as a fax"
          subtitle="Set a line to fax, or leave it on voice and detect a terminal"
        >
          {numbers.length ? (
            <div className="stack" style={{ gap: 8 }}>
              {numbers.slice(0, 8).map((number) => (
                <div key={number.id} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <span className="tiny num">{number.display || number.e164}</span>
                  </div>
                  <select
                    className="select"
                    style={{ width: 150 }}
                    value={number.faxMode || 'voice'}
                    aria-label={`Fax routing for ${number.e164}`}
                    onChange={(event) => setFaxMode(number, event.target.value)}
                  >
                    <option value="voice">Voice</option>
                    <option value="fax">Fax machine</option>
                    <option value="auto">Voice, then fax if unanswered</option>
                  </select>
                </div>
              ))}
            </div>
          ) : (
            <p className="tiny dim">No numbers in the registry yet.</p>
          )}
          <p className="tiny dim" style={{ marginTop: 8 }}>
            “Fax machine” answers immediately and receives — that is the reliable choice for a fax number, because a fax
            terminal negotiates T.38 with the receiver. “Voice, then fax if unanswered” rings the line first and only treats
            the call as a fax when nobody picked up, which suits a number that is mostly voice.
          </p>
        </Card>
      </div>

      <Card
        bodyClass="tight"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: '', label: 'All' },
              { value: 'inbound', label: 'Inbound' },
              { value: 'outbound', label: 'Outbound' },
            ]}
          />
        }
        title="History"
      >
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={4} /></div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Content</th>
                  <th className="align-right">Pages</th>
                  <th>When</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((fax) => (
                  <tr key={fax.id}>
                    <td className="tiny">{fax.direction}</td>
                    <td className="tiny num nowrap">{fax.from || '—'}</td>
                    <td className="tiny num nowrap">{fax.to || '—'}</td>
                    <td className="tiny">{fax.subject || '—'}</td>
                    <td className="tiny">
                      {fax.attachmentName ? (
                        <a className="row" style={{ gap: 5, color: 'var(--accent)' }} href={fax.attachmentUrl} target="_blank" rel="noreferrer">
                          <span className="mono">{fax.attachmentName}</span>
                        </a>
                      ) : fax.body ? (
                        <span className="dim" title={fax.body}>
                          {fax.body.slice(0, 58)}
                          {fax.body.length > 58 ? '…' : ''}
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="align-right tiny mono">{fax.pages}</td>
                    <td className="tiny dim nowrap">{relativeTime(fax.at)}</td>
                    <td><Badge tone={TONE[fax.status] || 'neutral'}>{fax.status}</Badge></td>
                    <td className="align-right">
                      {fax.direction === 'outbound' && ['queued', 'failed'].includes(fax.status) ? (
                        <Button size="sm" variant="ghost" icon="printer" loading={busy === fax.id} onClick={() => sendNow(fax)}>
                          Send now
                        </Button>
                      ) : fax.error ? (
                        <span className="tiny" style={{ color: 'var(--danger)' }} title={fax.error}>
                          {fax.error.slice(0, 40)}…
                        </span>
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
          <Empty icon="printer" title="No faxes here" action={<Button variant="primary" onClick={() => setOpen(true)}>Send one</Button>}>
            Inbound faxes arrive on the DID that points at the fax service.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="Send fax"
          subtitle="A plain-text page, a document, or both"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'new'}
                disabled={!form.to.trim() || (!form.body.trim() && !file)}
                onClick={send}
              >
                Queue fax
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input label="To" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="+44 20 7946 0111" hint="Resolves to the canonical registry number." />
            <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Porting confirmation" />
            <Textarea
              label="Message"
              rows={5}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="Typed here and sent as the fax body — no document needed."
              hint={`${form.body.length} / 4000 characters`}
            />
            <div className="grid two">
              <div className="field">
                <span className="field-label">Attachment</span>
                <div className="row wrap" style={{ gap: 6 }}>
                  <Button size="sm" icon="paperclip" onClick={() => fileInput.current?.click()}>
                    {file ? 'Replace file' : 'Choose file'}
                  </Button>
                  {file ? <span className="tiny dim mono">{file.name}</span> : <span className="tiny dim">PDF or image, up to 10 MB</span>}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept="application/pdf,image/png,image/jpeg,image/tiff"
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </div>
              <Input
                label="Pages"
                type="number"
                min="1"
                value={form.pages}
                onChange={(e) => setForm({ ...form, pages: Number(e.target.value) })}
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
