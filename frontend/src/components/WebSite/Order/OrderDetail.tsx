"use client"

// OrderDetail component for displaying individual order information
import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { FaceIcon } from '@/components/WebSite/Shared/FaceRating';
import {
  ArrowLeft,
  Package,
  Truck,
  CheckCircle,
  Calendar,
  MapPin,
  CreditCard,
  Eye,
  Plus,
  Minus,
  Download,
  MessageCircle,
  AlertCircle,
  Clock,
  ExternalLink,
  RotateCcw,
  ShoppingCart,
  RefreshCw,
  BadgePercent,
  ClipboardCheck
} from "lucide-react"
import { formatPrice } from '@/lib/currency'
import { orderGstRows } from '@/lib/gst'
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils'
import { courierService } from "@/services/courierService"
import { courierName, courierTrackingUrl } from "@/lib/couriers"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card"
import Reveal from "@/components/WebSite/Shared/Reveal"
import orderService, { Order as APIOrder } from "@/services/orderService"
import productService from "@/services/productService"
import ProductCard from "@/components/WebSite/ProductCard/ProductCard"
import ReviewModal from "./ReviewModal"
import ReturnRequestModal from "./ReturnRequestModal"
import reviewService from "@/services/reviewService"
import { getStateName, formatPhoneForDisplay } from "@/components/WebSite/CheckOut/CheckoutProcess/constants"

interface OrderDetailProps {
  orderId: string
}

// Helper to normalize status for display
const formatStatus = (status: string) => {
  return status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
}

// Helper to get normalized status for comparison
const getNormalizedStatus = (status: string) => {
  const s = status.toLowerCase()
  if (['dispatched', 'shipped', 'shipped_to_customer'].includes(s)) return 'shipped'
  if (['completed', 'delivered', 'received', 'returned'].includes(s)) return 'received'
  if (['failed', 'cancelled', 'rejected', 'rejected_by_admin_hub'].includes(s)) return 'cancelled'
  // Everything else (order_created, vendor_processing, packed_by_vendor,
  // in_transit_to_admin_hub, received_at_admin_hub, approved_by_admin_hub) → processing
  return 'processing'
}

// Helper to get status color class
const getStatusColorClass = (status: string) => {
  const normalized = getNormalizedStatus(status)
  switch (normalized) {
    case 'received': return 'bg-green-100 text-green-800'
    case 'shipped': return 'bg-[#e01a1b]/10 text-[#e01a1b]'
    case 'processing': return 'bg-yellow-100 text-yellow-800'
    case 'cancelled': return 'bg-red-100 text-red-800'
    default: return 'bg-slate-100 text-slate-800'
  }
}

// Helper to check status timeline steps
const isStatusReached = (orderStatus: string, step: string) => {
  const statusOrder = ['processing', 'shipped', 'received']
  const normalized = getNormalizedStatus(orderStatus)

  // If cancelled, don't show any progress
  if (normalized === 'cancelled') return false;

  // A placed order is always "confirmed" — that's the first, always-complete step.
  if (step === 'confirmed') return true;

  const currentIndex = statusOrder.indexOf(normalized)
  const stepIndex = statusOrder.indexOf(step)
  // If the status is unknown (like some admin status not mapped), fallback to current step = -1
  return currentIndex !== -1 && currentIndex >= stepIndex
}

const isStatusCurrent = (orderStatus: string, step: string) => {
  return getNormalizedStatus(orderStatus) === step
}

// "2026-08-17T14:09:00Z" → "17 Aug 2026, 2:09 PM". Returns null on bad input.
const formatDateTime = (iso?: string | null): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

// When a timeline step was reached: the earliest status-history entry that maps
// to that step. (We intentionally ignore the entries' internal `comment` text —
// those are system notes like "auto-computed to APPROVED_BY_ADMIN_HUB", not
// customer-facing places.)
const historyForStep = (
  history: any[] | undefined,
  step: 'processing' | 'shipped' | 'received',
): { reachedAt?: string } => {
  const matches = (history || [])
    .filter((h) => h?.status && getNormalizedStatus(String(h.status)) === step)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  if (matches.length === 0) return {}
  return { reachedAt: matches[0].timestamp }
}

// Preset reasons offered in the cancel / return modal ("Other" reveals a text box).
const CANCEL_REASONS = [
  'Changed my mind',
  'Ordered by mistake',
  'Found a better price elsewhere',
  'Delivery is taking too long',
  'Need to change address or details',
  'Other',
]
const RETURN_REASONS = [
  'Damaged or defective',
  'Wrong item received',
  'Not as described',
  'Size or fit issue',
  'Quality not satisfactory',
  'Other',
]

export default function OrderDetail({ orderId }: OrderDetailProps) {
  const router = useRouter()
  const [buyingAgain, setBuyingAgain] = useState(false)
  const [quantities, setQuantities] = useState<{ [key: number]: number }>({})
  const [orderDetails, setOrderDetails] = useState<APIOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewModalState, setReviewModalState] = useState<{ isOpen: boolean, orderId: string, items: any[] }>({ isOpen: false, orderId: '', items: [] })
  const [hasReviewed, setHasReviewed] = useState(false)
  const [similarProducts, setSimilarProducts] = useState<any[]>([])
  // Cancel confirmation modal (returns use the dedicated multi-step ReturnRequestModal below).
  const [actionModal, setActionModal] = useState<'cancel' | 'return' | null>(null)
  const [returnModalOpen, setReturnModalOpen] = useState(false)
  const [reasonChoice, setReasonChoice] = useState('')  // selected preset reason
  const [actionReason, setActionReason] = useState('')   // free text when "Other"
  const [actionSubmitting, setActionSubmitting] = useState(false)

  const submitAction = async () => {
    if (!actionModal || !orderDetails) return
    const type = actionModal
    // Final reason = the selected preset, or the free text when "Other".
    const finalReason = reasonChoice === 'Other' ? actionReason.trim() : reasonChoice
    if (type === 'return' && !finalReason) {
      showErrorToast('Reason required', reasonChoice === 'Other' ? 'Please describe the reason.' : 'Please select a reason for the return.')
      return
    }
    try {
      setActionSubmitting(true)
      if (type === 'cancel') {
        const res = await orderService.cancelOrder(orderDetails.id, finalReason || undefined)
        showSuccessToast('Order Cancelled', res.message || 'Your refund has been initiated.')
      } else {
        const res = await orderService.requestReturn(orderDetails.id, finalReason)
        showSuccessToast('Return Requested', res.message || 'We will review it shortly.')
      }
      setActionModal(null)
      setReasonChoice('')
      setActionReason('')
      fetchOrder()
    } catch (e: any) {
      showErrorToast('Failed', e?.message || 'Please try again.')
    } finally {
      setActionSubmitting(false)
    }
  }

  // "Buy Again": re-add this order's still-available items to the cart, then go
  // to the cart. Unavailable / out-of-stock lines are reported, not dropped silently.
  const handleBuyAgain = async () => {
    if (!orderDetails || buyingAgain) return
    try {
      setBuyingAgain(true)
      const res = await orderService.reorder(orderDetails.id)
      const { addedCount = 0, skippedCount = 0, skipped = [], itemCount = 0 } = res.data || ({} as any)
      if (addedCount > 0) {
        const reasons = skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')
        const skipNote = skippedCount > 0 ? ` ${skippedCount} item${skippedCount > 1 ? 's' : ''} couldn't be added (${reasons}).` : ''
        showSuccessToast('Added to Cart', `${res.message}.${skipNote}`)
        try { window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count: itemCount } })) } catch {}
        router.push('/cart')
      } else {
        const reasons = skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')
        showErrorToast('Nothing added', skippedCount > 0 ? `These items are currently unavailable (${reasons}).` : 'No items from this order could be added to your cart.')
      }
    } catch (e: any) {
      showErrorToast('Failed', e?.message || 'Could not add items to your cart. Please try again.')
    } finally {
      setBuyingAgain(false)
    }
  }

  // .com (USD) orders can't be returned — stash a pre-filled ticket so the
  // Support tab opens the compose form ready (same as the Order list screen).
  const stashSupportPrefill = () => {
    try {
      const items = (orderDetails?.items || []).map((i: any) => `${i.productName} x${i.quantity}`).join(', ')
      const ordered = orderDetails?.createdAt ? new Date(orderDetails.createdAt).toLocaleString('en-US', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : ''
      const description = [
        `Order: ${orderDetails?.orderId || ''}`,
        ordered ? `Ordered on: ${ordered}` : '',
        `Status: Delivered`,
        `Items: ${items}`,
        '',
        'I need help with this delivered order:',
        '',
      ].filter(Boolean).join('\n')
      sessionStorage.setItem('m2c_support_prefill', JSON.stringify({
        subject: `Help with order ${orderDetails?.orderId || ''}`.trim(),
        category: 'order',
        description,
      }))
    } catch { /* sessionStorage may be unavailable */ }
  }

  useEffect(() => {
    fetchOrder()
  }, [orderId])

  // Similar products — matched by the ordered items' category, deduped against the
  // products already in this order, with a best-seller fallback so the strip always
  // populates even when the category is sparse.
  useEffect(() => {
    if (!orderDetails?.items?.length) { setSimilarProducts([]); return }
    let cancelled = false
    const orderedIds = new Set(orderDetails.items.map((i) => String(i.productId)))
    ;(async () => {
      const seen = new Map<string, any>()
      const add = (items?: any[]) => {
        (items || []).forEach((p) => {
          const id = String(p.id)
          if (!orderedIds.has(id) && !seen.has(id)) seen.set(id, p)
        })
      }
      try {
        // Learn the category from the first ordered product, then pull that category.
        const first = await productService.getPublicProduct(String(orderDetails.items[0].productId)).catch(() => null)
        const category = first?.success ? first.data?.category : undefined
        if (category) {
          const r = await productService.getPublicProducts({ category, limit: 12, inStock: true })
          if (r.success) add(r.data?.items)
        }
        // Fallback so the strip isn't empty when the category is sparse or unknown.
        if (seen.size < 5) {
          const r = await productService.getPublicProducts({ sortBy: 'rating', sortOrder: 'desc', limit: 12, inStock: true })
          if (r.success) add(r.data?.items)
        }
        if (!cancelled) setSimilarProducts(Array.from(seen.values()).slice(0, 5))
      } catch {
        if (!cancelled) setSimilarProducts([])
      }
    })()
    return () => { cancelled = true }
  }, [orderDetails?.id])

  const fetchOrder = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await orderService.getOrderById(orderId)
      if (response.success) {
        setOrderDetails(response.data)
        // Check if user already reviewed
        const order = response.data
        if (getNormalizedStatus(order.status) === 'received' && order.items?.length > 0) {
          // "Done" only when every product is reviewed AND purchase-experience
          // feedback has been given for this order.
          const elig = await reviewService.getOrderReviewEligibility(order.id)
          const d = elig?.data
          if (d && d.products.every((p) => p.reviewed) && d.experienceReviewed) setHasReviewed(true)
        }
      } else {
        setError('Order not found')
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch order details')
    } finally {
      setLoading(false)
    }
  }

  const updateQuantity = (productId: number, change: number) => {
    setQuantities(prev => ({
      ...prev,
      [productId]: Math.max(1, (prev[productId] || 1) + change)
    }))
  }

  // Prime the courier registry so courierName()/courierTrackingUrl() resolve the
  // order's courier id to its name + tracking website.
  useEffect(() => {
    courierService.getActiveCouriers().catch(() => {})
  }, [])

  // "Track Order" deep-links to #order-status; the data loads async, so scroll to
  // the status timeline once it exists in the DOM.
  useEffect(() => {
    if (!orderDetails?.id || typeof window === 'undefined' || window.location.hash !== '#order-status') return;
    requestAnimationFrame(() => {
      document.getElementById('order-status')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [orderDetails?.id])

  const getQuantity = (productId: number) => quantities[productId] || 1

  const handleDownloadInvoice = async () => {
    if (!orderDetails?.id) return;
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
      const token = localStorage.getItem("userToken") || sessionStorage.getItem("userToken") || "";
      const response = await fetch(`${baseUrl}/orders/${orderDetails.id}/invoice`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Failed to generate invoice");
      const html = await response.text();
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 300);
      }
    } catch (err) {
      console.error(err);
      alert("Failed to generate invoice. Please try again later.");
    }
  };

  // Loading state
  if (loading) {
    /* Skeleton mirrors the order detail page (header + items list + totals). */
    return (
      <div className="min-h-screen bg-slate-50 py-8 font-sans">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 bg-gray-200 rounded animate-pulse" />
            <div className="h-7 w-48 bg-gray-200 rounded animate-pulse" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
                <div className="h-5 w-32 bg-gray-200 rounded animate-pulse" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-4 items-center pt-3">
                    <div className="w-20 h-20 bg-gray-200 rounded-lg animate-pulse shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/4 bg-gray-200 rounded animate-pulse" />
                      <div className="h-3 w-1/2 bg-gray-100 rounded animate-pulse" />
                    </div>
                    <div className="h-5 w-16 bg-gray-200 rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3 h-fit">
              <div className="h-5 w-28 bg-gray-200 rounded animate-pulse" />
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <div className="h-4 w-20 bg-gray-100 rounded animate-pulse" />
                  <div className="h-4 w-16 bg-gray-200 rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !orderDetails) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 font-sans">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Card className="border p-12 text-center">
            <CardContent>
              {error ? (
                <>
                  <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">Error Loading Order</h3>
                  <p className="text-slate-600 mb-6">{error}</p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={fetchOrder}
                      className="btn-shine bg-[#e01a1b] text-white px-6 py-3 rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300"
                    >
                      Try Again
                    </button>
                    <Link href="/order">
                      <button className="border border-slate-300 text-slate-700 px-6 py-3 rounded-full hover:border-[#e01a1b] hover:text-[#e01a1b] transition-colors">
                        Back to Orders
                      </button>
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <Package className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">Order Not Found</h3>
                  <p className="text-slate-600 mb-6">The order you&apos;re looking for doesn&apos;t exist or has been removed.</p>
                  <Link href="/order">
                    <button className="btn-shine bg-[#e01a1b] text-white px-6 py-3 rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">
                      Back to Orders
                    </button>
                  </Link>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // formatPrice() with no currency arg falls back to the REGION, not this order's
  // currency — so a USD order viewed on the .in site rendered as ₹. Bind the order's
  // own currency once and use it for every amount below.
  const money = (n: number) => formatPrice(n, orderDetails.currency === 'USD' ? 'USD' : 'INR')

  // Savings breakdown for the cart-style Order Summary. The stored order exposes
  // each line's pre-offer price (originalUnitPrice, set only when an offer applied),
  // so we can surface the offer discount alongside the coupon. Product-level MRP
  // isn't frozen per line, so "Subtotal" starts at the post-offer goods value.
  const round2 = (n: number) => Math.round(n * 100) / 100
  const offerDiscount = Math.max(0, round2(
    orderDetails.items.reduce((s, it) => {
      const orig = it.originalUnitPrice
      return s + (orig && orig > it.unitPrice ? (orig - it.unitPrice) * it.quantity : 0)
    }, 0)
  ))
  const couponDiscount = orderDetails.discount || 0
  const totalSavings = round2(offerDiscount + couponDiscount)
  const itemsSubtotal = round2(orderDetails.subtotal + offerDiscount)

  const normalizedStatus = getNormalizedStatus(orderDetails.status)
  const shippingAddr = orderDetails.shippingAddress || {}
  const cityState = (loc?: { city?: string | null; state?: string | null } | null) =>
    [loc?.city, loc?.state].filter(Boolean).join(', ')
  // Processing → vendor warehouse/factory; Shipped → admin hub; Received → customer address.
  const vendorPlace = cityState(orderDetails.vendorLocation)
  const hubPlace = cityState(orderDetails.hubLocation)
  const destination = [shippingAddr.city, shippingAddr.state].filter(Boolean).join(', ')

  // Build the 3-step timeline with a real date/time and a location/detail line
  // for each step, sourced from the order's status history.
  const timelineSteps = (() => {
    const proc = historyForStep(orderDetails.statusHistory, 'processing')
    const ship = historyForStep(orderDetails.statusHistory, 'shipped')
    const recv = historyForStep(orderDetails.statusHistory, 'received')
    return [
      {
        // Always-complete first step: the moment the customer placed the order.
        // No location here — just when it was confirmed.
        key: 'confirmed' as const,
        label: 'Order Confirmed',
        Icon: ClipboardCheck,
        activeBg: 'bg-blue-500',
        activeText: 'text-blue-600',
        lineNext: 'processing',
        at: formatDateTime(orderDetails.createdAt),
        detail: '',
      },
      {
        // Order assigned to the vendor to pack and hand to the hub. The time is when
        // the admin assigned it; the location is the vendor's city/state.
        key: 'processing' as const,
        label: 'Processing',
        Icon: Package,
        activeBg: 'bg-yellow-500',
        activeText: 'text-yellow-600',
        lineNext: 'shipped',
        at: formatDateTime(proc.reachedAt || orderDetails.createdAt),
        detail: vendorPlace ? `Assigned to vendor · ${vendorPlace}.` : 'Assigned to vendor for packing.',
      },
      {
        key: 'shipped' as const,
        label: 'Shipped',
        Icon: Truck,
        activeBg: 'bg-[#e01a1b]',
        activeText: 'text-[#e01a1b]',
        lineNext: 'received',
        at: formatDateTime(ship.reachedAt || orderDetails.vendorShippedAt),
        detail: hubPlace ? `Shipped from ${hubPlace}.` : 'Your order is on the way.',
      },
      {
        key: 'received' as const,
        label: 'Received',
        Icon: CheckCircle,
        activeBg: 'bg-green-500',
        activeText: 'text-green-600',
        lineNext: null,
        at: formatDateTime(recv.reachedAt || orderDetails.actualDelivery),
        detail: isStatusReached(orderDetails.status, 'received')
          ? (destination ? `Delivered to ${destination}.` : 'Delivered.')
          : (destination ? `Deliver to ${destination}.` : 'Awaiting delivery.'),
      },
    ]
  })()

  return (
    <div className="min-h-screen bg-white py-4 sm:py-6 lg:py-8 font-sans">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 lg:px-8">
        <Link href="/order">
          <button className="inline-flex items-center gap-2 text-white bg-[#1a1a1a] px-3 py-2 sm:px-4 sm:py-2.5 text-sm sm:text-base rounded-full mb-4 hover:bg-[#e01a1b] transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Orders
          </button>
        </Link>

        {/* Header — Order-page style with icon */}
        <Reveal className="mb-5 sm:mb-6 lg:mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <Package className="w-6 h-6 sm:w-7 sm:h-7 lg:w-8 lg:h-8 text-[#e01a1b] shrink-0" />
              <div className="min-w-0">
                <h1 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#1a1a1a] tracking-tight mb-1">Order Details</h1>
                <p className="text-xs sm:text-sm text-slate-600 break-all">Order #{orderDetails.orderId}</p>
              </div>
            </div>
            <div className="shrink-0 flex flex-col items-start sm:items-end gap-2">
              <div className={`inline-flex items-center px-3 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium ${getStatusColorClass(orderDetails.status)}`}>
                <Package className="w-4 h-4 mr-1" />
                {formatStatus(getNormalizedStatus(orderDetails.status))}
              </div>
              {/* Customer actions — request return post-delivery. Order
                  cancellation is not offered to customers at any pre-delivery stage. */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Buy Again — re-add this order's items to the cart. */}
                <button
                  onClick={handleBuyAgain}
                  disabled={buyingAgain}
                  className="inline-flex items-center gap-2 rounded-full border border-[#e01a1b] px-4 py-2 text-sm font-medium text-[#e01a1b] transition-colors hover:bg-[#e01a1b] hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {buyingAgain ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                  {buyingAgain ? 'Adding…' : 'Buy Again'}
                </button>
                {orderDetails.status === 'DELIVERED'
                  && orderDetails.currency !== 'USD'
                  && orderDetails.items.some((it) => it.returnable !== false)
                  && orderDetails.returnRequest?.status !== 'Requested'
                  && orderDetails.returnRequest?.status !== 'Approved' && (
                  <button
                    onClick={() => setReturnModalOpen(true)}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    <RotateCcw className="w-4 h-4" /> Return
                  </button>
                )}
                {/* International (.com/USD) orders can't be returned — point them to support instead. */}
                {orderDetails.status === 'DELIVERED' && orderDetails.currency === 'USD' && (
                  <Link
                    href="/profile?tab=support"
                    onClick={stashSupportPrefill}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    <MessageCircle className="w-4 h-4" /> Contact Support
                  </Link>
                )}
                {orderDetails.returnRequest?.status === 'Requested' && (
                  <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">Return Requested</span>
                )}
              </div>
            </div>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
          {/* Order Items */}
          <div className="lg:col-span-2 space-y-6">
            {/* Courier & Tracking — the dispatch details the admin entered */}
            {(orderDetails.courier || orderDetails.trackingReference) && (
              <Card className="rounded-2xl border border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2.5 text-lg sm:text-xl">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]">
                      <Truck className="w-5 h-5" />
                    </span>
                    Shipping &amp; Tracking
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">Courier Partner</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {orderDetails.courier ? courierName(orderDetails.courier) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">Tracking ID</p>
                      <p className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">
                        {orderDetails.trackingReference || '—'}
                      </p>
                    </div>
                  </div>
                  {courierTrackingUrl(orderDetails.courier, orderDetails.trackingReference) && (
                    <a
                      href={courierTrackingUrl(orderDetails.courier, orderDetails.trackingReference) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#e01a1b] hover:underline"
                    >
                      Track on {orderDetails.courier ? courierName(orderDetails.courier) : 'courier'} website
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Order Status Timeline — "Track Order" deep-links here (#order-status) */}
            <Card className="scroll-mt-28 rounded-2xl border border-slate-200 shadow-sm" id="order-status">
              <CardHeader>
                <CardTitle className="flex items-center gap-2.5 text-lg sm:text-xl">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
                    <Clock className="w-5 h-5" />
                  </span>
                  Order Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                {normalizedStatus === 'cancelled' ? (
                  (() => {
                    // Full history of what happened, oldest → newest, with date + time —
                    // so a cancelled/returned order still reads like a tracking trail.
                    const history = [...(orderDetails.statusHistory || [])]
                      .filter((h) => h?.status && h?.timestamp)
                      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                    const events = history.length
                      ? history
                      : [{ status: orderDetails.status, timestamp: orderDetails.createdAt }]
                    // Ensure the trail opens with "Order Placed" even if that entry wasn't logged.
                    if (!events.some((h) => String(h.status).toUpperCase() === 'ORDER_CREATED')) {
                      events.unshift({ status: 'ORDER_CREATED', timestamp: orderDetails.createdAt })
                    }
                    const isEnd = (s: string) => ['CANCELLED', 'REJECTED_BY_ADMIN_HUB', 'RETURNED'].includes(String(s).toUpperCase())
                    return (
                      <ol className="relative">
                        {events.map((h, idx) => {
                          const isLast = idx === events.length - 1
                          const ended = isEnd(h.status)
                          return (
                            <li key={idx} className="relative flex gap-3 sm:gap-4">
                              <div className="flex flex-col items-center">
                                <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center shrink-0 ${ended ? 'bg-red-500' : 'bg-green-500'}`}>
                                  {ended ? <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 text-white" /> : <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 text-white" />}
                                </div>
                                {!isLast && <div className="w-0.5 flex-1 my-1 rounded-full bg-slate-200" />}
                              </div>
                              <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-5 sm:pb-6'}`}>
                                <span className={`text-sm sm:text-base font-semibold ${ended ? 'text-red-600' : 'text-slate-800'}`}>
                                  {formatStatus(String(h.status))}
                                </span>
                                {formatDateTime(h.timestamp) && (
                                  <p className="mt-1 flex items-center gap-1.5 text-xs sm:text-sm text-slate-500">
                                    <Clock className="w-3.5 h-3.5 shrink-0" /> {formatDateTime(h.timestamp)}
                                  </p>
                                )}
                                {ended && orderDetails.cancelReason && (
                                  <p className="mt-0.5 text-xs text-slate-500">Reason: {orderDetails.cancelReason}</p>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    )
                  })()
                ) : (
                  <ol className="relative">
                    {timelineSteps.map((step, idx) => {
                      const reached = isStatusReached(orderDetails.status, step.key)
                      const current = isStatusCurrent(orderDetails.status, step.key)
                      const nextReached = step.lineNext
                        ? isStatusReached(orderDetails.status, step.lineNext)
                        : false
                      const stateLabel = step.key === 'received'
                        ? (reached ? 'Complete' : 'Pending')
                        : (current ? 'Current' : reached ? 'Complete' : 'Pending')
                      // Colour by outcome, not by stage: a completed step is
                      // always positive (green), the in-progress step is amber,
                      // and a step not yet reached is muted grey.
                      const stateCls = current
                        ? 'bg-amber-100 text-amber-700'
                        : reached
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-slate-500'
                      const isLast = idx === timelineSteps.length - 1
                      return (
                        <li key={step.key} className="relative flex gap-3 sm:gap-4">
                          {/* Rail: icon + connecting line */}
                          <div className="flex flex-col items-center">
                            <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center shrink-0 ${current ? 'bg-amber-500 ring-4 ring-amber-100' : reached ? 'bg-green-500' : 'bg-slate-300'}`}>
                              <step.Icon className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                            </div>
                            {!isLast && (
                              <div className={`w-0.5 flex-1 my-1 rounded-full ${nextReached ? 'bg-green-300' : 'bg-slate-200'}`} />
                            )}
                          </div>

                          {/* Details */}
                          <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-5 sm:pb-6'}`}>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className={`text-sm sm:text-base font-semibold ${current ? 'text-amber-700' : reached ? 'text-green-700' : 'text-slate-500'}`}>
                                {step.label}
                              </span>
                              <span className={`text-[10px] sm:text-[11px] font-medium px-2 py-0.5 rounded-full ${stateCls}`}>
                                {stateLabel}
                              </span>
                            </div>

                            {reached && step.at && (
                              <p className="mt-1 flex items-center gap-1.5 text-xs sm:text-sm text-slate-500">
                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                {step.at}
                              </p>
                            )}

                            {step.detail && (
                              <p className={`mt-1 flex items-start gap-1.5 text-xs sm:text-sm ${reached ? 'text-slate-600' : 'text-slate-400'}`}>
                                <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span className="min-w-0">{step.detail}</span>
                              </p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}

                {/* Payment & refund — refund block only when the order was actually paid */}
                {(() => {
                  const paid = ['PAID', 'SUCCESS', 'CAPTURED'].includes(String(orderDetails.paymentStatus || '').toUpperCase())
                  const refundLabel: Record<string, string> = {
                    INITIATED: 'Refund Initiated', PROCESSED: 'Refunded',
                    MANUAL: 'Refund Being Processed', FAILED: 'Refund Failed', NONE: 'No Refund',
                  }
                  const refundColor: Record<string, string> = {
                    INITIATED: 'text-blue-600', PROCESSED: 'text-green-600',
                    MANUAL: 'text-amber-600', FAILED: 'text-red-600', NONE: 'text-slate-500',
                  }
                  const rStatus = String(orderDetails.refundStatus || '').toUpperCase()
                  const cur = orderDetails.currency === 'USD' ? 'USD' : 'INR'
                  return (
                    <div className="mt-5 space-y-1.5 border-t border-slate-100 pt-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Payment Status</span>
                        <span className={`font-semibold ${paid ? 'text-green-600' : 'text-yellow-600'}`}>
                          {orderDetails.paymentStatus || 'PENDING'}
                        </span>
                      </div>
                      {paid && orderDetails.refundStatus && (
                        <>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-500">Refund Status</span>
                            <span className={`font-semibold ${refundColor[rStatus] || 'text-slate-600'}`}>
                              {refundLabel[rStatus] || orderDetails.refundStatus}
                            </span>
                          </div>
                          {orderDetails.refundAmount != null && (
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-slate-500">Refund Amount</span>
                              <span className="font-medium text-slate-900">{formatPrice(orderDetails.refundAmount, cur)}</span>
                            </div>
                          )}
                          {orderDetails.refundId && (
                            <div className="flex items-center justify-between gap-3 text-sm">
                              <span className="shrink-0 text-slate-500">Refund ID</span>
                              <span className="break-all text-right font-mono text-xs text-slate-600">{orderDetails.refundId}</span>
                            </div>
                          )}
                          {rStatus === 'FAILED' && (
                            <div className="pt-1">
                              <p className="text-xs text-slate-500">Your refund couldn&apos;t be processed automatically. Our team will process it manually. For more info, contact us.</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Link
                                  href="/profile?tab=support"
                                  onClick={stashSupportPrefill}
                                  className="inline-flex items-center justify-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                                >
                                  Raise a Ticket
                                </Link>
                                <Link
                                  href="/contact"
                                  className="inline-flex items-center justify-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                                >
                                  Contact Us
                                </Link>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>

            {/* Ordered Items */}
            <Card className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-100">
                <CardTitle className="flex items-center gap-2.5 text-lg sm:text-xl">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]">
                    <Package className="w-5 h-5" />
                  </span>
                  Ordered Items
                  <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                    {orderDetails.items.length} {orderDetails.items.length === 1 ? 'item' : 'items'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 sm:p-5 lg:p-6">
                <div className="space-y-4 sm:space-y-6">
                  {orderDetails.items.map((item) => (
                    <div key={item.id} className="flex items-start gap-3 sm:gap-4 p-3 sm:p-4 border border-slate-200 rounded-2xl ring-1 ring-black/5 hover:shadow-[0_14px_34px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 hover:ring-[#e01a1b]/20 transition-all duration-500">
                      <Link
                        href={`/products/${item.productId}`}
                        className="group/thumb relative w-16 h-16 sm:w-20 sm:h-20 bg-slate-100 rounded-lg overflow-hidden flex items-center justify-center shrink-0"
                      >
                        {item.productImage ? (
                          <Image
                            src={item.productImage}
                            alt={item.productName}
                            fill
                            sizes="80px"
                            className="object-cover transition-transform duration-500 group-hover/thumb:scale-105"
                          />
                        ) : (
                          <Package className="w-8 h-8 sm:w-10 sm:h-10 text-slate-400" />
                        )}
                      </Link>
                      <div className="flex-1 min-w-0">
                        <Link href={`/products/${item.productId}`} className="inline-block">
                          <h3 className="font-semibold text-slate-900 mb-1 text-sm sm:text-base break-words transition-colors hover:text-[#e01a1b]">{item.productName}</h3>
                        </Link>
                        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-slate-600 mb-2">
                          <span>Qty: {item.quantity}</span>
                          {item.color && <span>{item.color}</span>}
                          {item.size && <span>Size: {item.size}</span>}
                        </div>
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                          <span className="text-base sm:text-lg font-bold text-slate-900">
                            {money(item.totalPrice)}
                          </span>
                          <span className="text-xs sm:text-sm text-slate-500">
                            {money(item.unitPrice)} each
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}

                </div>

                {/* Action Buttons */}
                <div className="mt-5 sm:mt-6 pt-5 sm:pt-6 border-t border-slate-200">
                  <div className="flex flex-wrap gap-2 sm:gap-3">
                    <button
                      onClick={handleDownloadInvoice}
                      className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-300 text-slate-700 rounded-full hover:border-[#e01a1b] hover:text-[#e01a1b] transition-colors text-sm sm:text-base"
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      Download Invoice
                    </button>
                    {normalizedStatus === "received" && (
                      hasReviewed ? (
                        <div className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 bg-green-50 text-green-600 rounded-full ring-1 ring-green-200">
                          <CheckCircle className="w-4 h-4 shrink-0" />
                          <span className="font-medium text-sm">Review Submitted</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => setReviewModalState({ isOpen: true, orderId: orderDetails.id, items: orderDetails.items })}
                          className="btn-shine flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 bg-[#e01a1b] text-white rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300"
                        >
                          <FaceIcon value={5} className="w-4 h-4 shrink-0" />
                          <span className="font-medium text-sm">Write a Review</span>
                        </button>
                      )
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Order Summary & Details */}
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-8 space-y-6">
              {/* Order Summary */}
              <Card className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="flex items-center gap-2.5 text-lg sm:text-xl">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]">
                      <CreditCard className="w-5 h-5" />
                    </span>
                    Order Summary
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 sm:p-5 lg:p-6">
                  {/* Cart-style price ladder. Discount rows only show when they
                      exist and read as green savings; the coupon sits above the
                      taxable amount (GST is charged on the post-coupon net). */}
                  <div className="space-y-2.5 text-[13.5px] sm:text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Items subtotal</span>
                      <span className="tabular-nums text-slate-900">{money(itemsSubtotal)}</span>
                    </div>

                    {offerDiscount > 0 && (
                      <div className="flex items-center justify-between text-[#157f4a]">
                        <span>Offer discount</span>
                        <span className="font-medium tabular-nums">−{money(offerDiscount)}</span>
                      </div>
                    )}
                    {couponDiscount > 0 && (
                      <div className="flex items-center justify-between text-[#157f4a]">
                        <span>Coupon discount</span>
                        <span className="font-medium tabular-nums">−{money(couponDiscount)}</span>
                      </div>
                    )}

                    {/* Tax shown only for the `.in` region (INR orders); hidden
                        on `.com`/other regions which carry no tax. */}
                    {orderDetails.currency === 'INR' && (
                      <>
                        <div className="flex items-center justify-between border-t border-dashed border-slate-200 pt-2.5">
                          <span className="text-slate-600">Taxable amount</span>
                          <span className="font-medium tabular-nums text-slate-900">{money(Math.max(0, orderDetails.subtotal - couponDiscount))}</span>
                        </div>

                        {orderGstRows(orderDetails).map((row) => (
                          <div key={row.label} className="flex items-center justify-between">
                            <span className="text-slate-600">{row.label}</span>
                            <span className="tabular-nums text-slate-900">{money(row.amount)}</span>
                          </div>
                        ))}
                      </>
                    )}

                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Delivery charges</span>
                      {orderDetails.shippingCost > 0 ? (
                        <span className="tabular-nums text-slate-900">{money(orderDetails.shippingCost)}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-semibold text-[#157f4a]">
                          <Truck className="h-3.5 w-3.5" /> FREE
                        </span>
                      )}
                    </div>

                    {/* Credit points redeemed — a tender applied after wallet. */}
                    {(orderDetails.pointsRedeemed ?? 0) > 0 && (
                      <div className="flex items-center justify-between text-[#157f4a]">
                        <span>Points redeemed ({orderDetails.pointsRedeemed} points)</span>
                        <span className="font-medium tabular-nums">−{money(orderDetails.pointsRedeemedValue || 0)}</span>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 border-t border-slate-100 pt-4">
                    {totalSavings > 0 && (
                      <div className="mb-3 flex items-center justify-between rounded-xl bg-[#eaf7ef] px-3.5 py-2.5 ring-1 ring-[#cdebd8]">
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#157f4a]">
                          <BadgePercent className="h-4 w-4" /> You save
                        </span>
                        <span className="text-[15px] font-bold tabular-nums text-[#157f4a]">{money(totalSavings)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between">
                      <span className="text-[15px] font-semibold text-slate-900 sm:text-base">Total payable</span>
                      <span className="text-2xl font-bold tabular-nums text-[#e01a1b]">{money(orderDetails.totalAmount)}</span>
                    </div>
                    {(orderDetails.pointsEarned ?? 0) > 0 && (
                      <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] font-medium text-amber-800 ring-1 ring-amber-200">
                        You earned {orderDetails.pointsEarned} points on this order.
                      </p>
                    )}
                    {orderDetails.currency === 'INR' && (
                      <p className="mt-1.5 text-[11.5px] leading-snug text-slate-400">
                        Taxes are calculated based on applicable product tax rates.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Delivery Information */}
              <Card className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="flex items-center gap-2.5 text-lg sm:text-xl">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-green-500/10 text-green-600">
                      <Truck className="w-5 h-5" />
                    </span>
                    Delivery Info
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 sm:p-5 lg:p-6 space-y-3 sm:space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]">
                      <Calendar className="w-5 h-5" />
                    </span>
                    <div>
                      <p className="font-medium text-slate-900">
                        {normalizedStatus === "received" ? "Delivered" : "Estimated Delivery"}
                      </p>
                      <p className="text-sm text-slate-600">
                        {normalizedStatus === "received"
                          ? `Delivered on ${new Date(orderDetails.createdAt).toLocaleDateString()}`
                          : orderDetails.estimatedDelivery
                            ? new Date(orderDetails.estimatedDelivery).toLocaleDateString()
                            : "To be updated"
                        }
                      </p>
                    </div>
                  </div>
                  {shippingAddr && (
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-500/10 text-green-600">
                        <MapPin className="w-5 h-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">Shipping Address</p>
                        <div className="text-sm text-slate-600 break-words">
                          {shippingAddr.firstName && <p>{shippingAddr.firstName} {shippingAddr.lastName}</p>}
                          {shippingAddr.street && <p>{shippingAddr.street}</p>}
                          {shippingAddr.city && <p>{shippingAddr.city}, {getStateName(shippingAddr.state ?? "", shippingAddr.country)} {shippingAddr.zipCode}</p>}
                          {shippingAddr.phone && <p>{formatPhoneForDisplay(shippingAddr.phone, shippingAddr.country)}</p>}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                      <CreditCard className="w-5 h-5" />
                    </span>
                    <div>
                      <p className="font-medium text-slate-900">Payment Method</p>
                      <p className="text-sm text-slate-600">{orderDetails.paymentMethod || "N/A"}</p>
                      <p className="text-xs text-slate-500 mt-1">Status: {orderDetails.paymentStatus}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        {/* Similar Products */}
        {similarProducts.length > 0 && (
          <Reveal className="mt-10 sm:mt-12 lg:mt-14">
            <div className="mb-4 flex items-end justify-between gap-4 sm:mb-6">
              <div>
                <span className="mb-1 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e01a1b]">
                  <span className="h-px w-6 bg-[#e01a1b]" /> More to explore
                </span>
                <h2 className="font-playfair text-xl font-semibold tracking-tight text-[#1a1a1a] sm:text-2xl lg:text-3xl">
                  Similar Products
                </h2>
              </div>
              <Link
                href="/products"
                className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-[#e01a1b] hover:text-[#c41617] sm:inline-flex"
              >
                View all
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
              {similarProducts.map((p) => (
                <ProductCard key={p.id} product={p} variant="showcase" />
              ))}
            </div>
          </Reveal>
        )}

      </div>
      <ReviewModal
        isOpen={reviewModalState.isOpen}
        onClose={() => {
          setReviewModalState({ ...reviewModalState, isOpen: false })
          // Re-check eligibility after modal closes — mark done only when both
          // the product reviews and the experience feedback are complete.
          if (orderDetails?.items?.length) {
            reviewService.getOrderReviewEligibility(orderDetails.id)
              .then((res) => {
                const d = res?.data
                if (d && d.products.every((p) => p.reviewed) && d.experienceReviewed) setHasReviewed(true)
              })
              .catch(() => {})
          }
        }}
        orderId={reviewModalState.orderId}
        items={reviewModalState.items}
      />

      {/* Multi-step return / refund / replacement flow */}
      <ReturnRequestModal
        open={returnModalOpen}
        order={{
          id: orderDetails.id,
          orderNumber: orderDetails.orderId,
          currency: orderDetails.currency === 'USD' ? 'USD' : 'INR',
          paymentStatus: orderDetails.paymentStatus,
          items: orderDetails.items.map((it) => ({
            id: it.id,
            name: it.productName,
            image: it.productImage,
            quantity: it.quantity,
            price: it.unitPrice,
            size: it.size,
            color: it.color,
            returnable: it.returnable,
          })),
        }}
        onClose={() => setReturnModalOpen(false)}
        onSubmitted={() => { setReturnModalOpen(false); fetchOrder() }}
      />

      {/* Cancel confirmation modal */}
      {actionModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]" onClick={() => !actionSubmitting && setActionModal(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5" onClick={(e) => e.stopPropagation()}>
            <div className={`h-1 w-full ${actionModal === 'cancel' ? 'bg-gradient-to-r from-red-500 to-rose-500' : 'bg-gradient-to-r from-slate-500 to-slate-600'}`} />
            <div className="p-6">
              <h3 className="text-[17px] font-bold text-slate-900">
                {actionModal === 'cancel' ? 'Cancel this order?' : 'Request a return'}
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Order #{orderDetails.orderId}
                {actionModal === 'cancel'
                  ? ' — the order will be cancelled and your payment refunded to the original method.'
                  : ' — tell us why, and our team will review your return.'}
              </p>

              <label className="mt-4 block text-sm font-medium text-slate-700">
                Reason {actionModal === 'return' && <span className="text-red-500">*</span>}
                {actionModal === 'cancel' && <span className="font-normal text-slate-400"> (optional)</span>}
              </label>
              <div className="mt-2 space-y-1.5">
                {(actionModal === 'cancel' ? CANCEL_REASONS : RETURN_REASONS).map((r) => (
                  <label
                    key={r}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      reasonChoice === r ? 'border-[#e01a1b] bg-[#fff5f5] text-[#1a1a1a]' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="cancel-return-reason"
                      value={r}
                      checked={reasonChoice === r}
                      onChange={() => setReasonChoice(r)}
                      disabled={actionSubmitting}
                      className="h-4 w-4 accent-[#e01a1b]"
                    />
                    {r}
                  </label>
                ))}
              </div>
              {reasonChoice === 'Other' && (
                <textarea
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  disabled={actionSubmitting}
                  rows={2}
                  autoFocus
                  placeholder="Please describe your reason…"
                  className="mt-2 w-full resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none transition-all focus:border-[#e01a1b] focus:ring-4 focus:ring-[#e01a1b]/10 disabled:bg-slate-50"
                />
              )}

              <div className="mt-5 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  disabled={actionSubmitting}
                  className="rounded-full border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  {actionModal === 'cancel' ? 'Keep Order' : 'Close'}
                </button>
                <button
                  type="button"
                  onClick={submitAction}
                  disabled={actionSubmitting}
                  className={`rounded-full px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${actionModal === 'cancel' ? 'bg-[#e01a1b] hover:bg-[#c41617]' : 'bg-slate-800 hover:bg-slate-900'}`}
                >
                  {actionSubmitting ? 'Submitting…' : actionModal === 'cancel' ? 'Cancel Order' : 'Submit Return'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}