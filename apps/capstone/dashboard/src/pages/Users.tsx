import { useState, useMemo } from 'react';
import type { User, Role } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import Button from '../components/Button';
import { cn, formatRelativeTime } from '../lib/utils';
import Modal from '../components/Modal';
import Input from '../components/Input';
import Select from '../components/Select';

const roles: Array<{ value: Role; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'auditor', label: 'Auditor' },
];

const statusBadge = (status: User['status']) => {
  switch (status) {
    case 'active':
      return <span className="inline-flex items-center gap-1 rounded-full bg-success/20 px-2 py-0.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />Active</span>;
    case 'disabled':
      return <span className="inline-flex items-center gap-1 rounded-full bg-danger/20 px-2 py-0.5 text-xs font-medium text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" />Disabled</span>;
    case 'pending':
      return <span className="inline-flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning"><span className="h-1.5 w-1.5 rounded-full bg-warning" />Pending</span>;
    default:
      return <span className="text-xs text-muted-foreground">{status}</span>;
  }
};

export default function Users() {
  const { users } = useDashboardData();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);

  const filtered = useMemo(() => {
    return users.filter(u => {
      const matchesSearch = search === '' || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase());
      const matchesRole = roleFilter === 'all' || u.role === roleFilter;
      const matchesStatus = statusFilter === 'all' || u.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [search, roleFilter, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & Access</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage user accounts, roles, permissions, and access levels.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export users
          </Button>
          <Button variant="default" size="sm" onClick={() => setCreateOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="23" y1="12" x2="17" y2="12" /></svg>
            Add user
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search by name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search users"
          />
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Role filter">
          {['all', 'admin', 'operator', 'viewer', 'auditor'].map(r => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', roleFilter === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {r === 'all' ? 'All roles' : r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Status filter">
          {['all', 'active', 'disabled', 'pending'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {s === 'all' ? 'All status' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="border rounded-xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">User</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Role</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last active</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sessions</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Created</th>
              <th className="px-4 py-3 w-[120px]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(user => (
              <tr key={user.id} className="hover:bg-muted/40 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-semibold">
                      {user.name.split(' ')[0].charAt(0)}
                    </div>
                    <div>
                      <div className="font-medium">{user.name}</div>
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary', user.role)}>
                    {user.role}
                  </span>
                </td>
                <td className="px-4 py-3">{statusBadge(user.status)}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(user.lastActive)}</td>
                <td className="px-4 py-3 text-right font-medium">{user.sessions}</td>
                <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatRelativeTime(user.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setEditUser(user); setEditOpen(true); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                      Edit
                    </Button>
                    {user.status !== 'disabled' && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="23" y1="12" x2="17" y2="12" /></svg>
                        Disable
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            <p className="mt-2 text-sm font-medium">No users match your filters.</p>
            <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
          </div>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add user"
        size="md"
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input className="mt-1" placeholder="Full name" />
            </div>
            <div>
              <label className="text-sm font-medium">Email</label>
              <Input className="mt-1" placeholder="user@capstone.internal" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Role</label>
              <Select
                value="viewer"
                options={roles}
                onChange={() => {}}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Status</label>
              <Select
                value="active"
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
                onChange={() => {}}
                className="mt-1"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="default" size="sm">Add user</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editUser ? `Edit ${editUser.name}` : 'Edit user'}
        size="sm"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input className="mt-1" defaultValue={editUser?.name} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Email</label>
            <Input className="mt-1" defaultValue={editUser?.email} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Role</label>
            <Select
              value={editUser?.role ?? 'viewer'}
              options={roles}
              onChange={() => {}}
              className="mt-1"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Select
              value={editUser?.status ?? 'active'}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'disabled', label: 'Disabled' },
                { value: 'pending', label: 'Pending' },
              ]}
              onChange={() => {}}
              className="mt-1"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="default" size="sm" onClick={() => setEditOpen(false)}>Save changes</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
