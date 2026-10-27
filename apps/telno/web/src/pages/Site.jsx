import { useEffect, useMemo, useState } from 'react';
import { api, compactNumber, qs } from '../api.js';
import { BrandMark, useBrand } from '../brand.jsx';
import { Badge, Button, Icon, Input, Loading } from '../ui.jsx';
import { Link, navigate } from '../router.jsx';

/**
 * The public site: introduction, product, pricing, signup.
 *
 * One page because a phone system is bought in one sitting: the visitor reads
 * what it is, sees what each plan includes, and picks one without being sent to
 * a different domain or a different design. Everything it shows — the name, the
 * features, the prices, the registry counters — comes from the database, which
 * is what makes it work white-labelled: an operator edits the catalogue and the
 * brand in the console and this page follows.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(
    (cents || 0) / 100
  );

const STEPS = [
  {
    icon: 'tag',
    title: 'Pick a plan',
    body: 'Choose what the team needs. Plans carry the features, so turning something on later is a plan edit, not a migration.',
  },
  {
    icon: 'numbers',
    title: 'Bring your numbers',
    body: 'Port a line or add a new one. Every number is normalized to E.164 and de-duplicated against the worldwide registry.',
  },
  {
    icon: 'users',
    title: 'Invite the team',
    body: 'A desk phone, a browser softphone, or both on the same extension — calls ring wherever somebody is.',
  },
  {
    icon: 'wave',
    title: 'Turn on the agents',
    body: 'Voice agents answer, campaigns dial, and every call is graded against the goal you wrote for it.',
  },
];

const FAQ = [
  [
    'Are calls encrypted?',
    'Yes. The softphone negotiates DTLS-SRTP with the switch, so the media is encrypted in both directions between the browser or handset and the platform. Like any SRTP deployment, both ends have to speak it — a call to a provider that only does plain RTP cannot be encrypted on that leg, and the console shows the real state rather than claiming otherwise.',
  ],
  [
    'What happens to my numbers if I leave?',
    'They are yours. Numbers are a registry record keyed to your account, and they can be released or ported out. The platform keeps a canonical row per number rather than hiding them inside a PBX table.',
  ],
  [
    'Do I need a desk phone?',
    'No. The browser softphone is a full extension with encrypted audio, video and call recording policy. Desk phones, ATAs and gateways are supported and provision themselves from the platform.',
  ],
  [
    'How does billing work?',
    'Subscriptions run through Stripe, monthly or yearly. Invoices, reminders, final notices and suspension are automatic, and paying online restores service without waiting for an operator.',
  ],
  [
    'Can I run this under my own brand?',
    'Yes. The product name, vendor, accent colour, logo and support addresses are settings, not source code: the site, the console, the signup page and the reports all read them.',
  ],
];

export default function Site() {
  const brand = useBrand();
  const [pricing, setPricing] = useState(null);
  const [stats, setStats] = useState(null);
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openFaq, setOpenFaq] = useState(0);
  const [lookup, setLookup] = useState({ number: '', busy: false, result: null, error: '' });
  const [signupPlan, setSignupPlan] = useState('');
  const [signup, setSignup] = useState({ name: '', email: '', password: '' });
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState('');

  /** The plan the signup form is currently set to buy. */
  const chosenPlan = useMemo(
    () => (pricing?.plans || []).find((plan) => plan.slug === signupPlan) || null,
    [pricing, signupPlan]
  );

  const scrollToSignup = (plan) => {
    if (plan) setSignupPlan(plan.slug);
    document.getElementById('signup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** The hero lookup: the registry answering, on the page that sells it. */
  const runLookup = async (event) => {
    event.preventDefault();
    const number = lookup.number.trim();
    if (!number) return;
    setLookup((current) => ({ ...current, busy: true, error: '', result: null }));
    try {
      const result = await api.get(`/public/lookup${qs({ number })}`);
      setLookup((current) => ({ ...current, busy: false, result }));
    } catch (err) {
      setLookup((current) => ({ ...current, busy: false, error: err.message }));
    }
  };

  // A deployment without a Stripe key cannot open a checkout page; saying so
  // before the form is submitted beats a refused submission at the last step.
  const checkoutOff = pricing?.payments?.configured === false;

  /** Creates the customer account and hands the buyer to Stripe. */
  const startCheckout = async (event) => {
    event.preventDefault();
    if (!chosenPlan) return;
    setSignupError('');
    setSignupBusy(true);
    try {
      const data = await api.post('/public/subscribe', {
        plan: chosenPlan.slug,
        name: signup.name,
        email: signup.email,
        password: signup.password,
        origin: window.location.origin,
      });
      // Stripe's page is outside this app, so this is a real navigation.
      window.location.assign(data.checkoutUrl);
    } catch (err) {
      setSignupError(err.message);
      setSignupBusy(false);
    }
  };

  useEffect(() => {
    let canceled = false;
    Promise.all([
      api.get('/public/plans').catch(() => null),
      api.get('/public/stats').catch(() => null),
      api.get('/public/domains').catch(() => null),
    ]).then(([plans, counters, hosts]) => {
      if (canceled) return;
      setPricing(plans);
      setStats(counters);
      setDomains(hosts?.domains || []);
      // The signup form opens on the plan the page recommends, so a visitor who
      // scrolls straight to it is not met with a disabled button.
      const starter = plans?.plans?.find((plan) => plan.isDefault) || plans?.plans?.[0];
      if (starter) setSignupPlan((current) => current || starter.slug);
      setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, []);

  // The union of every plan's features, in catalogue order: the product story
  // is the same list the pricing table is built from.
  const features = useMemo(() => {
    const seen = new Map();
    for (const plan of pricing?.plans || []) {
      for (const feature of plan.features) {
        if (!seen.has(feature.key)) seen.set(feature.key, feature);
      }
    }
    return [...seen.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }, [pricing]);

  const defaultPlan = (pricing?.plans || []).find((plan) => plan.isDefault) || pricing?.plans?.[0];
  const canonical = domains.find((domain) => domain.host === (pricing?.brand?.domain || domains[0]?.host)) || domains[0];

  return (
    <div className="site">
      <header className="site-nav">
        <Link to="/" className="site-brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="phone" size={15} />
          </span>
          <BrandMark brand={brand} size={26} />
        </Link>

        <nav className="site-links" aria-label="Sections">
          <a href="#product">Product</a>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="#signup">Sign up</a>
          <a href="#faq">FAQ</a>
          {canonical ? (
            <a href={`/d/${canonical.host}`} target="_blank" rel="noreferrer">
              Directory
            </a>
          ) : null}
        </nav>

        <div className="site-actions">
          <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>
            Sign in
          </Button>
          <Button variant="primary" size="sm" onClick={() => scrollToSignup(defaultPlan)}>
            Get started
          </Button>
        </div>
      </header>

      <main>
        <section className="site-hero">
          <span className="site-eyebrow">
            <span className="dot live" /> {brand.vendor}
          </span>
          <h1>{brand.tagline}</h1>
          <p className="site-lede">{brand.description}</p>

          <div className="site-cta">
            <Button variant="primary" size="lg" onClick={() => scrollToSignup(defaultPlan)}>
              Start with {defaultPlan ? defaultPlan.name : 'a plan'}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => navigate('/login')}>
              Open the console
            </Button>
          </div>

          <form className="site-lookup" onSubmit={runLookup}>
            <label htmlFor="site-lookup-number">Look up any number in the worldwide registry</label>
            <div className="site-lookup-row">
              <input
                id="site-lookup-number"
                className="input"
                inputMode="tel"
                autoComplete="off"
                placeholder="+1 202 555 0147"
                value={lookup.number}
                onChange={(event) =>
                  setLookup({ number: event.target.value, busy: false, result: null, error: '' })
                }
              />
              <Button type="submit" variant="primary" loading={lookup.busy}>
                Look up
              </Button>
            </div>

            {lookup.error ? <p className="site-lookup-note bad">{lookup.error}</p> : null}

            {lookup.result?.found ? (
              <div className="site-lookup-card">
                <span className="mono tiny dim">{lookup.result.entry.display}</span>
                <strong>{lookup.result.entry.listings?.[0]?.name || 'Listed number'}</strong>
                <span className="tiny dim">
                  {[
                    lookup.result.entry.lineType,
                    lookup.result.entry.country,
                    ...(lookup.result.entry.listings || []).map((listing) => listing.kind).slice(0, 2),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <a
                  className="tiny"
                  href={`/lookup?number=${encodeURIComponent(lookup.result.parsed?.e164 || lookup.number)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the full listing
                </a>
              </div>
            ) : lookup.result ? (
              <p className="site-lookup-note">
                Not listed yet.{' '}
                <a
                  href={`/lookup?number=${encodeURIComponent(lookup.result.parsed?.e164 || lookup.number)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Claim it on the directory
                </a>
                .
              </p>
            ) : null}
          </form>

          <div className="site-proof">
            {stats?.numbers ? (
              <div>
                <strong>{compactNumber(stats.numbers)}</strong>
                <span>numbers indexed</span>
              </div>
            ) : null}
            {stats?.listings ? (
              <div>
                <strong>{compactNumber(stats.listings)}</strong>
                <span>directory listings</span>
              </div>
            ) : null}
            {stats?.countries ? (
              <div>
                <strong>{compactNumber(stats.countries)}</strong>
                <span>countries</span>
              </div>
            ) : null}
            <div>
              <strong>{(domains.length || stats?.domains || 0) || 6}</strong>
              <span>directory hostnames</span>
            </div>
            <div>
              <strong>{(pricing?.plans || []).length}</strong>
              <span>plans on sale</span>
            </div>
          </div>
        </section>

        <section id="product" className="site-section">
          <div className="site-section-head">
            <h2>All of it, in one place.</h2>
            <p>
              A switch, a console, a registry and the billing that keeps them paid for — one container, one
              database, one identity. Nothing here is an integration you have to keep alive.
            </p>
          </div>

          <div className="site-cards">
            <article className="site-card wide">
              <span className="site-icon">
                <Icon name="shield" size={18} />
              </span>
              <h3>Encrypted calling, in the browser and on the desk</h3>
              <p>
                The softphone registers over secure WebSocket and negotiates DTLS-SRTP with the switch, so audio
                and video are encrypted end to end. Recording follows a per-agent, per-direction policy that is
                written into the dialplan — not a checkbox that only exists in a UI.
              </p>
              <ul className="site-list">
                <li>Video calling in the browser and on supported handsets</li>
                <li>Call recordings, voicemail audio and fax documents on the data volume</li>
                <li>The softphone opens in its own window and keeps the line registered while you work</li>
              </ul>
            </article>

            <article className="site-card">
              <span className="site-icon">
                <Icon name="wave" size={18} />
              </span>
              <h3>Voice agents that answer and dial</h3>
              <p>
                Give an agent a greeting, a script and a number. Edit the script whenever; the next call uses it.
                Turn it on for inbound, outbound, or both.
              </p>
            </article>

            <article className="site-card">
              <span className="site-icon">
                <Icon name="megaphone" size={18} />
              </span>
              <h3>Campaigns with graded reports</h3>
              <p>
                Import a list, work it from the softphone or an agent, record what happened, and every call is
                graded against the campaign's own goal. The report arrives as a PDF, by email.
              </p>
            </article>

            <article className="site-card wide">
              <span className="site-icon">
                <Icon name="book" size={18} />
              </span>
              <h3>A worldwide phonebook, on its own hostnames</h3>
              <p>
                The same registry serves every directory surface, with one canonical row per number, verified
                listings and a suppression list that outlives any single campaign.
              </p>
              <div className="site-domains">
                {domains.map((domain) => (
                  <a key={domain.host} href={`/d/${domain.host}`} target="_blank" rel="noreferrer">
                    {domain.host}
                  </a>
                ))}
                {!domains.length ? <span className="tiny dim">Directory hostnames appear once configured.</span> : null}
              </div>
            </article>
          </div>
        </section>

        <section id="features" className="site-section">
          <div className="site-section-head">
            <h2>What every plan can carry.</h2>
            <p>
              Features are a catalogue, not a code branch. What is listed under a plan below is exactly what the
              platform will let that account use.
            </p>
          </div>
          <div className="site-features">
            {features.map((feature) => (
              <div key={feature.key} className="site-feature">
                <Icon name="check" size={14} />
                <div>
                  <strong>{feature.label}</strong>
                  <span>{feature.description}</span>
                </div>
              </div>
            ))}
            {!features.length ? <Loading rows={2} /> : null}
          </div>
        </section>

        <section id="how" className="site-section">
          <div className="site-section-head">
            <h2>Four steps, then it rings.</h2>
          </div>
          <ol className="site-steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="site-step-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="site-icon">
                  <Icon name={step.icon} size={18} />
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="pricing" className="site-section">
          <div className="site-section-head">
            <h2>Pricing.</h2>
            <p>Monthly or yearly, billed by card through Stripe. Change plan or cancel from the portal.</p>
          </div>

          {loading ? (
            <Loading rows={3} />
          ) : (
            <div className="pricing-grid">
              {(pricing?.plans || []).map((plan) => (
                <div key={plan.id} className={`price-card${plan.isDefault ? ' featured' : ''}`}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h3>{plan.name}</h3>
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
                    onClick={() => scrollToSignup(plan)}
                  >
                    Choose {plan.name}
                  </Button>
                </div>
              ))}
              {!(pricing?.plans || []).length ? <p className="muted">No plans are on sale yet.</p> : null}
            </div>
          )}

          <p className="site-fineprint">
            Prices in USD. Card details are entered on Stripe's page and never touch this platform.
            {brand.salesEmail ? <> Questions? <a href={`mailto:${brand.salesEmail}`}>{brand.salesEmail}</a>.</> : null}
          </p>

          <div id="signup" className="site-signup">
            <div className="site-signup-copy">
              <h3>Open your account</h3>
              <p>
                Pick the plan, create the login that owns it, and finish on Stripe. The account exists as soon as
                this form submits; the plan turns on when Stripe confirms the payment.
              </p>
              <ul className="site-list">
                <li>A desk phone, a browser softphone, or both on the same extension.</li>
                <li>Already a customer? Enter the same email and password to reach checkout again.</li>
                <li>The directory stays readable without an account — only the console is paid.</li>
              </ul>
              {brand.salesEmail ? (
                <p className="tiny dim">
                  Buying for a team? <a href={`mailto:${brand.salesEmail}`}>{brand.salesEmail}</a>.
                </p>
              ) : null}
              <p className="tiny dim">
                Already subscribed? <Link to="/login">Sign in to the console</Link>.
              </p>
            </div>

            <form className="site-signup-form" onSubmit={startCheckout} noValidate>
              <div className="site-plan-picker" role="radiogroup" aria-label="Plan">
                {(pricing?.plans || []).map((plan) => (
                  <button
                    type="button"
                    key={plan.id}
                    role="radio"
                    aria-checked={chosenPlan?.slug === plan.slug}
                    className={`site-plan${chosenPlan?.slug === plan.slug ? ' on' : ''}`}
                    onClick={() => setSignupPlan(plan.slug)}
                  >
                    <span>{plan.name}</span>
                    <strong>{money(plan.priceCents, plan.currency)}</strong>
                    <span className="tiny dim">/{plan.interval}</span>
                  </button>
                ))}
              </div>

              <Input
                label="Full name"
                autoComplete="name"
                required
                value={signup.name}
                onChange={(event) => setSignup({ ...signup, name: event.target.value })}
                placeholder="Dana Whitfield"
              />
              <Input
                label="Work email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={signup.email}
                onChange={(event) => setSignup({ ...signup, email: event.target.value })}
                placeholder="you@company.com"
              />
              <Input
                label="Password"
                type="password"
                autoComplete="new-password"
                required
                hint="10 characters or more for a new account."
                value={signup.password}
                onChange={(event) => setSignup({ ...signup, password: event.target.value })}
                placeholder="••••••••••"
              />

              {signupError ? <p className="site-lookup-note bad">{signupError}</p> : null}
              {checkoutOff ? (
                <p className="site-lookup-note">
                  Card checkout is not switched on for this deployment yet. Add the Stripe key in the console under
                  Settings, or {brand.salesEmail ? <a href={`mailto:${brand.salesEmail}`}>contact sales</a> : 'contact sales'} to
                  be invoiced instead.
                </p>
              ) : null}

              <Button
                type="submit"
                variant="primary"
                loading={signupBusy}
                disabled={!chosenPlan || checkoutOff}
              >
                {chosenPlan
                  ? `Continue with ${chosenPlan.name} — ${money(chosenPlan.priceCents, chosenPlan.currency)}/${chosenPlan.interval}`
                  : 'Choose a plan'}
              </Button>
              <p className="tiny dim">
                You will be taken to Stripe's secure checkout. Cancel or change plan from the portal at any time.
              </p>
            </form>
          </div>
        </section>

        <section id="faq" className="site-section">
          <div className="site-section-head">
            <h2>Questions people ask first.</h2>
          </div>
          <div className="site-faq">
            {FAQ.map(([question, answer], index) => (
              <details key={question} open={openFaq === index} onToggle={() => setOpenFaq(index)}>
                <summary>
                  {question}
                  <Icon name="chevron" size={14} />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="site-closing">
          <h2>Ready when the phone is.</h2>
          <p>
            Choose a plan, keep your numbers, and the first call can land in minutes. No hardware required to
            start.
          </p>
          {brand.supportEmail ? <p className="tiny dim">Support: {brand.supportEmail}</p> : null}
          <div className="site-cta">
            <Button variant="primary" size="lg" onClick={() => scrollToSignup(defaultPlan)}>
              Choose a plan
            </Button>
            <Button variant="ghost" size="lg" onClick={() => navigate('/login')}>
              Sign in
            </Button>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="site-foot-brand">
          <BrandMark brand={brand} size={22} />
          <span className="tiny dim">A product of {brand.vendor}</span>
        </div>
        <nav aria-label="Footer">
          <a href="#product">Product</a>
          <a href="#pricing">Pricing</a>
          <a href="#signup">Sign up</a>
          <a href="#faq">FAQ</a>
          {canonical ? (
            <a href={`/d/${canonical.host}`} target="_blank" rel="noreferrer">
              Directory
            </a>
          ) : null}
          <Link to="/login">Console</Link>
        </nav>
        <span className="tiny dim">{brand.footerNote}</span>
      </footer>
    </div>
  );
}
