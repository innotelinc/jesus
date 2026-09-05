import { useCallback, useEffect, useState } from 'react';
import { api, type ExtensionCall } from '../lib/api';
import Button from '../components/Button';
import Input from '../components/Input';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { cn } from '../lib/utils';

interface ListEntry {
  extension: string;
  callerId: string;
  hasPassword: boolean;
  registered?: boolean;
  contactUri?: string | null;
}

function RegChip({ registered }: { registered?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        registered
          ? 'border-success/40 text-success'
          : 'border-muted-foreground/30 text-muted-foreground',
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {registered ? 'Registered' : 'Offline'}
    </span>
  );
}

function dispositionLabel(d: string): { label: string; tone: 'ok' | 'warn' } {
  const s = (d || '').toLowerCase();
  if (s.includes('answered')) return { label: 'Answered', tone: 'ok' };
  if (s.includes('no answer') || s.includes('failed') || s.includes('busy') || s.includes('congestion'))
    return { label: d, tone: 'warn' };
  return { label: d || '—', tone: 'ok' };
}

export default function Extensions() {
  const [extensions, setExtensions] = useState<ListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newExt, setNewExt] = useState('');
  const [newCid, setNewCid] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Call-history modal state
  const [historyExt, setHistoryExt] = useState<ListEntry | null>(null);
  const [calls, setCalls] = useState<ExtensionCall[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.extensions();
      setExtensions(list as ListEntry[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load extensions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  };

  const handleCreate = async () => {
    if (!newExt.trim() || !newPass.trim()) return;
    setBusy('create');
    setError(null);
    try {
      await api.createExtension({ extension: newExt.trim(), password: newPass, callerId: newCid.trim() || undefined });
      setCreateOpen(false);
      setNewExt(''); setNewCid(''); setNewPass('');
      flash(`Extension ${newExt} provisioned and pjsip reloaded`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (ext: string) => {
    if (!window.confirm(`Remove extension ${ext}? Devices using it will be disconnected.`)) return;
    setBusy(ext);
    setError(null);
    try {
      await api.deleteExtension(ext);
      flash(`Extension ${ext} removed`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const handleRotate = async (ext: string) => {
    const password = window.prompt(`New SIP password for extension ${ext}:`);
    if (!password) return;
    setBusy(ext);
    setError(null);
    try {
      await api.rotateExtensionPassword(ext, password);
      flash(`Password rotated for extension ${ext}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Password rotation failed');
    } finally {
      setBusy(null);
    }
  };

  const openHistory = async (ext: ListEntry) => {
    setHistoryExt(ext);
    setCalls(null);
    setHistoryError(null);
    try {
      const rows = await api.extensionCalls(ext.extension);
      setCalls(rows);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load call history');
    }
  };

  const fmtDur = (secs: number) => {
    if (secs < 1) return '<1s';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Extensions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            WebRTC endpoints on the Zeus PBX — register from the Softphone page or any SIP client over WSS.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Add extension</Button>
      </div>

      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-3 p-10 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading extensions…
          </div>
        ) : extensions.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No WebRTC extensions found on the PBX.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3 font-medium">Extension</th>
                <th className="px-5 py-3 font-medium">Caller ID</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {extensions.map(ext => (
                <tr key={ext.extension} className="border-b last:border-0">
                  <td className="px-5 py-3.5 font-mono font-semibold">{ext.extension}</td>
                  <td className="px-5 py-3.5">{ext.callerId}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <RegChip registered={ext.registered} />
                      {ext.registered && ext.contactUri && (
                        <span className="hidden font-mono text-xs text-muted-foreground xl:inline" title={ext.contactUri}>
                          {ext.contactUri.replace(';transport=ws;x-', '').slice(0, 40)}…
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        disabled={busy === ext.extension}
                        onClick={() => void openHistory(ext)}
                      >
                        Call history
                      </button>
                      <button
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        disabled={busy === ext.extension}
                        onClick={() => void handleRotate(ext.extension)}
                      >
                        Rotate password
                      </button>
                      {ext.extension !== '102' && (
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                          disabled={busy === ext.extension}
                          onClick={() => void handleDelete(ext.extension)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Registration status is read live from pjsip ({extensions.filter(e => e.registered).length}/{extensions.length} online).
        Extension 102 is the built-in durable test extension (password from the stack's WEBRTC_TEST_PASSWORD).
        All changes write to the PBX's durable custom conf files and reload pjsip live — no container restart.
      </p>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add WebRTC extension">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Extension number</label>
            <Input className="mt-1" placeholder="103" value={newExt}
              onChange={e => setNewExt(e.target.value.replace(/\D/g, '').slice(0, 5))} />
            <p className="mt-1 text-xs text-muted-foreground">3–5 digits. 102 is reserved for the built-in test extension.</p>
          </div>
          <div>
            <label className="text-sm font-medium">Caller ID name</label>
            <Input className="mt-1" placeholder="Desk phone" value={newCid}
              onChange={e => setNewCid(e.target.value.slice(0, 60))} />
          </div>
          <div>
            <label className="text-sm font-medium">SIP password</label>
            <Input className="mt-1" type="password" placeholder="Strong password" value={newPass}
              onChange={e => setNewPass(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              Tip: generate one with the Password Generator tool.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleCreate()} disabled={busy === 'create' || !newExt.trim() || !newPass.trim()}>
              {busy === 'create' ? 'Provisioning…' : 'Create extension'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Call history modal */}
      <Modal open={historyExt !== null} onClose={() => setHistoryExt(null)} title={`Call history — ${historyExt?.extension ?? ''}`}>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {historyError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {historyError}
            </div>
          )}
          {!historyError && calls === null && (
            <div className="flex items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" /> Loading CDRs…
            </div>
          )}
          {!historyError && calls !== null && calls.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No calls logged for this extension yet.
            </p>
          )}
          {!historyError && calls !== null && calls.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Dir</th>
                  <th className="px-3 py-2 font-medium">Peer</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, i) => {
                  const disp = dispositionLabel(c.disposition);
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{c.time.replace('T', ' ')}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
                          c.direction === 'out' ? 'bg-brand-500/15 text-brand-600 dark:text-brand-300' : 'bg-muted text-muted-foreground')}>
                          {c.direction === 'out' ? 'OUT' : 'IN'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">{c.peer}</td>
                      <td className="px-3 py-2.5">
                        <span className={disp.tone === 'ok' ? 'text-success' : 'text-warning'}>{disp.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs">{fmtDur(c.durationSeconds)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </div>
  );
}
