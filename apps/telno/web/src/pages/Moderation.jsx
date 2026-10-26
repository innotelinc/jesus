import { useCallback, useEffect, useState } from 'react';
import { api, prettyNumber, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  Loading,
  Modal,
  PageHeader,
  Tabs,
  Textarea,
  statusTone,
  useToast,
} from '../ui.jsx';

const TABS = [
  { value: 'verified', label: 'Ready to approve' },
  { value: 'awaiting_verification', label: 'Unverified' },
  { value: 'approved', label: 'Published' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'duplicate', label: 'Duplicates' },
];

export default function Moderation() {
  const toast = useToast();
  const [tab, setTab] = useState('verified');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, all] = await Promise.all([
        api.get(`/submissions?status=${tab}&limit=100`),
        api.get('/submissions?limit=100'),
      ]);
      setData({ items: list.items, counts: all.counts });
    } catch (err) {
      toast.error('Could not load submissions', err.message);
    } finally {
      setLoading(false);
    }
  }, [tab, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const approve = async (item) => {
    try {
      const result = await api.post(`/submissions/${item.id}/approve`, {});
      toast.success('Listing published', `${item.name} · ${item.display || prettyNumber(item.e164)}`);
      if (result.listing?.created === false) {
        toast.info('Existing listing reused', 'The entity was already attached to this number.');
      }
      load();
    } catch (err) {
      toast.error('Approval failed', err.message);
    }
  };

  const reject = async (item, note) => {
    try {
      await api.post(`/submissions/${item.id}/reject`, { note });
      toast.success('Submission rejected');
      setRejecting(null);
      load();
    } catch (err) {
      toast.error('Rejection failed', err.message);
    }
  };

  const items = data?.items || [];
  const counts = data?.counts || {};

  return (
    <>
      <PageHeader
        title="Moderation"
        subtitle="Nothing is published until the number owner verifies it and an operator approves"
        actions={
          <Button variant="ghost" icon="refresh" onClick={load}>
            Refresh
          </Button>
        }
      />

      <div className="row wrap">
        <Tabs
          tabs={TABS.map((t) => ({ ...t, count: counts[t.value] || 0 }))}
          value={tab}
          onChange={setTab}
        />
      </div>

      {loading ? (
        <Loading rows={4} />
      ) : items.length ? (
        <div className="stack">
          {items.map((item) => (
            <Card key={item.id} bodyClass="tight">
              <div className="result">
                <div className="avatar">{(item.name || '?').slice(0, 2)}</div>
                <div className="result-main">
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="result-name truncate">{item.name}</span>
                    <Badge tone={statusTone(item.status)}>{item.status.replace(/_/g, ' ')}</Badge>
                    <Badge tone="neutral">{item.kind}</Badge>
                    {item.verify_channel === 'sms' ? <Badge tone="info">SMS verified</Badge> : <Badge tone="info">Email verified</Badge>}
                  </div>
                  <div className="result-meta">
                    <span className="mono">{item.display || prettyNumber(item.e164)}</span>
                    {item.category ? <span>· {item.category}</span> : null}
                    {item.city ? <span>· {item.city}</span> : null}
                    {item.country ? <span>{item.country}</span> : null}
                    <span>· submitted {relativeTime(item.created_at)}</span>
                    {item.domain_slug ? <span>· {item.domain_slug}</span> : null}
                  </div>
                  {item.notes ? <p className="tiny dim" style={{ marginTop: 4 }}>“{item.notes}”</p> : null}
                  {item.matches?.length ? (
                    <p className="tiny dim">
                      Matches existing: {item.matches.join(', ')}
                    </p>
                  ) : null}
                  {item.review_note ? (
                    <p className="tiny dim">Review note: {item.review_note}</p>
                  ) : null}
                </div>

                <div className="row" style={{ gap: 6 }}>
                  {item.status === 'verified' ? (
                    <>
                      <Button size="sm" variant="primary" icon="check" onClick={() => approve(item)}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" icon="x" onClick={() => setRejecting(item)}>
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {item.status === 'approved' ? (
                    <a
                      className="btn ghost sm"
                      href={`/d/telno.directory?q=${encodeURIComponent(item.e164)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View public <Icon name="external" size={11} />
                    </a>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon="check" title="Nothing in this queue">
            {tab === 'verified'
              ? 'Submissions appear here once their owner confirms the verification code.'
              : 'Switch tabs to see other submissions.'}
          </Empty>
        </Card>
      )}

      {rejecting ? <RejectDialog item={rejecting} onClose={() => setRejecting(null)} onReject={reject} /> : null}
    </>
  );
}

function RejectDialog({ item, onClose, onReject }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Reject submission"
      subtitle={`${item.name} · ${item.display || prettyNumber(item.e164)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onReject(item, note);
              setBusy(false);
            }}
          >
            Reject listing
          </Button>
        </>
      }
    >
      <Textarea
        label="Reason"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Could not confirm the number belongs to this business."
        hint="Stored on the submission for the audit trail."
        autoFocus
      />
    </Modal>
  );
}
