'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { userManagementService, Staff } from '@/services/userManagementService';
import { roleService, Role } from '@/services/roleService';
import { hasPermission } from '@/lib/auth';
import ApprovalActions from '@/components/AdminDashboard/Approvals/ApprovalActions';
import { Button } from '@/components/UI/Button';
import { Badge } from '@/components/UI/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/UI/Table';
import { useRouter } from 'next/navigation';
import Dropdown from '@/components/UI/Dropdown';
import DateRangeCalendar, { fmtDate } from '@/components/Shared/DateRangeCalendar';
import DeleteConfirmModal from '@/components/UI/DeleteConfirmModal';
import { formatPrice } from "@/lib/currency";
import {
  Users as UsersIcon,
  UserPlus,
  Search,
  Eye,
  Edit,
  Trash2,
  Shield,
  ShieldCheck,
  Mail,
  Phone,
  Activity,
  UserCheck,
  UserX,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal
} from 'lucide-react';

const PAGE_SIZE = 10;
const REFRESH_INTERVAL_MS = 30000;

function getPageRange(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: Array<number | '…'> = [1];
  if (current > 4) pages.push('…');
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let p = start; p <= end; p++) pages.push(p);
  if (current < total - 3) pages.push('…');
  pages.push(total);
  return pages;
}

export default function UserManagement() {
  const router = useRouter();
  const [users, setUsers] = useState<Staff[]>([]);
  const [availableRoles, setAvailableRoles] = useState<Role[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; email: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  // Use a ref to always call the latest fetchStaff inside setInterval without resetting the interval
  const fetchStaffRef = useRef<() => void>(() => {});

  // Update the ref to the latest fetchStaff on every render
  useEffect(() => {
    fetchStaffRef.current = fetchStaff;
  });

  // Initial load + 30s polling. Filtering is client-side, so this only needs to
  // run once (plus on tab re-focus) — it no longer refetches per keystroke/filter.
  useEffect(() => {
    fetchStaff();
    fetchRoles();

    let timer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (timer) return;
      timer = setInterval(() => fetchStaffRef.current(), REFRESH_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchStaffRef.current();
        startPolling();
      } else {
        stopPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to the first page whenever the client-side search/filter changes.
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, roleFilter, statusFilter, dateFrom, dateTo]);

  const fetchRoles = async () => {
    try {
      const data = await roleService.getRoles();
      if (data.success) {
        setAvailableRoles(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch roles', error);
    }
  };

  // Always fetch the FULL staff set so the metric cards reflect global totals.
  // Search + role/status/date filtering is applied client-side below, so the
  // stats never shrink to the currently-filtered subset.
  const fetchStaff = async () => {
    try {
      const data = await userManagementService.getStaff();
      setUsers(data);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to fetch staff', error);
    }
  };

  const handleStatusChange = async (userId: string, newStatus: 'active' | 'suspended') => {
    try {
      await userManagementService.updateStaffStatus(userId, newStatus);
      fetchStaff();
    } catch (error) {
      console.error('Failed to update status', error);
    }
  };

  const handleDeleteClick = (user: Staff) => {
    setDeleteTarget({ id: user.id, name: `${user.firstName} ${user.lastName}`, email: user.email });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await userManagementService.deleteStaff(deleteTarget.id);
      fetchStaff();
    } catch (error) {
      console.error('Failed to delete staff', error);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleAddStaff = () => {
    router.push('/admin/dashboard/users/add');
  };

  const handleEditStaff = (userId: string) => {
    router.push(`/admin/dashboard/users/edit/${userId}`);
  };

  // Calculate stats from current data
  const totalUsers = users.length;
  const newThisMonth = users.filter(user => {
    const joinDate = new Date(user.joinDate);
    const now = new Date();
    return joinDate.getMonth() === now.getMonth() && joinDate.getFullYear() === now.getFullYear();
  }).length;
  const activeToday = users.filter(user => {
    const lastLogin = new Date(user.lastLogin);
    const today = new Date();
    return lastLogin.toDateString() === today.toDateString();
  }).length;
  const activeUsers = users.filter(user => user.status === 'active').length;
  const suspendedUsers = users.filter(user => user.status === 'suspended').length;
  const pendingUsers = users.filter(user => user.status === 'pending').length;

  // Clickable metric cards — each key maps to a client-side filter applied to the
  // table below. 'all' clears the status filter; the status keys match user.status;
  // the two date-based keys reuse the exact metric definitions.
  const statCards = [
    { key: 'all',          title: 'Total Users',    value: totalUsers,     subtitle: 'Internal staff members', Icon: UsersIcon, iconBg: 'bg-brand-50',   iconColor: 'text-brand-500',   countColor: 'text-slate-900',   activeClass: 'border-brand-400 bg-brand-50/50' },
    { key: 'newThisMonth', title: 'New This Month', value: newThisMonth,   subtitle: 'Joined this month',      Icon: UserPlus,  iconBg: 'bg-emerald-50', iconColor: 'text-emerald-500', countColor: 'text-emerald-700', activeClass: 'border-emerald-400 bg-emerald-50/60' },
    { key: 'activeToday',  title: 'Active Today',   value: activeToday,    subtitle: 'Currently online',       Icon: Activity,  iconBg: 'bg-indigo-50',  iconColor: 'text-indigo-500',  countColor: 'text-indigo-700',  activeClass: 'border-indigo-400 bg-indigo-50/60' },
    { key: 'active',       title: 'Active Users',   value: activeUsers,    subtitle: 'Verified accounts',      Icon: UserCheck, iconBg: 'bg-teal-50',    iconColor: 'text-teal-500',    countColor: 'text-teal-700',    activeClass: 'border-teal-400 bg-teal-50/60' },
    { key: 'suspended',    title: 'Suspended',      value: suspendedUsers, subtitle: 'Restricted access',      Icon: UserX,     iconBg: 'bg-red-50',     iconColor: 'text-red-500',     countColor: 'text-red-700',     activeClass: 'border-red-400 bg-red-50/60' },
    { key: 'pending',      title: 'Pending',        value: pendingUsers,   subtitle: 'Awaiting approval',      Icon: Shield,    iconBg: 'bg-amber-50',   iconColor: 'text-amber-500',   countColor: 'text-amber-700',   activeClass: 'border-amber-400 bg-amber-50/60' },
  ] as const;

  // Client-side search + role + status + join-date filtering.
  const now = new Date();
  const filteredUsers = users.filter((user) => {
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      const hay = `${user.firstName} ${user.lastName} ${user.email} ${user.phone}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (roleFilter !== 'all' && user.roleId !== roleFilter) return false;
    if (dateFrom || dateTo) {
      const jd = user.joinDate ? fmtDate(new Date(user.joinDate)) : '';
      if (!jd) return false;
      if (dateFrom && jd < dateFrom) return false;
      if (dateTo && jd > dateTo) return false;
    }
    switch (statusFilter) {
      case 'active':
      case 'suspended':
      case 'pending':
        return user.status === statusFilter;
      case 'newThisMonth': {
        const j = new Date(user.joinDate);
        return j.getMonth() === now.getMonth() && j.getFullYear() === now.getFullYear();
      }
      case 'activeToday':
        return new Date(user.lastLogin).toDateString() === now.toDateString();
      default:
        return true; // 'all'
    }
  });

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const paginatedUsers = filteredUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-50 text-green-700 border border-green-200">Active</Badge>;
      case 'suspended':
        return <Badge className="bg-red-50 text-red-700 border border-red-200">Suspended</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-50 text-yellow-700 border border-yellow-200">Pending</Badge>;
      default:
        return <Badge className="bg-slate-50 text-slate-700 border border-slate-200">Unknown</Badge>;
    }
  };

  // Deterministic color picker — hashes the role name to a fixed palette so
  // every role (including future custom ones) gets a stable color with no
  // hardcoded "admin"/"manager" string matching.
  const ROLE_PALETTE = [
    'bg-purple-50 text-purple-700 border border-purple-200',
    'bg-blue-50 text-blue-700 border border-blue-200',
    'bg-green-50 text-green-700 border border-green-200',
    'bg-amber-50 text-amber-700 border border-amber-200',
    'bg-rose-50 text-rose-700 border border-rose-200',
    'bg-teal-50 text-teal-700 border border-teal-200',
    'bg-indigo-50 text-indigo-700 border border-indigo-200',
    'bg-orange-50 text-orange-700 border border-orange-200',
  ];
  const getRoleBadge = (role: string) => {
    if (!role) return <Badge className="bg-slate-50 text-slate-700 border border-slate-200">—</Badge>;
    // Super Admin always gets the distinctive purple treatment (case-insensitive match)
    if (role.toLowerCase().trim() === 'super admin') {
      return <Badge className="bg-purple-50 text-purple-700 border border-purple-200">{role}</Badge>;
    }
    let hash = 0;
    for (let i = 0; i < role.length; i++) hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
    const cls = ROLE_PALETTE[hash % ROLE_PALETTE.length];
    return <Badge className={cls}>{role}</Badge>;
  };

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500">Manage internal staff and their access levels (Ready for Add Staff)</p>
        </div>
        <div className="flex items-center gap-3">
          {hasPermission('staff_management:create') && (
            <Button
              onClick={handleAddStaff}
              className="bg-brand-500 hover:bg-brand-600 text-white shadow-sm px-6 py-2 rounded-lg font-semibold flex items-center transition-all hover:scale-105 active:scale-95"
            >
              <UserPlus className="h-5 w-5 mr-2" />
              <span>Add Staff Member</span>
            </Button>
          )}
        </div>
      </div>

      {/* Collapsible "Overview & Filters" — expand/collapse the metrics + filters */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-slate-900 transition-colors"
        >
          <SlidersHorizontal className="h-4 w-4 text-slate-500" />
          Overview &amp; Filters
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${panelOpen ? 'rotate-180' : ''}`} />
        </button>
        <span className="text-xs text-slate-500">
          Showing {filteredUsers.length} of {users.length} users
        </span>
      </div>

      {panelOpen && (
        <div className="space-y-4">
      {/* Stats Cards — click a card to filter the table below by that metric */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map(({ key, title, value, subtitle, Icon, iconBg, iconColor, countColor, activeClass }) => {
          const isActive = statusFilter === key;
          const toggle = () => setStatusFilter((prev) => (key === 'all' || prev === key ? 'all' : key));
          return (
            <button
              key={key}
              type="button"
              onClick={toggle}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
              className={`text-left bg-white border rounded-2xl shadow-xs transition-all duration-200 hover:shadow-sm group ${isActive ? activeClass : 'border-slate-200/80 hover:border-slate-300'}`}
            >
              <div className="flex flex-row items-center justify-between px-3.5 pt-3 pb-1">
                <span className="text-[13px] font-medium text-slate-500">{title}</span>
                <div className={`p-1.5 rounded-lg ${isActive ? iconBg.replace('50', '100') : iconBg} transition-transform duration-150 group-hover:scale-110`}>
                  <Icon className={`h-4 w-4 ${iconColor}`} />
                </div>
              </div>
              <div className="px-3.5 pb-3">
                <div className={`text-xl font-bold ${countColor}`}>{value}</div>
                <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs p-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
          <div className="flex-1 relative min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 h-4 w-4 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name, email, or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 focus:outline-none w-full transition-all bg-white text-sm"
            />
          </div>
          <div className="w-full md:w-44 shrink-0">
            <Dropdown
              value={roleFilter}
              options={[
                { value: 'all', label: 'All Roles' },
                ...availableRoles.map(r => ({ value: r.id, label: r.name }))
              ]}
              onChange={(value: string | string[]) => setRoleFilter(value as string)}
              placeholder="All Roles"
            />
          </div>
          <div className="w-full md:w-44 shrink-0">
            <Dropdown
              value={['active', 'suspended', 'pending'].includes(statusFilter) ? statusFilter : 'all'}
              options={[
                { value: 'all', label: 'All Status' },
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'pending', label: 'Pending' }
              ]}
              onChange={(value: string | string[]) => setStatusFilter(value as string)}
              placeholder="All Status"
            />
          </div>
          <div className="shrink-0">
            <DateRangeCalendar
              from={dateFrom}
              to={dateTo}
              placeholder="Join Date"
              onChange={(f, t) => { setDateFrom(f); setDateTo(t); }}
            />
          </div>
        </div>
      </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="!bg-brand-500/[0.06] !border-0 [&_tr]:border-b [&_tr]:border-brand-100/50 [&_th]:!text-brand-500/60 [&_th]:font-bold [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:h-11 [&_th]:px-4">
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12">
                    <div className="text-slate-500">
                      <p className="text-lg font-medium">No users found</p>
                      <p className="text-sm">Try adjusting your search or filter criteria</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedUsers.map((user) => (
                  <TableRow key={user.id} className="hover:bg-slate-50/60 transition-colors duration-150 border-b border-slate-100 last:border-0">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center">
                          {user.avatar ? (
                            <img
                              src={user.avatar}
                              alt={`${user.firstName} ${user.lastName}`}
                              className="w-full h-full object-cover rounded-full"
                            />
                          ) : (
                            <span className="text-sm font-medium text-slate-600">
                              {user.firstName.charAt(0)}{user.lastName.charAt(0)}
                            </span>
                          )}
                        </div>
                        <div>
                          <div className="font-medium">{user.firstName} {user.lastName}</div>
                          <div className="text-sm text-slate-500">{user.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-sm">
                          <Mail className="h-3 w-3 text-slate-400" />
                          <span className={user.isEmailVerified ? 'text-green-600' : 'text-slate-600'}>
                            {user.email}
                          </span>
                          {user.isEmailVerified && <ShieldCheck className="h-3 w-3 text-green-500" />}
                        </div>
                        <div className="flex items-center gap-1 text-sm">
                          <Phone className="h-3 w-3 text-slate-400" />
                          <span className={user.isPhoneVerified ? 'text-green-600' : 'text-slate-600'}>
                            {user.phone}
                          </span>
                          {user.isPhoneVerified && <ShieldCheck className="h-3 w-3 text-green-500" />}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
                    <TableCell>{getStatusBadge(user.status)}</TableCell>
                    <TableCell>
                      <div className="text-sm text-slate-600">
                        {new Date(user.lastLogin).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <ApprovalActions module="staff" id={user.id} label={`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email} approvalStatus={(user as any).approvalStatus} permission="staff_management:approve" onDone={fetchStaff} />
                        {hasPermission('staff_management:view') && (
                          <button
                            title="View User Details"
                            onClick={() => router.push(`/admin/dashboard/users/view/${user.id}`)}
                            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        )}
                        {hasPermission('staff_management:edit') && (
                          <button
                            title="Edit User"
                            onClick={() => handleEditStaff(user.id)}
                            className="p-2 rounded-lg text-blue-500 hover:text-blue-700 hover:bg-blue-50 transition-colors"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                        )}
                        {hasPermission('staff_management:suspend') && user.status === 'active' ? (
                          <button
                            title="Suspend User"
                            onClick={() => handleStatusChange(user.id, 'suspended')}
                            className="p-2 rounded-lg text-orange-500 hover:text-orange-700 hover:bg-orange-50 transition-colors"
                          >
                            <UserX className="h-4 w-4" />
                          </button>
                        ) : hasPermission('staff_management:suspend') ? (
                          <button
                            title="Activate User"
                            onClick={() => handleStatusChange(user.id, 'active')}
                            className="p-2 rounded-lg text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
                          >
                            <UserCheck className="h-4 w-4" />
                          </button>
                        ) : null}
                        {hasPermission('staff_management:delete') && (
                          <button
                            title="Delete User"
                            onClick={() => handleDeleteClick(user)}
                            className="p-2 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm px-4 py-3 border-t border-slate-100">
          <div className="flex items-center gap-1">
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1} className="p-2 text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
            {getPageRange(currentPage, totalPages).map((p, i) => p === '…' ? (<span key={`e-${i}`} className="px-2 text-slate-400">…</span>) : (<button key={`p-${p}`} onClick={() => setCurrentPage(p as number)} aria-current={p === currentPage ? 'page' : undefined} className={`min-w-9 h-9 px-2 rounded-lg text-sm font-medium transition-colors ${p === currentPage ? 'bg-brand-500 text-white shadow-xs shadow-brand-500/20' : 'text-slate-700 hover:bg-slate-100'}`}>{p}</button>))}
            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages} className="p-2 text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
        )}
      </div>

      <DeleteConfirmModal
        show={!!deleteTarget}
        title="Delete Staff Member"
        itemName={deleteTarget?.name || ''}
        itemDetail={deleteTarget?.email || ''}
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}