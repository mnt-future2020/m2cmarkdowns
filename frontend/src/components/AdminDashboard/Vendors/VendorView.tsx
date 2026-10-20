'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/UI/Button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/UI/Card'
import { Badge } from '@/components/UI/Badge'
import { LoadingSpinner } from '@/components/UI/LoadingSpinner'
import { openDoc } from '@/lib/docViewerBus'
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils'
import {
  ArrowLeft,
  Plus,
  X,
  Building2,
  Globe,
  Mail,
  Phone,
  MapPin,
  User,
  Package,
  Factory,
  Award,
  Calendar,
  Star,
  Edit,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileText,
  Download,
  Eye,
  CreditCard,
  ExternalLink,
  MessageSquare,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  RotateCcw,
  Megaphone,
  Hash,
  Landmark,
  Wallet,
  BadgeCheck,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/UI/Table'
import Dropdown from '@/components/UI/Dropdown'
import VendorService, { VendorProfile } from '@/services/vendorService'
import adminReviewService, { AdminOrderReview } from '@/services/adminReviewService'
import { categoryService } from '@/services/categoryService'
import { toast } from '@/hooks/use-toast'
import RejectionModal from './RejectionModal'
import SuspensionModal from './SuspensionModal'
import DeleteConfirmModal from '@/components/UI/DeleteConfirmModal'
import { hasPermission } from '@/lib/auth'
import { getLandlineDisplay, formatLocalLandline, formatIntlLandline } from '@/components/VendorHub/FormUI'
import { buildFullName, toExternalUrl, resolveOwnerDesignation } from '@/lib/utils'
import { downloadDoc } from '@/lib/docDownload'
import DocViewerModal from '@/components/UI/DocViewerModal'
import { FACILITY_META, withUnit } from '@/components/Checker/Vendor/Steps/VI_Step5_Manufacturing'
import { Country } from 'country-state-city'
import { formatOrderAmount } from "@/lib/currency";
import { formatSqFt } from "@/lib/units";

// Map country name → ISO code so we can render flag *images* (via flagcdn).
// Flag emoji don't render on Windows, which shows the bare ISO letters instead.
const COUNTRY_ISO: Record<string, string> = {}
Country.getAllCountries().forEach((c) => { COUNTRY_ISO[c.name] = c.isoCode })
function withFlags(countries: string[]): { flagIso: string; label: string }[] {
  return countries.map((name) => ({ flagIso: COUNTRY_ISO[name] || "", label: name }))
}

/**
 * Latitude / longitude readout for an address card.
 *
 * Renders nothing when neither value is stored *and* no hint is supplied — most
 * addresses have no coordinates and two empty rows would be noise. The factory card
 * passes a hint because a missing pair there has a real consequence: the QC inspection
 * geofence has nothing to verify against.
 */
const CoordinatePair = ({
  latitude,
  longitude,
  emptyHint,
}: {
  latitude?: number | string | null
  longitude?: number | string | null
  emptyHint?: string
}) => {
  const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
  if (!has(latitude) && !has(longitude)) {
    return emptyHint ? (
      <div>
        <p className="text-sm text-slate-500 font-semibold mb-1">Coordinates</p>
        <p className="text-sm text-amber-700">{emptyHint}</p>
      </div>
    ) : null
  }
  return (
    <div>
      <p className="text-sm text-slate-500 font-semibold mb-1">Coordinates</p>
      <p className="font-medium font-mono text-sm">
        {has(latitude) ? latitude : '—'}, {has(longitude) ? longitude : '—'}
      </p>
    </div>
  )
}

interface VendorViewProps {
  vendorId: string
}

export default function VendorView({ vendorId }: VendorViewProps) {
  const router = useRouter()
  const [vendor, setVendor] = useState<VendorProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [rejectionModal, setRejectionModal] = useState(false)
  // 'direct' = legacy direct reject; 'review' = staff proposes rejection at the review gate
  const [rejectMode, setRejectMode] = useState<'direct' | 'review'>('direct')
  const [suspensionModal, setSuspensionModal] = useState(false)
  const [approvalModal, setApprovalModal] = useState(false)

  useEffect(() => {
    const fetchVendorData = async () => {
      try {
        setLoading(true)
        // Use the new getVendorById method
        const response = await VendorService.getVendorById(vendorId)
        setVendor(response.vendor)
      } catch (error) {
        console.error('Error fetching vendor data:', error)
        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to fetch vendor details',
          variant: 'destructive'
        })
      } finally {
        setLoading(false)
      }
    }

    fetchVendorData()
  }, [vendorId])

  const handleApprove = () => {
    setApprovalModal(true)
  }

  const handleApproveConfirm = async () => {
    if (!vendor) return

    try {
      setActionLoading('approve')
      setApprovalModal(false)
      await VendorService.approveVendor(vendor.id)

      setVendor({ ...vendor, status: 'APPROVED', approvedAt: new Date().toISOString() })
      toast({
        title: 'Success',
        description: 'Vendor approved successfully'
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to approve vendor'
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive'
      })
    } finally {
      setActionLoading(null)
    }
  }

  const handleReject = () => {
    setRejectMode('direct')
    setRejectionModal(true)
  }

  // Staff review gate: mark the registration form reviewed & qualified.
  const handleQualify = async () => {
    if (!vendor) return
    if (!confirm('Mark this registration as Reviewed & Qualified? It will then be ready for QC assignment.')) return
    try {
      setActionLoading('qualify')
      await VendorService.reviewVendor(vendor.id, 'QUALIFIED')
      setVendor({ ...vendor, status: 'REVIEWED', reviewedAt: new Date().toISOString() })
      toast({ title: 'Reviewed & Qualified', description: 'Ready to assign a QC checker for factory inspection.' })
    } catch (error: any) {
      toast({ title: 'Error', description: error?.response?.data?.error || 'Failed to review vendor', variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }

  // Staff review gate: propose rejection (routes to an authorised person).
  const handleProposeReject = () => {
    setRejectMode('review')
    setRejectionModal(true)
  }

  const handleRejectConfirm = async (reason: string) => {
    if (!vendor) return

    try {
      setActionLoading('reject')
      if (rejectMode === 'review') {
        // Propose rejection → goes to an authorised person for the final decision.
        await VendorService.reviewVendor(vendor.id, 'REJECT', { reason })
        setVendor({ ...vendor, status: 'REJECTION_PENDING', rejectionReason: reason, rejectionRequestedAt: new Date().toISOString() })
        toast({ title: 'Rejection proposed', description: 'Sent to an authorised person for the final decision.' })
      } else {
        await VendorService.rejectVendor(vendor.id, reason)
        setVendor({ ...vendor, status: 'REJECTED', rejectedAt: new Date().toISOString(), rejectionReason: reason })
        toast({ title: 'Success', description: 'Vendor rejected successfully' })
      }
      setRejectionModal(false)
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || (error instanceof Error ? error.message : 'Failed to reject vendor')
      toast({ title: 'Error', description: errorMessage, variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleSuspend = () => {
    setSuspensionModal(true)
  }

  const handleSuspendConfirm = async (reason: string) => {
    if (!vendor) return

    try {
      setActionLoading('suspend')
      await VendorService.suspendVendor(vendor.id, reason)

      setVendor({ ...vendor, status: 'SUSPENDED', suspendedAt: new Date().toISOString(), rejectionReason: reason })
      toast({
        title: 'Success',
        description: 'Vendor suspended successfully'
      })
      setSuspensionModal(false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to suspend vendor'
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive'
      })
    } finally {
      setActionLoading(null)
    }
  }

  const handleVerifyBankDetails = async () => {
    if (!vendor) return

    try {
      setActionLoading('verify-bank')
      await VendorService.verifyVendorBankDetails(vendor.id)

      setVendor({
        ...vendor,
        bankDetails: {
          ...vendor.bankDetails,
          isVerified: true,
          verifiedAt: new Date().toISOString()
        } as any
      })
      toast({
        title: 'Success',
        description: 'Vendor bank details verified successfully'
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to verify bank details'
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive'
      })
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-slate-500 mt-4">Loading vendor details...</p>
        </div>
      </div>
    )
  }

  if (!vendor) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-slate-900 mb-2">Vendor Not Found</h2>
          <p className="text-slate-500 mb-4">The vendor you're looking for doesn't exist or has been removed.</p>
          <Button onClick={() => router.push('/admin/dashboard/vendors')}>
            Back to Vendors
          </Button>
        </div>
      </div>
    )
  }

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
        return <Badge className="bg-red-50 text-red-700 border border-red-200 font-bold">Suspended</Badge>
      case 'REJECTED':
        return <Badge className="bg-red-50 text-red-700 border border-red-200 font-bold">Rejected</Badge>
      case 'APPROVAL_PENDING':
        return <Badge className="bg-cyan-50 text-cyan-700 border border-cyan-200 font-bold">Approval Pending</Badge>
      case 'REJECTION_PENDING':
        return <Badge className="bg-orange-50 text-orange-700 border border-orange-200 font-bold">Rejection Pending</Badge>
      case 'REINSPECTION':
        return <Badge className="bg-orange-50 text-orange-700 border border-orange-200 font-bold">Re-Inspection</Badge>
      default:
        return <Badge className="bg-slate-100 text-slate-600 border border-slate-200 font-bold">Unknown</Badge>
    }
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: Building2 },
    { id: 'details', label: 'Company Details', icon: FileText },
    { id: 'contact-trade', label: 'Contact & Trade', icon: Phone },
    { id: 'products', label: 'Products & Services', icon: Package },
    { id: 'facilities', label: 'Facilities', icon: Factory },
    { id: 'bank-details', label: 'Bank Details', icon: CreditCard },
    { id: 'reviews', label: 'Reviews', icon: MessageSquare }
  ]

  return (
    <div className="min-h-screen bg-slate-50/50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-420 mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-6">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/admin/dashboard/vendors')}
                className="p-2"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{vendor.companyName}</h1>
                <p className="text-slate-500">
                  Vendor Code: <span className="font-mono">{vendor.vendorCode || vendor.id}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              {getStatusBadge(vendor.status)}

              {/* Pending request info */}
              {vendor.status === 'APPROVAL_PENDING' && (vendor as any).approvalRequestedByName && (
                <span className="text-sm text-cyan-700 bg-cyan-50 px-3 py-1 rounded-full font-medium">
                  Requested by <strong>{(vendor as any).approvalRequestedByName}</strong>
                  {(vendor as any).approvalRequestedAt && (
                    <> on {new Date((vendor as any).approvalRequestedAt).toLocaleDateString('en-IN')}</>
                  )}
                </span>
              )}
              {vendor.status === 'REJECTION_PENDING' && (vendor as any).rejectionRequestedByName && (
                <span className="text-sm text-orange-700 bg-orange-50 px-3 py-1 rounded-full font-medium">
                  Requested by <strong>{(vendor as any).rejectionRequestedByName}</strong>
                  {(vendor as any).rejectionRequestedAt && (
                    <> on {new Date((vendor as any).rejectionRequestedAt).toLocaleDateString('en-IN')}</>
                  )}
                </span>
              )}

              {/* Review gate — a staff member reviews the registration form first */}
              {vendor.status === 'PENDING' && hasPermission('vendor_management:review') && (
                <>
                  <Button
                    onClick={handleQualify}
                    disabled={actionLoading === 'qualify'}
                    className="bg-green-600 text-white hover:bg-green-700 rounded-xl"
                  >
                    {actionLoading === 'qualify' ? (
                      <LoadingSpinner size="sm" />
                    ) : (
                      <>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Reviewed &amp; Qualified
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={handleProposeReject}
                    disabled={actionLoading === 'reject'}
                    variant="outline"
                    className="text-red-600 border-red-600 hover:bg-red-50"
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Reject
                  </Button>
                </>
              )}

              {/* Reviewed & qualified — prompt to assign a QC checker next */}
              {vendor.status === 'REVIEWED' && (
                <>
                  {(vendor as any).reviewedByName && (
                    <span className="text-sm text-teal-700 bg-teal-50 px-3 py-1 rounded-full font-medium">
                      Reviewed by <strong>{(vendor as any).reviewedByName}</strong>
                      {(vendor as any).reviewedAt && (<> on {new Date((vendor as any).reviewedAt).toLocaleDateString('en-IN')}</>)}
                    </span>
                  )}
                  {hasPermission('assign_qc_checker:create') && (
                    <Button
                      onClick={() => router.push('/admin/dashboard/vendors/assign-qc')}
                      className="bg-brand-500 hover:bg-brand-600 text-white rounded-xl"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Assign QC Checker
                    </Button>
                  )}
                </>
              )}

              {/* Post-inspection: the vendor is awaiting the final approve/reject
                  decision. Without this the detail page showed no next-step action. */}
              {(vendor.status === 'UNDER_REVIEW' || vendor.status === 'REINSPECTION') && hasPermission('vendor_management:approve') && (
                <>
                  <Button
                    onClick={handleApprove}
                    disabled={actionLoading === 'approve'}
                    className="bg-green-600 text-white hover:bg-green-700 rounded-xl"
                  >
                    {actionLoading === 'approve' ? <LoadingSpinner size="sm" /> : (<><CheckCircle className="h-4 w-4 mr-2" />Approve</>)}
                  </Button>
                  <Button
                    onClick={handleReject}
                    disabled={actionLoading === 'reject'}
                    variant="outline"
                    className="text-red-600 border-red-600 hover:bg-red-50"
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Reject
                  </Button>
                </>
              )}

              {vendor.status === 'APPROVED' && hasPermission('vendor_management:suspend') && (
                <Button
                  onClick={handleSuspend}
                  disabled={actionLoading === 'suspend'}
                  variant="outline"
                  className="text-orange-600 border-orange-600 hover:bg-orange-50"
                >
                  {actionLoading === 'suspend' ? (
                    <LoadingSpinner size="sm" />
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 mr-2" />
                      Suspend
                    </>
                  )}
                </Button>
              )}

              {vendor.status === 'APPROVAL_PENDING' && hasPermission('vendor_management:approve') && (
                <>
                  <Button
                    onClick={async () => {
                      if (!confirm('Confirm approval? Credentials will be sent to the vendor.')) return;
                      try {
                        setActionLoading('confirm-approve');
                        await VendorService.confirmApproval(vendor.id);
                        toast({ title: 'Approval Confirmed', description: 'Vendor approved and credentials sent.' });
                        setVendor({ ...vendor, status: 'APPROVED', approvedAt: new Date().toISOString() });
                      } catch (err: any) {
                        toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to confirm approval', variant: 'destructive' });
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                    disabled={actionLoading === 'confirm-approve'}
                    className="bg-green-600 text-white hover:bg-green-700"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Confirm Approval
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!confirm('Cancel this approval? Vendor will be restored to Pending.')) return;
                      try {
                        setActionLoading('cancel-approve');
                        await VendorService.cancelApproval(vendor.id);
                        toast({ title: 'Approval Cancelled', description: 'Vendor restored to Pending.' });
                        setVendor({ ...vendor, status: 'PENDING' });
                      } catch (err: any) {
                        toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to cancel approval', variant: 'destructive' });
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                    disabled={actionLoading === 'cancel-approve'}
                    variant="outline"
                    className="text-orange-600 border-orange-600 hover:bg-orange-50"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Cancel Approval
                  </Button>
                </>
              )}

              {vendor.status === 'REJECTION_PENDING' && hasPermission('vendor_management:approve') && (
                <>
                  <Button
                    onClick={async () => {
                      if (!confirm('Confirm rejection? Rejection email will be sent to the vendor.')) return;
                      try {
                        setActionLoading('confirm-reject');
                        await VendorService.confirmRejection(vendor.id);
                        toast({ title: 'Rejection Confirmed', description: 'Vendor has been rejected and notified.' });
                        setVendor({ ...vendor, status: 'REJECTED', rejectedAt: new Date().toISOString() });
                      } catch (err: any) {
                        toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to confirm rejection', variant: 'destructive' });
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                    disabled={actionLoading === 'confirm-reject'}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Confirm Rejection
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!confirm('Cancel this rejection? Vendor will be restored to Pending.')) return;
                      try {
                        setActionLoading('cancel-reject');
                        await VendorService.cancelRejection(vendor.id);
                        toast({ title: 'Rejection Cancelled', description: 'Vendor restored to Pending.' });
                        setVendor({ ...vendor, status: 'PENDING', rejectionReason: undefined });
                      } catch (err: any) {
                        toast({ title: 'Error', description: err?.response?.data?.error || 'Failed to cancel rejection', variant: 'destructive' });
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                    disabled={actionLoading === 'cancel-reject'}
                    variant="outline"
                    className="text-green-600 border-green-600 hover:bg-green-50"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Cancel Rejection
                  </Button>
                </>
              )}

              {hasPermission('vendor_management:edit') && (
                <Button
                  onClick={() => router.push(`/admin/dashboard/vendors/edit/${vendor.id}`)}
                  className="bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white rounded-xl"
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Vendor
                </Button>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center space-x-2 py-4 px-1 border-b-2 font-medium text-sm ${activeTab === tab.id
                    ? 'border-brand-500 text-brand-700'
                    : 'border-transparent text-slate-400 hover:text-slate-700 hover:border-slate-300'
                    }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-420 mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'overview' && <OverviewTab vendor={vendor} />}
        {activeTab === 'details' && <DetailsTab vendor={vendor} />}
        {activeTab === 'contact-trade' && <ContactTradeTab vendor={vendor} />}
        {activeTab === 'products' && <ProductsTab vendor={vendor} />}
        {activeTab === 'facilities' && <FacilitiesTab vendor={vendor} />}
        {activeTab === 'bank-details' && (
          <BankDetailsTab
            vendor={vendor}
            onVerify={handleVerifyBankDetails}
            loading={actionLoading === 'verify-bank'}
            onBankSaved={(saved) => setVendor({ ...vendor, bankDetails: saved })}
          />
        )}
        {activeTab === 'reviews' && <ReviewsTab vendor={vendor} />}
      </div>

      {/* Rejection Modal */}
      <RejectionModal
        isOpen={rejectionModal}
        onClose={() => setRejectionModal(false)}
        onConfirm={handleRejectConfirm}
        vendor={{
          id: vendor.id,
          companyName: vendor.companyName,
          ownerName: vendor.ownerName,
          email: vendor.email
        }}
        isLoading={actionLoading === 'reject'}
      />

      {/* Suspension Modal */}
      <SuspensionModal
        isOpen={suspensionModal}
        onClose={() => setSuspensionModal(false)}
        onConfirm={handleSuspendConfirm}
        vendor={{
          id: vendor.id,
          companyName: vendor.companyName,
          ownerName: vendor.ownerName,
          email: vendor.email,
          status: vendor.status
        }}
        isLoading={actionLoading === 'suspend'}
      />

      {/* Approval Confirmation Modal */}
      <DeleteConfirmModal
        show={approvalModal}
        variant="confirm"
        title="Confirm Vendor Approval"
        subtitle="Once approved, the vendor will be able to access the platform and proceed with the next steps."
        itemName={vendor.companyName}
        itemDetail={vendor.ownerName}
        confirmLabel="Approve"
        loadingLabel="Approving..."
        loading={actionLoading === 'approve'}
        onConfirm={handleApproveConfirm}
        onCancel={() => setApprovalModal(false)}
      />
    </div>
  )
}

// Map Step 1 chip IDs back to display labels. Any other value (the
// `'others'` placeholder or a custom user-typed string) is shown as-is
// with light title-casing so admins see exactly what the vendor entered.
const BUSINESS_TYPE_LABELS: Record<string, string> = {
  'proprietorship': 'Proprietorship',
  'pvt-ltd': 'Pvt Ltd',
  'partnership-firm': 'Partnership Firm',
  'llp': 'LLP',
  'others': 'Others',
};
const businessTypeLabel = (raw: string): string => {
  if (!raw) return '';
  return BUSINESS_TYPE_LABELS[raw] || raw;
};

// Acquisition channel labels — ids match backend/utils/referralSources.js.
const REFERRAL_SOURCE_LABELS: Record<string, string> = {
  'google': 'Google / Search',
  'online-ads': 'Online Ads',
  'linkedin': 'LinkedIn',
  'instagram': 'Instagram',
  'facebook': 'Facebook',
  'youtube': 'YouTube',
  'referral': 'Referral / Word of Mouth',
  'trade-show': 'Trade Show / Exhibition',
  'others': 'Others',
};
const referralSourceLabel = (raw: string): string => (raw ? (REFERRAL_SOURCE_LABELS[raw] || raw) : '');

// Tab Components
function OverviewTab({ vendor }: { vendor: VendorProfile }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main Info */}
      <div className="lg:col-span-2 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Building2 className="h-5 w-5" />
              <span>Company Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                {(vendor as any).businessType && (
                  <div className="flex items-center space-x-3">
                    <Building2 className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Business Type</p>
                      <p className="font-medium">{businessTypeLabel((vendor as any).businessType)}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center space-x-3">
                  <Mail className="h-4 w-4 text-slate-400" />
                  <div>
                    <p className="text-sm text-slate-500">Business Email</p>
                    <p className="font-medium">{vendor.businessEmail || vendor.email}</p>
                  </div>
                </div>

                {(vendor as any).businessEmail2 && (
                  <div className="flex items-center space-x-3">
                    <Mail className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Secondary Email</p>
                      <p className="font-medium">{(vendor as any).businessEmail2}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center space-x-3">
                  <Phone className="h-4 w-4 text-slate-400" />
                  <div>
                    <p className="text-sm text-slate-500">Primary Phone</p>
                    <p className="font-medium">{vendor.businessPhone}</p>
                  </div>
                </div>

                {vendor.landlineNumber && (
                  <div className="flex items-center space-x-3">
                    <Phone className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Local Landline</p>
                      <p className="font-medium">{formatLocalLandline({ countryCode: '+91', std: (vendor as any).localLandlineStd, number: vendor.landlineNumber })}</p>
                    </div>
                  </div>
                )}
                {(() => {
                  const intlLL = formatIntlLandline((vendor as any).intlLandline);
                  return intlLL ? (
                    <div className="flex items-center space-x-3">
                      <Phone className="h-4 w-4 text-slate-400" />
                      <div>
                        <p className="text-sm text-slate-500">International Landline</p>
                        <p className="font-medium">{intlLL}</p>
                      </div>
                    </div>
                  ) : null;
                })()}

                {vendor.phoneNumber2 && (
                  <div className="flex items-center space-x-3">
                    <Phone className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Secondary Phone</p>
                      <p className="font-medium">{vendor.phoneNumber2}</p>
                    </div>
                  </div>
                )}

                {vendor.gstNumber ? (
                  <div className="flex items-center space-x-3">
                    <FileText className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500 flex items-center gap-1.5">
                        GST Number
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-green-50 text-green-700 border border-green-200">Unique ID</span>
                      </p>
                      <p className="font-medium font-mono tracking-wide">{vendor.gstNumber}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center space-x-3">
                    <FileText className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500 flex items-center gap-1.5">
                        Vendor Type
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">Unregistered</span>
                      </p>
                      <p className="text-sm text-slate-500">No GST — identified by email</p>
                    </div>
                  </div>
                )}

                {vendor.website && (
                  <div className="flex items-center space-x-3">
                    <Globe className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Website</p>
                      {toExternalUrl(vendor.website) ? (
                        <a href={toExternalUrl(vendor.website)!} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline">
                          {vendor.website}
                        </a>
                      ) : (
                        <p className="font-medium text-slate-900">{vendor.website}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Always rendered, even when empty: vendors who registered before this
                    field existed have no value, and hiding the row makes it impossible
                    to tell "not asked" from "feature missing". */}
                <div className="flex items-center space-x-3">
                  <Megaphone className="h-4 w-4 text-slate-400" />
                  <div>
                    <p className="text-sm text-slate-500">How They Heard About Us</p>
                    {(vendor as any).referralSource ? (
                      <p className="font-medium">
                        {referralSourceLabel((vendor as any).referralSource)}
                        {(vendor as any).referralSourceDetail && (
                          <span className="text-slate-500 font-normal"> — {(vendor as any).referralSourceDetail}</span>
                        )}
                      </p>
                    ) : (
                      <p className="font-medium text-slate-400 italic">Not recorded</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-start space-x-3">
                  <MapPin className="h-4 w-4 text-slate-400 mt-1 shrink-0" />
                  <div>
                    <p className="text-sm text-slate-500">Address</p>
                    <div className="font-medium leading-relaxed">
                      {vendor.businessAddress && <p>{vendor.businessAddress}</p>}
                      {(vendor as any).businessAddressLine2 && <p>{(vendor as any).businessAddressLine2}</p>}
                      {(vendor as any).businessAddressLine3 && <p>{(vendor as any).businessAddressLine3}</p>}
                      {(vendor as any).businessLandmark && <p className="text-slate-500 text-sm">Near: {(vendor as any).businessLandmark}</p>}
                      {(vendor.businessCity || vendor.businessState || vendor.businessZipCode) && (
                        <p>{[vendor.businessCity, vendor.businessState, vendor.businessZipCode].filter(Boolean).join(', ')}</p>
                      )}
                      {vendor.businessCountry && <p>{vendor.businessCountry}</p>}
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-3">
                  <Calendar className="h-4 w-4 text-slate-400" />
                  <div>
                    <p className="text-sm text-slate-500">Join Date</p>
                    <p className="font-medium">{new Date(vendor.createdAt).toLocaleDateString()}</p>
                  </div>
                </div>

                {vendor.establishedYear && (
                  <div className="flex items-center space-x-3">
                    <Building2 className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Established</p>
                      <p className="font-medium">{vendor.establishedYear}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <User className="h-5 w-5" />
              <span>Owner Identity</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6">
              {/* Owner Photo */}
              {(vendor as any).ownerPhoto && (
                <div className="shrink-0">
                  <img
                    src={(vendor as any).ownerPhoto}
                    alt={vendor.ownerName}
                    onClick={() => openDoc((vendor as any).ownerPhoto, vendor.ownerName || 'Owner', true)}
                    title="View full photo"
                    className="w-20 h-20 rounded-full object-cover border-2 border-slate-200 cursor-zoom-in transition hover:ring-2 hover:ring-[#e01a1b]/40"
                  />
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
                <div>
                  <p className="text-sm text-slate-500">Owner Full Name</p>
                  <p className="font-medium">{buildFullName((vendor as any).ownerTitle, (vendor as any).ownerFirstName, (vendor as any).ownerMiddleName, (vendor as any).ownerLastName, vendor.ownerName)}</p>
                </div>
                {(vendor as any).designation && (
                  <div>
                    <p className="text-sm text-slate-500">Designation</p>
                    <p className="font-medium">{resolveOwnerDesignation((vendor as any).designation)}</p>
                  </div>
                )}
                {(vendor as any).designation === 'Others' && (vendor as any).customDesignation && (
                  <div>
                    <p className="text-sm text-slate-500">Custom Designation</p>
                    <p className="font-medium">{(vendor as any).customDesignation}</p>
                  </div>
                )}
                <div>
                  <p className="text-sm text-slate-500">Primary Email</p>
                  <p className="font-medium">{vendor.ownerEmail}</p>
                </div>
                {(vendor as any).ownerEmail2 && (
                  <div>
                    <p className="text-sm text-slate-500">Secondary Email</p>
                    <p className="font-medium">{(vendor as any).ownerEmail2}</p>
                  </div>
                )}
                <div>
                  <p className="text-sm text-slate-500">Primary Phone</p>
                  <p className="font-medium">{vendor.ownerPhone}</p>
                </div>
                {(vendor as any).ownerPhone2 && (
                  <div>
                    <p className="text-sm text-slate-500">Secondary Phone</p>
                    <p className="font-medium">{(vendor as any).ownerPhone2}</p>
                  </div>
                )}
                {(vendor as any).ownerLandline && (
                  <div>
                    <p className="text-sm text-slate-500">Local Landline</p>
                    <p className="font-medium">{(() => {
                      const std = ((vendor as any).ownerLocalLandlineStd || '').trim();
                      const assembled = ((vendor as any).ownerLandline || '').trim();
                      // ownerLandline = STD + subscriber; strip the STD prefix so it isn't doubled
                      const num = std && assembled.startsWith(std) ? assembled.slice(std.length) : assembled;
                      return formatLocalLandline({ countryCode: '+91', std, number: num });
                    })()}</p>
                  </div>
                )}
                {(() => {
                  const intlLL = formatIntlLandline((vendor as any).ownerIntlLandline);
                  return intlLL ? (
                    <div>
                      <p className="text-sm text-slate-500">International Landline</p>
                      <p className="font-medium">{intlLL}</p>
                    </div>
                  ) : null;
                })()}
                {(vendor as any).businessStartDate && (
                  <div>
                    <p className="text-sm text-slate-500">Business Start Date</p>
                    <p className="font-medium">{new Date((vendor as any).businessStartDate).toLocaleDateString()}</p>
                  </div>
                )}
                {(vendor as any).employeeCount && (
                  <div>
                    <p className="text-sm text-slate-500">Number of Employees</p>
                    <p className="font-medium">{(vendor as any).employeeCount}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Additional Owners */}
            {(() => {
              const owners = vendor.additionalOwners;
              if (!owners || !Array.isArray(owners) || owners.length === 0) return null;
              return (
                <div className="mt-6 pt-6 border-t border-slate-200">
                  <h4 className="text-sm font-semibold text-slate-700 mb-3">Additional Owners</h4>
                  <div className="space-y-3">
                    {owners.map((owner: any, index: number) => (
                      <div key={index} className="flex items-start gap-4 p-3 bg-slate-50 rounded-lg">
                        {/* Profile photo when uploaded; numbered badge as fallback */}
                        {owner.photo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={owner.photo}
                            alt={`Owner ${index + 2} profile`}
                            onClick={() => openDoc(owner.photo, owner.name || `Owner ${index + 2}`, true)}
                            title="View full photo"
                            className="w-12 h-12 rounded-full object-cover border border-slate-200 shrink-0 mt-0.5 cursor-zoom-in transition hover:ring-2 hover:ring-[#e01a1b]/40"
                          />
                        ) : (
                          <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 mt-0.5">
                            {index + 2}
                          </div>
                        )}
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 flex-1 text-sm">
                          <div>
                            <p className="text-slate-500">Full Name</p>
                            <p className="font-medium">{buildFullName(owner.title, owner.firstName, owner.middleName, owner.lastName, owner.name)}</p>
                          </div>
                          {owner.designation && (
                            <div>
                              <p className="text-slate-500">Designation</p>
                              <p className="font-medium">{resolveOwnerDesignation(owner.designation)}</p>
                            </div>
                          )}
                          {owner.designation === 'Others' && owner.customDesignation && (
                            <div>
                              <p className="text-slate-500">Custom Designation</p>
                              <p className="font-medium">{owner.customDesignation}</p>
                            </div>
                          )}
                          <div>
                            <p className="text-slate-500">Primary Email</p>
                            <p className="font-medium">{owner.email}</p>
                          </div>
                          {owner.email2 && (
                            <div>
                              <p className="text-slate-500">Secondary Email</p>
                              <p className="font-medium">{owner.email2}</p>
                            </div>
                          )}
                          <div>
                            <p className="text-slate-500">Primary Phone</p>
                            <p className="font-medium">{owner.phone}</p>
                          </div>
                          {owner.phone2 && (
                            <div>
                              <p className="text-slate-500">Secondary Phone</p>
                              <p className="font-medium">{owner.phone2}</p>
                            </div>
                          )}
                          {(owner.localLandline || owner.landline) && (
                            <div>
                              <p className="text-slate-500">Local Landline</p>
                              <p className="font-medium">{(() => {
                                const std = (owner.localLandlineStd || '').trim();
                                const assembled = (owner.localLandline || owner.landline || '').trim();
                                const num = std && assembled.startsWith(std) ? assembled.slice(std.length) : assembled;
                                return formatLocalLandline({ countryCode: '+91', std, number: num });
                              })()}</p>
                            </div>
                          )}
                          {(() => {
                            const intlLL = formatIntlLandline(owner.intlLandline);
                            return intlLL ? (
                              <div>
                                <p className="text-slate-500">International Landline</p>
                                <p className="font-medium">{intlLL}</p>
                              </div>
                            ) : null;
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Sidebar */}
      <div className="space-y-6">
        {/* Company Logo */}
        {vendor.companyLogo && (
          <Card>
            <CardHeader>
              <CardTitle>Company Logo</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex justify-center">
                <img
                  src={vendor.companyLogo}
                  alt={`${vendor.companyName} Logo`}
                  className="w-32 h-32 object-contain border border-slate-200 rounded-lg"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick Stats */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-500">Product Categories</span>
              <span className="font-semibold">{vendor.productCategories?.length || 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-500">Certifications</span>
              <span className="font-semibold">{vendor._count?.certifications || 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-500">Documents</span>
              <span className="font-semibold">{vendor._count?.documents || 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Status Information */}
        <Card>
          <CardHeader>
            <CardTitle>Status Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-500">Current Status</span>
              <span className="font-semibold capitalize">{vendor.status.toLowerCase()}</span>
            </div>

            {vendor.approvedAt && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Approved Date</span>
                <span className="font-semibold">{new Date(vendor.approvedAt).toLocaleDateString()}</span>
              </div>
            )}

            {vendor.rejectedAt && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Rejected Date</span>
                <span className="font-semibold">{new Date(vendor.rejectedAt).toLocaleDateString()}</span>
              </div>
            )}

            {vendor.suspendedAt && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Suspended Date</span>
                <span className="font-semibold">{new Date(vendor.suspendedAt).toLocaleDateString()}</span>
              </div>
            )}

            {vendor.rejectionReason && (
              <div>
                <p className="text-sm text-slate-500">Reason</p>
                <p className="font-medium text-red-600">{vendor.rejectionReason}</p>
              </div>
            )}
          </CardContent>
        </Card>


      </div>
    </div>
  )
}

function DetailsTab({ vendor }: { vendor: VendorProfile }) {
  const v = vendor as any;
  const [viewerDoc, setViewerDoc] = useState<{ url: string; name: string } | null>(null);
  const openViewer = (url: string, name: string) => setViewerDoc({ url, name });

  const docs: any[] = Array.isArray(vendor.documents) ? vendor.documents : [];
  const findDoc = (type: string) => docs.find((d: any) => d.type === type) ?? null;

  // Factory site images (CompanyDetails → Legal Address & Factory Site section)
  const factorySiteImgs = docs.filter((d: any) =>
    typeof d.name === 'string' && d.name.startsWith('Factory Site ') && d.documentUrl
  );
  // Warehouse factory images (WarehouseDetails → Warehouse Address section)
  const factoryImgs = docs.filter((d: any) =>
    typeof d.name === 'string' && d.name.startsWith('Factory ') &&
    !d.name.startsWith('Factory Site ') && d.documentUrl
  );

  const imageGallery = (images: any[], prefixToStrip: string) => {
    if (!images.length) return null;
    return (
      <div className="mt-4 pt-4 border-t border-slate-100">
        <p className="text-sm font-semibold text-slate-700 mb-3">
          {prefixToStrip === 'Factory Site ' ? 'Factory Images' : 'Warehouse Images'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {images.map((img: any, idx: number) => (
            <div key={img.id || idx} className="space-y-1.5">
              <div
                className="relative rounded-lg overflow-hidden border border-slate-200 bg-slate-50 aspect-square cursor-pointer group"
                onClick={() => openViewer(img.documentUrl, img.name)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.documentUrl}
                  alt={img.name}
                  className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
                />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/20 transition-opacity">
                  <Eye className="w-5 h-5 text-white drop-shadow" />
                </div>
              </div>
              <p className="text-xs font-medium text-slate-700 truncate" title={img.name}>
                {img.name.replace(prefixToStrip, '')}
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openViewer(img.documentUrl, img.name)}
                  className="flex-1 h-6 px-1 text-[10px] font-medium transition-colors hover:bg-slate-100 hover:border-slate-300 hover:text-slate-800"
                >
                  <Eye className="w-2.5 h-2.5 mr-0.5" />View
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadDoc(img.documentUrl, img.name)}
                  className="flex-1 h-6 px-1 text-[10px] font-medium transition-colors hover:bg-slate-100 hover:border-slate-300 hover:text-slate-800"
                >
                  <Download className="w-2.5 h-2.5 mr-0.5" />Download
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const isProp  = v.businessType === 'proprietorship';
  const isUnreg = v.businessType === 'unregistered';
  const isMeta  = ['pvt-ltd', 'partnership-firm', 'llp'].includes(v.businessType);

  const idLabelByType: Record<string, string> = {
    'pvt-ltd':          'CIN Number',
    'partnership-firm': 'Partnership Deed Details',
    'llp':              'LLPIN Number',
  };
  const certLabelByType: Record<string, string> = {
    'pvt-ltd':          'CIN Certificate',
    'partnership-firm': 'Partnership Deed Certificate',
    'llp':              'LLPIN Certificate',
  };
  const panLabel     = isProp ? 'Proprietor PAN Number' : isUnreg ? 'PAN Number' : 'Company PAN Number';
  const panCardLabel = isProp ? 'Proprietor PAN Card'   : isUnreg ? 'PAN Card'   : 'Company PAN Card';

  const hasAnyRegId = v.gstNumber || v.panNumber || v.iecCode || v.aadhaarNumber
    || v.companyIdNumber || docs.some((d: any) => COMPANY_DOC_TYPES.includes(d.type));

  const regRow = (label: string, value: string | undefined, docType: string, docLabel: string) => {
    const doc = findDoc(docType);
    if (!value && !doc) return null;
    return (
      <div className="space-y-2 pb-4 border-b border-slate-100 last:border-0 last:pb-0">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
          <p className="font-medium text-slate-900 mt-0.5">{value || '—'}</p>
        </div>
        {doc && (
          <DocFileCard doc={doc} docLabel={docLabel} onView={openViewer} />
        )}
      </div>
    );
  };

  // Track which company doc types the explicit regRow calls cover so a
  // catch-all can surface any remaining uploaded documents (e.g. a
  // proprietorship who also uploads a separate IEC_CERTIFICATE).
  const coveredDocTypes = new Set<string>(['GST_CERTIFICATE', 'PAN_CARD']);
  if (isUnreg) coveredDocTypes.add('AADHAAR_CARD');
  // Proprietorship: COMPANY_REGISTRATION is their IEC cert (typeCertDocument)
  if (isProp) coveredDocTypes.add('COMPANY_REGISTRATION');
  // Meta types (pvt-ltd/partnership/llp): COMPANY_REGISTRATION is CIN/deed/LLPIN
  if (isMeta) coveredDocTypes.add('COMPANY_REGISTRATION');
  // "Others" with a registration number
  if (!isProp && !isUnreg && !isMeta && v.companyIdNumber) coveredDocTypes.add('COMPANY_REGISTRATION');
  // Non-proprietorship IEC (backend stores this as EXPORT_LICENSE, not IEC_CERTIFICATE)
  if (!isProp && (v.hasImportExport === 'yes' || v.iecCode)) coveredDocTypes.add('EXPORT_LICENSE');

  const uncoveredDocs = docs.filter((d: any) =>
    COMPANY_DOC_TYPES.includes(d.type) && !coveredDocTypes.has(d.type)
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {hasAnyRegId && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <FileText className="h-5 w-5" />
              <span>Regulatory IDs &amp; Documents</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              {regRow('GST Number', v.gstNumber, 'GST_CERTIFICATE', 'GST Certificate')}
              {isUnreg && regRow('Aadhaar Number', v.aadhaarNumber, 'AADHAAR_CARD', 'Aadhaar Card')}
              {/* For proprietorship the typeCertDocument IS the IEC cert (stored as COMPANY_REGISTRATION).
                  Always attempt to show it — regRow returns null if neither value nor doc exists. */}
              {isProp && regRow('IEC Code', v.iecCode, 'COMPANY_REGISTRATION', 'IEC Certificate')}
              {!isProp && (v.hasImportExport === 'yes' || v.iecCode) && regRow(
                'IEC Code',
                v.iecCode,
                'EXPORT_LICENSE',
                'IEC Certificate',
              )}
              {isMeta && regRow(
                idLabelByType[v.businessType] || 'Business Registration ID',
                v.companyIdNumber,
                'COMPANY_REGISTRATION',
                certLabelByType[v.businessType] || 'Company Registration Certificate',
              )}
              {!isProp && !isUnreg && !isMeta && v.companyIdNumber && regRow(
                'Others Registration Number',
                v.companyIdNumber,
                'COMPANY_REGISTRATION',
                'Other Supporting Document',
              )}
              {regRow(panLabel, v.panNumber, 'PAN_CARD', panCardLabel)}
              {uncoveredDocs.map((doc: any) => (
                <div key={doc.id || doc.type} className="space-y-2 pb-4 border-b border-slate-100 last:border-0 last:pb-0">
                  <DocFileCard doc={doc} onView={openViewer} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Legal Address & Factory Site — always read from businessAddress* columns,
          which are set from CompanyDetails on every save (old and new vendors).
          factoryAddress* was historically mirrored from warehouseAddress on old
          registrations, making it unreliable for pre-fix vendors. */}
      {vendor.businessAddress && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <MapPin className="h-5 w-5" />
              <span>Legal Address &amp; Factory Site</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {(vendor as any).factoryOwnershipType && (
                <div>
                  <p className="text-sm text-slate-500 font-semibold mb-1">Factory Ownership</p>
                  <p className="font-medium capitalize">{(vendor as any).factoryOwnershipType}</p>
                </div>
              )}
              <div>
                <p className="font-medium">{vendor.businessAddress}</p>
                {(vendor as any).addressLine2 && <p className="font-medium">{(vendor as any).addressLine2}</p>}
                {(vendor as any).addressLine3 && <p className="font-medium">{(vendor as any).addressLine3}</p>}
                {(vendor as any).landmark && (
                  <p className="text-sm text-slate-500">
                    <span className="font-semibold">Landmark:</span> {(vendor as any).landmark}
                  </p>
                )}
                <p className="font-medium">
                  {vendor.businessCity}{vendor.businessState ? `, ${vendor.businessState}` : ''}{vendor.businessZipCode ? ` ${vendor.businessZipCode}` : ''}
                </p>
                {vendor.businessCountry && <p className="font-medium">{vendor.businessCountry}</p>}
              </div>
              {/* Factory coordinates — the pair the QC inspection geofence measures
                  against, so surface whether they are actually set. */}
              <CoordinatePair
                latitude={(vendor as any).factoryLatitude}
                longitude={(vendor as any).factoryLongitude}
                emptyHint="Not set — QC inspections at this vendor cannot be location-verified."
              />
              {(vendor as any).factorySize && (
                <div>
                  <p className="text-sm text-slate-500">Warehousing Capacity</p>
                  <p className="font-medium">{formatSqFt((vendor as any).factorySize)}</p>
                </div>
              )}
              {imageGallery(factorySiteImgs, 'Factory Site ')}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Warehouse Address — compare against businessAddress (always correct) so
          old vendors whose factoryAddress was mirrored from warehouseAddress
          still show the correct "same as" or separate address. */}
      {(() => {
        const v = vendor as any
        const eq = (a: any, b: any) => (a || '').trim() === (b || '').trim()
        const isSameAsLegal = (
          !vendor.warehouseAddress && !vendor.warehouseCity
        ) || (
          eq(vendor.warehouseAddress, vendor.businessAddress) &&
          eq(vendor.warehouseCity, vendor.businessCity) &&
          eq(vendor.warehouseState, vendor.businessState) &&
          eq(vendor.warehouseZipCode, vendor.businessZipCode) &&
          eq(vendor.warehouseCountry, vendor.businessCountry)
        )
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <MapPin className="h-5 w-5" />
                <span>Warehouse Address</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {v.ownershipType && (
                <div className="mb-3">
                  <p className="text-sm text-slate-500 font-semibold mb-1">Ownership Type</p>
                  <p className="font-medium capitalize">{v.ownershipType}</p>
                </div>
              )}
              {isSameAsLegal ? (
                <div className="p-3 bg-blue-50 text-blue-800 rounded-lg text-sm border border-blue-200 font-medium">
                  Warehouse Address is the same as the Legal Address &amp; Factory Site above.
                </div>
              ) : (
                <div className="space-y-1">
                  {vendor.warehouseAddress && <p className="font-medium">{vendor.warehouseAddress}</p>}
                  {v.warehouseAddressLine2 && <p className="font-medium">{v.warehouseAddressLine2}</p>}
                  {v.warehouseAddressLine3 && <p className="font-medium">{v.warehouseAddressLine3}</p>}
                  {v.warehouseLandmark && (
                    <p className="text-sm text-slate-500">
                      <span className="font-semibold">Landmark:</span> {v.warehouseLandmark}
                    </p>
                  )}
                  {vendor.warehouseCity && (
                    <p className="font-medium">
                      {vendor.warehouseCity}{vendor.warehouseState ? `, ${vendor.warehouseState}` : ''}{vendor.warehouseZipCode ? ` ${vendor.warehouseZipCode}` : ''}
                    </p>
                  )}
                  {vendor.warehouseCountry && <p className="font-medium">{vendor.warehouseCountry}</p>}
                </div>
              )}
              {/* When linked, the warehouse coordinates are a mirror of the factory
                  pair, so show whichever is stored rather than a blank row. */}
              <div className="mt-3">
                <CoordinatePair
                  latitude={isSameAsLegal ? (v.warehouseLatitude ?? v.factoryLatitude) : v.warehouseLatitude}
                  longitude={isSameAsLegal ? (v.warehouseLongitude ?? v.factoryLongitude) : v.warehouseLongitude}
                />
              </div>
              {vendor.warehouseSize && (
                <div className="mt-3">
                  <p className="text-sm text-slate-500">Warehousing Capacity</p>
                  <p className="font-medium">{formatSqFt(vendor.warehouseSize)}</p>
                </div>
              )}
              {/* Which address QC product inspections are geofenced against. */}
              <div className="mt-3">
                <p className="text-sm text-slate-500">Product Inspection Site</p>
                <p className="font-medium">
                  {(() => {
                    const sites = Array.isArray((v as any).productInspectionSites) && (v as any).productInspectionSites.length
                      ? (v as any).productInspectionSites
                      : (v.productInspectionSite ? [v.productInspectionSite] : []);
                    return sites.length
                      ? sites.map((s: string) => String(s).toUpperCase() === 'WAREHOUSE' ? 'Warehouse address' : 'Legal / Factory address').join(' & ')
                      : 'Legal / Factory address';
                  })()}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">Products are location-verified at this address during QC inspection.</p>
              </div>
              {v.mapLink && (
                <div className="mt-3">
                  <a href={v.mapLink} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">
                    <MapPin className="w-4 h-4" /> View on Map
                  </a>
                </div>
              )}
              {imageGallery(factoryImgs, 'Factory ')}
            </CardContent>
          </Card>
        )
      })()}

      {viewerDoc && (
        <DocViewerModal url={viewerDoc.url} name={viewerDoc.name} onClose={() => setViewerDoc(null)} />
      )}
    </div>
  )
}

function ProductsTab({ vendor }: { vendor: VendorProfile }) {
  const v = vendor as any;
  const vendorTypesArray: string[] = Array.isArray(v.vendorTypes) && v.vendorTypes.length > 0
    ? v.vendorTypes
    : [vendor.vendorType.replace(/_/g, ' ').toLowerCase()];
  const marketTypeArray: string[] = (vendor as any).marketType
    ? (Array.isArray((vendor as any).marketType) ? (vendor as any).marketType : [(vendor as any).marketType])
    : [];

  const [categoryNameMap, setCategoryNameMap] = useState<Record<string, string>>({});
  const [viewerDoc, setViewerDoc] = useState<{ url: string; name: string } | null>(null);
  const openViewer = (url: string, name: string) => setViewerDoc({ url, name });

  useEffect(() => {
    categoryService.getCategoryTree({ status: 'ACTIVE', includeInactive: false })
      .then((res: any) => {
        const map: Record<string, string> = {};
        (res.data || []).forEach((cat: any) => { map[cat.id] = cat.name; });
        setCategoryNameMap(map);
      })
      .catch(() => {});
  }, []);

  const renderProductCard = (p: any, i: number, prefix: string) => {
    const firstPhoto = Array.isArray(p.photos) && p.photos.length > 0
      ? (p.photos[0].preview || p.photos[0].url)
      : null;
    const productName = p.name || `Product ${i + 1}`;
    return (
      <div key={p.id || `${prefix}-${i}`} className="border border-slate-200 rounded-lg overflow-hidden bg-white hover:shadow-md hover:border-slate-300 transition-all flex flex-col">
        <div className="h-28 bg-slate-50 overflow-hidden shrink-0">
          {firstPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={firstPhoto} alt={productName} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Package className="w-6 h-6 text-slate-300" />
            </div>
          )}
        </div>
        <div className="px-2.5 pt-2 pb-2.5 border-t border-slate-100 flex flex-col gap-1.5 flex-1">
          <p className="text-xs font-semibold text-slate-800 truncate leading-snug" title={productName}>
            {productName}
          </p>
          {p.description && (
            <p className="text-[10px] text-slate-500 truncate leading-snug">{p.description}</p>
          )}
          {firstPhoto && (
            <div className="flex gap-1.5 mt-auto pt-0.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => openViewer(firstPhoto, productName)}
                className="flex-1 h-6 px-1.5 text-[10px] font-medium transition-colors hover:bg-slate-100 hover:border-slate-300 hover:text-slate-800"
              >
                <Eye className="w-2.5 h-2.5 mr-1 shrink-0" />View
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadDoc(firstPhoto, productName)}
                className="flex-1 h-6 px-1.5 text-[10px] font-medium transition-colors hover:bg-slate-100 hover:border-slate-300 hover:text-slate-800"
              >
                <Download className="w-2.5 h-2.5 mr-1 shrink-0" />Download
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCategorySection = (catName: string, catKey: string, products: any[], isCustom?: boolean) => (
    <div key={catKey}>
      <div className="flex items-center gap-3 mb-3">
        <p className="text-xs font-bold text-slate-600 uppercase tracking-widest shrink-0">{catName}</p>
        {isCustom && (
          <Badge className="bg-orange-50 text-orange-700 border border-orange-200 text-[10px] px-1.5 py-0 shrink-0">Custom</Badge>
        )}
        <div className="flex-1 h-px bg-slate-100" />
        <span className="text-xs text-slate-400 shrink-0">
          {products.length} product{products.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {products.map((p: any, i: number) => renderProductCard(p, i, catKey))}
      </div>
    </div>
  );

  const hasCategoryProducts = v.categoryProducts && typeof v.categoryProducts === 'object'
    && Object.keys(v.categoryProducts).length > 0;
  const hasAdditionalCategories = Array.isArray(v.additionalCategories) && v.additionalCategories.length > 0;
  const hasCategories = vendor.productCategories && vendor.productCategories.length > 0;

  return (
    <div className="space-y-6">
      {/* Compact meta row: Vendor Type | Market Type | Product Categories */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700">Vendor Type</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex flex-wrap gap-1.5">
              {vendorTypesArray.map((t) => (
                <Badge key={t} className="bg-blue-50 text-blue-700 border border-blue-200 capitalize text-xs font-medium">{t}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        {marketTypeArray.length > 0 && (
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-slate-700">Market Type</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-wrap gap-1.5">
                {marketTypeArray.map((type: string, i: number) => (
                  <Badge key={i} className="bg-orange-50 text-orange-700 border border-orange-200 capitalize text-xs font-medium">{type}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {hasCategories && (
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-slate-700">Product Categories</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-wrap gap-1.5">
                {Array.from(new Set(vendor.productCategories)).map((category, i) => (
                  <Badge key={`${category}-${i}`} className="bg-green-50 text-green-700 border border-green-200 capitalize text-xs font-medium">
                    {category}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* General Remarks */}
      {(vendor as any).categoryRemarks && (
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700">General Remarks</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{(vendor as any).categoryRemarks}</p>
          </CardContent>
        </Card>
      )}

      {/* Per-category Products */}
      {hasCategoryProducts && (
        <Card>
          <CardHeader>
            <CardTitle>Products by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-8">
              {Object.entries(v.categoryProducts).map(([catId, products]) => {
                const list = Array.isArray(products) ? products : [];
                if (list.length === 0) return null;
                return renderCategorySection(categoryNameMap[catId] || 'Category', catId, list);
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* User-defined custom categories */}
      {hasAdditionalCategories && (
        <Card>
          <CardHeader>
            <CardTitle>Additional (Custom) Categories</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-8">
              {v.additionalCategories.map((cat: any) => {
                const products = Array.isArray(cat.products) ? cat.products : [];
                if (products.length === 0) return null;
                return renderCategorySection(cat.name || 'Unnamed Category', cat.id || cat.name, products, true);
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {viewerDoc && (
        <DocViewerModal url={viewerDoc.url} name={viewerDoc.name} onClose={() => setViewerDoc(null)} />
      )}
    </div>
  );
}

function FacilitiesTab({ vendor }: { vendor: VendorProfile }) {
  const [viewerDoc, setViewerDoc] = useState<{ url: string; name: string } | null>(null)
  return (
    <div className="space-y-6">
      {vendor.factoryAddress && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Factory className="h-5 w-5" />
              <span>Manufacturing Facilities</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {vendor.qualityControl && (
              <div className="mb-4">
                <p className="text-sm text-slate-500">Quality Control Process</p>
                <p className="font-medium">{vendor.qualityControl}</p>
              </div>
            )}

            {/* Enabled Facilities & Details */}
            {(() => {
              const enabled = (vendor as any).enabledFacilities;
              const details = (vendor as any).facilityDetails;
              if (!enabled || typeof enabled !== 'object') return null;

              const activeFacilities = Object.entries(enabled).filter(([, v]) => v);
              if (activeFacilities.length === 0) return null;

              return (
                <div className={vendor.qualityControl ? 'mt-4 pt-4 border-t border-slate-200' : undefined}>
                  <h4 className="text-sm font-semibold text-slate-700 mb-3">Active Facility Stages</h4>
                  <div className="space-y-3">
                    {activeFacilities.map(([id]) => {
                      const fd = details?.[id];
                      const meta = FACILITY_META[id];
                      const label = meta?.label ?? (id.charAt(0).toUpperCase() + id.slice(1));
                      return (
                        <div key={id} className="p-3 bg-slate-50 rounded-lg">
                          <p className="font-medium text-slate-900 mb-2">{label}</p>
                          {fd && meta && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                              {meta.detailFields.map(({ key, label: fieldLabel, unit }) => {
                                const val = fd[key];
                                if (val === null || val === undefined || val === '') return null;
                                return (
                                  <div key={key}>
                                    <p className="text-slate-500">{fieldLabel}</p>
                                    <p className="font-medium">{withUnit(val, unit)}</p>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {vendor.certifications && vendor.certifications.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Certifications</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {vendor.certifications.map((cert, index) => (
                <div key={index} className="flex items-center justify-between p-4 border border-slate-200 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <Award className="h-8 w-8 text-yellow-500" />
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        <span>{cert.name}</span>
                        {(cert as any).isCustom && (
                          <Badge className="bg-orange-50 text-orange-700 border border-orange-200">Custom</Badge>
                        )}
                      </div>
                      {cert.issuedBy && (
                        <p className="text-sm text-slate-500">Issued by: {cert.issuedBy}</p>
                      )}
                      {(cert as any).description && (
                        <p className="text-sm text-slate-700 mt-1">{(cert as any).description}</p>
                      )}
                      {cert.expiryDate && (
                        <p className="text-xs text-slate-500">Expires: {new Date(cert.expiryDate).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                  {cert.documentUrl && (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setViewerDoc({ url: cert.documentUrl!, name: cert.name || 'Certificate' })}>
                        <Eye className="h-4 w-4 mr-2" />
                        View
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => downloadDoc(cert.documentUrl!, cert.name || 'Certificate')}>
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {((vendor.shippingMethods && vendor.shippingMethods.length > 0) ||
        (vendor as any).packagingCapabilities ||
        (vendor as any).logisticsPartners ||
        (vendor as any).complianceStandards) && (
        <Card>
          <CardHeader>
            <CardTitle>Logistics &amp; Compliance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {vendor.shippingMethods && vendor.shippingMethods.length > 0 && (
              <div>
                <p className="text-sm text-slate-500 mb-2">Shipping Methods</p>
                <div className="flex flex-wrap gap-2">
                  {vendor.shippingMethods.map((method, index) => (
                    <Badge key={index} className="bg-indigo-50 text-indigo-700 border border-indigo-200 capitalize">{method}</Badge>
                  ))}
                </div>
              </div>
            )}

            {(vendor as any).packagingCapabilities && (
              <div>
                <p className="text-sm text-slate-500">Packaging Capabilities</p>
                <p className="font-medium whitespace-pre-wrap">{(vendor as any).packagingCapabilities}</p>
              </div>
            )}
            {(vendor as any).logisticsPartners && (
              <div>
                <p className="text-sm text-slate-500">Logistics Partners</p>
                <p className="font-medium whitespace-pre-wrap">{(vendor as any).logisticsPartners}</p>
              </div>
            )}
            {(vendor as any).complianceStandards && (
              <div>
                <p className="text-sm text-slate-500">Compliance Standards</p>
                <p className="font-medium whitespace-pre-wrap">{(vendor as any).complianceStandards}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {viewerDoc && (
        <DocViewerModal
          url={viewerDoc.url}
          name={viewerDoc.name}
          onClose={() => setViewerDoc(null)}
        />
      )}
    </div>
  )
}

// ── Document type metadata ────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  GST_CERTIFICATE:      'GST Certificate',
  PAN_CARD:             'PAN Card',
  COMPANY_REGISTRATION: 'Company Registration Certificate',
  AADHAAR_CARD:         'Aadhaar Card',
  IEC_CERTIFICATE:      'IEC Certificate',
  TRADE_LICENSE:        'Trade License',
  EXPORT_LICENSE:       'IEC Certificate',
  FACTORY_LICENSE:      'Factory License',
  POLLUTION_CERTIFICATE:'Pollution Certificate',
  FIRE_SAFETY_CERTIFICATE: 'Fire Safety Certificate',
  BANK_STATEMENT:       'Bank Statement',
  AUDITED_FINANCIALS:   'Audited Financials',
}

const COMPANY_DOC_TYPES   = ['GST_CERTIFICATE', 'PAN_CARD', 'COMPANY_REGISTRATION', 'AADHAAR_CARD', 'EXPORT_LICENSE', 'TRADE_LICENSE']
const COMPLIANCE_DOC_TYPES = ['FACTORY_LICENSE', 'POLLUTION_CERTIFICATE', 'FIRE_SAFETY_CERTIFICATE']
const BANK_DOC_TYPES      = ['BANK_STATEMENT', 'AUDITED_FINANCIALS']
const ALL_KNOWN_TYPES     = new Set([...COMPANY_DOC_TYPES, ...COMPLIANCE_DOC_TYPES, ...BANK_DOC_TYPES, 'OTHER'])

function docTypeLabel(type: string): string {
  return DOC_TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function DocFileIcon({ name }: { name?: string }) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || ''
  if (ext === 'pdf') return (
    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-red-50 border border-red-100">
      <FileText className="w-5 h-5 text-red-500" />
    </div>
  )
  if (['doc', 'docx'].includes(ext)) return (
    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-blue-50 border border-blue-100">
      <FileText className="w-5 h-5 text-blue-500" />
    </div>
  )
  if (['xls', 'xlsx'].includes(ext)) return (
    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-green-50 border border-green-100">
      <FileText className="w-5 h-5 text-green-600" />
    </div>
  )
  return (
    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-slate-50 border border-slate-200">
      <FileText className="w-5 h-5 text-slate-400" />
    </div>
  )
}

function DocFileCard({ doc, docLabel, onView }: { doc: any; docLabel?: string; onView?: (url: string, name: string) => void }) {
  const label    = docLabel || docTypeLabel(doc.type || '')
  const fileName = doc.name || 'Document'
  const date     = doc.createdAt || doc.uploadDate

  return (
    <div className="flex items-center gap-3 p-3 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 transition-colors">
      <DocFileIcon name={fileName} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-900 truncate">{label}</p>
        <p className="text-xs text-slate-500 truncate">{fileName}</p>
        {date && (
          <p className="text-xs text-slate-400">
            {new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        )}
      </div>
      {doc.documentUrl && (
        <div className="flex gap-1.5 shrink-0">
          {onView && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onView(doc.documentUrl, fileName)}
              className="h-7 px-2.5 text-xs text-slate-500 hover:text-slate-800 hover:bg-slate-100"
            >
              <Eye className="w-3 h-3 mr-1" />
              View
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => downloadDoc(doc.documentUrl, fileName)}
            className="h-7 px-2.5 text-xs text-slate-500 hover:text-slate-800 hover:bg-slate-100 shrink-0"
          >
            <Download className="w-3 h-3 mr-1" />
            Download
          </Button>
        </div>
      )}
    </div>
  )
}

/** Same IFSC rule the vendor portal and the backend enforce. */
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/

/**
 * Admin bank-details form — mirrors the vendor portal's own form
 * (VendorDashboard/Settings/BankDetails) so both capture identical fields.
 */
function BankDetailsFormModal({
  vendorId,
  existing,
  businessType,
  companyName,
  onClose,
  onSaved,
}: {
  vendorId: string
  existing?: any
  businessType?: string
  companyName?: string
  onClose: () => void
  onSaved: (saved: any) => void
}) {
  // Registered vendors (any businessType other than "unregistered") are locked
  // to a Current Account; only unregistered vendors may choose Savings or Current.
  const isUnregistered = String(businessType || '').toLowerCase() === 'unregistered'
  const [form, setForm] = useState({
    accountHolderName: existing?.accountHolderName || '',
    bankName: existing?.bankName || '',
    accountNumber: existing?.accountNumber || '',
    // A legacy row may hold the IFSC in the SWIFT column — surface it here so
    // the admin can save it back into the correct field.
    ifscCode: existing?.ifscCode || (IFSC_REGEX.test(String(existing?.swiftCode || '')) ? existing.swiftCode : '') || '',
    // Registered vendor with no saved type defaults to Current.
    accountType: (existing?.accountType || (isUnregistered ? 'savings' : 'current')).toLowerCase(),
    // Editable for admins; defaults to the vendor's registered company name.
    legalEntity: existing?.legalEntity || companyName || '',
    branchName: existing?.branchName || '',
    branchAddress: existing?.branchAddress || '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState('')

  const set = (k: string, v: string) => {
    setForm(prev => ({ ...prev, [k]: v }))
    setErrors(prev => ({ ...prev, [k]: '' }))
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.accountHolderName.trim()) e.accountHolderName = 'Account holder name is required'
    if (!form.bankName.trim()) e.bankName = 'Bank name is required'
    if (!form.accountNumber.trim()) e.accountNumber = 'Account number is required'
    if (!form.ifscCode.trim()) e.ifscCode = 'IFSC code is required'
    else if (!IFSC_REGEX.test(form.ifscCode.toUpperCase())) e.ifscCode = 'Invalid IFSC code format (e.g. HDFC0001234)'
    if (!form.accountType) e.accountType = 'Account type is required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSave = async () => {
    if (!validate()) return
    setSaving(true)
    setApiError('')
    try {
      const res = await VendorService.upsertVendorBankDetailsByAdmin(vendorId, {
        ...form,
        // Registered vendors are locked to a Current Account.
        accountType: isUnregistered ? form.accountType : 'current',
        ifscCode: form.ifscCode.toUpperCase(),
      })
      onSaved(res.bankDetails)
      onClose()
    } catch (err: any) {
      setApiError(err?.response?.data?.error || err?.message || 'Failed to save bank details')
    } finally {
      setSaving(false)
    }
  }

  const field = (name: string, label: string, opts: { required?: boolean; placeholder?: string; mono?: boolean } = {}) => (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label} {opts.required && <span className="text-brand-500">*</span>}
      </label>
      <input
        type="text"
        value={(form as any)[name]}
        onChange={e => set(name, e.target.value)}
        placeholder={opts.placeholder}
        className={`w-full px-3 py-2 border rounded-lg text-sm outline-none transition-colors ${opts.mono ? 'font-mono' : ''} ${
          errors[name] ? 'border-red-400 focus:ring-2 focus:ring-red-200' : 'border-slate-300 focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500'
        }`}
      />
      {errors[name] && <p className="text-xs text-red-600 mt-1">{errors[name]}</p>}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-brand-500" />
            {existing ? 'Edit Bank Details' : 'Add Bank Details'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {apiError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{apiError}</div>
          )}

          {existing?.isVerified && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              These details are currently verified. Changing the account number, IFSC or holder name will reset them to unverified.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Legal Entity — editable for admins; defaults to the company name. */}
            <div className="md:col-span-2">
              {field('legalEntity', 'Legal Entity', { placeholder: 'Registered company / legal entity name' })}
              <p className="-mt-0.5 text-xs text-slate-400">Defaults to the vendor&apos;s registered company name.</p>
            </div>
            {field('accountHolderName', 'Account Holder Name', { required: true, placeholder: 'As printed on the passbook' })}
            {field('bankName', 'Bank Name', { required: true, placeholder: 'e.g. ICICI Bank' })}
            {field('accountNumber', 'Account Number', { required: true, mono: true })}
            {field('ifscCode', 'IFSC Code', { required: true, mono: true, placeholder: 'HDFC0001234' })}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Account Type <span className="text-brand-500">*</span>
              </label>
              <Dropdown
                value={form.accountType}
                onChange={(v) => set('accountType', String(v))}
                placeholder="Select account type"
                options={
                  isUnregistered
                    ? [
                        { value: 'savings', label: 'Savings Account' },
                        { value: 'current', label: 'Current Account' },
                      ]
                    : [{ value: 'current', label: 'Current Account' }]
                }
              />
              {!isUnregistered && (
                <p className="mt-1 text-xs text-slate-400">Registered vendors must use a Current Account.</p>
              )}
              {errors.accountType && <p className="text-xs text-red-600 mt-1">{errors.accountType}</p>}
            </div>

            {field('branchName', 'Branch Name', { placeholder: 'e.g. Anna Nagar' })}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Branch Address</label>
            <textarea
              value={form.branchAddress}
              onChange={e => set('branchAddress', e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50 rounded-b-2xl sticky bottom-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-brand-500 hover:bg-brand-600 text-white">
            {saving ? 'Saving...' : existing ? 'Save Changes' : 'Add Bank Details'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function BankDetailsTab({ vendor, onVerify, loading, onBankSaved }: { vendor: VendorProfile, onVerify?: () => void, loading?: boolean, onBankSaved?: (b: any) => void }) {
  // Check if bank details strictly exist either as an object or as a nested object
  // Based on the VendorProfile interface, it's bankDetails?: any
  // But often it might be nested or direct properties

  const bankDetails = vendor.bankDetails
  const [showForm, setShowForm] = useState(false)
  const canEdit = hasPermission('vendor_management:edit')

  // Penny-drop verification handshake state.
  const [sendModalOpen, setSendModalOpen] = useState(false)
  const [sendNote, setSendNote] = useState('')
  const [sendBusy, setSendBusy] = useState(false)

  const doSendAmount = async () => {
    try {
      setSendBusy(true)
      const res = await VendorService.sendBankVerificationAmount(vendor.id, sendNote.trim() || undefined)
      onBankSaved?.(res.bankDetails)
      showSuccessToast('Verification amount marked as sent', 'The vendor has been asked to confirm receipt.')
      setSendModalOpen(false)
      setSendNote('')
    } catch (e: any) {
      showErrorToast('Failed', e?.response?.data?.error || e?.message || 'Could not update.')
    } finally {
      setSendBusy(false)
    }
  }

  const formModal = showForm ? (
    <BankDetailsFormModal
      vendorId={vendor.id}
      existing={bankDetails}
      businessType={(vendor as any).businessType}
      companyName={vendor.companyName}
      onClose={() => setShowForm(false)}
      onSaved={saved => onBankSaved?.(saved)}
    />
  ) : null

  if (!bankDetails) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center space-x-2">
                <CreditCard className="h-5 w-5" />
                <span>Bank Information</span>
              </span>
              {canEdit && (
                <Button size="sm" onClick={() => setShowForm(true)} className="bg-brand-500 hover:bg-brand-600 text-white">
                  <Plus className="h-4 w-4 mr-1.5" /> Add Bank Details
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-slate-500">
              <CreditCard className="h-12 w-12 mx-auto mb-3 text-slate-300" />
              <p>No bank details available for this vendor.</p>
            </div>
          </CardContent>
        </Card>
        {formModal}
      </>
    )
  }

  return (
    <>
    {formModal}
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500/10 text-brand-600">
              <CreditCard className="h-5 w-5" />
            </span>
            <span>Bank Information</span>
          </span>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
              <Edit className="h-4 w-4 mr-1.5" /> Edit
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/*
          Every field the vendor can submit (Vendor Portal → Settings → Bank
          Details) is rendered unconditionally. Previously the optional ones
          (IFSC, account type, branch) were hidden when empty, so a partially
          captured vendor looked identical to a fully captured one and admins
          couldn't tell "not provided" from "not displayed".
        */}
        {(() => {
          // Styled field cell — icon chip + uppercase label + value, matching the
          // app's card UI. Falls back to a muted "Not provided" when empty.
          const Field = ({ icon: Icon, label, value, mono = false, hint }: { icon: any; label: string; value?: string | null; mono?: boolean; hint?: string }) => (
            <div className="flex items-start gap-3 rounded-xl border border-slate-200/70 bg-slate-50/50 p-3.5 transition-colors hover:bg-slate-50">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                {value ? (
                  <p className={`mt-0.5 text-sm font-semibold text-slate-800 break-words ${mono ? 'font-mono tracking-tight' : ''}`}>{value}</p>
                ) : (
                  <p className="mt-0.5 text-sm font-medium italic text-slate-400">Not provided</p>
                )}
                {hint && value && <p className="mt-1 text-[11px] text-amber-600">{hint}</p>}
              </div>
            </div>
          );

          // SWIFT/BIC and IBAN are not displayed: nothing collects them anymore
          // (the vendor portal and the admin bank modal both capture IFSC only),
          // so they were permanently "Not provided".
          //
          // The swiftCode column is still read here for one reason: legacy rows
          // captured an Indian IFSC in it (the older banking form only offered
          // SWIFT/IBAN). Surface that value under IFSC — flagged — instead of
          // losing it now that the SWIFT field is gone.
          const looksLikeIfsc = (v?: string | null) => !!v && /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v.trim());
          const swiftIsActuallyIfsc = looksLikeIfsc(bankDetails.swiftCode) && !bankDetails.ifscCode;

          const SectionLabel = ({ children }: { children: React.ReactNode }) => (
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">{children}</p>
          );

          return (
            <div className="space-y-6">
              {/* Account */}
              <div>
                <SectionLabel>Account</SectionLabel>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field icon={Building2} label="Legal Entity" value={(bankDetails as any).legalEntity} />
                  <Field icon={User} label="Account Holder Name" value={bankDetails.accountHolderName} />
                  <Field icon={Landmark} label="Bank Name" value={bankDetails.bankName} />
                  <Field icon={Hash} label="Account Number" value={bankDetails.accountNumber} mono />
                  <Field icon={Wallet} label="Account Type" value={bankDetails.accountType} />
                  <Field
                    icon={BadgeCheck}
                    label="IFSC Code"
                    value={bankDetails.ifscCode || (swiftIsActuallyIfsc ? bankDetails.swiftCode : null)}
                    mono
                    hint={swiftIsActuallyIfsc ? 'Recorded in the SWIFT field on an older form — verify before payout.' : undefined}
                  />
                </div>
              </div>

              {/* Branch */}
              <div>
                <SectionLabel>Branch</SectionLabel>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field icon={MapPin} label="Branch Name" value={bankDetails.branchName} />
                  <Field icon={MapPin} label="Branch Address" value={bankDetails.branchAddress} />
                </div>
              </div>
            </div>
          );
        })()}

        {bankDetails.isVerified !== undefined && (
          <div className="mt-6">
            {(() => {
              const status: string = bankDetails.isVerified ? 'VERIFIED' : (bankDetails.verificationStatus || 'PENDING')
              const canManage = hasPermission('vendor_management:edit')
              // Per-status banner theme + icon.
              const theme = {
                VERIFIED:     { box: 'border-green-200 bg-green-50/60',    chip: 'bg-green-100 text-green-700',     Icon: BadgeCheck,   badge: 'bg-green-100 text-green-700 border border-green-200',     label: 'Verified' },
                AMOUNT_SENT:  { box: 'border-blue-200 bg-blue-50/60',      chip: 'bg-blue-100 text-blue-700',       Icon: Send,         badge: 'bg-blue-100 text-blue-700 border border-blue-200',       label: 'Amount sent — awaiting vendor' },
                RECEIVED:     { box: 'border-emerald-200 bg-emerald-50/60',chip: 'bg-emerald-100 text-emerald-700', Icon: CheckCircle,  badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200', label: 'Vendor confirmed receipt' },
                NOT_RECEIVED: { box: 'border-red-200 bg-red-50/60',        chip: 'bg-red-100 text-red-700',         Icon: AlertTriangle, badge: 'bg-red-100 text-red-700 border border-red-200',           label: 'Vendor did not receive' },
                PENDING:      { box: 'border-amber-200 bg-amber-50/60',    chip: 'bg-amber-100 text-amber-700',     Icon: ShieldCheck,  badge: 'bg-amber-100 text-amber-700 border border-amber-200',     label: 'Pending — send verification amount' },
              }[status] || { box: 'border-amber-200 bg-amber-50/60', chip: 'bg-amber-100 text-amber-700', Icon: ShieldCheck, badge: 'bg-amber-100 text-amber-700 border border-amber-200', label: 'Pending' }
              const BannerIcon = theme.Icon
              return (
                <div className={`rounded-xl border p-4 ${theme.box}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${theme.chip}`}>
                        <BannerIcon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Verification Status</span>
                          <Badge className={theme.badge}>{theme.label}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-slate-600 max-w-xl">
                          {status === 'PENDING' && 'Send a small test amount to the vendor’s account, then ask them to confirm receipt before approving.'}
                          {status === 'AMOUNT_SENT' && `Waiting for the vendor to confirm they received the amount${bankDetails.amountSentAt ? ` (sent ${new Date(bankDetails.amountSentAt).toLocaleString()})` : ''}.`}
                          {status === 'RECEIVED' && 'The vendor confirmed receipt. You can now approve the bank details.'}
                          {status === 'NOT_RECEIVED' && 'The vendor reported they did not receive the amount. Recheck and resend.'}
                          {status === 'VERIFIED' && (bankDetails.verifiedAt ? `Verified on ${new Date(bankDetails.verifiedAt).toLocaleDateString()}.` : 'These bank details have been verified.')}
                        </p>
                        {bankDetails.verificationNote && status !== 'VERIFIED' && (
                          <p className="mt-1 text-xs text-slate-400">Your note: {bankDetails.verificationNote}</p>
                        )}
                        {status === 'NOT_RECEIVED' && (bankDetails as any).vendorNote && (
                          <p className="mt-1 text-xs text-red-500">Vendor&apos;s note: {(bankDetails as any).vendorNote}</p>
                        )}
                      </div>
                    </div>
                    {canManage && status !== 'VERIFIED' && (
                      <div className="flex items-center gap-2 shrink-0">
                        {(status === 'PENDING' || status === 'NOT_RECEIVED' || status === 'AMOUNT_SENT') && (
                          <Button size="sm" onClick={() => setSendModalOpen(true)} disabled={sendBusy}
                            className="bg-brand-500 hover:bg-brand-600 text-white">
                            <Send className="h-3.5 w-3.5 mr-1.5" />
                            {status === 'AMOUNT_SENT' ? 'Resend Amount' : status === 'NOT_RECEIVED' ? 'Resend Amount' : 'Send Verification Amount'}
                          </Button>
                        )}
                        {status === 'RECEIVED' && onVerify && (
                          <Button size="sm" onClick={onVerify} disabled={loading}
                            className="bg-green-600 hover:bg-green-700 text-white">
                            {loading ? <LoadingSpinner size="sm" /> : <><CheckCircle className="h-3.5 w-3.5 mr-1.5" /> Approve Bank Details</>}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        )}
      </CardContent>
    </Card>

    {/* Send verification amount modal */}
    {sendModalOpen && (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onClick={() => !sendBusy && setSendModalOpen(false)}>
        <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2"><CreditCard className="h-5 w-5 text-brand-500" /> Send Verification Amount</h3>
            <button onClick={() => !sendBusy && setSendModalOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X className="h-5 w-5" /></button>
          </div>
          <div className="px-6 py-5 space-y-3">
            <p className="text-sm text-slate-600">Confirm that you’ve sent a small test amount to the vendor’s bank account. They’ll be notified to confirm receipt.</p>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Note <span className="text-slate-400 font-normal">(optional — e.g. amount / UTR ref)</span></label>
              <input value={sendNote} onChange={e => setSendNote(e.target.value)} placeholder="₹1 sent · UTR 123456789"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500" />
            </div>
          </div>
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50 rounded-b-2xl">
            <Button variant="outline" onClick={() => setSendModalOpen(false)} disabled={sendBusy}>Cancel</Button>
            <Button onClick={doSendAmount} disabled={sendBusy} className="bg-brand-500 hover:bg-brand-600 text-white">
              {sendBusy ? 'Sending…' : 'Confirm Sent'}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function ContactTradeTab({ vendor }: { vendor: VendorProfile }) {
  return (
    <div className="space-y-6">
      {/* Main Contact */}
      {vendor.mainContact && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <User className="h-5 w-5" />
              <span>Main Contact Person</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6">
              {/* Contact Person Photo */}
              {vendor.mainContact.photo && (
                <div className="shrink-0">
                  <img
                    src={vendor.mainContact.photo}
                    alt={vendor.mainContact.name || 'Contact'}
                    onClick={() => openDoc(vendor.mainContact.photo, vendor.mainContact.name || 'Contact Person', true)}
                    title="View full photo"
                    className="w-20 h-20 rounded-full object-cover border-2 border-slate-200 cursor-zoom-in transition hover:ring-2 hover:ring-[#e01a1b]/40"
                  />
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
              <div>
                <p className="text-sm text-slate-500">Full Name</p>
                <p className="font-medium">{buildFullName((vendor.mainContact as any).title, (vendor.mainContact as any).firstName, (vendor.mainContact as any).middleName, (vendor.mainContact as any).lastName, vendor.mainContact.name) || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500">Designation</p>
                <p className="font-medium capitalize">{vendor.mainContact.designation || 'N/A'}</p>
              </div>
              {vendor.mainContact.designation === 'Others' && (vendor.mainContact as any).customDesignation && (
                <div>
                  <p className="text-sm text-slate-500">Custom Designation</p>
                  <p className="font-medium">{(vendor.mainContact as any).customDesignation}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-slate-500">Primary Email</p>
                <p className="font-medium">{vendor.mainContact.email1 || vendor.mainContact.email || 'N/A'}</p>
              </div>
              {vendor.mainContact.email2 && (
                <div>
                  <p className="text-sm text-slate-500">Secondary Email</p>
                  <p className="font-medium">{vendor.mainContact.email2}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-slate-500">Primary Phone</p>
                <p className="font-medium">{vendor.mainContact.phone1 || vendor.mainContact.phone || 'N/A'}</p>
              </div>
              {vendor.mainContact.phone2 && (
                <div>
                  <p className="text-sm text-slate-500">Secondary Phone</p>
                  <p className="font-medium">{vendor.mainContact.phone2}</p>
                </div>
              )}
              {(() => {
                const ll = getLandlineDisplay(vendor.mainContact as any);
                return (
                  <>
                    {ll.local && (
                      <div>
                        <p className="text-sm text-slate-500">Local Landline Number</p>
                        <p className="font-medium">{ll.local}</p>
                      </div>
                    )}
                    {ll.intl && (
                      <div>
                        <p className="text-sm text-slate-500">International Landline Number</p>
                        <p className="font-medium">{ll.intl}</p>
                      </div>
                    )}
                    {!ll.hasNew && ll.legacy && (
                      <div>
                        <p className="text-sm text-slate-500">Local Landline Number</p>
                        <p className="font-medium">{ll.legacy}</p>
                      </div>
                    )}
                  </>
                );
              })()}
              <div>
                <p className="text-sm text-slate-500">Department</p>
                <p className="font-medium capitalize">{vendor.mainContact.department || 'N/A'}</p>
              </div>
              {vendor.mainContact.department === 'Others' && (vendor.mainContact as any).customDepartment && (
                <div>
                  <p className="text-sm text-slate-500">Custom Department</p>
                  <p className="font-medium">{(vendor.mainContact as any).customDepartment}</p>
                </div>
              )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alternate Contacts */}
      {vendor.alternateContacts && vendor.alternateContacts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Mail className="h-5 w-5" />
              <span>Additional Contact Persons</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {vendor.alternateContacts.map((contact: any, index: number) => (
                <div key={index} className="border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center gap-3 mb-4">
                    {contact.photo && (
                      <Image src={contact.photo} alt={contact.name || 'Contact'} width={40} height={40} onClick={() => openDoc(contact.photo, contact.name || `Contact Person ${index + 2}`, true)} title="View full photo" className="w-10 h-10 rounded-full object-cover border border-slate-200 shrink-0 cursor-zoom-in transition hover:ring-2 hover:ring-[#e01a1b]/40" />
                    )}
                    <h4 className="font-medium text-slate-900">Contact Person {index + 2}</h4>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-slate-500">Full Name</p>
                      <p className="font-medium">{buildFullName(contact.title, contact.firstName, contact.middleName, contact.lastName, contact.name) || 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500">Designation</p>
                      <p className="font-medium capitalize">{contact.designation || 'N/A'}</p>
                    </div>
                    {contact.designation === 'Others' && contact.customDesignation && (
                      <div>
                        <p className="text-sm text-slate-500">Custom Designation</p>
                        <p className="font-medium">{contact.customDesignation}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-sm text-slate-500">Primary Email</p>
                      <p className="font-medium">{contact.email1 || contact.email || 'N/A'}</p>
                    </div>
                    {contact.email2 && (
                      <div>
                        <p className="text-sm text-slate-500">Secondary Email</p>
                        <p className="font-medium">{contact.email2}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-sm text-slate-500">Primary Phone</p>
                      <p className="font-medium">{contact.phone1 || contact.phone || 'N/A'}</p>
                    </div>
                    {contact.phone2 && (
                      <div>
                        <p className="text-sm text-slate-500">Secondary Phone</p>
                        <p className="font-medium">{contact.phone2}</p>
                      </div>
                    )}
                    {(contact.localLandline || contact.landline) && (
                      <div>
                        <p className="text-sm text-slate-500">Local Landline Number</p>
                        <p className="font-medium">{formatLocalLandline({ countryCode: '+91', std: contact.localLandlineStd, number: contact.localLandline || contact.landline })}</p>
                      </div>
                    )}
                    {(() => {
                      const intlLL = formatIntlLandline(contact.intlLandline);
                      return intlLL ? (
                        <div>
                          <p className="text-sm text-slate-500">International Landline Number</p>
                          <p className="font-medium">{intlLL}</p>
                        </div>
                      ) : null;
                    })()}
                    <div>
                      <p className="text-sm text-slate-500">Department</p>
                      <p className="font-medium capitalize">{contact.department || 'N/A'}</p>
                    </div>
                    {contact.department === 'Others' && contact.customDepartment && (
                      <div>
                        <p className="text-sm text-slate-500">Custom Department</p>
                        <p className="font-medium">{contact.customDepartment}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Import / Export — split flags + country lists */}
      {((vendor as any).hasImportExport === 'yes' ||
        (vendor as any).importExperience ||
        (vendor as any).exportExperience ||
        ((vendor as any).importCountries?.length > 0) ||
        ((vendor as any).exportCountries?.length > 0)) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Globe className="h-5 w-5" />
              <span>Import &amp; Export</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-sm text-slate-500 mb-1">Import Countries</p>
                <p className="font-medium">{(vendor as any).importExperience ? 'Yes' : 'No'}</p>
                {Array.isArray((vendor as any).importCountries) && (vendor as any).importCountries.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-slate-500 mb-1">Import Countries</p>
                    <div className="flex flex-wrap gap-1.5">
                      {withFlags((vendor as any).importCountries).map((c) => (
                        <Badge key={c.label} className="bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1.5">
                          {c.flagIso && <img src={`https://flagcdn.com/w20/${c.flagIso.toLowerCase()}.png`} alt="" className="w-4 h-auto rounded-[2px] shrink-0" loading="lazy" />}
                          {c.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <p className="text-sm text-slate-500 mb-1">Export Countries</p>
                <p className="font-medium">{(vendor as any).exportExperience ? 'Yes' : 'No'}</p>
                {Array.isArray((vendor as any).exportCountries) && (vendor as any).exportCountries.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-slate-500 mb-1">Export Countries</p>
                    <div className="flex flex-wrap gap-1.5">
                      {withFlags((vendor as any).exportCountries).map((c) => (
                        <Badge key={c.label} className="bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1.5">
                          {c.flagIso && <img src={`https://flagcdn.com/w20/${c.flagIso.toLowerCase()}.png`} alt="" className="w-4 h-auto rounded-[2px] shrink-0" loading="lazy" />}
                          {c.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface ReviewItem {
  id: string
  orderId: string
  productName: string
  productSKU: string
  productImage: string
  reviewedDate: string
  status: 'approved' | 'rejected'
  rating: number
  reviewComments: string
  qualityCheckNotes: string
  rejectionReason?: string
  returnToVendor: boolean
  customerName: string
  orderDate: string
  totalAmount: number
  // Carried from the parent Order: order items are priced in whatever currency the
  // buyer was charged, so the amount cannot be rendered as ₹ unconditionally.
  currency?: 'INR' | 'USD'
  exchangeRate?: number | null
  quantity: number
}

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

function ReviewsTab({ vendor }: { vendor: VendorProfile }) {
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 10, totalPages: 0 })
  const [stats, setStats] = useState({ total: 0, approved: 0, rejected: 0 })
  const [ratingDistribution, setRatingDistribution] = useState<Record<number, number>>({})
  const [selectedReview, setSelectedReview] = useState<ReviewItem | null>(null)

  const fetchReviews = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) setInitialLoading(true)

      const response = await adminReviewService.getAllAdminReviews({
        vendorId: vendor.id,
        search: searchTerm || undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        page: currentPage,
        limit: 10,
      })

      if (response.success) {
        const transformed: ReviewItem[] = []
        response.data.forEach((adminReview: AdminOrderReview) => {
          const order = adminReview.order
          if (!order) return
          order.items.forEach((item) => {
            transformed.push({
              id: `${adminReview.id}_${item.id}`,
              orderId: order.orderId,
              productName: item.productName,
              productSKU: item.sku,
              productImage: item.productImage || '',
              reviewedDate: adminReview.reviewedAt || adminReview.createdAt,
              status: adminReview.approved ? 'approved' : 'rejected',
              rating: adminReview.rating || 0,
              reviewComments: adminReview.reviewComments || '',
              qualityCheckNotes: adminReview.qualityCheckNotes || '',
              rejectionReason: adminReview.rejectionReason || undefined,
              returnToVendor: adminReview.returnToVendor,
              customerName: order.customerName,
              orderDate: order.orderDate,
              totalAmount: item.totalPrice,
              currency: order.currency,
              exchangeRate: order.exchangeRate,
              quantity: item.quantity,
            })
          })
        })
        setReviews(transformed)
        setStats(response.stats)
        setPagination(response.pagination)
        if (response.ratingDistribution) {
          setRatingDistribution(response.ratingDistribution)
        }
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load reviews', variant: 'destructive' })
    } finally {
      setInitialLoading(false)
    }
  }, [vendor.id, searchTerm, statusFilter, currentPage])

  const isFirstLoad = useRef(true)

  useEffect(() => {
    if (isFirstLoad.current) {
      isFirstLoad.current = false
      fetchReviews(true)
    } else {
      fetchReviews(false)
    }
  }, [fetchReviews])

  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, statusFilter])

  const renderStars = (rating: number) => (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`h-4 w-4 ${star <= rating ? 'fill-yellow-400 text-yellow-400' : 'text-slate-300'}`}
        />
      ))}
    </div>
  )

  const maxDistCount = Math.max(...Object.values(ratingDistribution), 1)

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Star className="h-5 w-5 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Overall Rating</p>
                <p className="text-2xl font-bold text-slate-900">
                  {vendor.rating != null ? vendor.rating.toFixed(1) : 'N/A'}
                </p>
                <p className="text-xs text-slate-500">
                  Based on {vendor.ratingCount ?? 0} review{(vendor.ratingCount ?? 0) !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <button
          type="button"
          onClick={() => setStatusFilter('all')}
          className="text-left rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-brand-400 transition-all"
        >
          <div className="p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${statusFilter === 'all' ? 'bg-brand-100' : 'bg-slate-100'}`}>
                <MessageSquare className={`h-5 w-5 ${statusFilter === 'all' ? 'text-brand-600' : 'text-slate-500'}`} />
              </div>
              <div>
                <p className="text-sm text-slate-500">Total Reviews</p>
                <p className={`text-2xl font-bold ${statusFilter === 'all' ? 'text-brand-600' : 'text-slate-900'}`}>{stats.total}</p>
              </div>
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'approved' ? 'all' : 'approved')}
          className="text-left rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-green-300 transition-all"
        >
          <div className="p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${statusFilter === 'approved' ? 'bg-green-200' : 'bg-green-100'}`}>
                <CheckCircle className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Approved</p>
                <p className="text-2xl font-bold text-green-600">{stats.approved}</p>
              </div>
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'rejected' ? 'all' : 'rejected')}
          className="text-left rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-red-300 transition-all"
        >
          <div className="p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${statusFilter === 'rejected' ? 'bg-red-200' : 'bg-red-100'}`}>
                <XCircle className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Rejected</p>
                <p className="text-2xl font-bold text-red-600">{stats.rejected}</p>
              </div>
            </div>
          </div>
        </button>
      </div>

      {/* Rating Distribution */}
      {vendor.ratingCount != null && vendor.ratingCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rating Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = ratingDistribution[star] || 0
                const pct = maxDistCount > 0 ? (count / maxDistCount) * 100 : 0
                return (
                  <div key={star} className="flex items-center gap-3">
                    <span className="text-sm text-slate-500 w-12">{star} star</span>
                    <div className="flex-1 h-3 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-yellow-400 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-sm text-slate-500 w-8 text-right">{count}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-5 w-5" />
          <input
            type="text"
            placeholder="Search by order ID, product name, or comments..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-9 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-brand-500 bg-white transition-colors"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-500"
            >
              <XCircle className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="w-full md:w-48">
          <Dropdown
            value={statusFilter}
            options={[
              { value: 'all', label: 'All Status' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
            ]}
            onChange={(val) => setStatusFilter(val as string)}
            placeholder="Filter by status"
          />
        </div>
      </div>

      {/* Reviews Table */}
      <Card>
        {initialLoading ? (
          <div className="p-4 space-y-4">
            {/* Skeleton table header */}
            <div className="grid grid-cols-7 gap-4 pb-3 border-b border-slate-200">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-4 bg-slate-200 rounded animate-pulse" />
              ))}
            </div>
            {/* Skeleton table rows */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="grid grid-cols-7 gap-4 items-center py-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-slate-200 rounded animate-pulse" />
                  <div className="space-y-1.5 flex-1">
                    <div className="h-3.5 bg-slate-200 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-slate-100 rounded animate-pulse w-1/2" />
                  </div>
                </div>
                <div className="h-4 bg-slate-200 rounded animate-pulse" />
                <div className="h-4 bg-slate-200 rounded animate-pulse w-20" />
                <div className="h-5 bg-slate-200 rounded-full animate-pulse w-16" />
                <div className="space-y-1.5">
                  <div className="h-3.5 bg-slate-200 rounded animate-pulse" />
                  <div className="h-3 bg-slate-100 rounded animate-pulse w-2/3" />
                </div>
                <div className="h-4 bg-slate-200 rounded animate-pulse" />
                <div className="h-4 bg-slate-200 rounded animate-pulse w-12" />
              </div>
            ))}
          </div>
        ) : (
          <div>
          <Table>
            <TableHeader className="!bg-brand-500/[0.06] !border-0 [&_tr]:border-b [&_tr]:border-brand-100/50 [&_th]:!text-brand-500/60 [&_th]:font-bold [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:h-11">
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Order ID</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Comments</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reviews.length > 0 ? (
                reviews.map((review) => (
                  <TableRow key={review.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {review.productImage ? (
                          <img
                            src={review.productImage}
                            alt={review.productName}
                            className="w-10 h-10 object-cover rounded border border-slate-200"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          />
                        ) : (
                          <div className="w-10 h-10 bg-slate-100 rounded border border-slate-200 flex items-center justify-center">
                            <Package className="w-5 h-5 text-slate-400" />
                          </div>
                        )}
                        <div>
                          <div className="font-medium text-slate-900 text-sm">{review.productName}</div>
                          <div className="text-xs text-slate-500">SKU: {review.productSKU}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-mono text-slate-900">{review.orderId}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {renderStars(review.rating)}
                        <span className="text-sm text-slate-500">({review.rating})</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${review.status === 'approved' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                        {review.status === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-slate-900">{new Date(review.reviewedDate).toLocaleDateString()}</div>
                      <div className="text-xs text-slate-500">{new Date(review.reviewedDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm text-slate-700 max-w-[180px] truncate">
                        {review.reviewComments || 'No comments'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => setSelectedReview(review)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        <Eye className="h-4 w-4" />
                        View
                      </button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7}>
                    <div className="p-12 text-center">
                      <AlertCircle className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                      <p className="text-slate-500 text-lg font-medium mb-2">No reviews found</p>
                      <p className="text-slate-400 text-sm">
                        {searchTerm || statusFilter !== 'all'
                          ? 'Try adjusting your search or filter criteria.'
                          : 'Admin reviews will appear here after quality checks are completed.'}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      {!initialLoading && pagination.totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <div className="flex items-center gap-1">
            <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className="p-2 text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
            {getPageRange(pagination.page, pagination.totalPages).map((p, i) => p === '…' ? (<span key={`e-${i}`} className="px-2 text-slate-400">…</span>) : (<button key={`p-${p}`} onClick={() => setCurrentPage(p as number)} aria-current={p === pagination.page ? 'page' : undefined} className={`min-w-9 h-9 px-2 rounded-lg text-sm font-medium transition-colors ${p === pagination.page ? 'bg-brand-500 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>{p}</button>))}
            <button onClick={() => setCurrentPage((p) => Math.min(pagination.totalPages, p + 1))} disabled={currentPage === pagination.totalPages} className="p-2 text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {selectedReview && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200">
              <div className="flex justify-between items-start">
                <div className="flex items-start gap-4">
                  {selectedReview.productImage ? (
                    <img
                      src={selectedReview.productImage}
                      alt={selectedReview.productName}
                      className="w-20 h-20 object-cover rounded-lg border border-slate-200"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-20 h-20 bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-center">
                      <Package className="w-8 h-8 text-slate-400" />
                    </div>
                  )}
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">{selectedReview.productName}</h2>
                    <p className="text-sm text-slate-500 mt-1">SKU: {selectedReview.productSKU}</p>
                    <p className="text-sm text-slate-500">Order ID: {selectedReview.orderId}</p>
                    <div className="mt-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${selectedReview.status === 'approved' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                        {selectedReview.status === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                    </div>
                  </div>
                </div>
                <button onClick={() => setSelectedReview(null)} className="text-slate-400 hover:text-slate-500 text-xl leading-none p-1">
                  ✕
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* Rating */}
              <div className="bg-slate-50 p-4 rounded-xl">
                <label className="text-sm font-semibold text-slate-700 block mb-2">Quality Rating</label>
                <div className="flex items-center gap-3">
                  {renderStars(selectedReview.rating)}
                  <span className="text-lg font-bold text-slate-900">{selectedReview.rating}/5</span>
                </div>
              </div>

              {/* Review Comments */}
              <div>
                <label className="text-sm font-semibold text-slate-700 block mb-2">Review Comments</label>
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-200">
                  <p className="text-slate-900">{selectedReview.reviewComments || 'No comments provided'}</p>
                </div>
              </div>

              {/* Quality Check Notes */}
              <div>
                <label className="text-sm font-semibold text-slate-700 block mb-2">Quality Check Notes</label>
                <div className="bg-green-50 p-4 rounded-xl border border-green-200">
                  <p className="text-slate-900">{selectedReview.qualityCheckNotes || 'No notes provided'}</p>
                </div>
              </div>

              {/* Rejection Reason */}
              {selectedReview.rejectionReason && (
                <div>
                  <label className="text-sm font-semibold text-red-700 block mb-2">Rejection Reason</label>
                  <div className="bg-red-50 p-4 rounded-xl border border-red-300">
                    <p className="text-red-900 font-medium">{selectedReview.rejectionReason}</p>
                  </div>
                </div>
              )}

              {/* Return to Vendor */}
              {selectedReview.returnToVendor && (
                <div className="flex items-center gap-2 bg-orange-50 p-3 rounded-xl border border-orange-200">
                  <AlertTriangle className="h-5 w-5 text-orange-600" />
                  <span className="text-sm font-medium text-orange-800">Marked for return to vendor</span>
                </div>
              )}

              {/* Order Details */}
              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-200">
                <div>
                  <label className="text-sm font-medium text-slate-500">Customer</label>
                  <p className="text-slate-900 font-medium">{selectedReview.customerName}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-500">Quantity</label>
                  <p className="text-slate-900">{selectedReview.quantity} units</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-500">Amount</label>
                  <p className="text-slate-900 font-medium">
                    {(() => {
                      const { charged, inrEquivalent } = formatOrderAmount(
                        selectedReview.totalAmount, selectedReview.currency, selectedReview.exchangeRate);
                      return (<>{charged}{inrEquivalent && (
                        <span className="block text-xs font-normal text-slate-500">&#8776; {inrEquivalent}</span>
                      )}</>);
                    })()}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-500">Order Date</label>
                  <p className="text-slate-900">{new Date(selectedReview.orderDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-500">Reviewed Date</label>
                  <p className="text-slate-900">{new Date(selectedReview.reviewedDate).toLocaleString()}</p>
                </div>
              </div>

              {/* Close Button */}
              <div className="flex justify-end pt-4 border-t border-slate-200">
                <button
                  onClick={() => setSelectedReview(null)}
                  className="px-6 py-2 bg-slate-600 text-white rounded-xl hover:bg-slate-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}