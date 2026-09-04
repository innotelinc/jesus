import { useState } from 'react';
import type { ConfigPolicy } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import Button from '../components/Button';
import { cn } from '../lib/utils';
import Modal from '../components/Modal';
import Input from '../components/Input';

export default function Config() {
  const { policies } = useDashboardData();
  const [editing, setEditing] = useState<ConfigPolicy | null>(null);
  const [editName, setEditName] = useState('');
  const [editValue, setEditValue] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  const togglePolicy = (policy: ConfigPolicy) => {
    setEditing(policy);
    setEditName(policy.name);
    setEditValue(policy.value);
    setSaveOpen(true);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage system policies, service configuration, and platform settings.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 border rounded-2xl bg-card shadow-sm overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Policy</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Enabled</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Value</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last updated</th>
                <th className="px-4 py-3 w-[120px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {policies.map(policy => (
                <tr key={policy.id} className="hover:bg-muted/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary text-xs font-semibold">
                        {policy.name.charAt(0)}
                      </div>
                      <span className="font-medium">{policy.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground max-w-[220px] truncate">{policy.description}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => togglePolicy(policy)}
                      className={cn(
                        'inline-flex h-6 w-10 items-center rounded-full transition-colors',
                        policy.enabled ? 'bg-success' : 'bg-muted hover:bg-muted/80',
                      )}
                      role="switch"
                      aria-checked={policy.enabled}
                      aria-label={`Toggle ${policy.name}`}
                    >
                      <span className={cn('inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform', policy.enabled ? 'translate-x-4' : 'translate-x-1')} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">{policy.value}</td>
                  <td className="px-4 py-3 text-right text-sm text-muted-foreground">{policy.updatedAt}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" className="h-7 text-xs">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.36 2.36M17.42 17.42l2.36 2.36M1 12h4M19 12h4M4.22 19.78l2.36-2.36M17.42 6.58l2.36-2.36" /></svg>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                        Duplicate
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border bg-card shadow-sm p-5">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Quick actions</h2>
            <div className="flex flex-col gap-2 mt-3">
              <Button variant="secondary" size="sm" className="justify-start text-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Apply pending config
              </Button>
              <Button variant="secondary" size="sm" className="justify-start text-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
                Export configuration
              </Button>
              <Button variant="secondary" size="sm" className="justify-start text-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                Reset to defaults
              </Button>
              <Button variant="outline" size="sm" className="justify-start text-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                Add custom policy
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border bg-card shadow-sm p-5">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Settings summary</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Alert escalation timeout</span>
                <span className="font-medium">{policies.find(p => p.id === 'p2')?.value || '30'} min</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Secrets rotation reminder</span>
                <span className="font-medium">{policies.find(p => p.id === 'p3')?.value || '30'} days</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Audit log retention</span>
                <span className="font-medium">{policies.find(p => p.id === 'p5')?.value || '90'} days</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Environment access</span>
                <span className="font-medium">{policies.find(p => p.id === 'p4')?.value || 'admin|operator'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'Edit policy'}
        size="sm"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input className="mt-1" value={editName} onChange={e => setEditName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Value</label>
            <Input className="mt-1" value={editValue} onChange={e => setEditValue(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="default" size="sm" onClick={() => setSaveOpen(false)}>Save changes</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
