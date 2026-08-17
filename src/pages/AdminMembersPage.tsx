import { useEffect, useState, useMemo } from 'react';
import {
  Users,
  ShieldCheck,
  ShieldAlert,
  UserCheck,
  UserX,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Key,
  Database,
  Cpu,
  Activity,
  Crown,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AdminMember } from '../types';

export default function AdminMembersPage() {
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'super_admin' | 'admin' | 'member'>('all');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<AdminMember[]>('/admin/members');
      setMembers(data || []);
    } catch (err) {
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not fetch members.',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => {
    const total = members.length;
    const active = members.filter((m) => m.is_active && m.access_granted).length;
    const suspended = members.filter((m) => !m.is_active || !m.access_granted).length;
    const superAdmins = members.filter((m) => m.role === 'super_admin' || m.email.toLowerCase() === 'leadspree24x7@gmail.com').length;
    return { total, active, suspended, superAdmins };
  }, [members]);

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const matchesSearch = m.email.toLowerCase().includes(search.toLowerCase());
      const isSuper = m.role === 'super_admin' || m.email.toLowerCase() === 'leadspree24x7@gmail.com';
      const effectiveRole = isSuper ? 'super_admin' : m.role;
      const matchesRole = roleFilter === 'all' || effectiveRole === roleFilter;
      return matchesSearch && matchesRole;
    });
  }, [members, search, roleFilter]);

  async function toggleAccess(member: AdminMember) {
    if (member.email.toLowerCase() === 'leadspree24x7@gmail.com') {
      alert('The root Super Admin account (leadspree24x7@gmail.com) cannot be suspended.');
      return;
    }

    const newActiveState = !(member.is_active && member.access_granted);
    setUpdatingId(member.id);
    setNotice(null);

    try {
      await api<AdminMember>(`/admin/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: newActiveState,
          access_granted: newActiveState,
        }),
      });

      setMembers((prev) =>
        prev.map((m) =>
          m.id === member.id
            ? { ...m, is_active: newActiveState, access_granted: newActiveState }
            : m
        )
      );

      setNotice({
        type: 'success',
        message: newActiveState
          ? `Access granted to ${member.email}. They can now use OniRoute API and Dashboard.`
          : `Access revoked for ${member.email}. Their API routing and dashboard access are suspended.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to update member access.',
      });
    } finally {
      setUpdatingId(null);
    }
  }

  async function changeRole(member: AdminMember, newRole: 'super_admin' | 'admin' | 'member') {
    if (member.email.toLowerCase() === 'leadspree24x7@gmail.com' && newRole !== 'super_admin') {
      alert('Cannot change the role of root Super Admin (leadspree24x7@gmail.com).');
      return;
    }

    setUpdatingId(member.id);
    setNotice(null);

    try {
      await api<AdminMember>(`/admin/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });

      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m))
      );

      setNotice({
        type: 'success',
        message: `Updated role for ${member.email} to “${newRole}”.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to change role.',
      });
    } finally {
      setUpdatingId(null);
    }
  }

  async function removeMember(member: AdminMember) {
    if (member.email.toLowerCase() === 'leadspree24x7@gmail.com') {
      alert('Cannot delete the root Super Admin account.');
      return;
    }

    if (!confirm(`Are you sure you want to completely remove ${member.email}? This will revoke all their API keys and providers.`)) {
      return;
    }

    setUpdatingId(member.id);
    setNotice(null);

    try {
      await api(`/admin/members/${member.id}`, { method: 'DELETE' });
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      setNotice({
        type: 'success',
        message: `Member ${member.email} successfully removed from OniRoute.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to remove member.',
      });
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold text-gray-900">Team & Member Control</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
              <Crown className="h-3 w-3 text-amber-600" /> Super Admin
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Managed by <strong>leadspree24x7@gmail.com</strong>. Grant or revoke member access, configure roles, and inspect AI routing usage.
          </p>
        </div>
      </div>

      {/* Notification Toast */}
      {notice && (
        <div
          className={`flex items-center gap-3 rounded-xl border p-4 text-sm shadow-sm animate-in fade-in slide-in-from-top-2 duration-150 ${
            notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
              : 'border-rose-200 bg-rose-50 text-rose-950'
          }`}
        >
          {notice.type === 'success' ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="h-5 w-5 text-rose-600 shrink-0" />
          )}
          <span className="font-medium">{notice.message}</span>
        </div>
      )}

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Total Registered Members</span>
            <div className="rounded-lg bg-violet-50 p-2 text-violet-600">
              <Users className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold text-gray-900">{stats.total}</p>
          <p className="mt-1 text-xs text-gray-400">All registered workspace accounts</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Active & Authorized</span>
            <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600">
              <UserCheck className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold text-emerald-600">{stats.active}</p>
          <p className="mt-1 text-xs text-gray-400">Full API gateway & dashboard access</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Access Suspended</span>
            <div className="rounded-lg bg-rose-50 p-2 text-rose-600">
              <UserX className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold text-rose-600">{stats.suspended}</p>
          <p className="mt-1 text-xs text-gray-400">Blocked by Super Admin</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Super Admins</span>
            <div className="rounded-lg bg-amber-50 p-2 text-amber-600">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold text-amber-700">{stats.superAdmins}</p>
          <p className="mt-1 text-xs text-gray-400">Root administration control</p>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search member by email..."
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-4 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs font-medium text-gray-500">Filter Role:</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as any)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 outline-none focus:ring-2 focus:ring-violet-500"
          >
            <option value="all">All Roles</option>
            <option value="super_admin">Super Admins</option>
            <option value="admin">Admins</option>
            <option value="member">Members</option>
          </select>
        </div>
      </div>

      {/* Members Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xs">
        {loading ? (
          <div className="p-12 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-violet-600" />
            <p className="mt-3 text-sm text-gray-500">Loading member records...</p>
          </div>
        ) : !filteredMembers.length ? (
          <div className="p-12 text-center">
            <Users className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 font-medium text-gray-900">No Members Found</p>
            <p className="mt-1 text-sm text-gray-500">No accounts match your current search and filter criteria.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50/75 text-xs font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="py-3.5 pl-6 pr-4">Member Email</th>
                  <th className="px-4 py-3.5">Role</th>
                  <th className="px-4 py-3.5">Access Status</th>
                  <th className="px-4 py-3.5">Usage / Resources</th>
                  <th className="py-3.5 pl-4 pr-6 text-right">Admin Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredMembers.map((member) => {
                  const isRootSuper = member.email.toLowerCase() === 'leadspree24x7@gmail.com';
                  const isUpdating = updatingId === member.id;
                  const hasAccess = member.is_active && member.access_granted;

                  return (
                    <tr key={member.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="py-4 pl-6 pr-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 font-semibold text-violet-700">
                            {member.email.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-gray-900 truncate">{member.email}</p>
                              {isRootSuper && (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                                  Root Admin
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 font-mono mt-0.5">
                              Joined {new Date(member.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-4">
                        {isRootSuper ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 border border-amber-200">
                            <Crown className="h-3 w-3 text-amber-600" /> Super Admin
                          </span>
                        ) : (
                          <select
                            disabled={isUpdating}
                            value={member.role}
                            onChange={(e) => changeRole(member, e.target.value as any)}
                            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 outline-none focus:ring-2 focus:ring-violet-500"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                            <option value="super_admin">Super Admin</option>
                          </select>
                        )}
                      </td>

                      <td className="px-4 py-4">
                        {hasAccess ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                            Active & Granted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 border border-rose-200">
                            <span className="h-2 w-2 rounded-full bg-rose-500"></span>
                            Access Suspended
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-4 text-xs text-gray-500">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="inline-flex items-center gap-1" title="Configured AI Providers">
                            <Cpu className="h-3.5 w-3.5 text-gray-400" /> {member.providers_count ?? 0}
                          </span>
                          <span className="inline-flex items-center gap-1" title="Active Gateway Keys">
                            <Key className="h-3.5 w-3.5 text-gray-400" /> {member.keys_count ?? 0}
                          </span>
                          <span className="inline-flex items-center gap-1" title="Knowledge Bases">
                            <Database className="h-3.5 w-3.5 text-gray-400" /> {member.knowledge_count ?? 0}
                          </span>
                          <span className="inline-flex items-center gap-1 text-violet-700 font-medium" title="Total Inference Requests">
                            <Activity className="h-3.5 w-3.5 text-violet-500" /> {member.total_requests ?? 0} reqs
                          </span>
                        </div>
                      </td>

                      <td className="py-4 pl-4 pr-6 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!isRootSuper && (
                            <>
                              <button
                                onClick={() => toggleAccess(member)}
                                disabled={isUpdating}
                                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors shadow-2xs ${
                                  hasAccess
                                    ? 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                }`}
                                title={hasAccess ? 'Revoke member access' : 'Grant member access'}
                              >
                                {isUpdating ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : hasAccess ? (
                                  <>
                                    <ShieldAlert className="h-3.5 w-3.5 text-rose-600" /> Revoke Access
                                  </>
                                ) : (
                                  <>
                                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Grant Access
                                  </>
                                )}
                              </button>

                              <button
                                onClick={() => removeMember(member)}
                                disabled={isUpdating}
                                className="rounded-lg p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                                title="Remove member account"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {isRootSuper && (
                            <span className="text-xs text-gray-400 font-medium pr-2">Protected Owner</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
