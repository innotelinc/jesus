import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, Button, Card, Icon, Input, PageHeader, useToast } from '../ui.jsx';

/**
 * The account this console session signs in as.
 *
 * Its reason to exist is the credential a fresh install generates: at first boot
 * the owner's password is written to the data volume, and the only way to retire
 * it used to be a curl against `POST /api/auth/password`. A screen is where an
 * operator actually is, so this is where that now happens.
 *
 * It is deliberately about one account and nothing else — a subscriber signs in
 * to the portal, not here, so no customer data belongs on this page.
 */

// The route's own floor (`min: 10` in src/routes/auth.js). Checked here too, so
// a short password is answered immediately instead of by a round trip.
const MIN_LENGTH = 10;

export default function Account() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  // The address this account signs in with. Separated from the password form
  // because the two are different promises: one changes a credential, the other
  // changes where the platform reaches you, and both need the same proof.
  const [address, setAddress] = useState({ email: '', current: '' });
  const [addressBusy, setAddressBusy] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [firstRun, setFirstRun] = useState(null);

  // Whether this install still has a generated password on the volume. The
  // server answers that only for an owner, and it sends the file's path rather
  // than its contents — this page never sees the credential.
  useEffect(() => {
    let canceled = false;
    api
      .get('/auth/me')
      .then((data) => {
        if (!canceled) setFirstRun(data.firstRun || null);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);

  const field = (key) => (event) => setForm((state) => ({ ...state, [key]: event.target.value }));

  const submitAddress = async (event) => {
    event.preventDefault();
    setAddressError('');
    const next = address.email.trim().toLowerCase();
    if (next === String(user?.email || '').toLowerCase()) {
      setAddressError('That is already the address you sign in with.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      setAddressError('That is not an email address.');
      return;
    }
    setAddressBusy(true);
    try {
      const result = await api.post('/auth/email', { email: next, currentPassword: address.current });
      // The session survives a change of address, and the answer carries the
      // account as the database now sees it — so the header updates without a
      // reload that would strand the operator on a page about a stale identity.
      setUser(result.user);
      toast.success('Email address changed', `${result.previous} → ${result.user.email}`);
      setAddress({ email: '', current: '' });
    } catch (err) {
      setAddressError(err.message);
    } finally {
      setAddressBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (form.next.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (form.next !== form.confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    if (form.next === form.current) {
      setError('The new password must be different from the current one.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post('/auth/password', {
        currentPassword: form.current,
        newPassword: form.next,
      });
      setForm({ current: '', next: '', confirm: '' });
      if (result.firstRunCredentialRemoved) setFirstRun(null);
      toast.success(
        'Password changed',
        result.firstRunCredentialRemoved
          ? 'The generated first-run password file was deleted — the credential on the volume is dead.'
          : 'Every other session was signed out. This browser has a fresh one.'
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(form.current && form.next && form.confirm);

  return (
    <>
      <PageHeader
        title="Account"
        subtitle={user?.email ? `Signed in as ${user.email}` : 'Your sign-in identity'}
      />

      {firstRun?.pending ? (
        <Card
          title="The password this install generated is still on the volume"
          subtitle="First boot created the owner account and wrote the password here instead of printing it"
          actions={
            <Badge tone="warning" dot>
              Retire it
            </Badge>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <p className="tiny" style={{ margin: 0 }}>
              Read it on the host — it is the only copy, and nothing in the platform can show it to you:
            </p>
            <div className="panel row" style={{ gap: 8 }}>
              <span className="mono tiny truncate" style={{ flex: 1 }}>
                {`docker compose exec telno cat ${firstRun.file}`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="copy"
                onClick={() => {
                  navigator.clipboard?.writeText(`docker compose exec telno cat ${firstRun.file}`);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
            </div>
            <p className="tiny dim" style={{ margin: 0 }}>
              Then change the password below: the file is deleted as soon as you do, because the generated
              password stops working at that moment. Setting <span className="mono">ADMIN_PASSWORD</span> before
              the first boot skips this entirely — no file is written at all.
            </p>
          </div>
        </Card>
      ) : null}

      <Card
        title="Email address"
        subtitle="The address this console signs in with, and where the platform writes to you"
        actions={<Badge tone="neutral"><Icon name="mail" size={12} /> {user?.email || '—'}</Badge>}
      >
        <form className="stack" onSubmit={submitAddress} noValidate>
          <div className="grid two">
            <Input
              label="New email address"
              type="email"
              autoComplete="email"
              value={address.email}
              onChange={(event) => setAddress({ ...address, email: event.target.value })}
              placeholder="you@example.com"
              hint="The address the next sign-in uses. Letters only differ in case, not identity."
            />
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={address.current}
              onChange={(event) => setAddress({ ...address, current: event.target.value })}
              placeholder="••••••••••"
              hint="Proves it is you, not whoever has the browser open."
            />
          </div>
          {addressError ? (
            <p className="tiny" style={{ margin: 0, color: 'var(--danger)' }} role="alert">
              {addressError}
            </p>
          ) : null}
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <Button type="submit" variant="primary" icon="check" loading={addressBusy} disabled={!address.email || !address.current}>
              Change email
            </Button>
            <span className="tiny dim">Sessions stay signed in: an address is not a credential.</span>
          </div>
        </form>
      </Card>

      <Card
        title="Change password"
        subtitle="Retires the generated credential and signs every other session out"
        actions={
          <Badge tone="neutral">
            <Icon name={firstRun?.pending ? 'alert' : 'lock'} size={12} /> {firstRun?.pending ? 'Generated password still active' : 'Your own password'}
          </Badge>
        }
      >
        <form className="stack" onSubmit={submit} noValidate>
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={form.current}
            onChange={field('current')}
            placeholder="••••••••••"
            hint="The password you just signed in with."
          />
          <div className="grid two">
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              value={form.next}
              onChange={field('next')}
              placeholder="••••••••••"
              hint={`At least ${MIN_LENGTH} characters.`}
            />
            <Input
              label="Repeat new password"
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={field('confirm')}
              placeholder="••••••••••"
              hint="Typed again, in case of a typo you would not notice."
            />
          </div>

          {error ? (
            <p className="tiny" style={{ margin: 0, color: 'var(--danger)' }} role="alert">
              {error}
            </p>
          ) : null}

          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <Button type="submit" variant="primary" icon="check" loading={busy} disabled={!ready}>
              Change password
            </Button>
            <span className="tiny dim">
              Tokens issued to every other browser are invalidated. This one keeps working.
            </span>
          </div>
        </form>
      </Card>
    </>
  );
}
