import { useCallback, useEffect, useRef, useState } from 'react';
import { api, prettyNumber, relativeTime, qs } from '../api.js';
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
  statusTone,
  useToast,
} from '../ui.jsx';

const KINDS = [
  ['business', 'Business'],
  ['person', 'Person'],
  ['service', 'Service'],
  ['government', 'Government'],
  ['emergency', 'Emergency'],
];

const COUNTRIES = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'],
  ['IT', 'Italy'], ['NL', 'Netherlands'], ['SE', 'Sweden'], ['IE', 'Ireland'], ['DK', 'Denmark'],
  ['AU', 'Australia'], ['NZ', 'New Zealand'], ['JP', 'Japan'], ['CN', 'China'], ['IN', 'India'],
  ['BR', 'Brazil'], ['MX', 'Mexico'], ['ZA', 'South Africa'], ['AE', 'United Arab Emirates'], ['CA', 'Canada'],
];

const LIMIT = 20;

export default function Numbers() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(null);
  const debounce = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get(`/numbers${qs({ q: query, country, status, page, limit: LIMIT })}`);
      setData(result);
    } catch (err) {
      toast.error('Could not load numbers', err.message);
    } finally {
      setLoading(false);
    }
  }, [query, country, status, page, toast]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(load, query ? 260 : 0);
    return () => clearTimeout(debounce.current);
  }, [load, query]);

  const items = data?.items || [];

  return (
    <>
      <PageHeader
        title="Numbers"
        subtitle={`${data?.total ?? 0} canonical rows — duplicates collapse into one E.164 key`}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add number
          </Button>
        }
      />

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 12, gap: 8 }}>
          <div className="search">
            <Icon name="search" size={14} />
            <input
              className="input"
              placeholder="Search name or digits…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              aria-label="Search the registry"
            />
          </div>
          <select
            className="select"
            style={{ width: 170 }}
            value={country}
            onChange={(event) => {
              setCountry(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by country"
          >
            <option value="">All countries</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 150 }}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="registered">Registered</option>
            <option value="reserved">Reserved</option>
            <option value="ported">Ported</option>
            <option value="retired">Retired</option>
          </select>
        </div>

        {loading && !data ? (
          <div style={{ padding: 16 }}>
            <Loading rows={4} />
          </div>
        ) : items.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Entity</th>
                    <th>Type</th>
                    <th>Country</th>
                    <th>Status</th>
                    <th className="align-right">Listings</th>
                    <th className="align-right">Trust</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="clickable" onClick={() => setSelected(row.id)}>
                      <td className="num nowrap">{row.display || prettyNumber(row.e164)}</td>
                      <td className="truncate" style={{ maxWidth: 220 }}>
                        <div className="truncate">{row.name || <span className="dim">unlisted</span>}</div>
                        {row.city ? <div className="tiny dim truncate">{row.city}</div> : null}
                      </td>
                      <td className="tiny muted nowrap">{row.kind || '—'}</td>
                      <td className="tiny muted">{row.country || '—'}</td>
                      <td>
                        <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="align-right tiny mono">{row.listingCount}</td>
                      <td className="align-right tiny mono">{row.trust}</td>
                      <td className="tiny dim nowrap">{relativeTime(row.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
              <span className="tiny dim">
                Page {data.page} of {data.pages}
              </span>
              <div className="row right" style={{ gap: 6 }}>
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : (
          <Empty icon="numbers" title="No numbers match">
            {query ? 'Try a shorter query, or search by digits.' : 'Add the first number to the registry.'}
          </Empty>
        )}
      </Card>

      {adding ? <AddNumberDialog onClose={() => setAdding(false)} onSaved={load} /> : null}
      {selected ? <NumberDetail id={selected} onClose={() => setSelected(null)} onChanged={load} /> : null}
    </>
  );
}

function AddNumberDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    number: '',
    name: '',
    kind: 'business',
    category: '',
    city: '',
    country: 'US',
    website: '',
    visibility: 'public',
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const debounce = useRef();

  useEffect(() => {
    clearTimeout(debounce.current);
    if (form.number.trim().length < 4) {
      setPreview(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const result = await api.get(`/numbers/lookup/${encodeURIComponent(form.number.trim())}`);
        setPreview(result);
      } catch {
        setPreview(null);
      }
    }, 320);
    return () => clearTimeout(debounce.current);
  }, [form.number]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.post('/numbers', form);
      if (result.deduplicated) {
        toast.info('Already in the registry', `${result.number.display || prettyNumber(result.number.e164)} was matched and merged, not duplicated.`);
      } else {
        toast.success('Number added', result.number.display || prettyNumber(result.number.e164));
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add a number"
      subtitle="Anything typed here is normalized before it is stored"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Save number</Button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Input
          label="Phone number"
          placeholder="+1 (415) 555-0123"
          value={form.number}
          onChange={(event) => setForm({ ...form, number: event.target.value })}
          className="mono"
          autoFocus
          error={form.number && preview && !preview.parsed?.ok ? preview.parsed?.reason : undefined}
          hint={
            preview?.parsed?.ok
              ? `${preview.parsed.e164} · ${preview.parsed.countryName || 'international'} · ${preview.parsed.lineType}`
              : 'Include the country code, or type a national number and pick the country below.'
          }
        />

        {preview?.found ? (
          <div className="panel row" style={{ gap: 10, padding: 12 }}>
            <Icon name="alert" size={16} />
            <div className="tiny">
              <strong>Already registered</strong>
              {preview.number.listings?.length
                ? ` as “${preview.number.listings[0].name}”`
                : ' with no listing yet'}
              . Saving attaches your listing to the same row instead of creating a duplicate.
            </div>
          </div>
        ) : null}

        <div className="grid two" style={{ gap: 12 }}>
          <Input
            label="Entity name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Hudson & Vale"
          />
          <Select label="Kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          <Input
            label="Category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
            placeholder="Legal services"
          />
          <Input
            label="City"
            value={form.city}
            onChange={(event) => setForm({ ...form, city: event.target.value })}
            placeholder="New York"
          />
          <Select
            label="Country"
            value={form.country}
            onChange={(event) => setForm({ ...form, country: event.target.value })}
          >
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </Select>
          <Select
            label="Visibility"
            value={form.visibility}
            onChange={(event) => setForm({ ...form, visibility: event.target.value })}
          >
            <option value="public">Public — full number</option>
            <option value="unlisted">Unlisted — masked</option>
            <option value="private">Private — hidden</option>
          </Select>
        </div>

        <Input
          label="Website"
          value={form.website}
          onChange={(event) => setForm({ ...form, website: event.target.value })}
          placeholder="example.com"
        />

        {error ? <p className="tiny" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      </form>
    </Modal>
  );
}

function NumberDetail({ id, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState({ name: '', kind: 'business', category: '', city: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/numbers/${id}`));
    } catch (err) {
      toast.error('Could not load number', err.message);
      onClose();
    } finally {
      setLoading(false);
    }
  }, [id, onClose, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (body) => {
    setSaving(true);
    try {
      await api.patch(`/numbers/${id}`, body);
      await load();
      onChanged?.();
      toast.success('Updated');
    } catch (err) {
      toast.error('Update failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    try {
      await api.post(`/numbers/${id}/verify`, {});
      await load();
      onChanged?.();
      toast.success('Marked verified', 'Trust score increased by 15');
    } catch (err) {
      toast.error('Could not verify', err.message);
    }
  };

  const addListing = async () => {
    if (!listing.name.trim()) return;
    try {
      const result = await api.post(`/numbers/${id}/listings`, listing);
      await load();
      onChanged?.();
      setListing({ ...listing, name: '' });
      toast[result.deduplicated ? 'info' : 'success'](
        result.deduplicated ? 'Listing already present' : 'Listing added'
      );
    } catch (err) {
      toast.error('Could not add listing', err.message);
    }
  };

  const removeListing = async (listingId) => {
    try {
      await api.del(`/listings/${listingId}`);
      await load();
      onChanged?.();
      toast.success('Listing removed');
    } catch (err) {
      toast.error('Could not remove listing', err.message);
    }
  };

  const removeNumber = async () => {
    if (!window.confirm('Delete this number and all of its listings?')) return;
    try {
      await api.del(`/numbers/${id}`);
      onChanged?.();
      onClose();
      toast.success('Number deleted');
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  return (
    <Modal
      wide
      title={data ? data.number.display || prettyNumber(data.number.e164) : 'Loading…'}
      subtitle={data?.number?.id}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" icon="trash" onClick={removeNumber}>Delete</Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" icon="check" onClick={verify} loading={saving}>Mark verified</Button>
        </>
      }
    >
      {loading || !data ? (
        <Loading rows={4} />
      ) : (
        <>
          <div className="grid two" style={{ gap: 12 }}>
            <Select
              label="Status"
              value={data.number.status}
              onChange={(event) => patch({ status: event.target.value })}
            >
              {['registered', 'active', 'reserved', 'ported', 'retired'].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Select
              label="Visibility"
              value={data.number.visibility}
              onChange={(event) => patch({ visibility: event.target.value })}
            >
              <option value="public">Public — full number</option>
              <option value="unlisted">Unlisted — masked</option>
              <option value="private">Private — hidden</option>
            </Select>
            <Select
              label="Line type"
              value={data.number.lineType}
              onChange={(event) => patch({ lineType: event.target.value })}
            >
              {['unknown', 'fixed', 'mobile', 'voip', 'tollfree', 'premium'].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Input
              label="Carrier / region"
              defaultValue={data.number.region}
              onBlur={(event) => patch({ region: event.target.value, carrier: event.target.value })}
              placeholder="Region or carrier"
            />
          </div>

          <dl className="kv">
            <dt>National</dt>
            <dd className="mono">{data.number.national || '—'}</dd>
            <dt>Country</dt>
            <dd>{data.number.country || '—'}</dd>
            <dt>Trust</dt>
            <dd>{data.number.trust} / 100</dd>
            <dt>Verified</dt>
            <dd>{data.number.verifiedAt ? relativeTime(data.number.verifiedAt) : 'not yet'}</dd>
            <dt>Source</dt>
            <dd>{data.number.source}</dd>
            <dt>Extension</dt>
            <dd>{data.extension ? `${data.extension.extension} — ${data.extension.name}` : 'not assigned'}</dd>
          </dl>

          <div>
            <h3 style={{ fontSize: '0.875rem', marginBottom: 8 }}>Listings ({data.listings.length})</h3>
            <div className="stack" style={{ gap: 6 }}>
              {data.listings.length ? (
                data.listings.map((item) => (
                  <div key={item.id} className="row" style={{ padding: '7px 10px', background: 'rgba(255,255,255,.03)', borderRadius: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 550 }}>{item.name}</div>
                      <div className="tiny dim">
                        {item.kind} · {item.city || '—'} {item.verifiedAt ? '· verified' : ''}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="right"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => removeListing(item.id)}
                    >
                      <Icon name="x" size={13} />
                    </Button>
                  </div>
                ))
              ) : (
                <p className="tiny dim">No listing yet.</p>
              )}
            </div>
          </div>

          <div className="panel stack" style={{ gap: 10 }}>
            <div className="row">
              <Icon name="plus" size={14} />
              <strong className="tiny">Attach an entity</strong>
            </div>
            <div className="grid two" style={{ gap: 10 }}>
              <Input
                label="Name"
                value={listing.name}
                onChange={(event) => setListing({ ...listing, name: event.target.value })}
                placeholder="Entity name"
              />
              <Select
                label="Kind"
                value={listing.kind}
                onChange={(event) => setListing({ ...listing, kind: event.target.value })}
              >
                {KINDS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="primary" icon="plus" onClick={addListing} disabled={!listing.name.trim()}>
              Add listing
            </Button>
          </div>

          {data.calls.length ? (
            <div>
              <h3 style={{ fontSize: '0.875rem', marginBottom: 6 }}>Recent activity</h3>
              <div className="stack" style={{ gap: 4 }}>
                {data.calls.slice(0, 4).map((call) => (
                  <div key={call.id} className="row tiny">
                    <Badge tone={statusTone(call.disposition)}>{call.disposition}</Badge>
                    <span className="dim">{relativeTime(call.startedAt)}</span>
                    <span className="right mono dim">{call.duration}s</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
