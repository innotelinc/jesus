import { useEffect, useRef, useState } from 'react';
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

  const setStatus = async (fax, status) => {
    setBusy(fax.id);
    try {
      const data = await api.patch(`/faxes/${fax.id}`, { status });
      setItems((list) => list.map((item) => (item.id === fax.id ? data.fax : item)));
      load();
    } catch (err) {
      toast.error('Could not update the fax', err.message);
    } finally {
      setBusy('');
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
                      {fax.status === 'queued' ? (
                        <Button size="sm" variant="ghost" loading={busy === fax.id} onClick={() => setStatus(fax, 'sending')}>
                          Start
                        </Button>
                      ) : fax.status === 'sending' ? (
                        <Button size="sm" variant="ghost" loading={busy === fax.id} onClick={() => setStatus(fax, 'sent')}>
                          Mark sent
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
