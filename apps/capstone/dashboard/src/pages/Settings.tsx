import { useState } from 'react';import { useResolvedTheme } from '../components/providers';
import Button from '../components/Button';
import { cn } from '../lib/utils';
import Modal from '../components/Modal';
import Input from '../components/Input';
import Select from '../components/Select';

export default function Settings() {
  const { theme, setTheme } = useResolvedTheme();
  const [notifEmail, setNotifEmail] = useState('maya@capstone.internal');
  const [notifSlack, setNotifSlack] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Personal preferences, theme, notifications, and dashboard behavior.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Appearance</h2>
          <div>
            <label className="text-sm font-medium">Theme</label>
            <div className="mt-2 flex rounded-lg border bg-background p-1" role="group" aria-label="Theme selector">
              <button
                onClick={() => setTheme('dark')}
                className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', theme === 'dark' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Dark
              </button>
              <button
                onClick={() => setTheme('light')}
                className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', theme === 'light' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Light
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="reduceMotion" className="h-4 w-4 rounded border input accent-primary" />
            <label htmlFor="reduceMotion" className="text-sm cursor-pointer">Reduce motion</label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="highContrast" className="h-4 w-4 rounded border input accent-primary" />
            <label htmlFor="highContrast" className="text-sm cursor-pointer">High contrast focus rings</label>
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Notifications</h2>
          <div>
            <label className="text-sm font-medium">Email</label>
            <Input className="mt-1" value={notifEmail} onChange={e => setNotifEmail(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="notifSlack" className="h-4 w-4 rounded border input accent-primary" checked={notifSlack} onChange={e => setNotifSlack(e.target.checked)} />
            <label htmlFor="notifSlack" className="text-sm cursor-pointer">Slack alerts</label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Notify on</label>
            <div className="flex flex-col gap-2">
              {['Critical alerts', 'Warning alerts', 'Secret expiry reminders', 'Config changes', 'Audit log events'].map(label => (
                <label key={label} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" className="h-4 w-4 rounded border input accent-primary" defaultChecked={label === 'Critical alerts' || label === 'Secret expiry reminders'} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Dashboard</h2>
          <div>
            <label className="text-sm font-medium">Auto-refresh interval (seconds)</label>
            <Select
              value="30"
              options={[
                { value: '15', label: '15' },
                { value: '30', label: '30' },
                { value: '60', label: '60' },
                { value: '120', label: '120' },
                { value: '0', label: 'Off' },
              ]}
              onChange={() => {}}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Default export format</label>
            <Select
              value="csv"
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'json', label: 'JSON' },
                { value: 'pdf', label: 'PDF (browser)' },
              ]}
              onChange={() => {}}
              className="mt-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="compactView" className="h-4 w-4 rounded border input accent-primary" />
            <label htmlFor="compactView" className="text-sm cursor-pointer">Compact table view</label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="showTrends" className="h-4 w-4 rounded border input accent-primary" defaultChecked />
            <label htmlFor="showTrends" className="text-sm cursor-pointer">Show trend indicators</label>
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Profile</h2>
          <div>
            <label className="text-sm font-medium">Display name</label>
            <Input className="mt-1" defaultValue="Maya K." />
          </div>
          <div>
            <label className="text-sm font-medium">Email</label>
            <Input className="mt-1" defaultValue="maya@capstone.internal" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="showEmail" className="h-4 w-4 rounded border input accent-primary" defaultChecked />
            <label htmlFor="showEmail" className="text-sm cursor-pointer">Show email on dashboard</label>
          </div>
          <div className="pt-2">
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => setModalOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              Change password
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Access</h2>
          <div>
            <label className="text-sm font-medium">Session timeout (minutes)</label>
            <Select
              value="60"
              options={[
                { value: '15', label: '15' },
                { value: '30', label: '30' },
                { value: '60', label: '60' },
                { value: '120', label: '120' },
              ]}
              onChange={() => {}}
              className="mt-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="requireMfa" className="h-4 w-4 rounded border input accent-primary" />
            <label htmlFor="requireMfa" className="text-sm cursor-pointer">Require MFA for admin actions</label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="ipAllowList" className="h-4 w-4 rounded border input accent-primary" defaultChecked />
            <label htmlFor="ipAllowList" className="text-sm cursor-pointer">IP allow list enforcement</label>
          </div>
          <div>
            <label className="text-sm font-medium">Allowed IP ranges</label>
            <Input className="mt-1" placeholder="e.g. 192.168.1.0/24 (LAN subnet)" defaultValue="203.0.113.0/24" />
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Data & privacy</h2>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Dashboard analytics</span>
              <input type="checkbox" className="h-4 w-4 rounded border input accent-primary" defaultChecked />
            </div>
            <div className="flex items-center justify-between">
              <span>Usage metrics retention</span>
              <span className="font-mono text-xs">30 days</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Diagnostic telemetry</span>
              <span className="text-xs">Local only</span>
            </div>
          </div>
          <div className="pt-2">
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                Download my data
              </Button>
              <Button variant="ghost" size="sm" className="text-danger hover:text-danger/80">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                Delete account
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-card shadow-sm p-5">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Keyboard shortcuts</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          {[
            { shortcut: '⌘K', action: 'Global search' },
            { shortcut: '⌘R', action: 'Refresh dashboard' },
            { shortcut: 'Escape', action: 'Close modal/drawer' },
            { shortcut: '? ', action: 'Show shortcuts' },
          ].map(item => (
            <div key={item.shortcut} className="flex items-center justify-between">
              <span className="text-muted-foreground">{item.action}</span>
              <kbd className="h-7 min-w-[60px] rounded-md border bg-muted px-2 text-xs text-muted-foreground font-mono text-center">{item.shortcut}</kbd>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Change password"
        size="sm"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Current password</label>
            <Input className="mt-1" type="password" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">New password</label>
            <Input className="mt-1" type="password" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Confirm new password</label>
            <Input className="mt-1" type="password" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="default" size="sm">Update password</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
