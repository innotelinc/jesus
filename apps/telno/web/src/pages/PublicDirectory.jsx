import { useEffect, useMemo, useRef, useState } from 'react';
import { api, compactNumber } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Input, Loading, Select, useToast } from '../ui.jsx';

const KIND_OPTIONS = [
  ['business', 'Business'],
  ['person', 'Person'],
  ['service', 'Service'],
  ['government', 'Government'],
  ['emergency', 'Emergency'],
];

export default function PublicDirectory({ host, search }) {
  const toast = useToast();
  const [domains, setDomains] = useState([]);
  const [stats, setStats] = useState(null);
  const [domain, setDomain] = useState(null);
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [countryList, setCountryList] = useState([]);
  const [tab, setTab] = useState('search');
  const debounce = useRef();

  // Branding: match the requested host, fall back to the canonical one.
  useEffect(() => {
    let canceled = false;
    api
      .get('/public/domains')
      .then((data) => {
        if (canceled) return;
        setDomains(data.domains);
        const wanted = (host || '').toLowerCase();
        setDomain(data.domains.find((d) => d.host === wanted) || data.domains.find((d) => d.host === data.canonical) || data.domains[0]);
      })
      .catch(() => {});
    api.get('/public/stats').then((data) => !canceled && setStats(data)).catch(() => {});
    api
      .get('/public/countries')
      .then((data) => !canceled && setCountryList(data.countries))
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [host]);

  useEffect(() => {
    const params = new URLSearchParams(search || '');
    const initial = params.get('q');
    if (initial) {
      setQuery(initial);
      runSearch(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const runSearch = async (value, countryCode = country) => {
    const term = value ?? query;
    if (!term.trim() && !countryCode) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await api.get(
        `/public/search?q=${encodeURIComponent(term)}&limit=40${countryCode ? `&country=${countryCode}` : ''}`
      );
      setResults(data);
    } catch (err) {
      toast.error('Search failed', err.message);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    clearTimeout(debounce.current);
    if (!query.trim() && !country) return;
    debounce.current = setTimeout(() => runSearch(query), 320);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, country]);

  const accent = domain?.accent || '#635bff';
  const style = useMemo(() => ({ '--domain-accent': accent }), [accent]);

  return (
    <div className="public" style={style}>
      <header className="public-top">
        <span className="brand-mark" aria-hidden="true" style={{ background: `linear-gradient(150deg, ${accent}, #a78bfa)` }}>
          <Icon name="book" size={14} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }} className="truncate">
            {domain?.label || 'Telno Directory'}
          </div>
          <div className="tiny dim mono truncate">{domain?.host || 'telno.directory'}</div>
        </div>
        <div className="row right" style={{ gap: 6 }}>
          <a className="btn ghost sm" href="/login">
            Operator
          </a>
        </div>
      </header>

      <section className="public-hero">
        <Badge tone="accent" dot="live">
          {stats ? `${compactNumber(stats.numbers)} numbers · ${stats.countries} countries` : 'worldwide directory'}
        </Badge>
        <h1>
          Find any number. <span className="accent-text">Worldwide.</span>
        </h1>
        <p>{domain?.tagline || 'A single, verified phonebook. Every listing is de-duplicated and owned by its number holder.'}</p>

        <div className="big-search" role="search">
          <div className="search" style={{ flex: 1 }}>
            <Icon name="search" size={17} />
            <input
              className="input"
              placeholder="Name, business or phone number…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && runSearch()}
              aria-label="Search the directory"
              autoComplete="off"
            />
          </div>
          <Button variant="primary" onClick={() => runSearch()} loading={searching}>
            Search
          </Button>
        </div>

        <div className="row wrap" style={{ justifyContent: 'center', gap: 10 }}>
          <select
            className="select"
            style={{ width: 190 }}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            aria-label="Filter by country"
          >
            <option value="">All countries</option>
            {countryList.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.name} (+{c.dial})
              </option>
            ))}
          </select>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>
              Search
            </button>
            <button role="tab" aria-selected={tab === 'submit'} onClick={() => setTab('submit')}>
              List your number
            </button>
            <button role="tab" aria-selected={tab === 'remove'} onClick={() => setTab('remove')}>
              Remove
            </button>
          </div>
        </div>

        {stats ? (
          <div className="stat-strip">
            <div>
              <b>{compactNumber(stats.listings)}</b>
              <span>listings</span>
            </div>
            <div>
              <b>{compactNumber(stats.verified)}</b>
              <span>verified</span>
            </div>
            <div>
              <b>{stats.countries}</b>
              <span>countries</span>
            </div>
            <div>
              <b>{stats.domains}</b>
              <span>hostnames</span>
            </div>
          </div>
        ) : null}
      </section>

      <main className="public-body">
        {tab === 'search' ? (
          <Card bodyClass={results?.results?.length ? 'tight' : ''}>
            {searching ? (
              <div style={{ padding: 18 }}>
                <Loading rows={3} />
              </div>
            ) : results ? (
              results.results.length ? (
                <>
                  <div className="row tiny dim" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                    {results.total} {results.total === 1 ? 'result' : 'results'}
                    <span className="right">
                      {results.mode === 'number' ? 'matched by number' : 'matched by name'}
                    </span>
                  </div>
                  {results.results.map((row) => (
                    <div className="result" key={row.id}>
                      <div className="avatar">{(row.name || '?').slice(0, 2)}</div>
                      <div className="result-main">
                        <div className="row wrap" style={{ gap: 7 }}>
                          <span className="result-name truncate">{row.name}</span>
                          {row.verified ? <Badge tone="success">verified</Badge> : null}
                          {row.kind !== 'business' ? <Badge tone="neutral">{row.kind}</Badge> : null}
                        </div>
                        <div className="result-meta">
                          {row.category ? <span>{row.category}</span> : null}
                          {row.city ? <span>{row.city}</span> : null}
                          {row.country ? <span>{row.country}</span> : null}
                          {row.lineType && row.lineType !== 'unknown' ? <span>· {row.lineType}</span> : null}
                          {row.languages?.length ? <span>· {row.languages.join(', ')}</span> : null}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                        <span className={`result-number ${row.masked ? 'masked' : ''}`}>{row.display}</span>
                        {row.masked ? <span className="tiny dim">owner-only</span> : null}
                        {row.website ? (
                          <a
                            className="tiny dim row"
                            href={row.website}
                            target="_blank"
                            rel="noreferrer noopener"
                            style={{ gap: 3 }}
                          >
                            website <Icon name="external" size={10} />
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <Empty icon="search" title="No match in the directory">
                  {results.mode === 'number'
                    ? 'This number has no public listing. You can add it with verification.'
                    : 'Try a shorter name, or search by the phone number.'}
                </Empty>
              )
            ) : (
              <Empty icon="book" title="Search the worldwide phonebook">
                Type a business, a person or a phone number. Unlisted numbers show a masked form by design.
              </Empty>
            )}
          </Card>
        ) : null}

        {tab === 'submit' ? <SubmitFlow domain={domain} onDone={() => setTab('search')} /> : null}
        {tab === 'remove' ? <RemoveFlow /> : null}
      </main>

      <footer className="public-foot">
        <div className="public-foot-inner">
          <span>© {new Date().getFullYear()} Telno — one registry, many doors:</span>
          {domains.map((item) => (
            <a key={item.slug} href={`/d/${item.host}`} aria-current={item.host === domain?.host ? 'page' : undefined}>
              {item.host}
            </a>
          ))}
          <span className="right">Listings are removed on request, no questions asked.</span>
        </div>
      </footer>
    </div>
  );
}

function SubmitFlow({ domain, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    number: '',
    name: '',
    kind: 'business',
    category: '',
    city: '',
    country: '',
    website: '',
    email: '',
    channel: 'email',
    phone: '',
    notes: '',
  });
  const [submission, setSubmission] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = { ...form, domain: domain?.slug };
      if (form.channel === 'sms' && !form.phone) payload.phone = form.number;
      const result = await api.post('/public/submissions', payload);
      setSubmission(result);
      if (result.status === 'duplicate') {
        toast.info('Already listed', result.message);
        setStep(3);
      } else {
        setStep(2);
        if (result.devCode) setCode(result.devCode);
        toast.success('Verification sent', result.message);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post(`/public/submissions/${submission.id}/verify`, { code });
      if (result.status === 'verified' || result.alreadyVerified) {
        setSubmission({ ...submission, status: 'verified' });
        setStep(3);
        toast.success('Number verified', 'Your listing is queued for review.');
      } else {
        setError(result.message || 'Could not verify that code.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="List a number"
      subtitle="The number owner verifies by code, then an operator reviews it"
      actions={
        <div className="steps">
          <span className="step" data-active={step === 1} data-done={step > 1}>
            <i>{step > 1 ? '✓' : '1'}</i> Details
          </span>
          <span className="step" data-active={step === 2} data-done={step > 2}>
            <i>{step > 2 ? '✓' : '2'}</i> Verify
          </span>
          <span className="step" data-active={step === 3}>
            <i>3</i> Done
          </span>
        </div>
      }
    >
      {step === 1 ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="grid two" style={{ gap: 12 }}>
            <Input
              label="Phone number"
              className="mono"
              value={form.number}
              onChange={(event) => setForm({ ...form, number: event.target.value })}
              placeholder="+1 (415) 555-0123"
              hint="Include the country code"
              autoFocus
            />
            <Input
              label="Name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Business or person"
            />
            <Select label="Kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              {KIND_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
            <Input
              label="Category"
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
              placeholder="Restaurant"
            />
            <Input
              label="City"
              value={form.city}
              onChange={(event) => setForm({ ...form, city: event.target.value })}
              placeholder="San Francisco"
            />
            <Input
              label="Country code"
              value={form.country}
              onChange={(event) => setForm({ ...form, country: event.target.value.toUpperCase().slice(0, 2) })}
              placeholder="CA"
              className="mono"
              hint="Optional — derived from the number"
            />
          </div>

          <Input
            label="Website"
            value={form.website}
            onChange={(event) => setForm({ ...form, website: event.target.value })}
            placeholder="example.com"
          />

          <div className="panel stack" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 14 }}>
              <span className="field-label">Verify by</span>
              <label className="switch">
                <input
                  type="radio"
                  name="channel"
                  checked={form.channel === 'email'}
                  onChange={() => setForm({ ...form, channel: 'email' })}
                  style={{ position: 'absolute', opacity: 0 }}
                />
                <span>{form.channel === 'email' ? '◉' : '○'} Email</span>
              </label>
              <label className="switch">
                <input
                  type="radio"
                  name="channel"
                  checked={form.channel === 'sms'}
                  onChange={() => setForm({ ...form, channel: 'sms' })}
                  style={{ position: 'absolute', opacity: 0 }}
                />
                <span>{form.channel === 'sms' ? '◉' : '○'} SMS to the number</span>
              </label>
            </div>
            {form.channel === 'email' ? (
              <Input
                label="Email for the code"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="owner@example.com"
                hint="Not published — used only to deliver the verification code."
              />
            ) : (
              <p className="tiny dim">
                We send the code by SMS to {form.number || 'the number above'}. Standard message rates apply.
              </p>
            )}
          </div>

          <label className="sr-only" aria-hidden="true">
            Company URL
            <input tabIndex={-1} autoComplete="off" value={form.company_url || ''} onChange={(event) => setForm({ ...form, company_url: event.target.value })} />
          </label>

          {error ? <p className="tiny" style={{ color: 'var(--danger)' }} role="alert">{error}</p> : null}

          <div className="row">
            <p className="tiny dim" style={{ maxWidth: '52ch' }}>
              By submitting you confirm you are authorized to list this number. We never publish the contact
              address used for verification.
            </p>
            <Button variant="primary" className="right" onClick={submit} loading={busy}>
              Send verification code
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="stack" style={{ gap: 12, maxWidth: 420 }}>
          <p className="tiny muted">{submission?.message}</p>
          <Input
            label="6-digit code"
            className="code-input"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            error={error || undefined}
            autoFocus
          />
          <div className="row">
            <Button variant="primary" onClick={verify} loading={busy} disabled={code.length !== 6}>
              Verify number
            </Button>
            <Button variant="ghost" onClick={() => setStep(1)} className="right">
              Back
            </Button>
          </div>
          <p className="tiny dim">
            Codes expire after 10 minutes. Nothing is published until an operator approves the listing.
          </p>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="stack" style={{ gap: 10, maxWidth: 520 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="badge success">{submission?.status === 'duplicate' ? 'already listed' : 'verified'}</span>
          </div>
          <h3 style={{ fontSize: '1rem' }}>
            {submission?.status === 'duplicate' ? 'This listing already exists' : 'Thanks — the number is verified'}
          </h3>
          <p className="tiny muted">
            {submission?.status === 'duplicate'
              ? submission.message
              : 'Your listing is in the review queue. Most reviews finish within one business day, and the number appears in every directory host once approved.'}
          </p>
          <div className="row">
            <Button variant="primary" onClick={onDone}>
              Back to search
            </Button>
            <Button variant="ghost" onClick={() => { setStep(1); setCode(''); setSubmission(null); }}>
              Submit another
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function RemoveFlow() {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.post('/public/optout', { number, reason });
      setDone(true);
      toast.success('Removal requested', result.message);
    } catch (err) {
      toast.error('Could not submit', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Remove a number" subtitle="Immediate, no account needed">
      {done ? (
        <div className="stack" style={{ gap: 10, maxWidth: 520 }}>
          <Badge tone="success">request received</Badge>
          <p className="muted tiny">
            If this number was listed, it is no longer shown publicly and is excluded from search and from all six
            directory hostnames. Nothing else about the request is stored.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12, maxWidth: 520 }}>
          <Input
            label="Phone number"
            className="mono"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            placeholder="+1 415 555 0123"
            hint="The number you want removed from every directory host."
            autoFocus
          />
          <Input
            label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="I no longer own this line"
          />
          <Button variant="danger" onClick={submit} loading={busy} disabled={number.trim().length < 6}>
            Remove from the directory
          </Button>
          <p className="tiny dim">
            Business listings are removed here too. The same answer is returned whether or not the number was
            listed, so this form cannot be used to test whether a number is in the registry.
          </p>
        </div>
      )}
    </Card>
  );
}
