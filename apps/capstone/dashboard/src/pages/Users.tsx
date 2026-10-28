import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import Button from '../components/Button';
import StatusBadge from '../components/StatusBadge';
import { cn, formatRelativeTime } from '../lib/utils';
import { exportJSON } from '../lib/export';

const roles = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'auditor', label: 'Auditor' },
] as const;

export default function Users() {
  const { users } = useDashboardData();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = useMemo(() => users.filter(user => {
    const needle = search.trim().toLowerCase();
    const matchesSearch = !needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesStatus = statusFilter === 'all' || user.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  }), [roleFilter, search, statusFilter, users]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & Access</h1>
          <p className="mt-1 text-sm text-muted-foreground">Search the operational user directory and review account activity.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportJSON(users, { filename: `capstone-users-${new Date().toISOString().slice(0, 10)}.json` })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export users
          </Button>
          <Link to="/health#sso-access" className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium shadow-sm hover:bg-muted">
            View live SSO access
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-info/30 bg-info/5 px-4 py-3 text-sm">
        <span className="font-medium">Identity is managed in Authentik.</span>{' '}
        <span className="text-muted-foreground">This page is a read-only directory snapshot; use Health → Stack SSO & access for live identity, group, and application enforcement.</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Directory users', value: users.length },
          { label: 'Active', value: users.filter(user => user.status === 'active').length },
          { label: 'Active sessions', value: users.reduce((sum, user) => sum + user.sessions, 0) },
        ].map(card => (
          <div key={card.label} className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search by name or email…"
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="h-9 w-full min-w-[240px] rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search users"
          />
        </div>
        <div className="flex flex-wrap rounded-md border bg-background p-1" role="group" aria-label="Role filter">
          {['all', ...roles.map(role => role.value)].map(role => (
            <button
              key={role}
              type="button"
              onClick={() => setRoleFilter(role)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', roleFilter === role ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {role === 'all' ? 'All roles' : role.charAt(0).toUpperCase() + role.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap rounded-md border bg-background p-1" role="group" aria-label="Status filter">
          {['all', 'active', 'disabled', 'pending'].map(status => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === status ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {status === 'all' ? 'All status' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">User</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Role</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last active</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sessions</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((user: User) => (
              <tr key={user.id} className="transition-colors hover:bg-muted/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{user.name.split(' ')[0]?.charAt(0) || '?'}</div>
                    <div><div className="font-medium">{user.name}</div><div className="text-xs text-muted-foreground">{user.email}</div></div>
                  </div>
                </td>
                <td className="px-4 py-3"><span className={cn('rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary', user.role)}>{user.role}</span></td>
                <td className="px-4 py-3"><StatusBadge status={user.status} size="sm" /></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(user.lastActive)}</td>
                <td className="px-4 py-3 text-right font-medium">{user.sessions}</td>
                <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatRelativeTime(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="border-t py-12 text-center text-sm text-muted-foreground">No users match your filters.</div>}
      </div>
    </div>
  );
}
