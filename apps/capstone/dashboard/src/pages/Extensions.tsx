import { useCallback, useEffect, useState } from 'react';
import { api, type ExtensionCall, type PbxExtension } from '../lib/api';
import Button from '../components/Button';
import Input from '../components/Input';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { cn } from '../lib/utils';

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

/** Parse a free-form DID list ("2125551234, 8009") into plain digit strings. */
function parseDids(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map(s => s.replace(/\D/g, ''))
        .filter(s => /^\d{3,15}$/.test(s)),
    ),
  );
}

export default function Extensions() {
  const [extensions, setExtensions] = useState<PbxExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newExt, setNewExt] = useState('');
  const [newCid, setNewCid] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newDids, setNewDids] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Edit modal state
  const [editExt, setEditExt] = useState<PbxExtension | null>(null);
  const [editCid, setEditCid] = useState('');
  const [editPass, setEditPass] = useState('');
  const [editDids, setEditDids] = useState('');

  // Call-history modal state
  const [historyExt, setHistoryExt] = useState<PbxExtension | null>(null);
  const [calls, setCalls] = useState<ExtensionCall[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setExtensions(await api.extensions());
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
      const dids = parseDids(newDids);
      await api.createExtension({
        extension: newExt.trim(),
        password: newPass,
        callerId: newCid.trim() || undefined,
        dids: dids.length ? dids : undefined,
      });
      setCreateOpen(false);
      setNewExt(''); setNewCid(''); setNewPass(''); setNewDids('');
      flash(`Extension ${newExt} provisioned${dids.length ? `; DID ${dids.join(', ')} routed to it` : ''} and pjsip reloaded`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(null);
    }
  };

  const openEdit = (ext: PbxExtension) => {
    setEditExt(ext);
    setEditCid(ext.callerId.replace(` <${ext.extension}>`, ''));
    setEditPass('');
    setEditDids((ext.dids ?? []).join(', '));
  };

  const handleSaveEdit = async () => {
    if (!editExt) return;
    setBusy(editExt.extension);
    setError(null);
    try {
      const dids = parseDids(editDids);
      const body: { callerId?: string; password?: string; dids?: string[] } = {};
      const cid = editCid.trim();
      const curCid = editExt.callerId.replace(` <${editExt.extension}>`, '');
      if (cid && cid !== curCid) body.callerId = cid;
      if (editPass.trim()) body.password = editPass.trim();
      body.dids = dids;
      await api.updateExtension(editExt.extension, body);
      setEditExt(null);
      flash(`Extension ${editExt.extension} updated` + (body.password ? ' (password rotated)' : '') +
        `; ${dids.length} DID${dids.length === 1 ? '' : 's'} routed`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (ext: PbxExtension) => {
    if (!window.confirm(`Remove extension ${ext.extension}? Devices using it will be disconnected and its inbound DID routes dropped.`)) return;
    setBusy(ext.extension);
    setError(null);
    try {
      await api.deleteExtension(ext.extension);
      flash(`Extension ${ext.extension} removed`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const handleRotate = async (ext: PbxExtension) => {
    const password = window.prompt(`New SIP password for extension ${ext.extension}:`);
    if (!password) return;
    setBusy(ext.extension);
    setError(null);
    try {
      await api.rotateExtensionPassword(ext.extension, password);
      flash(`Password rotated for extension ${ext.extension}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Password rotation failed');
    } finally {
      setBusy(null);
    }
  };

  const openHistory = async (ext: PbxExtension) => {
    setHistoryExt(ext);
    setCalls(null);
    setHistoryError(null);
    try {
      setCalls(await api.extensionCalls(ext.extension));
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

  const online = extensions.filter(e => e.registered).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Extensions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            WebRTC endpoints on the Zeus PBX — create, edit, and route inbound numbers to them. Devices register over WSS from the Softphone page or any SIP client.
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Extension</th>
                  <th className="px-5 py-3 font-medium">Caller ID</th>
                  <th className="px-5 py-3 font-medium">Inbound DIDs</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {extensions.map(ext => (
                  <tr key={ext.extension} className="border-b last:border-0">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">{ext.extension}</span>
                        {ext.builtIn && (
                          <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-600 ring-1 ring-brand-500/30 dark:text-brand-300">
                            Built-in
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">{ext.callerId}</td>
                    <td className="px-5 py-3.5">
                      {ext.dids && ext.dids.length > 0 ? (
                        <div className="flex max-w-[240px] flex-wrap gap-1">
                          {ext.dids.map(did => (
                            <span key={did} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                              {did}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
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
                          onClick={() => openEdit(ext)}
                        >
                          Edit
                        </button>
                        {!ext.builtIn && (
                          <>
                            <button
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                              disabled={busy === ext.extension}
                              onClick={() => void handleRotate(ext)}
                            >
                              Rotate password
                            </button>
                            <button
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                              disabled={busy === ext.extension}
                              onClick={() => void handleDelete(ext)}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Registration status is read live from pjsip ({online}/{extensions.length} online). The built-in test extension (default 101) is stack-managed via
        WEBRTC_TEST_EXTENSION / WEBRTC_TEST_PASSWORD — rename or password-rotate it in the stack env, not here. Inbound DID routes ring the extension's
        registered device; a number with no route still lands on the default dograh agent (8000). All changes write to the PBX's durable custom conf
        files and reload live — no container restart.
      </p>

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add WebRTC extension">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Extension number</label>
            <Input className="mt-1" placeholder="103" value={newExt}
              onChange={e => setNewExt(e.target.value.replace(/\D/g, '').slice(0, 5))} />
            <p className="mt-1 text-xs text-muted-foreground">3–5 digits. The built-in test extension (default 101) is reserved.</p>
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
          <div>
            <label className="text-sm font-medium">Inbound DID numbers (optional)</label>
            <Input className="mt-1" placeholder="2125551234, 8009" value={newDids}
              onChange={e => setNewDids(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              Comma/space-separated. Calls to these numbers will ring this extension.
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

      {/* Edit modal */}
      <Modal open={editExt !== null} onClose={() => setEditExt(null)}
        title={`Edit extension — ${editExt?.extension ?? ''}`}>
        {editExt && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Caller ID name</label>
              <Input className="mt-1" placeholder="Desk phone" value={editCid}
                onChange={e => setEditCid(e.target.value.slice(0, 60))} />
            </div>
            <div>
              <label className="text-sm font-medium">New SIP password (leave blank to keep)</label>
              <Input className="mt-1" type="password" placeholder={editExt.builtIn ? 'Stack-managed (WEBRTC_TEST_PASSWORD)' : 'Unchanged'}
                value={editPass} disabled={editExt.builtIn}
                onChange={e => setEditPass(e.target.value)} />
              {editExt.builtIn && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The built-in test extension's password comes from the stack env (WEBRTC_TEST_PASSWORD).
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Inbound DID numbers</label>
              <Input className="mt-1" placeholder="2125551234, 8009" value={editDids}
                onChange={e => setEditDids(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma/space-separated. Saves replace this extension's routes — calls to these numbers ring it; a route can only belong to one extension.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditExt(null)}>Cancel</Button>
              <Button onClick={() => void handleSaveEdit()} disabled={busy === editExt.extension}>
                {busy === editExt.extension ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
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
