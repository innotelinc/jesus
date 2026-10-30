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
  Textarea,
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
  const [voipUser, setVoipUser] = useState('');
  const [voipPass, setVoipPass] = useState('');
  const [voipRoutingField, setVoipRoutingField] = useState('');
  const [provider, setProvider] = useState(null);
  const [testingProvider, setTestingProvider] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [aiTest, setAiTest] = useState(null);
  const [brandForm, setBrandForm] = useState(null);
  const [savingBrand, setSavingBrand] = useState(false);
  const [magnateHook, setMagnateHook] = useState('');
  const [magnateToken, setMagnateToken] = useState('');
  const [savingSecret, setSavingSecret] = useState('');
  const [testTo, setTestTo] = useState('');
  const [savingMail, setSavingMail] = useState(false);
  const [testingMail, setTestingMail] = useState(false);
  const [twilioSid, setTwilioSid] = useState('');
  const [twilioToken, setTwilioToken] = useState('');
  const [twilioFrom, setTwilioFrom] = useState('');
  const [smsTo, setSmsTo] = useState('');
  const [smsFrom, setSmsFrom] = useState('');
  const [smsProviderChoice, setSmsProviderChoice] = useState('');
  const [testingSms, setTestingSms] = useState(false);
  const [backups, setBackups] = useState({ status: null, items: [] });
  const [backupBusy, setBackupBusy] = useState('');
  const [restoring, setRestoring] = useState(null);

  // The SMS choice is a vault key, so the select mirrors what the server says
  // rather than what was last clicked — a reload or a second operator cannot
  // leave it showing the wrong provider.
  useEffect(() => {
    setSmsProviderChoice(status?.channels?.sms?.preference || '');
  }, [status?.channels?.sms?.preference]);

  // Branding is its own request: it is white-label configuration, not part of
  // the operator status the rest of this page reads.
  useEffect(() => {
    api
      .get('/system/brand')
      .then((data) => setBrandForm(data.brand))
      .catch(() => setBrandForm(null));
  }, []);

  const saveBrand = async () => {
    setSavingBrand(true);
    try {
      const data = await api.put('/system/brand', brandForm);
      setBrandForm(data.brand);
      toast.success('Brand updated', 'The site, console and signup page now use it on the next load.');
      load();
    } catch (err) {
      toast.error('Could not save the brand', err.message);
    } finally {
      setSavingBrand(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [domainData, keyData, eventData, statusData, vaultData, backupData] = await Promise.all([
        api.get('/system/domains'),
        api.get('/system/keys'),
        api.get('/system/events?limit=25'),
        api.get('/system/status'),
        api.get('/system/vault').catch(() => ({ items: [], channels: null })),
        // Backups are owner-only, so a viewer's Settings page still loads.
        api.get('/system/backups').catch(() => ({ status: null, items: [] })),
      ]);
      setDomains(domainData.items);
      setKeys(keyData.items);
      setEvents(eventData.items);
      setStatus(statusData);
      setVault(vaultData);
      setBackups(backupData);
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

  const runBackup = async () => {
    setBackupBusy('new');
    try {
      const data = await api.post('/system/backups', {});
      setBackups({ status: data.status, items: data.items });
      toast.success('Backup taken', `${data.name} · ${Math.round(data.bytes / 1024)} kB`);
    } catch (err) {
      toast.error('Backup failed', err.message);
    } finally {
      setBackupBusy('');
    }
  };

  /**
   * A restore is the one action here that replaces live data, so it is behind a
   * dialog that names the archive, what it holds, and the fact that the platform
   * restarts to apply it.
   */
  const restore = async (item) => {
    setBackupBusy(item.name);
    try {
      const data = await api.post('/system/backups/restore', { name: item.name });
      toast.success(
        'Restore staged',
        `${data.name} will be applied as the platform restarts (${data.records?.calls ?? 0} calls in the archive).`
      );
      setRestoring(null);
      // The platform is going down to apply it; the page will lose its session.
      setTimeout(() => window.location.reload(), 4000);
    } catch (err) {
      toast.error('Could not stage the restore', err.message);
      setBackupBusy('');
    }
  };

  const removeBackup = async (item) => {
    if (!window.confirm(`Delete ${item.name}? The other archives are kept.`)) return;
    setBackupBusy(item.name);
    try {
      const data = await api.del(`/system/backups/${item.name}`);
      setBackups((current) => ({ ...current, items: data.items }));
      toast.success('Archive deleted');
    } catch (err) {
      toast.error('Could not delete it', err.message);
    } finally {
      setBackupBusy('');
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
  const smsStatus = status?.channels?.sms || { provider: 'console', configured: false, missing: [] };
  const secretByName = (name) => vault.items.find((item) => item.name === name);
  const stripeKeyStored = secretByName('STRIPE_SECRET_KEY');
  const stripeSecretStored = secretByName('STRIPE_WEBHOOK_SECRET');
  const voipUserStored = secretByName('VOIPMS_API_USERNAME');
  const voipPassStored = secretByName('VOIPMS_API_PASSWORD');
  const voipRoutingStored = secretByName('VOIPMS_ROUTING');

  /**
   * Ask the number provider whether it answers, as the operator, from here.
   *
   * The interesting failure is `invalid_ip`: VoIP.ms only answers allow-listed
   * source addresses, so a connection that is refused for that reason needs a
   * different fix from a wrong password, and the test says which it is.
   */
  const testNumberProvider = async () => {
    setTestingProvider(true);
    try {
      const result = await api.get('/provider/voipms');
      setProvider(result);
      if (result.configured && result.reachable) {
        const balance = Number.isFinite(result.balanceCents)
          ? (result.balanceCents / 100).toLocaleString('en-US', {
              style: 'currency',
              currency: result.currency || 'USD',
            })
          : 'not reported';
        toast.success('VoIP.ms answered', `Balance ${balance} · routing ${result.defaults?.routing || 'not set'}`);
      } else if (result.configured) {
        toast.error('VoIP.ms refused the call', result.error || 'The provider did not explain');
      } else {
        toast.error('VoIP.ms is not connected', 'Store the API username and API password first — both come from Main Menu → SOAP & REST API.');
      }
    } catch (err) {
      toast.error('The connection test failed', err.message);
    } finally {
      setTestingProvider(false);
    }
  };

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
      else if (name === 'VOIPMS_API_USERNAME') setVoipUser('');
      else if (name === 'VOIPMS_API_PASSWORD') setVoipPass('');
      else if (name === 'VOIPMS_ROUTING') setVoipRoutingField('');
      else if (name === 'TWILIO_ACCOUNT_SID') setTwilioSid('');
      else if (name === 'TWILIO_AUTH_TOKEN') setTwilioToken('');
      else if (name === 'TWILIO_FROM') setTwilioFrom('');
      else if (name === 'LLM_API_KEY') setAiKey('');
      else if (name === 'MAGNATE_WEBHOOK_URL') setMagnateHook('');
      else if (name === 'MAGNATE_API_TOKEN') setMagnateToken('');
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

  /** The choice is one vault key; `''` removes it and lets the channel decide. */
  const chooseSmsProvider = async (value) => {
    setSmsProviderChoice(value);
    try {
      if (value) await api.put('/system/vault/SMS_PROVIDER', { value });
      else await api.del('/system/vault/SMS_PROVIDER');
      await load();
      toast.success(
        value ? `Texts will leave through ${value === 'voipms' ? 'your own number' : 'Twilio'}` : 'Back to automatic',
        value ? 'It applies to the next code, with no restart.' : 'The number this platform holds comes first, then Twilio.'
      );
    } catch (err) {
      toast.error('Could not change the SMS provider', err.message);
    }
  };

  const testSms = async () => {
    if (!smsTo.trim()) {
      toast.error('Where should it go?', 'Type the mobile number to text.');
      return;
    }
    setTestingSms(true);
    try {
      const result = await api.post('/system/sms/test', { to: smsTo.trim() });
      if (result.sent) toast.success('Test text sent', `Accepted by ${result.provider} for ${result.to}`);
      else toast.error('The provider refused it', result.error || 'No detail returned');
      load();
    } catch (err) {
      toast.error('Test failed', err.message);
    } finally {
      setTestingSms(false);
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
          <p className="tiny dim" style={{ marginTop: 12 }}>          Email leaves through the provider chosen below — a stored key and the choice take effect on the next message, with no restart. With no key at all, codes and invoices are written to the container log. Texts leave through Twilio, configured in{' '}
            Settings → Text messages; until it is, the code is written to the log and handed back in the wizard.
          </p>
        </Card>
      </div>

      <Card
        title="Generated switch configuration"
        subtitle={
          status?.telephony?.configDir
            ? `Written to ${status.telephony.configDir} and reloaded as changes are saved`
            : 'ASTERISK_CONFIG_DIR is not set'
        }
        actions={
          // Read-only on purpose: saving an extension, trunk or menu writes and
          // reloads the switch by itself, so this is a window, not a button.
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
        title="Text messages"
        subtitle="Verification codes go to a handset from your own number, or through Twilio"
        actions={
          <Badge tone={smsStatus.configured ? 'success' : 'neutral'} dot>
            {smsStatus.configured ? `${smsStatus.provider} · ${smsStatus.source}` : 'Not configured'}
          </Badge>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          A code is one short message, so it can leave from a number this platform already holds. That is the VoIP.ms DID
          below, and it is what customers see when the text arrives. Twilio stays the alternative for an install without a
          number of its own. Either way the credentials are stored encrypted here and take effect on the next code.
        </p>
        {smsStatus.configured ? null : (
          <p className="tiny dim" style={{ marginTop: 0 }}>
            Still needed: <span className="mono">{(smsStatus.missing || []).join(', ')}</span>. Until that is stored, codes are
            written to the container log and handed back in the wizard instead of being texted.
          </p>
        )}
        <div className="stack" style={{ gap: 10, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <Select
                label="Send texts with"
                value={smsProviderChoice}
                onChange={(event) => chooseSmsProvider(event.target.value)}
              >
                <option value="">Automatically — my number first, then Twilio</option>
                <option value="voipms">My own number (VoIP.ms)</option>
                <option value="twilio">Twilio</option>
              </Select>
            </div>
            <div style={{ flex: '2 1 260px' }}>
              <Input
                label="Text codes from this number"
                placeholder={
                  secretByName('VOIPMS_SMS_DID')
                    ? `Stored ${secretByName('VOIPMS_SMS_DID').hint}`
                    : smsStatus.providers?.voipms?.from || '+1 415 555 0123'
                }
                hint={
                  smsStatus.providers?.voipms?.configured
                    ? `Texting from ${smsStatus.from || 'that number'}`
                    : 'A DID on the VoIP.ms account with SMS enabled'
                }
                value={smsFrom}
                onChange={(event) => setSmsFrom(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              loading={savingSecret === 'VOIPMS_SMS_DID'}
              onClick={() => storeSecret('VOIPMS_SMS_DID', smsFrom, 'the number texts come from')}
            >
              {secretByName('VOIPMS_SMS_DID') ? 'Replace number' : 'Store number'}
            </Button>
          </div>
          <p className="tiny dim" style={{ margin: 0 }}>
            {smsStatus.providers?.voipms?.configured
              ? 'Ready: codes leave through VoIP.ms from the number above.'
              : 'Connect VoIP.ms under Numbers from VoIP.ms first — the API username, password and this SMS-enabled DID are all it takes.'}
          </p>
        </div>
        <strong className="tiny" style={{ display: 'block', marginTop: 16 }}>Or through Twilio</strong>
        <div className="grid two">
          <div className="stack">
            <Input
              label="Account SID"
              autoComplete="off"
              placeholder={secretByName('TWILIO_ACCOUNT_SID') ? `Stored ${secretByName('TWILIO_ACCOUNT_SID').hint}` : 'AC…'}
              hint={
                secretByName('TWILIO_ACCOUNT_SID')
                  ? `Stored ${relativeTime(secretByName('TWILIO_ACCOUNT_SID').updatedAt)}`
                  : 'twilio.com → Console → Account Info'
              }
              value={twilioSid}
              onChange={(event) => setTwilioSid(event.target.value)}
            />
            <Input
              label="Auth token"
              type="password"
              autoComplete="off"
              placeholder={secretByName('TWILIO_AUTH_TOKEN') ? `Stored ${secretByName('TWILIO_AUTH_TOKEN').hint}` : 'The account auth token'}
              hint={
                secretByName('TWILIO_AUTH_TOKEN')
                  ? `Stored ${relativeTime(secretByName('TWILIO_AUTH_TOKEN').updatedAt)}`
                  : 'Rotating it in Twilio means replacing it here'
              }
              value={twilioToken}
              onChange={(event) => setTwilioToken(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'TWILIO_ACCOUNT_SID'}
                onClick={() => storeSecret('TWILIO_ACCOUNT_SID', twilioSid, 'Twilio account SID')}
              >
                {secretByName('TWILIO_ACCOUNT_SID') ? 'Replace SID' : 'Store SID'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'TWILIO_AUTH_TOKEN'}
                onClick={() => storeSecret('TWILIO_AUTH_TOKEN', twilioToken, 'Twilio auth token')}
              >
                {secretByName('TWILIO_AUTH_TOKEN') ? 'Replace token' : 'Store token'}
              </Button>
              {secretByName('TWILIO_AUTH_TOKEN') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('TWILIO_AUTH_TOKEN', 'Remove the stored Twilio auth token? Codes stop being texted until it is stored again.')}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <div className="stack">
            <Input
              label="Send from"
              placeholder={secretByName('TWILIO_FROM') ? `Stored ${secretByName('TWILIO_FROM').hint}` : '+15551234567'}
              hint={
                secretByName('TWILIO_FROM')
                  ? `Texts would come from ${smsStatus.providers?.twilio?.from || 'the stored number'}`
                  : 'A number or messaging service SID the Twilio account owns'
              }
              value={twilioFrom}
              onChange={(event) => setTwilioFrom(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'TWILIO_FROM'}
                onClick={() => storeSecret('TWILIO_FROM', twilioFrom, 'Twilio sender number')}
              >
                {secretByName('TWILIO_FROM') ? 'Replace sender' : 'Store sender'}
              </Button>
              {secretByName('TWILIO_FROM') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('TWILIO_FROM', 'Remove the stored sender number? Codes stop being texted until it is stored again.')}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 4, alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 180px' }}>
                <Input
                  label="Text a test message to"
                  value={smsTo}
                  onChange={(event) => setSmsTo(event.target.value)}
                  placeholder="+15551234567"
                  hint="International form, so the carrier knows the country"
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                icon="message"
                onClick={testSms}
                loading={testingSms}
                disabled={!smsStatus.configured}
              >
                Send test
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Numbers from VoIP.ms"
        subtitle="Where a rented DID comes from, and where it rings"
        actions={
          <Badge tone={provider?.configured ? (provider?.reachable ? 'success' : 'warn') : 'neutral'} dot>
            {provider
              ? provider.configured
                ? provider.reachable
                  ? 'Connected'
                  : 'Configured, refused'
                : 'Not configured'
              : 'Not configured'}
          </Badge>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          The API username and API password are not the credentials you sign in to the VoIP.ms portal with: they are
          under Main Menu → SOAP &amp; REST API, and that page also has to allow-list this server&apos;s public IP
          address. They go into the same encrypted vault as everything else here. Routing is where a bought number
          rings on your switch, for example <span className="mono">account:100001_telno</span>.
        </p>
        <div className="grid two">
          <div className="stack">
            <Input
              label="VoIP.ms API username"
              autoComplete="off"
              placeholder={voipUserStored ? `Stored ${voipUserStored.hint}` : 'Usually the email on the account'}
              hint={
                voipUserStored
                  ? `Stored ${relativeTime(voipUserStored.updatedAt)}${voipUserStored.updatedBy ? ` by ${voipUserStored.updatedBy}` : ''}`
                  : 'voip.ms → Main Menu → SOAP & REST API'
              }
              value={voipUser}
              onChange={(event) => setVoipUser(event.target.value)}
            />
            <Input
              label="VoIP.ms API password"
              type="password"
              autoComplete="off"
              placeholder={voipPassStored ? `Stored ${voipPassStored.hint}` : 'The API password, not the portal one'}
              hint={voipPassStored ? `Stored ${relativeTime(voipPassStored.updatedAt)}` : 'Both halves are needed before a DID can be ordered'}
              value={voipPass}
              onChange={(event) => setVoipPass(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'VOIPMS_API_USERNAME'}
                onClick={() => storeSecret('VOIPMS_API_USERNAME', voipUser, 'VoIP.ms API username')}
              >
                {voipUserStored ? 'Replace username' : 'Store username'}
              </Button>
              {voipUserStored ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('VOIPMS_API_USERNAME', 'Remove the stored VoIP.ms username? Number ordering stops until it is stored again.')}
                >
                  Remove
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'VOIPMS_API_PASSWORD'}
                onClick={() => storeSecret('VOIPMS_API_PASSWORD', voipPass, 'VoIP.ms API password')}
              >
                {voipPassStored ? 'Replace password' : 'Store password'}
              </Button>
              {voipPassStored ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('VOIPMS_API_PASSWORD', 'Remove the stored VoIP.ms password? Number ordering stops until it is stored again.')}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <div className="stack">
            <Input
              label="Routing target"
              placeholder={voipRoutingStored ? `Stored ${voipRoutingStored.hint}` : 'account:100001_telno'}
              hint={
                voipRoutingStored
                  ? `Stored ${relativeTime(voipRoutingStored.updatedAt)} — new numbers ring here`
                  : 'Where a number bought from the console rings; every order needs one'
              }
              value={voipRoutingField}
              onChange={(event) => setVoipRoutingField(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'VOIPMS_ROUTING'}
                onClick={() => storeSecret('VOIPMS_ROUTING', voipRoutingField, 'routing target')}
              >
                {voipRoutingStored ? 'Replace routing' : 'Store routing'}
              </Button>
              {voipRoutingStored ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearSecret('VOIPMS_ROUTING', 'Remove the stored routing target? Numbers can then only be ordered with one supplied.')}
                >
                  Remove
                </Button>
              ) : null}
              <Button size="sm" icon="refresh" loading={testingProvider} onClick={testNumberProvider}>
                Test the connection
              </Button>
            </div>
            {provider ? (
              <div className="tiny dim" style={{ display: 'grid', gap: 3 }}>
                <span>
                  From the provider:{' '}
                  {provider.configured
                    ? provider.reachable
                      ? `reachable, balance ${Number.isFinite(provider.balanceCents) ? (provider.balanceCents / 100).toLocaleString('en-US', { style: 'currency', currency: provider.currency || 'USD' }) : 'not reported'}`
                      : provider.error || 'no answer'
                    : 'not configured'}
                </span>
                <span>
                  Credentials from {provider.credentials?.username || 'nowhere'} · routing from{' '}
                  {provider.routingSource || 'nowhere'}
                </span>
                <span>Checked {relativeTime(provider.checkedAt)}</span>
              </div>
            ) : null}
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
          <div style={{ marginTop: 6 }}>
            Subscriptions bill through the same account, from the public page at
            <span className="mono"> /subscribe</span> — register
            <span className="mono"> customer.subscription.updated</span>,
            <span className="mono"> customer.subscription.deleted</span> and
            <span className="mono"> invoice.payment_failed</span> on the same endpoint, or the portal gate will
            never learn that a renewal lapsed.
          </div>
        </div>
      </Card>

      <Card
        title="Branding"
        subtitle="The name, vendor and color the site, console, signup page and reports use"
        actions={
          brandForm ? (
            <Button size="sm" variant="primary" icon="check" loading={savingBrand} onClick={saveBrand}>
              Save brand
            </Button>
          ) : null
        }
      >
        {brandForm ? (
          <div className="stack">
            <div className="grid two">
              <Input
                label="Product name"
                value={brandForm.name}
                maxLength={40}
                onChange={(event) => setBrandForm({ ...brandForm, name: event.target.value })}
                hint="Appears in the console, the site, the signup page and every report."
              />
              <Input
                label="Vendor"
                value={brandForm.vendor}
                maxLength={60}
                onChange={(event) => setBrandForm({ ...brandForm, vendor: event.target.value })}
                hint="“A product of …” on the public pages."
              />
            </div>
            <Input
              label="Tagline"
              value={brandForm.tagline}
              maxLength={160}
              onChange={(event) => setBrandForm({ ...brandForm, tagline: event.target.value })}
              hint="The headline on the site and the signup page."
            />
            <Textarea
              label="Description"
              rows={3}
              value={brandForm.description}
              maxLength={600}
              onChange={(event) => setBrandForm({ ...brandForm, description: event.target.value })}
            />
            <div className="grid three">
              <Input
                label="Accent color"
                value={brandForm.accent}
                onChange={(event) => setBrandForm({ ...brandForm, accent: event.target.value })}
                hint="Six-digit hex, e.g. #6f66ff."
                type="color"
                style={{ minHeight: 42, padding: 4 }}
              />
              <Input
                label="Logo URL"
                value={brandForm.logoUrl}
                onChange={(event) => setBrandForm({ ...brandForm, logoUrl: event.target.value })}
                placeholder="https://…/logo.svg"
                hint="Optional; the wordmark is used when empty."
              />
              <Input
                label="Directory domain"
                value={brandForm.domain}
                onChange={(event) => setBrandForm({ ...brandForm, domain: event.target.value })}
                placeholder="telno.directory"
                hint="Which host the site links as its public directory."
              />
            </div>
            <div className="grid three">
              <Input
                label="Support email"
                type="email"
                value={brandForm.supportEmail}
                onChange={(event) => setBrandForm({ ...brandForm, supportEmail: event.target.value })}
              />
              <Input
                label="Sales email"
                type="email"
                value={brandForm.salesEmail}
                onChange={(event) => setBrandForm({ ...brandForm, salesEmail: event.target.value })}
              />
              <Input
                label="Estate email"
                type="email"
                value={brandForm.estateEmail || ''}
                hint="The address this estate speaks from: the From on notices and the reply-to a customer reaches. Empty uses the environment default."
                onChange={(event) => setBrandForm({ ...brandForm, estateEmail: event.target.value })}
              />
              <Input
                label="Footer note"
                value={brandForm.footerNote}
                onChange={(event) => setBrandForm({ ...brandForm, footerNote: event.target.value })}
              />
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <a href="/" target="_blank" rel="noreferrer" className="btn sm">
                <Icon name="external" size={14} /> Preview the site
              </a>
              <a href="/subscribe" target="_blank" rel="noreferrer" className="btn sm ghost">
                <Icon name="external" size={14} /> Preview the signup page
              </a>
              <span className="tiny dim">Changes apply on the next page load, no restart.</span>
            </div>
          </div>
        ) : (
          <p className="tiny dim" style={{ margin: 0 }}>
            Only an owner can read and change the brand.
          </p>
        )}
      </Card>

      <Card
        title="AI and subscriptions"
        subtitle="The model behind grading and suggestions, and the mirror into the subscriber system of record"
        actions={
          <Badge tone={status?.ai?.configured ? 'success' : 'warning'} dot={status?.ai?.configured}>
            {status?.ai?.configured ? `${status.ai.model} · ${status.ai.host}` : 'No model key'}
          </Badge>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Campaign grading, campaign suggestions and the operations autopilot all go through one OpenAI-compatible
          gateway. Without a key the platform still works — grading falls back to rules and the console says so.
        </p>
        <div className="grid two">
          <div className="stack">
            <Input
              label="Gateway API key"
              type="password"
              autoComplete="off"
              placeholder={secretByName('LLM_API_KEY') ? `Stored ${secretByName('LLM_API_KEY').hint}` : 'sk-…'}
              hint={`Sent to ${status?.ai?.host || 'the gateway'} · model ${status?.ai?.model || 'gpt-4o-mini'}`}
              value={aiKey}
              onChange={(event) => setAiKey(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={savingSecret === 'LLM_API_KEY'}
                onClick={() => storeSecret('LLM_API_KEY', aiKey, 'gateway key')}
              >
                {secretByName('LLM_API_KEY') ? 'Replace key' : 'Store key'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="pulse"
                loading={savingSecret === 'ai-test'}
                onClick={async () => {
                  setSavingSecret('ai-test');
                  try {
                    const result = await api.post('/system/ai/test', {});
                    setAiTest(result);
                    if (result.test.ok) toast.success('Model replied', `${result.test.model} in ${result.test.latencyMs}ms`);
                    else toast.error('Model did not answer', result.test.error);
                  } catch (err) {
                    toast.error('Could not test the model', err.message);
                  } finally {
                    setSavingSecret('');
                  }
                }}
              >
                Test
              </Button>
              {secretByName('LLM_API_KEY') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    clearSecret(
                      'LLM_API_KEY',
                      'Remove the model key? Campaign grading falls back to rules and suggestions stop working.'
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
            {aiTest ? (
              <p className="tiny" style={{ margin: 0, color: aiTest.test.ok ? 'var(--success)' : 'var(--danger)' }}>
                {aiTest.test.ok
                  ? `Replied "${aiTest.test.reply}" from ${aiTest.test.model} in ${aiTest.test.latencyMs}ms`
                  : `Failed: ${aiTest.test.error}`}
              </p>
            ) : null}
          </div>
          <div className="stack">
            <Input
              label="Subscriber system webhook"
              type="url"
              autoComplete="off"
              placeholder={secretByName('MAGNATE_WEBHOOK_URL') ? `Stored ${secretByName('MAGNATE_WEBHOOK_URL').hint}` : 'https://…/hooks/telno'}
              hint="Every plan change is posted here, so the catalog is never retyped by hand."
              value={magnateHook}
              onChange={(event) => setMagnateHook(event.target.value)}
            />
            <Input
              label="Webhook token"
              type="password"
              autoComplete="off"
              placeholder={secretByName('MAGNATE_API_TOKEN') ? `Stored ${secretByName('MAGNATE_API_TOKEN').hint}` : 'bearer token'}
              hint="Sent as Authorization: Bearer on every push."
              value={magnateToken}
              onChange={(event) => setMagnateToken(event.target.value)}
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                loading={savingSecret === 'MAGNATE_WEBHOOK_URL'}
                onClick={() => storeSecret('MAGNATE_WEBHOOK_URL', magnateHook, 'subscriber webhook')}
              >
                Save webhook
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={savingSecret === 'MAGNATE_API_TOKEN'}
                onClick={() => storeSecret('MAGNATE_API_TOKEN', magnateToken, 'webhook token')}
              >
                Save token
              </Button>
              <span className="tiny dim right">
                {status?.commerce?.magnateConfigured ? 'Mirroring' : 'Not mirroring'} · {status?.commerce?.plans ?? 0} plans
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Data backups"
        subtitle="The database, the recordings and a manifest — taken on a schedule and restorable in one request"
        actions={
          backups.status ? (
            <div className="row" style={{ gap: 8 }}>
              <Badge tone={backups.status.enabled ? 'info' : 'neutral'} dot={backups.status.enabled}>
                {backups.status.enabled
                  ? `every ${backups.status.intervalHours}h · keep ${backups.status.keep}`
                  : 'schedule off'}
              </Badge>
              <Button size="sm" variant="primary" icon="check" loading={backupBusy === 'new'} onClick={runBackup}>
                Back up now
              </Button>
            </div>
          ) : null
        }
      >
        {!backups.status ? (
          <p className="tiny dim" style={{ margin: 0 }}>
            Backups are owner-only.
          </p>
        ) : (
          <>
            <div className="grid two" style={{ gap: 14 }}>
              <div className="stack" style={{ gap: 6 }}>
                <span className="tiny dim">Stored in</span>
                <span className="mono tiny truncate" style={{ maxWidth: 360 }}>{backups.status.dir}</span>
                <span className="tiny dim">
                  Last: {backups.status.lastAt ? `${relativeTime(backups.status.lastAt)} (${backups.status.lastLabel})` : 'none yet'}
                </span>
              </div>
              <div className="tiny dim" style={{ lineHeight: 1.7 }}>
                An archive holds the database dumped consistently with <span className="mono">VACUUM INTO</span>, the
                recordings, voicemail audio and fax attachments, and a manifest of what it contains. It deliberately
                does <strong>not</strong> hold {backups.status.secretFilesNotIncluded.join(', ')} — restoring on new
                hardware means carrying those across too, or the credential vault cannot be decrypted.
              </div>
            </div>

            {backups.status.pendingRestore ? (
              <p className="tiny" style={{ marginTop: 12, color: 'var(--warning)' }}>
                A restore of {backups.status.pendingRestore} is staged and will be applied at the next boot.
              </p>
            ) : null}
            {backups.status.failedRestore ? (
              <p className="tiny" style={{ marginTop: 12, color: 'var(--danger)' }}>
                A staged restore failed at boot ({backups.status.failedRestore.error}) — the database was left
                untouched.
              </p>
            ) : null}

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Archive</th>
                    <th>Taken</th>
                    <th>Contents</th>
                    <th className="align-right">Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {backups.items.map((item) => (
                    <tr key={item.name}>
                      <td className="tiny mono nowrap">{item.name}</td>
                      <td className="tiny dim nowrap">{relativeTime(item.createdAt)}</td>
                      <td className="tiny dim">
                        {item.counts
                          ? `${item.counts.calls} calls · ${item.counts.listings} listings · ${item.recordings?.files ?? 0} media files`
                          : 'manifest unreadable'}
                      </td>
                      <td className="tiny align-right mono">{Math.max(1, Math.round(item.bytes / 1024))} kB</td>
                      <td className="align-right">
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <Button size="sm" variant="ghost" onClick={() => setRestoring(item)}>
                            Restore
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            icon="trash"
                            loading={backupBusy === item.name}
                            onClick={() => removeBackup(item)}
                            aria-label={`Delete ${item.name}`}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {backups.items.length ? null : (
                <div style={{ padding: 16 }}>
                  <Empty icon="terminal" title="No backups yet">
                    The schedule writes one to the data volume; Back up now takes one immediately.
                  </Empty>
                </div>
              )}
            </div>
          </>
        )}
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

      {restoring ? (
        <Modal
          title="Restore from an archive"
          subtitle={restoring.name}
          onClose={() => setRestoring(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRestoring(null)}>Cancel</Button>
              <Button
                variant="danger"
                loading={backupBusy === restoring.name}
                onClick={() => restore(restoring)}
              >
                Stage the restore
              </Button>
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <p className="tiny" style={{ margin: 0 }}>
              This replaces the live database and the media tree with the contents of{' '}
              <span className="mono">{restoring.name}</span>, taken {relativeTime(restoring.createdAt)}.
            </p>
            <dl className="kv">
              <dt>Contents</dt>
              <dd className="tiny">
                {restoring.counts
                  ? `${restoring.counts.calls} calls · ${restoring.counts.listings} listings · ${restoring.counts.invoices} invoices`
                  : 'unknown'}
              </dd>
              <dt>Media</dt>
              <dd className="tiny">{restoring.recordings?.files ?? 0} files</dd>
              <dt>How it applies</dt>
              <dd className="tiny">The platform restarts itself and applies the archive before it opens the database.</dd>
              <dt>Previous media</dt>
              <dd className="tiny">Kept beside the new tree, so a partial archive is not a loss.</dd>
            </dl>
            <p className="tiny" style={{ color: 'var(--warning)', margin: 0 }}>
              Anything created since that archive was taken will be gone: this is a real replacement, not a merge.
            </p>
          </div>
        </Modal>
      ) : null}

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
