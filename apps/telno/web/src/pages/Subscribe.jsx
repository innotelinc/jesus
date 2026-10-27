import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { BrandMark, useBrand } from '../brand.jsx';
import { Badge, Button, Icon, Input, Loading, Modal, useToast } from '../ui.jsx';
import { Link, navigate } from '../router.jsx';
import { useAuth } from '../auth.jsx';

/**
 * The public subscribe page, and the screen an unpaid customer sees.
 *
 * It is deliberately the same component for both: a customer whose subscription
 * lapsed is shown the plans they can buy, not a login wall. The page is public
 * because a stranger has to reach it without an account, and the account is
 * created as part of buying.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

export default function Subscribe({ locked = null, user = null }) {
  const toast = useToast();
  const brand = useBrand();
  const { logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const status = params.get('status');
  // The site's plan buttons arrive here with the choice already made, so the
  // visitor does not have to pick twice.
  const wantedPlan = params.get('plan');

  useEffect(() => {
    let canceled = false;
    api
      .get('/public/plans')
      .then((data) => !canceled && setPricing(data))
      .catch((err) => toast.error('Could not load the plans', err.message))
      .finally(() => !canceled && setLoading(false));
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status === 'success') setSuccess(true);
  }, [status]);

  useEffect(() => {
    if (!wantedPlan || !pricing || chosen) return;
    const match = pricing.plans?.find((plan) => plan.slug === wantedPlan || plan.id === wantedPlan);
    if (match) setChosen(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedPlan, pricing]);

  useEffect(() => {
    if (user?.email) setForm((current) => ({ ...current, email: current.email || user.email, name: current.name || user.name || '' }));
  }, [user]);

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      const data = await api.post('/public/subscribe', {
        plan: chosen.slug,
        name: form.name,
        email: form.email,
        password: form.password,
        origin: window.location.origin,
      });
      // Full navigation: Stripe's page is outside this app.
      window.location.assign(data.checkoutUrl);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="public-shell">
        <Loading rows={4} />
      </div>
    );
  }

  const plans = pricing?.plans || [];

  return (
    <div className="public-shell">
      <header className="public-nav">
        <Link to="/" className="row" style={{ gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <span className="brand-mark" aria-hidden="true">
            <Icon name="phone" size={15} />
          </span>
          <BrandMark brand={brand} size={24} />
        </Link>
        <span className="tiny dim">A product of {brand.vendor}</span>
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          {user && !locked ? (
            <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
              Back to the console
            </Button>
          ) : user ? (
            // A signed-in customer with no subscription: signing out is the one
            // useful action here, because "the console" is what they cannot reach.
            <Button variant="ghost" size="sm" onClick={logout}>
              Sign out ({user.email})
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>
              Sign in
            </Button>
          )}
        </div>
      </header>

      {locked ? (
        <div className="public-notice">
          <Icon name="lock" size={16} />
          <div>
            <strong>The portal is for subscribers</strong>
            <p className="tiny" style={{ margin: '2px 0 0' }}>
              {locked}
            </p>
          </div>
        </div>
      ) : null}

      {success ? (
        <div className="public-notice good">
          <Icon name="check" size={16} />
          <div>
            <strong>Payment received</strong>
            <p className="tiny" style={{ margin: '2px 0 0' }}>
              {locked
                ? 'Your subscription is active. Open the console — the next request lets you in.'
                : 'Your account is ready. Sign in with the email and password you just chose.'}
            </p>
          </div>
          <Button size="sm" variant="primary" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </div>
      ) : null}

      <section className="public-hero">
        <Badge tone="neutral" dot="live">
          Encrypted calling, voice agents and the worldwide registry
        </Badge>
        <h1>{brand.tagline}</h1>
        <p className="muted">
          {brand.description} Billed by card, cancel any time.
        </p>
      </section>

      <div className="pricing-grid">
        {plans.map((plan) => (
          <div key={plan.id} className={`price-card${plan.isDefault ? ' featured' : ''}`}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2>{plan.name}</h2>
              {plan.isDefault ? <Badge tone="success">Most chosen</Badge> : null}
            </div>
            <div className="price-row">
              <strong>{money(plan.priceCents, plan.currency)}</strong>
              <span className="tiny dim">/{plan.interval}</span>
            </div>
            <p className="tiny muted">{plan.tagline}</p>
            <div className="row wrap" style={{ gap: 10 }}>
              <span className="tiny dim">{plan.seats} seats</span>
              <span className="tiny dim">·</span>
              <span className="tiny dim">{plan.includedMinutes.toLocaleString()} minutes</span>
            </div>
            <ul className="plan-features">
              {plan.features.map((feature) => (
                <li key={feature.key}>
                  <Icon name="check" size={13} /> {feature.label}
                </li>
              ))}
            </ul>
            <Button
              variant={plan.isDefault ? 'primary' : ''}
              onClick={() => {
                setChosen(plan);
                setError('');
              }}
            >
              Choose {plan.name}
            </Button>
          </div>
        ))}
        {!plans.length ? <p className="muted">No plans are on sale yet.</p> : null}
      </div>

      <footer className="public-foot">
        <span>
          {pricing?.product || 'Telno'} · {pricing?.vendor || 'Innotel Labs'}
        </span>
        <span className="tiny dim">
          Card payments are handled by Stripe. Cancel from the portal; access runs to the end of the period you paid for.
        </span>
      </footer>

      {chosen ? (
        <Modal
          title={`Subscribe to ${chosen.name}`}
          subtitle={`${money(chosen.priceCents, chosen.currency)} per ${chosen.interval}, billed by Stripe`}
          onClose={() => setChosen(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setChosen(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!form.email.trim() || !form.password}
                onClick={start}
              >
                Continue to payment
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input
              label="Name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Dana Reed"
            />
            <Input
              label="Work email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="you@company.com"
            />
            <Input
              label="Password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              hint="At least 10 characters. This is what opens the portal after payment."
              error={error || undefined}
            />
            <p className="tiny dim" style={{ margin: 0 }}>
              Already have an account? Enter its password and the subscription is added to it. A staff console
              account cannot be turned into a customer one — use a different address.
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
