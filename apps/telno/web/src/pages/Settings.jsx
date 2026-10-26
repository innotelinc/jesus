import { useCallback, useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
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
  Switch,
  useToast,
} from '../ui.jsx';

const CONFIG_FILES = ['pjsip.conf', 'extensions.conf', 'voicemail.conf', 'manager.conf'];

export default function Settings() {
  const toast = useToast();
  const [domains, setDomains] = useState([]);
  const [keys, setKeys] = useState([]);
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState(null);
  const [configFile, setConfigFile] = useState('pjsip.conf');
  const [config, setConfig] = useState('');
  const [loading, setLoading] = useState(true);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [applying, setApplying] = useState(false);
  const [vault, setVault] = useState({ items: [], channels: null });
  const [mailKey, setMailKey] = useState('');
  const [mailFrom, setMailFrom] = useState('');
  const [stripeKey, setStripeKey] = useState('');
  const [stripeSecret, setStripeSecret] = useState('');
  const [mailjetKey, setMailjetKey] = useState('');
  const [mailjetSecret, setMailjetSecret] = useState('');
  const [savingSecret, setSavingSecret] = useState('');
  const [testTo, setTestTo] = useState('');
  const [savingMail, setSavingMail] = useState(false);
  const [testingMail, setTestingMail] = useState(false);

  const load = useCallback(async () => {
    try {
      const [domainData, keyData, eventData, statusData, vaultData] = await Promise.all([
        api.get('/system/domains'),
        api.get('/system/keys'),
        api.get('/system/events?limit=25'),
        api.get('/system/status'),
        api.get('/system/vault').catch(() => ({ items: [], channels: null })),
      ]);
      setDomains(domainData.items);
      setKeys(keyData.items);
      setEvents(eventData.items);
      setStatus(statusData);
      setVault(vaultData);
      setMailFrom((current) => current || vaultData.channels?.email?.from || '');
    } catch (err) {
      toast.error('Could not load settings', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let canceled = false;
    api
      .get(`/system/config-preview?file=${configFile}`)
      .then((data) => !canceled && setConfig(data.content))
      .catch(() => !canceled && setConfig(''));
    return () => {
      canceled = true;
    };
  }, [configFile]);

  const patchDomain = async (slug, patch) => {
    try {
      await api.patch(`/system/domains/${slug}`, patch);
      setDomains((list) => list.map((domain) => (domain.slug === slug ? { ...domain, ...patch } : domain)));
      toast.success('Domain updated');
    } catch (err) {
      toast.error('Update failed', err.message);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const result = await api.post('/system/apply', {});
      toast.success(result.written ? 'Configuration written' : 'Nothing written', result.written ? result.dir : result.reason);
      const refreshed = await api.get(`/system/config-preview?file=${configFile}`);
      setConfig(refreshed.content);
    } catch (err) {
      toast.error('Apply failed', err.message);
    } finally {
      setApplying(false);
    }
  };

  const emailStatus =
    vault.channels?.email || status?.channels?.email || { provider: 'console', configured: false, providers: {} };
  const keySecret = vault.items.find((item) => item.name === 'RESEND_API_KEY');
  const mailjetKeySecret = vault.items.find((item) => item.name === 'MAILJET_API_KEY');
  const mailjetSecretSecret = vault.items.find((item) => item.name === 'MAILJET_API_SECRET');
  // `provider` is what actually sends; `preference` is what the operator asked
  // for. They differ only when a chosen provider has no credentials yet.
  const emailProvider = emailStatus.provider || 'console';
  const PROVIDER_LABEL = { resend: 'Resend', mailjet: 'Mailjet', console: 'Log only' };
  const providerLabel = PROVIDER_LABEL[emailProvider] || emailProvider;
  const chosenProvider = emailStatus.preference || (emailProvider === 'console' ? 'resend' : emailProvider);

  const payments = status?.payments || { configured: false, mode: 'none', webhookUrl: '/api/public/stripe/webhook' };
  const secretByName = (name) => vault.items.find((item) => item.name === name);
  const stripeKeyStored = secretByName('STRIPE_SECRET_KEY');
  const stripeSecretStored = secretByName('STRIPE_WEBHOOK_SECRET');

  /** Same vault, same rules: stored encrypted, only the last four characters come back. */
  const storeSecret = async (name, value, label) => {
    if (!value.trim()) {
      toast.error('Nothing to store', `Paste the ${label} first`);
      return;
    }
    setSavingSecret(name);
    try {
      const result = await api.put(`/system/vault/${name}`, { value: value.trim() });
      setVault((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.name !== name), result.secret],
        channels: result.channels,
      }));
      if (name === 'STRIPE_SECRET_KEY') setStripeKey('');
      else if (name === 'STRIPE_WEBHOOK_SECRET') setStripeSecret('');
      else if (name === 'MAILJET_API_KEY') setMailjetKey('');
      else if (name === 'MAILJET_API_SECRET') setMailjetSecret('');
      await load();
      toast.success(`${label} stored`, 'Held encrypted in the vault — only the last four characters are shown.');
    } catch (err) {
      toast.error('Could not store it', err.message);
    } finally {
      setSavingSecret('');
    }
  };

  const clearSecret = async (name, question) => {
    if (!window.confirm(question)) return;
    try {
      const result = await api.del(`/system/vault/${name}`);
      setVault((current) => ({
        ...current,
        items: current.items.filter((item) => item.name !== name),
        channels: result.channels,
      }));
      await load();
      toast.success('Removed from the vault');
    } catch (err) {
      toast.error('Could not remove it', err.message);
    }
  };

  /** Switching provider is a vault write, so it takes effect on the next send. */
  const chooseProvider = async (value) => {
    try {
      const result = await api.put('/system/vault/EMAIL_PROVIDER', { value });
      setVault((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.name !== 'EMAIL_PROVIDER'), result.secret],
        channels: result.channels,
      }));
      await load();
      const email = result.channels?.email;
      if (email?.provider === value) {
        toast.success(`Mail now leaves through ${PROVIDER_LABEL[value]}`, 'The other provider keeps its key, so switching back takes one click.');
      } else {
        toast.error(
          `${PROVIDER_LABEL[value]} is selected but not configured`,
          email?.provider === 'mailjet'
            ? 'Add the Mailjet API key and secret below.'
            : 'Add the Resend API key below, or choose the provider that already has a key.'
        );
      }
    } catch (err) {
      toast.error('Could not change the provider', err.message);
    }
  };

  const storeMailKey = async () => {
    if (!mailKey.trim()) {
      toast.error('Nothing to store', 'Paste the Resend API key first');
      return;
    }
    setSavingMail(true);
    try {
      const result = await api.put('/system/vault/RESEND_API_KEY', { value: mailKey.trim() });
      setVault((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.name !== 'RESEND_API_KEY'), result.secret],
        channels: result.channels,
      }));
      setMailKey('');
      toast.success(
        'Key stored in the vault',
        result.channels?.email?.provider === 'resend'
          ? 'Mail now leaves through Resend'
          : 'Stored. Resend sends as soon as it is the chosen provider.'
      );
      load();
    } catch (err) {
      toast.error('Could not store the key', err.message);
    } finally {
      setSavingMail(false);
    }
  };

  const clearMailKey = async () => {
    if (
      !window.confirm(
        'Remove the stored Resend key? Mail falls back to the other provider, or to the log if none has a key.'
      )
    )
      return;
    try {
      const result = await api.del('/system/vault/RESEND_API_KEY');
      setVault((current) => ({
        ...current,
        items: current.items.filter((item) => item.name !== 'RESEND_API_KEY'),
        channels: result.channels,
      }));
      toast.success('Key removed from the vault');
      load();
    } catch (err) {
      toast.error('Could not remove the key', err.message);
    }
  };

  const storeFrom = async () => {
    try {
      const result = await api.put('/system/vault/EMAIL_FROM', { value: mailFrom.trim() });
      setVault((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.name !== 'EMAIL_FROM'), result.secret],
        channels: result.channels,
      }));
      toast.success('Sender address saved', result.channels?.email?.from);
    } catch (err) {
      toast.error('Could not save the sender', err.message);
    }
  };

  const testMail = async () => {
    setTestingMail(true);
    try {
      const result = await api.post('/system/email/test', testTo.trim() ? { to: testTo.trim() } : {});
      if (result.sent) toast.success('Test message sent', `Accepted by ${result.provider} for ${result.to}`);
      else toast.error('The provider refused it', result.error || 'No detail returned');
      load();
    } catch (err) {
      toast.error('Test failed', err.message);
    } finally {
      setTestingMail(false);
    }
  };

  const revoke = async (key) => {
    if (!window.confirm(`Revoke “${key.label}”? Integrations using it will start failing.`)) return;
    try {
      await api.del(`/system/keys/${key.id}`);
      toast.success('Key revoked');
      load();
    } catch (err) {
      toast.error('Could not revoke', err.message);
    }
  };

  if (loading) return <Loading rows={5} />;

  return (
    <>
      <PageHeader title="Settings" subtitle="One platform, one registry, six public hostnames" />

      <Card
        title="Directory hostnames"
        subtitle="Every host serves the same registry with its own accent and label"
        bodyClass="tight"
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Label</th>
                <th>Accent</th>
                <th>Scope</th>
                <th className="align-right">Public</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.slug}>
                  <td className="mono tiny nowrap">{domain.host}</td>
                  <td style={{ minWidth: 180 }}>
                    <input
                      className="input"
                      defaultValue={domain.label}
                      aria-label={`Label for ${domain.host}`}
                      onBlur={(event) =>
                        event.target.value !== domain.label && patchDomain(domain.slug, { label: event.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="color"
                      className="input"
                      style={{ width: 44, padding: 3, height: 32 }}
                      defaultValue={domain.accent}
                      aria-label={`Accent for ${domain.host}`}
                      onBlur={(event) => event.target.value !== domain.accent && patchDomain(domain.slug, { accent: event.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 110 }}
                      value={domain.scope}
                      onChange={(event) => patchDomain(domain.slug, { scope: event.target.value === 'world' ? 'world' : event.target.value })}
                      aria-label={`Scope for ${domain.host}`}
                    >
                      <option value="world">World</option>
                      <option value="US">US only</option>
                      <option value="GB">GB only</option>
                      <option value="DE">DE only</option>
                    </select>
                  </td>
                  <td className="align-right">
                    <Switch
                      checked={domain.enabled}
                      onChange={(value) => patchDomain(domain.slug, { enabled: value })}
                      label=""
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid two">
        <Card
          title="API keys"
          subtitle="Server-to-server access to the registry"
          actions={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreatingKey(true)}>New key</Button>}
          bodyClass="tight"
        >
          {keys.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Prefix</th>
                    <th>Scope</th>
                    <th>Last used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id}>
                      <td className="truncate" style={{ maxWidth: 140 }}>{key.label}</td>
                      <td className="mono tiny">{key.prefix}…</td>
                      <td className="tiny muted">{key.scope}</td>
                      <td className="tiny dim">{key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never'}</td>
                      <td className="align-right">
                        {key.revokedAt ? (
                          <Badge tone="neutral">revoked</Badge>
                        ) : (
                          <Button size="sm" variant="ghost" icon="trash" onClick={() => revoke(key)} aria-label={`Revoke ${key.label}`} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="key" title="No API keys">
              Create one to let a partner service query the directory.
            </Empty>
          )}
        </Card>

        <Card title="Verification delivery" subtitle="How listing owners receive codes">
          <dl className="kv">
            <dt>Channel</dt>
            <dd><Badge tone={status?.channels?.active === 'console' ? 'warning' : 'success'}>{status?.channels?.active}</Badge></dd>
            <dt>Available</dt>
            <dd className="tiny muted">{status?.channels?.available?.join(', ')}</dd>
            <dt>Code TTL</dt>
            <dd>10 minutes · 5 attempts</dd>
            <dt>Rate limit</dt>
            <dd>5 submissions per hour per IP</dd>
          </dl>
          <p className="tiny dim" style={{ marginTop: 12 }}>          Email leaves through the provider chosen below — a stored key and the choice take effect on the next message, with no restart. With no key at all, codes and invoices are written to the container log. SMS uses{' '}
            <span className="mono">TWILIO_ACCOUNT_SID</span> and <span className="mono">TWILIO_AUTH_TOKEN</span>{' '}
            from the environment.
          </p>
        </Card>
      </div>

      <Card
        title="Generated switch configuration"
        subtitle={status?.telephony?.configDir ? `Written to ${status.telephony.configDir}` : 'ASTERISK_CONFIG_DIR is not set'}
        actions={
          <>
            <select
              className="select"
              style={{ width: 160 }}
              value={configFile}
              onChange={(event) => setConfigFile(event.target.value)}
              aria-label="Configuration file"
            >
              {CONFIG_FILES.map((file) => (
                <option key={file} value={file}>{file}</option>
              ))}
            </select>
            <Button size="sm" variant="primary" icon="check" onClick={apply} loading={applying}>
              Apply
            </Button>
          </>
        }
      >
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 14,
            background: '#08080e',
            border: '1px solid var(--border)',
            borderRadius: 10,
            fontSize: '0.75rem',
            lineHeight: 1.6,
            maxHeight: 320,
            overflow: 'auto',
            color: 'var(--text-2)',
          }}
        >
          {config || '# nothing generated yet'}
        </pre>
      </Card>

      <Card
        title="Email delivery"
        subtitle="Invoice resends, verification codes and reminders leave through Resend or Mailjet"
        actions={
          <Badge tone={emailStatus.configured ? 'success' : 'neutral'} dot>
            {emailStatus.configured ? `${providerLabel} · ${emailStatus.source}` : 'Not configured'}
          </Badge>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Both keys live in the encrypted vault inside the container. They are never returned by the API and never
          appear in the configuration files or the activity log — only the last four characters do. Store both and
          switch between them here without pasting anything again.
        </p>
        <div className="row wrap" style={{ gap: 14, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: '0 1 240px' }}>
            <Select
              label="Send mail through"
              value={chosenProvider}
              onChange={(event) => chooseProvider(event.target.value)}
              hint={emailStatus.configured ? `Sending through ${providerLabel}` : 'No provider configured yet'}
            >
              <option value="resend">Resend</option>
              <option value="mailjet">Mailjet</option>
            </Select>
          </div>
          <div className="tiny dim" style={{ flex: '1 1 260px', lineHeight: 1.7 }}>
            {emailStatus.preference && !emailStatus.configured
              ? `${providerLabel} is selected but has no credentials — mail will fail until it does.`
              : emailStatus.configured
                ? `${providerLabel} is the provider. The other one keeps its key for an instant switch.`
                : 'With no key stored, codes and invoices are written to the container log.'}
          </div>
        </div>
        <div className="grid two">
          <div className="stack">
            <Input
              label="Resend API key"
              type="password"
              autoComplete="off"
              placeholder={keySecret ? `Stored ${keySecret.hint}` : 're_…'}
              hint={
                keySecret
                  ? `Stored ${relativeTime(keySecret.updatedAt)}${keySecret.updatedBy ? ` by ${keySecret.updatedBy}` : ''}`
                  : 'Create one at resend.com → API keys'
              }
              value={mailKey}
              onChange={(event) => setMailKey(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" icon="check" onClick={storeMailKey} loading={savingMail}>
                {keySecret ? 'Replace key' : 'Store key'}
              </Button>
              {keySecret ? (
                <Button size="sm" variant="ghost" onClick={clearMailKey}>
                  Remove
                </Button>
              ) : null}
            </div>

            <div className="tiny dim" style={{ margin: '6px 0 0' }}>
              Or Mailjet — it authenticates with a key <em>and</em> a secret.
            </div>
            <Input
              label="Mailjet API key"
              type="password"
              autoComplete="off"
              placeholder={mailjetKeySecret ? `Stored ${mailjetKeySecret.hint}` : 'Your Mailjet API key'}
              hint={
                mailjetKeySecret
                  ? `Stored ${relativeTime(mailjetKeySecret.updatedAt)}${mailjetKeySecret.updatedBy ? ` by ${mailjetKeySecret.updatedBy}` : ''}`
                  : 'mailjet.com → Account → API key management'
              }
              value={mailjetKey}
              onChange={(event) => setMailjetKey(event.target.value)}
            />
            <Input
              label="Mailjet API secret"
              type="password"
              autoComplete="off"
              placeholder={mailjetSecretSecret ? `Stored ${mailjetSecretSecret.hint}` : 'The secret shown beside the key'}
              hint={
                mailjetSecretSecret
                  ? `Stored ${relativeTime(mailjetSecretSecret.updatedAt)}${mailjetSecretSecret.updatedBy ? ` by ${mailjetSecretSecret.updatedBy}` : ''}`
                  : 'Both halves are needed before Mailjet can send'
              }
              value={mailjetSecret}
              onChange={(event) => setMailjetSecret(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'MAILJET_API_KEY'}
                onClick={() => storeSecret('MAILJET_API_KEY', mailjetKey, 'Mailjet API key')}
              >
                {mailjetKeySecret ? 'Replace key' : 'Store key'}
              </Button>
              {mailjetKeySecret ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('MAILJET_API_KEY', 'Remove the stored Mailjet key? Mail falls back to the other provider.')}
                >
                  Remove
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'MAILJET_API_SECRET'}
                onClick={() => storeSecret('MAILJET_API_SECRET', mailjetSecret, 'Mailjet API secret')}
              >
                {mailjetSecretSecret ? 'Replace secret' : 'Store secret'}
              </Button>
              {mailjetSecretSecret ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    clearSecret('MAILJET_API_SECRET', 'Remove the stored Mailjet secret? Mailjet cannot send without it.')
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <div className="stack">
            <Input
              label="Sender address"
              value={mailFrom}
              onChange={(event) => setMailFrom(event.target.value)}
              placeholder="directory@telno.directory"
              hint="Must be a sender approved by the provider you choose"
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button size="sm" variant="ghost" icon="check" onClick={storeFrom} disabled={!mailFrom.trim()}>
                Save sender
              </Button>
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 4, alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px' }}>
                <Input
                  label="Send a test message to"
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                  placeholder="Leave empty to use the owner address"
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                icon="mail"
                onClick={testMail}
                loading={testingMail}
                disabled={!emailStatus.configured}
              >
                Send test
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Card payment"
        subtitle="The Pay now button in final notices and suspension emails"
        actions={
          <Badge tone={payments.configured ? 'success' : 'neutral'} dot>
            {payments.configured ? `Stripe · ${payments.mode}` : 'Not configured'}
          </Badge>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Both values go into the same encrypted vault as the mail key. Stripe's secret key is only ever used from
          this server, and the card itself is entered on Stripe's page — never here.
        </p>
        <div className="grid two">
          <div className="stack">
            <Input
              label="Stripe secret key"
              type="password"
              autoComplete="off"
              placeholder={stripeKeyStored ? `Stored ${stripeKeyStored.hint}` : 'sk_live_… or sk_test_…'}
              hint={
                stripeKeyStored
                  ? `Stored ${relativeTime(stripeKeyStored.updatedAt)}${stripeKeyStored.updatedBy ? ` by ${stripeKeyStored.updatedBy}` : ''}`
                  : 'Stripe → Developers → API keys → Secret key'
              }
              value={stripeKey}
              onChange={(event) => setStripeKey(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'STRIPE_SECRET_KEY'}
                onClick={() => storeSecret('STRIPE_SECRET_KEY', stripeKey, 'secret key')}
              >
                {stripeKeyStored ? 'Replace key' : 'Store key'}
              </Button>
              {stripeKeyStored ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    clearSecret(
                      'STRIPE_SECRET_KEY',
                      'Remove the Stripe key? The Pay now button disappears from every notice until a key is stored again.'
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <div className="stack">
            <Input
              label="Webhook signing secret"
              type="password"
              autoComplete="off"
              placeholder={stripeSecretStored ? `Stored ${stripeSecretStored.hint}` : 'whsec_…'}
              hint={
                stripeSecretStored
                  ? `Stored ${relativeTime(stripeSecretStored.updatedAt)}${stripeSecretStored.updatedBy ? ` by ${stripeSecretStored.updatedBy}` : ''}`
                  : 'Shown once when the endpoint is added in Stripe'
              }
              value={stripeSecret}
              onChange={(event) => setStripeSecret(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'STRIPE_WEBHOOK_SECRET'}
                onClick={() => storeSecret('STRIPE_WEBHOOK_SECRET', stripeSecret, 'webhook secret')}
              >
                {stripeSecretStored ? 'Replace secret' : 'Store secret'}
              </Button>
              {stripeSecretStored ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    clearSecret(
                      'STRIPE_WEBHOOK_SECRET',
                      'Remove the webhook secret? Stripe\'s callbacks will be rejected and no invoice will be marked paid.'
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="tiny dim" style={{ marginTop: 14, lineHeight: 1.7 }}>
          Register this URL in Stripe → Developers → Webhooks, subscribed to
          <span className="mono"> checkout.session.completed </span> and
          <span className="mono"> checkout.session.async_payment_succeeded</span>:
          <div className="mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>{payments.webhookUrl}</div>
          <a href="/billing">Then run Test Stripe connection on Billing</a> to prove the key and the secret against
          Stripe before a customer ever clicks Pay now.
        </div>
      </Card>

      <Card title="Activity" subtitle="Who changed what" bodyClass="tight">
        {events.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Subject</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="tiny dim nowrap">{relativeTime(event.at)}</td>
                    <td className="tiny truncate" style={{ maxWidth: 150 }}>{event.actor}</td>
                    <td className="tiny">
                      <span className="mono">{event.action}</span>
                    </td>
                    <td className="tiny muted truncate" style={{ maxWidth: 260 }}>{event.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="clock" title="No activity recorded" />
        )}
      </Card>

      {creatingKey ? (
        <CreateKey
          onClose={() => setCreatingKey(false)}
          onSaved={(value) => {
            setNewKey(value);
            load();
          }}
        />
      ) : null}

      {newKey ? (
        <Modal title="API key created" subtitle="Copy it now — it is not shown again" onClose={() => setNewKey(null)}>
          <p className="tiny muted">Send it as an <span className="mono">x-api-key</span> header.</p>
          <div className="panel row" style={{ gap: 8 }}>
            <span className="mono truncate" style={{ fontSize: '0.8125rem' }}>{newKey.key}</span>
            <Button
              size="sm"
              variant="ghost"
              icon="copy"
              className="right"
              onClick={() => {
                navigator.clipboard?.writeText(newKey.key);
                toast.success('Copied');
              }}
            >
              Copy
            </Button>
          </div>
          <p className="tiny dim">Scope: <span className="mono">{newKey.scope}</span></p>
        </Modal>
      ) : null}
    </>
  );
}

function CreateKey({ onClose, onSaved }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('registry:read');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.post('/system/keys', { label, scope });
      onSaved(result);
      onClose();
    } catch (err) {
      toast.error('Could not create key', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New API key"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!label.trim()}>Create</Button>
        </>
      }
    >
      <Input
        label="Label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Partner lookup service"
        autoFocus
      />
      <Select label="Scope" value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="registry:read">registry:read — search and read numbers</option>
        <option value="registry:write">registry:write — also create and edit</option>
        <option value="*">* — everything the API allows</option>
      </Select>
      <p className="tiny dim">
        <Icon name="shield" size={12} /> Keys are stored as a hash. Revoke one at any time.
      </p>
    </Modal>
  );
}
