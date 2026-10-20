'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/UI/Table'
import { Badge } from '@/components/UI/Badge'
import { LoadingSpinner } from '@/components/UI/LoadingSpinner'
import Dropdown from '@/components/UI/Dropdown'
import DateRangeCalendar from '@/components/Shared/DateRangeCalendar'
import {
  Edit, Eye, CheckCircle, XCircle, Search, Plus,
  RotateCcw,
  Building2, Clock, AlertTriangle, Bell,
  ChevronDown, SlidersHorizontal,
} from 'lucide-react'
import Pagination from '@/components/UI/Pagination'
import VendorService, { VendorProfile, VendorFilters } from '@/services/vendorService'
import { formatDate } from '@/lib/utils'
import RejectionModal from './RejectionModal'
import SuspensionModal from './SuspensionModal'
import DeleteConfirmModal from '@/components/UI/DeleteConfirmModal'
import { toast } from '@/hooks/use-toast'
import { hasPermission } from '@/lib/auth'

const getStatusBadge = (status: string) => {
  switch (status.toUpperCase()) {
    case 'APPROVED':
      return <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">Approved</Badge>
    case 'PENDING':
      return <Badge className="bg-amber-50 text-amber-700 border border-amber-200 font-bold">Pending</Badge>
    case 'UNDER_REVIEW':
      return <Badge className="bg-blue-50 text-blue-700 border border-blue-200 font-bold">Under Review</Badge>
    case 'REVIEWED':
      return <Badge className="bg-teal-50 text-teal-700 border border-teal-200 font-bold">Reviewed &amp; Qualified</Badge>
    case 'SUSPENDED':
      return <Badge className="bg-orange-50 text-orange-700 border border-orange-200 font-bold">Suspended</Badge>
    case 'REJECTED':
      return <Badge className="bg-red-50 text-red-700 border border-red-200 font-bold">Rejected</Badge>
    case 'APPROVAL_PENDING':
      return <Badge className="bg-cyan-50 text-cyan-700 border border-cyan-200 font-bold">Approval Pending</Badge>
    case 'REJECTION_PENDING':
      return <Badge className="bg-orange-50 text-orange-700 border border-orange-200 font-bold">Rejection Pending</Badge>
    case 'REINSPECTION':
      return <Badge className="bg-orange-50 text-orange-700 border border-orange-200 font-bold">Re-Inspection</Badge>
    case 'SUBMITTED':
      return <Badge className="bg-blue-50 text-blue-700 border border-blue-200 font-bold">Submitted</Badge>
    default:
      return <Badge className="bg-slate-100 text-slate-600 border border-slate-200 font-bold">Unknown</Badge>
  }
}

// Inspection badge shown in its own column (mirrors the Assign QC Checker
// screen). Returns a muted "No Inspection" placeholder when the vendor has no
// inspection yet, so the column never renders empty.
const getInspectionBadge = (vendorStatus: string, latestInspection?: VendorProfile['latestInspection']) => {
  const status = latestInspection?.status || null
  const result = latestInspection?.result || null
  if (!status) return <span className="text-sm text-slate-400 italic">No Inspection</span>
  // Once the vendor decision is finalized, reflect the concluded outcome rather
  // than a lingering inspection state (an Approved vendor must never read
  // "In Progress"). A genuinely cancelled inspection falls through to its label.
  if (['APPROVED', 'REJECTED', 'SUSPENDED'].includes(vendorStatus) && status !== 'CANCELLED') {
    const failed = vendorStatus !== 'APPROVED'
    return (
      <Badge className={failed ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}>
        {failed ? 'Completed – Failed' : 'Completed'}
      </Badge>
    )
  }
  const configs: Record<string, { label: string; className: string }> = {
    SCHEDULED:          { label: 'Scheduled',           className: 'bg-slate-100 text-slate-600 border border-slate-200' },
    IN_PROGRESS:        { label: 'In Progress',          className: 'bg-amber-50 text-amber-700 border border-amber-200' },
    SUBMITTED:          { label: result === 'FAILED' ? 'Awaiting Review · Fail' : result === 'PASSED' ? 'Awaiting Review · Pass' : 'Awaiting Review',
                          className: result === 'FAILED' ? 'bg-red-50 text-red-700 border border-red-200' : result === 'PASSED' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200' },
    UNDER_ADMIN_REVIEW: { label: 'Under Admin Review',   className: 'bg-blue-50 text-blue-700 border border-blue-200' },
    COMPLETED:          { label: result === 'FAILED' ? 'Completed – Failed' : 'Completed',
                          className: result === 'FAILED' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
    REJECTED:           { label: 'Rejected',             className: 'bg-red-50 text-red-700 border border-red-200' },
    REINSPECTION:       { label: 'Re-Inspection',        className: 'bg-amber-50 text-amber-700 border border-amber-200' },
    CANCELLED:          { label: 'Cancelled',            className: 'bg-slate-100 text-slate-500 border border-slate-200' },
  }
  const cfg = configs[status] ?? { label: status, className: 'bg-slate-100 text-slate-600 border border-slate-200' }
  return <Badge className={cfg.className}>{cfg.label}</Badge>
}

// ── Per-vendor "needs attention" alerts ──────────────────────────────────────
// Each item is something an admin has to act on. When a vendor has ≥1 alert the
// row is highlighted and a bell shows the list on hover. Every case below is
// derived from real fields on the vendor list response — no invented signals.
type VendorAlertTone = 'review' | 'approval' | 'rejection' | 'pending' | 'bank'
type VendorAlert = { text: string; tone: VendorAlertTone }

// Minutes → compact "2h 15m" / "45m" / "<1m". Null until the vendor has accepted
// at least one order.
const formatAcceptanceTime = (mins?: number | null): string => {
  if (mins == null || !isFinite(mins)) return '—'
  if (mins < 1) return '<1m'
  const total = Math.round(mins)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

const ALERT_DOT: Record<VendorAlertTone, string> = {
  review: 'bg-blue-500',
  approval: 'bg-cyan-500',
  rejection: 'bg-orange-500',
  pending: 'bg-amber-500',
  bank: 'bg-purple-500',
}

function getVendorAlerts(vendor: VendorProfile): VendorAlert[] {
  const alerts: VendorAlert[] = []
  const vStatus = (vendor.status || '').toUpperCase()
  const finalized = ['APPROVED', 'REJECTED', 'SUSPENDED'].includes(vStatus)

  // Lifecycle alerts apply only while the vendor is still in the approval
  // pipeline — an Approved/Rejected/Suspended vendor has no pending review,
  // confirmation or QC assignment left to do.
  if (!finalized) {
    // A checker/employee requested approval — admin must confirm or cancel.
    if (vStatus === 'APPROVAL_PENDING') {
      alerts.push({
        tone: 'approval',
        text: `Approval requested${vendor.approvalRequestedByName ? ` by ${vendor.approvalRequestedByName}` : ''} — confirm or cancel`,
      })
    }
    // A rejection was requested — admin must confirm or cancel.
    if (vStatus === 'REJECTION_PENDING') {
      alerts.push({
        tone: 'rejection',
        text: `Rejection requested${vendor.rejectionRequestedByName ? ` by ${vendor.rejectionRequestedByName}` : ''} — confirm or cancel`,
      })
    }
    // QC inspection report submitted and waiting for the admin's review/decision.
    const insp = vendor.latestInspection?.status
    if (insp === 'SUBMITTED' || insp === 'UNDER_ADMIN_REVIEW') {
      const res = vendor.latestInspection?.result
      const suffix = res === 'PASSED' ? ' (Pass)' : res === 'FAILED' ? ' (Fail)' : ''
      alerts.push({ tone: 'review', text: `QC inspection report submitted${suffix} — review & decide` })
    }
    // Brand-new registration awaiting review / QC assignment.
    if (vStatus === 'PENDING') {
      alerts.push({ tone: 'pending', text: 'New vendor registration — review & assign a QC checker' })
    }
  }

  // Bank verification is independent of the vendor's approval status — it must
  // be done for payouts even after the vendor is approved, so it always shows.
  if (vendor.bankDetails && vendor.bankDetails.isVerified === false) {
    alerts.push({ tone: 'bank', text: 'Bank details submitted — needs verification' })
  }

  return alerts
}

// Bell + count badge that reveals the vendor's alert list on hover.
function VendorAlertIndicator({ alerts }: { alerts: VendorAlert[] }) {
  if (alerts.length === 0) return null
  return (
    <span className="relative group/alert inline-flex shrink-0">
      <span className="relative inline-flex">
        <Bell className="h-4 w-4 text-amber-500" />
        <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[14px] text-center ring-2 ring-white">
          {alerts.length}
        </span>
      </span>
      <div className="pointer-events-none absolute left-0 top-full mt-2 z-40 hidden w-64 group-hover/alert:block">
        <div className="rounded-xl border border-slate-200 bg-white shadow-xl p-3 space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Needs attention</p>
          {alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${ALERT_DOT[a.tone]}`} />
              <span className="text-xs text-slate-700 leading-snug">{a.text}</span>
            </div>
          ))}
        </div>
      </div>
    </span>
  )
}


interface StatusCounts {
  total: number
  pending: number
  underReview: number
  approved: number
  rejected: number
  suspended: number
}

interface ModalState {
  isOpen: boolean
  vendor: VendorProfile | null
}

const CLOSED_MODAL: ModalState = { isOpen: false, vendor: null }

export default function VendorsTable() {
  const [panelOpen, setPanelOpen] = useState(true)
  const [vendors, setVendors] = useState<VendorProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<VendorFilters>({ page: 1, limit: 10 })
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, pages: 0 })
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  // Inspection filter is applied client-side over the fetched page (the vendor
  // list API has no inspection param) — same pattern as the Assign QC screen.
  const [inspectionFilter, setInspectionFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    total: 0, pending: 0, underReview: 0, approved: 0, rejected: 0, suspended: 0,
  })
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Modals
  const [rejectionModal, setRejectionModal] = useState<ModalState>(CLOSED_MODAL)
  const [suspensionModal, setSuspensionModal] = useState<ModalState>(CLOSED_MODAL)
  const [approvalModal, setApprovalModal] = useState<ModalState>(CLOSED_MODAL)
  const [confirmApprovalModal, setConfirmApprovalModal] = useState<ModalState>(CLOSED_MODAL)
  const [cancelApprovalModal, setCancelApprovalModal] = useState<ModalState>(CLOSED_MODAL)
  const [confirmRejectionModal, setConfirmRejectionModal] = useState<ModalState>(CLOSED_MODAL)
  const [cancelRejectionModal, setCancelRejectionModal] = useState<ModalState>(CLOSED_MODAL)

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchVendors = async () => {
    try {
      setLoading(true)
      setError(null)
      const auth = VendorService.getStoredAuth ? VendorService.getStoredAuth() : null
      console.log('Auth check:', auth)
      const response = await VendorService.getAllVendors(filters)
      setVendors(response.vendors)
      setPagination(response.pagination)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch vendors'
      console.error('Fetch vendors error:', err)
      setError(msg)
      toast({ title: 'Error', description: msg, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const fetchStatusCounts = async () => {
    try {
      const [total, pending, underReview, approved, rejected, suspended] = await Promise.all([
        VendorService.getAllVendors({ limit: 1 }),
        VendorService.getAllVendors({ status: 'PENDING', limit: 1 }),
        VendorService.getAllVendors({ status: 'UNDER_REVIEW', limit: 1 }),
        VendorService.getAllVendors({ status: 'APPROVED', limit: 1 }),
        VendorService.getAllVendors({ status: 'REJECTED', limit: 1 }),
        VendorService.getAllVendors({ status: 'SUSPENDED', limit: 1 }),
      ])
      setStatusCounts({
        total: total.pagination.total,
        pending: pending.pagination.total,
        underReview: underReview.pagination.total,
        approved: approved.pagination.total,
        rejected: rejected.pagination.total,
        suspended: suspended.pagination.total,
      })
    } catch {
      // counts are informational — silently ignore
    }
  }

  useEffect(() => { fetchVendors() }, [filters])
  useEffect(() => { fetchStatusCounts() }, [])

  // ── Filter handlers ───────────────────────────────────────────────────────
  const handleSearch = () =>
    setFilters(prev => ({ ...prev, search: searchTerm || undefined, page: 1 }))

  const handleStatusFilter = (status: string) => {
    setStatusFilter(status)
    setFilters(prev => ({ ...prev, status: status ? status as any : undefined, page: 1 }))
  }

  const handleMetricClick = (key: string) =>
    handleStatusFilter(statusFilter === key ? '' : key)

  const handleDateChange = (from: string, to: string) => {
    setDateFrom(from)
    setDateTo(to)
    setFilters(prev => ({
      ...prev,
      dateFrom: from || undefined,
      dateTo: to || undefined,
      page: 1,
    }))
  }

  const handlePageChange = (newPage: number) =>
    setFilters(prev => ({ ...prev, page: newPage }))

  // Client-side inspection filter over the fetched page (the list API has no
  // inspection param). "NONE" matches vendors with no inspection yet.
  const displayedVendors = vendors.filter((vendor) => {
    if (inspectionFilter === 'all') return true
    const status = vendor.latestInspection?.status || null
    if (inspectionFilter === 'NONE') return !status
    return status === inspectionFilter
  })

  // ── Action helpers ────────────────────────────────────────────────────────
  const refreshAll = () => { fetchVendors(); fetchStatusCounts() }

  const handleApproveVendor = (v: VendorProfile) => setApprovalModal({ isOpen: true, vendor: v })
  const handleApproveConfirm = async () => {
    if (!approvalModal.vendor) return
    try {
      setActionLoading(approvalModal.vendor.id)
      setApprovalModal(CLOSED_MODAL)
      await VendorService.approveVendor(approvalModal.vendor.id)
      toast({ title: 'Success', description: 'Vendor approved successfully' })
      refreshAll()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to approve vendor', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleRejectVendor = (v: VendorProfile) => setRejectionModal({ isOpen: true, vendor: v })
  const handleRejectConfirm = async (reason: string) => {
    if (!rejectionModal.vendor) return
    try {
      setActionLoading(rejectionModal.vendor.id)
      await VendorService.rejectVendor(rejectionModal.vendor.id, reason)
      toast({ title: 'Success', description: 'Vendor rejected successfully' })
      setRejectionModal(CLOSED_MODAL)
      refreshAll()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to reject vendor', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleSuspendVendor = (v: VendorProfile) => setSuspensionModal({ isOpen: true, vendor: v })
  const handleSuspendConfirm = async (reason: string) => {
    if (!suspensionModal.vendor) return
    try {
      setActionLoading(suspensionModal.vendor.id)
      await VendorService.suspendVendor(suspensionModal.vendor.id, reason)
      toast({ title: 'Success', description: 'Vendor suspended successfully' })
      setSuspensionModal(CLOSED_MODAL)
      refreshAll()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to suspend vendor', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleConfirmApprovalConfirm = async () => {
    if (!confirmApprovalModal.vendor) return
    try {
      setActionLoading(confirmApprovalModal.vendor.id)
      setConfirmApprovalModal(CLOSED_MODAL)
      await VendorService.confirmApproval(confirmApprovalModal.vendor.id)
      toast({ title: 'Approval Confirmed', description: 'Vendor approved and credentials sent.' })
      refreshAll()
    } catch (err: any) {
      toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to confirm approval', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleCancelApprovalConfirm = async () => {
    if (!cancelApprovalModal.vendor) return
    try {
      setActionLoading(cancelApprovalModal.vendor.id)
      setCancelApprovalModal(CLOSED_MODAL)
      await VendorService.cancelApproval(cancelApprovalModal.vendor.id)
      toast({ title: 'Approval Cancelled', description: 'Vendor restored to Pending.' })
      refreshAll()
    } catch (err: any) {
      toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to cancel approval', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleConfirmRejectionConfirm = async () => {
    if (!confirmRejectionModal.vendor) return
    try {
      setActionLoading(confirmRejectionModal.vendor.id)
      setConfirmRejectionModal(CLOSED_MODAL)
      await VendorService.confirmRejection(confirmRejectionModal.vendor.id)
      toast({ title: 'Rejection Confirmed', description: 'Vendor has been rejected and notified.' })
      refreshAll()
    } catch (err: any) {
      toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to confirm rejection', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  const handleCancelRejectionConfirm = async () => {
    if (!cancelRejectionModal.vendor) return
    try {
      setActionLoading(cancelRejectionModal.vendor.id)
      setCancelRejectionModal(CLOSED_MODAL)
      await VendorService.cancelRejection(cancelRejectionModal.vendor.id)
      toast({ title: 'Rejection Cancelled', description: 'Vendor restored to Pending.' })
      refreshAll()
    } catch (err: any) {
      toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to cancel rejection', variant: 'destructive' })
    } finally { setActionLoading(null) }
  }

  // ── Metric cards config ───────────────────────────────────────────────────
  const metricCards = [
    {
      key: '',
      label: 'Total Vendors',
      subtitle: 'Registered vendors',
      count: statusCounts.total,
      Icon: Building2,
      iconBg: 'bg-brand-50',
      iconColor: 'text-brand-500',
      countColor: 'text-slate-900',
      activeClass: 'border-brand-400 bg-brand-50/50',
    },
    {
      key: 'PENDING',
      label: 'Pending',
      subtitle: 'Awaiting review',
      count: statusCounts.pending,
      Icon: Clock,
      iconBg: 'bg-amber-50',
      iconColor: 'text-amber-500',
      countColor: 'text-amber-700',
      activeClass: 'border-amber-400 bg-amber-50/60',
    },
    {
      key: 'UNDER_REVIEW',
      label: 'Under Review',
      subtitle: 'Being evaluated',
      count: statusCounts.underReview,
      Icon: Eye,
      iconBg: 'bg-blue-50',
      iconColor: 'text-blue-500',
      countColor: 'text-blue-700',
      activeClass: 'border-blue-400 bg-blue-50/60',
    },
    {
      key: 'APPROVED',
      label: 'Approved',
      subtitle: 'Active vendors',
      count: statusCounts.approved,
      Icon: CheckCircle,
      iconBg: 'bg-emerald-50',
      iconColor: 'text-emerald-500',
      countColor: 'text-emerald-700',
      activeClass: 'border-emerald-400 bg-emerald-50/60',
    },
    {
      key: 'REJECTED',
      label: 'Rejected',
      subtitle: 'Declined vendors',
      count: statusCounts.rejected,
      Icon: XCircle,
      iconBg: 'bg-red-50',
      iconColor: 'text-red-500',
      countColor: 'text-red-700',
      activeClass: 'border-red-400 bg-red-50/60',
    },
    {
      key: 'SUSPENDED',
      label: 'Suspended',
      subtitle: 'Account suspended',
      count: statusCounts.suspended,
      Icon: AlertTriangle,
      iconBg: 'bg-orange-50',
      iconColor: 'text-orange-500',
      countColor: 'text-orange-700',
      activeClass: 'border-orange-400 bg-orange-50/60',
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ── 1. Page Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Vendors Management</h1>
          <p className="text-sm text-slate-500">Manage registered vendors and their approval workflow.</p>
        </div>
        {hasPermission('vendor_management:create') && (
          <Link href="/admin/dashboard/vendors/add" className="shrink-0">
            <button className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white font-semibold py-2 px-4 rounded-xl transition-colors shadow-xs shadow-brand-500/10 text-sm whitespace-nowrap">
              <Plus className="h-4 w-4" />
              Add Vendor
            </button>
          </Link>
        )}
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
          Showing {displayedVendors.length} of {vendors.length} vendors
        </span>
      </div>

      {panelOpen && (
        <div className="space-y-4">
      {/* ── 2. Metric Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {metricCards.map(({ key, label, subtitle, count, Icon, iconBg, iconColor, countColor, activeClass }) => {
          const isActive = statusFilter === key
          const pct = statusCounts.total > 0 && key !== ''
            ? Math.round((count / statusCounts.total) * 100)
            : null
          return (
            <button
              key={key}
              onClick={() => handleMetricClick(key)}
              className={`text-left bg-white border rounded-2xl shadow-xs transition-all duration-200 hover:shadow-sm group ${
                isActive ? activeClass : 'border-slate-200/80 hover:border-slate-300'
              }`}
            >
              <div className="flex flex-row items-center justify-between px-3.5 pt-3 pb-1">
                <span className="text-[13px] font-medium text-slate-500">{label}</span>
                <div className={`p-1.5 rounded-lg ${iconBg} transition-transform duration-150 group-hover:scale-110`}>
                  <Icon className={`h-4 w-4 ${iconColor}`} />
                </div>
              </div>
              <div className="px-3.5 pb-3">
                <div className={`text-xl font-bold ${countColor}`}>{count}</div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {pct !== null ? `${pct}% of total` : subtitle}
                </p>
              </div>
            </button>
          )
        })}
      </div>

      {/* ── 3. Filter Toolbar ── */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 relative min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 h-4 w-4 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by vendor ID, company, GST, owner, email…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 focus:outline-none w-full transition-all bg-white text-sm"
            />
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-44">
              <Dropdown
                value={statusFilter}
                options={[
                  { value: '', label: 'All Status' },
                  { value: 'PENDING', label: 'Pending' },
                  { value: 'UNDER_REVIEW', label: 'Under Review' },
                  { value: 'REVIEWED', label: 'Reviewed & Qualified' },
                  { value: 'APPROVED', label: 'Approved' },
                  { value: 'REJECTED', label: 'Rejected' },
                  { value: 'APPROVAL_PENDING', label: 'Approval Pending' },
                  { value: 'REJECTION_PENDING', label: 'Rejection Pending' },
                  { value: 'REINSPECTION', label: 'Re-Inspection' },
                  { value: 'SUSPENDED', label: 'Suspended' },
                ]}
                placeholder="All Status"
                onChange={(value) => handleStatusFilter(value as string)}
              />
            </div>
            <div className="w-44">
              <Dropdown
                value={inspectionFilter}
                options={[
                  { value: 'all', label: 'All Inspections' },
                  { value: 'SCHEDULED', label: 'Scheduled' },
                  { value: 'IN_PROGRESS', label: 'In Progress' },
                  { value: 'SUBMITTED', label: 'Submitted' },
                  { value: 'UNDER_ADMIN_REVIEW', label: 'Under Admin Review' },
                  { value: 'COMPLETED', label: 'Completed' },
                  { value: 'REINSPECTION', label: 'Re-Inspection' },
                  { value: 'REJECTED', label: 'Rejected' },
                  { value: 'CANCELLED', label: 'Cancelled' },
                  { value: 'NONE', label: 'No Inspection' },
                ]}
                placeholder="All Inspections"
                onChange={(value) => setInspectionFilter(value as string)}
              />
            </div>
            <DateRangeCalendar
              from={dateFrom}
              to={dateTo}
              onChange={handleDateChange}
              placeholder="Join Date"
            />
          </div>
        </div>
      </div>
        </div>
      )}

      {/* ── 4. Vendors Table ── */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs overflow-hidden">

        {/* Error */}
        {error && (
          <div className="m-5 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <LoadingSpinner />
          </div>
        ) : displayedVendors.length === 0 ? (
          <div className="text-center py-16">
            <Building2 className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">No vendors found</p>
            <p className="text-slate-400 text-sm mt-1">Try adjusting your filters or search term</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table className="table-fixed min-w-[1100px]">
                <TableHeader className="!bg-brand-500/[0.06] !border-0 [&_tr]:border-b [&_tr]:border-brand-100/50">
                  <TableRow className="!bg-brand-500/[0.06] hover:!bg-brand-500/[0.06]">
                    <TableHead className="w-[12%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider whitespace-nowrap">Vendor ID</TableHead>
                    <TableHead className="w-[14%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider">Vendor</TableHead>
                    <TableHead className="w-[11%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider">Contact Person</TableHead>
                    <TableHead className="w-[12%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider">Contact</TableHead>
                    <TableHead className="w-[9%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider text-center">Status</TableHead>
                    <TableHead className="w-[10%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider text-center">Inspection</TableHead>
                    <TableHead className="w-[8%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider text-center whitespace-nowrap">Avg. Accept</TableHead>
                    <TableHead className="w-[10%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider text-center whitespace-nowrap">Join Date</TableHead>
                    <TableHead className="w-[14%] font-bold !text-brand-500/60 h-11 py-3 px-3 text-[10px] uppercase tracking-wider text-right whitespace-nowrap">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedVendors.map((vendor) => {
                    const alerts = getVendorAlerts(vendor)
                    return (
                    <TableRow
                      key={vendor.id}
                      className={`transition-colors duration-150 border-b border-slate-100 last:border-0 ${
                        alerts.length > 0
                          ? 'bg-amber-50/50 hover:bg-amber-50'
                          : 'hover:bg-slate-50/60'
                      }`}
                    >
                      {/* Vendor ID (+ needs-attention bell) */}
                      <TableCell className={`py-3 px-3 align-top ${alerts.length > 0 ? 'border-l-2 border-l-amber-400' : ''}`}>
                        <div className="flex items-center gap-3">
                          <VendorAlertIndicator alerts={alerts} />
                          {vendor.vendorCode ? (
                            <span className="text-xs font-mono font-semibold text-slate-700 whitespace-nowrap">{vendor.vendorCode}</span>
                          ) : (
                            <span className="text-xs text-slate-400 italic">—</span>
                          )}
                        </div>
                      </TableCell>

                      {/* Vendor */}
                      <TableCell className="py-3 px-3 align-top">
                        <div className="flex flex-col gap-0.5">
                          <div className="font-semibold text-slate-900 leading-snug break-words">{vendor.companyName}</div>
                          {vendor.gstNumber ? (
                            <div className="text-xs text-slate-500 font-mono break-all">GST: {vendor.gstNumber}</div>
                          ) : (
                            <div className="text-xs text-slate-400 italic">Unregistered</div>
                          )}
                        </div>
                      </TableCell>

                      {/* Contact Person */}
                      <TableCell className="py-3 px-3 align-top">
                        <div className="text-sm font-medium text-slate-700 break-words">{vendor.ownerName || '—'}</div>
                      </TableCell>

                      {/* Contact */}
                      <TableCell className="py-3 px-3 align-top">
                        <div className="flex flex-col gap-0.5">
                          {vendor.businessPhone && (
                            <div className="text-sm text-slate-700 whitespace-nowrap">{vendor.businessPhone}</div>
                          )}
                          {vendor.businessEmail && (
                            <div className="text-xs text-slate-500 break-all">{vendor.businessEmail}</div>
                          )}
                          {!vendor.businessPhone && !vendor.businessEmail && (
                            <span className="text-xs text-slate-400 italic">—</span>
                          )}
                        </div>
                      </TableCell>

                      {/* Status */}
                      <TableCell className="py-3 px-3 align-middle">
                        <div className="flex flex-col items-center gap-1.5">
                          {getStatusBadge(vendor.status)}
                          {vendor.status === 'APPROVAL_PENDING' && vendor.approvalRequestedByName && (
                            <p className="text-xs text-cyan-600">by {vendor.approvalRequestedByName}</p>
                          )}
                          {vendor.status === 'REJECTION_PENDING' && vendor.rejectionRequestedByName && (
                            <p className="text-xs text-orange-600">by {vendor.rejectionRequestedByName}</p>
                          )}
                        </div>
                      </TableCell>

                      {/* Inspection */}
                      <TableCell className="py-3 px-3 align-middle">
                        <div className="flex justify-center">
                          {getInspectionBadge(vendor.status, vendor.latestInspection)}
                        </div>
                      </TableCell>

                      {/* Avg. order-acceptance time */}
                      <TableCell className="py-3 px-3 align-middle text-center whitespace-nowrap">
                        {vendor.avgAcceptanceMins != null ? (
                          <div className="flex flex-col items-center leading-tight">
                            <span className="text-sm font-semibold text-slate-800">{formatAcceptanceTime(vendor.avgAcceptanceMins)}</span>
                            {vendor.acceptedOrdersCount ? (
                              <span className="text-[10px] text-slate-400">{vendor.acceptedOrdersCount} order{vendor.acceptedOrdersCount === 1 ? '' : 's'}</span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400 italic">—</span>
                        )}
                      </TableCell>

                      {/* Join Date */}
                      <TableCell className="py-3 px-3 text-sm text-slate-600 whitespace-nowrap align-middle text-center">
                        {formatDate(vendor.createdAt)}
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="py-3 px-3 align-middle">
                        <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                          {hasPermission('vendor_management:view') && (
                            <Link href={`/admin/dashboard/vendors/view/${vendor.id}`}>
                              <button
                                title="View Details"
                                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            </Link>
                          )}
                          {hasPermission('vendor_management:edit') && (
                            <Link href={`/admin/dashboard/vendors/edit/${vendor.id}`}>
                              <button
                                title="Edit Vendor"
                                className="p-1.5 rounded-lg text-blue-500 hover:text-blue-700 hover:bg-blue-50 transition-colors"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                            </Link>
                          )}
                          {/* Approve only AFTER inspection (UNDER_REVIEW). A PENDING vendor
                              must be reviewed/qualified from the detail page first — no
                              one-click approve that skips review + QC. */}
                          {vendor.status === 'UNDER_REVIEW' && hasPermission('vendor_management:approve') && (
                            <>
                              <button
                                title="Approve Vendor"
                                onClick={() => handleApproveVendor(vendor)}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50"
                              >
                                {actionLoading === vendor.id
                                  ? <LoadingSpinner size="sm" />
                                  : <CheckCircle className="h-4 w-4" />}
                              </button>
                              <button
                                title="Reject Vendor"
                                onClick={() => handleRejectVendor(vendor)}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                              >
                                <XCircle className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {vendor.status === 'APPROVED' && hasPermission('vendor_management:suspend') && (
                            <button
                              title="Suspend Vendor"
                              onClick={() => handleSuspendVendor(vendor)}
                              disabled={actionLoading === vendor.id}
                              className="p-1.5 rounded-lg text-orange-500 hover:text-orange-700 hover:bg-orange-50 transition-colors disabled:opacity-50"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          )}
                          {vendor.status === 'APPROVAL_PENDING' && (
                            <>
                              <button
                                title="Confirm Approval"
                                onClick={() => setConfirmApprovalModal({ isOpen: true, vendor })}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50"
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                              <button
                                title="Cancel Approval — Restore to Pending"
                                onClick={() => setCancelApprovalModal({ isOpen: true, vendor })}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-orange-500 hover:text-orange-700 hover:bg-orange-50 transition-colors disabled:opacity-50"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {vendor.status === 'REJECTION_PENDING' && (
                            <>
                              <button
                                title="Confirm Rejection"
                                onClick={() => setConfirmRejectionModal({ isOpen: true, vendor })}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                              <button
                                title="Cancel Rejection — Restore to Pending"
                                onClick={() => setCancelRejectionModal({ isOpen: true, vendor })}
                                disabled={actionLoading === vendor.id}
                                className="p-1.5 rounded-lg text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <Pagination
              page={pagination.page}
              totalPages={pagination.pages}
              onChange={handlePageChange}
              disabled={loading}
            />
          </>
        )}
      </div>

      {/* ══════════════════ Modals ══════════════════ */}

      <RejectionModal
        isOpen={rejectionModal.isOpen}
        onClose={() => setRejectionModal(CLOSED_MODAL)}
        onConfirm={handleRejectConfirm}
        vendor={rejectionModal.vendor ? {
          id: rejectionModal.vendor.id,
          companyName: rejectionModal.vendor.companyName,
          ownerName: rejectionModal.vendor.ownerName,
          email: rejectionModal.vendor.email,
        } : null}
        isLoading={actionLoading === rejectionModal.vendor?.id}
      />

      <SuspensionModal
        isOpen={suspensionModal.isOpen}
        onClose={() => setSuspensionModal(CLOSED_MODAL)}
        onConfirm={handleSuspendConfirm}
        vendor={suspensionModal.vendor ? {
          id: suspensionModal.vendor.id,
          companyName: suspensionModal.vendor.companyName,
          ownerName: suspensionModal.vendor.ownerName,
          email: suspensionModal.vendor.email,
          status: suspensionModal.vendor.status,
        } : null}
        isLoading={actionLoading === suspensionModal.vendor?.id}
      />

      <DeleteConfirmModal
        show={approvalModal.isOpen}
        variant="confirm"
        title="Confirm Vendor Approval"
        subtitle="Once approved, the vendor will be able to access the platform and proceed with the next steps."
        itemName={approvalModal.vendor?.companyName}
        itemDetail={approvalModal.vendor?.ownerName}
        confirmLabel="Approve"
        loadingLabel="Approving..."
        loading={actionLoading === approvalModal.vendor?.id}
        onConfirm={handleApproveConfirm}
        onCancel={() => setApprovalModal(CLOSED_MODAL)}
      />

      <DeleteConfirmModal
        show={confirmApprovalModal.isOpen}
        variant="confirm"
        title="Confirm Approval"
        subtitle="Credentials will be sent to the vendor upon confirmation."
        itemName={confirmApprovalModal.vendor?.companyName}
        itemDetail={confirmApprovalModal.vendor?.ownerName}
        confirmLabel="Confirm Approval"
        loadingLabel="Processing..."
        loading={actionLoading === confirmApprovalModal.vendor?.id}
        onConfirm={handleConfirmApprovalConfirm}
        onCancel={() => setConfirmApprovalModal(CLOSED_MODAL)}
      />

      <DeleteConfirmModal
        show={cancelApprovalModal.isOpen}
        variant="warning"
        title="Cancel Approval"
        subtitle="The vendor will be restored to Pending status."
        itemName={cancelApprovalModal.vendor?.companyName}
        itemDetail={cancelApprovalModal.vendor?.ownerName}
        confirmLabel="Cancel Approval"
        loadingLabel="Processing..."
        loading={actionLoading === cancelApprovalModal.vendor?.id}
        onConfirm={handleCancelApprovalConfirm}
        onCancel={() => setCancelApprovalModal(CLOSED_MODAL)}
      />

      <DeleteConfirmModal
        show={confirmRejectionModal.isOpen}
        variant="danger"
        title="Confirm Rejection"
        subtitle="A rejection email will be sent to the vendor."
        itemName={confirmRejectionModal.vendor?.companyName}
        itemDetail={confirmRejectionModal.vendor?.ownerName}
        confirmLabel="Confirm Rejection"
        loadingLabel="Processing..."
        loading={actionLoading === confirmRejectionModal.vendor?.id}
        onConfirm={handleConfirmRejectionConfirm}
        onCancel={() => setConfirmRejectionModal(CLOSED_MODAL)}
      />

      <DeleteConfirmModal
        show={cancelRejectionModal.isOpen}
        variant="confirm"
        title="Cancel Rejection"
        subtitle="The vendor will be restored to Pending status."
        itemName={cancelRejectionModal.vendor?.companyName}
        itemDetail={cancelRejectionModal.vendor?.ownerName}
        confirmLabel="Cancel Rejection"
        loadingLabel="Processing..."
        loading={actionLoading === cancelRejectionModal.vendor?.id}
        onConfirm={handleCancelRejectionConfirm}
        onCancel={() => setCancelRejectionModal(CLOSED_MODAL)}
      />
    </div>
  )
}
