"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { formatPrice, getRegionalPrice, getRegion } from "@/lib/currency"
import { FaceIcon } from '@/components/WebSite/Shared/FaceRating';
import {
  Package,
  Truck,
  CheckCircle,
  Clock,
  Search,
  ChevronRight,
  Eye,
  Download,
  Star,
  Sparkles,
  Plus,
  ShoppingCart,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ExternalLink,
  Copy,
  X,
  RotateCcw,
  CreditCard,
  ShieldCheck,
  LifeBuoy
} from "lucide-react"
import SelectMenu from "@/components/WebSite/Shared/SelectMenu"
import DateField from "@/components/WebSite/Shared/DateField"
import Reveal from "@/components/WebSite/Shared/Reveal"
import orderService, { Order as APIOrder } from "@/services/orderService"
import productService from "@/services/productService"
import { courierService } from "@/services/courierService"
import { courierName, courierTrackingUrl, courierDisplayName, orderTrackingUrl } from "@/lib/couriers"
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils"
import ReviewModal from "./ReviewModal"
import ReturnRequestModal from "./ReturnRequestModal"
import { returnService, returnStatusStyle, type ReturnRequest } from "@/services/returnService"

/**
 * Smart pagination range builder — collapses long page lists to "1 … 4 5 6 … 20".
 * Keeps the pagination bar narrow enough to render on a 375px viewport.
 */
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

// Interface definitions
interface OrderItem {
  id: string
  productId: string
  name: string
  image: string
  quantity: number
  price: number
  size?: string
  color?: string
  returnable?: boolean
}

/**
 * Format an amount in the currency the order was charged in.
 *
 * This screen hardcoded '$' on all eight money lines, so a .in shopper's ₹4,999 order
 * read back as "$4,999.00" in their own order history.
 */
function money(amount: number, order: Pick<Order, 'currency'>): string {
  return formatPrice(amount, order.currency === 'USD' ? 'USD' : 'INR')
}

interface Order {
  id: string
  orderNumber: string
  date: string
  status: string
  total: number
  /** The currency the customer was actually charged. Every amount below is in it. */
  currency?: 'INR' | 'USD'
  items: OrderItem[]
  trackingNumber?: string
  /** Courier partner id chosen at ship-to-customer (resolve via lib/couriers). */
  courier?: string | null
  estimatedDelivery?: string
  paymentStatus?: string
  /** Raw backend status (e.g. ORDER_CREATED, DELIVERED) — drives cancel/return eligibility. */
  rawStatus?: string
  returnRequest?: { status?: string; reason?: string } | null
  refundStatus?: string | null
}

/**
 * .com storefront has no returns — the "Contact Support" button on a delivered
 * order stashes a pre-filled ticket (order details + dates + status) that the
 * Support tab picks up, then routes the customer there.
 */
function stashSupportPrefill(order: Order): void {
  try {
    const items = order.items.map((i) => `${i.name} x${i.quantity}`).join(', ')
    const ordered = new Date(order.date).toLocaleString('en-US', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    const description = [
      `Order: ${order.orderNumber}`,
      `Ordered on: ${ordered}`,
      `Status: Delivered`,
      order.trackingNumber ? `Tracking: ${order.trackingNumber}` : '',
      `Items: ${items}`,
      `Order total: ${money(order.total, order)}`,
      '',
      'I need help with this delivered order:',
      '',
    ].filter(Boolean).join('\n')
    sessionStorage.setItem('m2c_support_prefill', JSON.stringify({
      subject: `Help with order ${order.orderNumber}`,
      category: 'order',
      description,
    }))
  } catch { /* sessionStorage may be unavailable */ }
}

// Statuses from which a customer may still cancel (pre-dispatch).
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

// ── Constants ───────────────────────────────────────────
const ORDERS_PER_PAGE = 5

export default function OrderList() {
  const router = useRouter()
  // Order whose "Buy Again" request is in flight (null = none) — disables that row's button.
  const [buyingAgainId, setBuyingAgainId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set())
  const [reviewModalState, setReviewModalState] = useState<{ isOpen: boolean, orderId: string, items: any[] }>({ isOpen: false, orderId: '', items: [] })
  const [reviewedOrders, setReviewedOrders] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  // Order whose tracking modal is open (null = closed).
  const [trackOrder, setTrackOrder] = useState<Order | null>(null)
  // Cancel / return confirmation modal.
  const [actionModal, setActionModal] = useState<{ order: Order; type: 'cancel' | 'return' } | null>(null)
  const [reasonChoice, setReasonChoice] = useState('')  // selected preset reason
  const [actionReason, setActionReason] = useState('')  // free text when "Other"
  const [actionSubmitting, setActionSubmitting] = useState(false)
  // Cancel refund destination: 'WALLET' (instant credit) or 'BANK' (gateway).
  // Multi-step return/refund/replacement flow (replaces the old single-reason return modal).
  const [returnModalOrder, setReturnModalOrder] = useState<Order | null>(null)
  // Latest return request per order code (ORD-…) — drives the Return button state
  // and the status badge once a return has been raised for an order.
  const [returnsByOrder, setReturnsByOrder] = useState<Record<string, ReturnRequest>>({})

  const fetchMyReturns = async () => {
    try {
      const res = await returnService.getMyReturns()
      const map: Record<string, ReturnRequest> = {}
      // findMany returns newest-first, so the first seen per order is the latest.
      for (const r of res.data || []) if (!map[r.orderCode]) map[r.orderCode] = r
      setReturnsByOrder(map)
    } catch { /* non-blocking */ }
  }

  const submitAction = async () => {
    if (!actionModal) return
    const { order, type } = actionModal
    // Final reason = the selected preset, or the free text when "Other".
    // A reason is mandatory for both cancel and return.
    const finalReason = reasonChoice === 'Other' ? actionReason.trim() : reasonChoice
    if (!finalReason) {
      showErrorToast('Reason required', reasonChoice === 'Other' ? 'Please describe the reason.' : `Please select a reason for the ${type === 'cancel' ? 'cancellation' : 'return'}.`)
      return
    }
    try {
      setActionSubmitting(true)
      if (type === 'cancel') {
        const res = await orderService.cancelOrder(order.id, finalReason || undefined)
        showSuccessToast('Order Cancelled', res.message || 'Your refund has been added to your wallet.')
      } else {
        const res = await orderService.requestReturn(order.id, finalReason)
        showSuccessToast('Return Requested', res.message || 'We will review it shortly.')
      }
      setActionModal(null)
      setReasonChoice('')
      setActionReason('')
      fetchOrders()
    } catch (e: any) {
      showErrorToast('Failed', e?.message || 'Please try again.')
    } finally {
      setActionSubmitting(false)
    }
  }

  // "Buy Again": re-add all still-available items from a past order to the cart,
  // then take the shopper to the cart. Unavailable / out-of-stock lines are
  // reported in the toast rather than silently dropped.
  const handleBuyAgain = async (order: Order) => {
    if (buyingAgainId) return
    try {
      setBuyingAgainId(order.id)
      const res = await orderService.reorder(order.id)
      const { addedCount = 0, skippedCount = 0, skipped = [], itemCount = 0 } = res.data || ({} as any)
      if (addedCount > 0) {
        const skipNote = skippedCount > 0
          ? ` ${skippedCount} item${skippedCount > 1 ? 's' : ''} couldn't be added (${skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).`
          : ''
        showSuccessToast('Added to Cart', `${res.message}.${skipNote}`)
        try { window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count: itemCount } })) } catch {}
        router.push('/cart')
      } else {
        showErrorToast('Nothing added', skippedCount > 0
          ? `These items are currently unavailable (${skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).`
          : 'No items from this order could be added to your cart.')
      }
    } catch (e: any) {
      showErrorToast('Failed', e?.message || 'Could not add items to your cart. Please try again.')
    } finally {
      setBuyingAgainId(null)
    }
  }

  // Prime the admin-managed courier registry so courierName()/courierTrackingUrl()
  // can resolve the order's courier id to its name + tracking website.
  useEffect(() => {
    courierService.getActiveCouriers().catch(() => {})
  }, [])
  const [pastPage, setPastPage] = useState(1)

  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sidebar real data
  const [topSelling, setTopSelling] = useState<any[]>([])
  const [bestSellers, setBestSellers] = useState<any[]>([])

  useEffect(() => {
    fetchOrders()
    fetchSidebarProducts()
    fetchMyReturns()
  }, [])

  const fetchOrders = async () => {
    try {
      setLoading(true)
      const response = await orderService.getUserOrders()
      if (response.success) {
        // Transform API data to component format
        const transformedOrders: Order[] = response.data.map((apiOrder: any) => ({
          id: apiOrder.id,
          orderNumber: apiOrder.orderId,
          date: apiOrder.createdAt,
          status: ((s: string) => {
            const normalized = s.toLowerCase();
            if (['dispatched', 'shipped', 'shipped_to_customer'].includes(normalized)) return 'shipped';
            if (['completed', 'delivered', 'received', 'returned'].includes(normalized)) return 'delivered';
            if (['cancelled', 'failed', 'rejected', 'rejected_by_admin_hub'].includes(normalized)) return 'cancelled';
            // Everything else (order_created, vendor_processing, packed_by_vendor,
            // in_transit_to_admin_hub, received_at_admin_hub, approved_by_admin_hub, etc.) → processing
            return 'processing';
          })(apiOrder.status),
          total: apiOrder.totalAmount,
          currency: apiOrder.currency,
          paymentStatus: apiOrder.paymentStatus,
          items: apiOrder.items.map((item: any) => ({
            id: item.id,
            productId: item.productId,
            name: item.productName,
            image: item.productImage || "", // Handle missing image
            quantity: item.quantity,
            price: item.unitPrice,
            size: item.size,
            color: item.color,
            returnable: item.returnable,
          })),
          trackingNumber: apiOrder.trackingReference,
          courier: apiOrder.courier,
          shippingProvider: (apiOrder as any).shippingProvider ?? null,
          estimatedDelivery: apiOrder.estimatedDelivery,
          rawStatus: apiOrder.status,
          returnRequest: (apiOrder as any).returnRequest ?? null,
          refundStatus: (apiOrder as any).refundStatus ?? null,
        }))
        setOrders(transformedOrders)
        setCurrentPage(1)
      } else {
        setError('Failed to fetch orders')
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching orders')
    } finally {
      setLoading(false)
    }
  }

  const fetchSidebarProducts = async () => {
    try {
      const [topRes, bestRes] = await Promise.all([
        productService.getPublicProducts({ sortBy: 'rating', sortOrder: 'desc', limit: 4, inStock: true }),
        productService.getPublicProducts({ tag: 'Best Seller', limit: 4, inStock: true })
      ])
      if (topRes.success) setTopSelling(topRes.data.items)
      if (bestRes.success) setBestSellers(bestRes.data.items)
    } catch (err) {
      // sidebar failing silently is okay
    }
  }

  const toggleOrderExpansion = (orderId: string) => {
    setExpandedOrders(prev => {
      const newSet = new Set(prev)
      if (newSet.has(orderId)) {
        newSet.delete(orderId)
      } else {
        newSet.add(orderId)
      }
      return newSet
    })
  }

  const handleDownloadInvoice = async (orderId: string) => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
      const token = localStorage.getItem("userToken") || sessionStorage.getItem("userToken") || "";
      const response = await fetch(`${baseUrl}/orders/${orderId}/invoice`, {
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

  const getStatusIcon = (status: string) => {
    const normalized = status.toLowerCase()
    if (normalized === 'received' || normalized === 'delivered' || normalized === 'completed') return <CheckCircle className="w-5 h-5 text-green-600" />
    if (normalized === 'shipped' || normalized === 'dispatched') return <Truck className="w-5 h-5 text-[#e01a1b]" />
    if (normalized === 'processing' || normalized.includes('created') || normalized === 'confirmed') return <Clock className="w-5 h-5 text-yellow-600" />
    if (normalized === 'cancelled' || normalized === 'failed') return <Package className="w-5 h-5 text-red-600" />
    return <Package className="w-5 h-5 text-slate-600" />
  }

  const getStatusColor = (status: string) => {
    const normalized = status.toLowerCase()
    if (normalized === 'received' || normalized === 'delivered' || normalized === 'completed') return 'bg-green-100 text-green-800 border-green-200'
    if (normalized === 'shipped' || normalized === 'dispatched') return 'bg-[#e01a1b]/10 text-[#e01a1b] border-[#e01a1b]/20'
    if (normalized === 'processing' || normalized.includes('created') || normalized === 'confirmed') return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    if (normalized === 'cancelled' || normalized === 'failed') return 'bg-red-100 text-red-800 border-red-200'
    return 'bg-slate-100 text-slate-800 border-slate-200'
  }

  const formatStatus = (status: string) => {
    switch (status) {
      case 'delivered': return 'Delivered'
      case 'shipped': return 'Shipped'
      case 'cancelled': return 'Cancelled'
      default: return 'Processing'
    }
  }

  // Strip hex codes like (#ead2d2) from color names stored in DB
  const cleanColorName = (color: string) => {
    return color.replace(/\s*\(#[0-9a-fA-F]{3,6}\)/, '').trim()
  }

  /** Both ends inclusive: the same day picked twice should find that day's
   *  orders rather than none of them. */
  const withinDates = (iso: string) => {
    const t = new Date(iso).getTime()
    if (fromDate && t < new Date(`${fromDate}T00:00:00`).getTime()) return false
    if (toDate && t > new Date(`${toDate}T23:59:59.999`).getTime()) return false
    return true
  }

  const filtersOn = searchTerm !== "" || statusFilter !== "all" || fromDate !== "" || toDate !== ""

  const clearFilters = () => {
    setSearchTerm("")
    setStatusFilter("all")
    setFromDate("")
    setToDate("")
    setCurrentPage(1)
    setPastPage(1)
  }

  const filteredOrders = orders.filter(order => {
    const matchesSearch = order.orderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.items.some(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()))

    if (!matchesSearch) return false
    if (!withinDates(order.date)) return false

    // Adjust logic for status filter to match transformed status
    if (statusFilter === "all") return true
    // "Returned" isn't an order status — it means the order has a return request.
    if (statusFilter === "returned") return !!returnsByOrder[order.orderNumber]
    return order.status.toLowerCase().includes(statusFilter.toLowerCase())
  })

  // Categorize orders based on status logic
  const currentOrders = filteredOrders.filter(order =>
    !['delivered', 'cancelled'].includes(order.status)
  )

  const pastOrders = filteredOrders.filter(order =>
    ['delivered', 'cancelled'].includes(order.status)
  )

  // Pagination
  const totalCurrentPages = Math.ceil(currentOrders.length / ORDERS_PER_PAGE)
  const paginatedCurrentOrders = currentOrders.slice(
    (currentPage - 1) * ORDERS_PER_PAGE,
    currentPage * ORDERS_PER_PAGE
  )

  const totalPastPages = Math.ceil(pastOrders.length / ORDERS_PER_PAGE)
  const paginatedPastOrders = pastOrders.slice(
    (pastPage - 1) * ORDERS_PER_PAGE,
    pastPage * ORDERS_PER_PAGE
  )

  if (loading) {
    /* Skeleton mirrors the order list page (header + tab strip + 3 order rows). */
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-6 space-y-3">
            <div className="h-8 w-40 bg-gray-200 rounded animate-pulse" />
            <div className="h-4 w-64 bg-gray-100 rounded animate-pulse" />
          </div>
          <div className="flex gap-2 mb-6">
            <div className="h-10 w-24 bg-gray-200 rounded-lg animate-pulse" />
            <div className="h-10 w-24 bg-gray-100 rounded-lg animate-pulse" />
          </div>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                <div className="flex justify-between">
                  <div className="h-5 w-36 bg-gray-200 rounded animate-pulse" />
                  <div className="h-6 w-20 bg-gray-200 rounded-full animate-pulse" />
                </div>
                <div className="flex gap-3 items-center">
                  <div className="w-16 h-16 bg-gray-200 rounded-lg animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-2/3 bg-gray-200 rounded animate-pulse" />
                    <div className="h-3 w-1/3 bg-gray-100 rounded animate-pulse" />
                  </div>
                  <div className="h-5 w-20 bg-gray-200 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 flex justify-center items-start">
        <div className="bg-white p-8 rounded-xl shadow text-center text-red-600">
          <AlertCircle className="w-12 h-12 mx-auto mb-4" />
          <p>{error}</p>
          <button onClick={fetchOrders} className="btn-shine mt-4 px-5 py-2.5 bg-[#e01a1b] text-white rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">Try Again</button>
        </div>
      </div>
    )
  }










  return (
    <div className="min-h-screen bg-slate-50 py-3 sm:py-4 lg:py-5 font-sans">
      <div className="max-w-420 mx-auto px-3 sm:px-4 md:px-6 lg:px-8">
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-5 sm:gap-6 lg:gap-8">
          {/* Main Content - Orders */}
          <div className="xl:col-span-3">
            <div className="max-w-6xl">
              {/* Header */}
              <Reveal className="mb-3 sm:mb-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <Package className="w-6 h-6 sm:w-7 sm:h-7 lg:w-8 lg:h-8 text-[#e01a1b] shrink-0" />
                    <div className="min-w-0">
                      <h1 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#1a1a1a] tracking-tight mb-0.5 truncate">My Orders</h1>
                      <p className="text-sm sm:text-base text-slate-600">Track and manage your orders</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xl sm:text-2xl font-bold text-[#1a1a1a]">{filteredOrders.length}</p>
                    <p className="text-xs sm:text-sm text-slate-600">Total Orders</p>
                  </div>
                </div>
              </Reveal>

              {/* Search and Filter */}
              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-4 lg:p-5 mb-4 sm:mb-5">
                {/* One labeled row: what, which status, and when. Every field
                    carries the same small label so the controls line up and no
                    empty band is left above the label-less ones. Native date
                    inputs, so the calendar is the operating system's own. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3 lg:flex-nowrap lg:gap-4">
                  <div className="min-w-0 flex-1 sm:min-w-[13rem]">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Search</span>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 transform text-slate-400 sm:w-5 sm:h-5" />
                      <input
                        type="text"
                        placeholder="Order no. or product…"
                        value={searchTerm}
                        onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); setPastPage(1) }}
                        className="w-full pl-9 sm:pl-10 pr-3 sm:pr-4 py-2.5 text-sm sm:text-base border rounded-lg sm:rounded-md border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#e01a1b]/40 focus:border-[#e01a1b] transition-all"
                      />
                    </div>
                  </div>

                  <div className="w-full sm:w-44 lg:shrink-0">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Status</span>
                    <SelectMenu
                      className="w-full"
                      buttonClassName="rounded-lg sm:rounded-md"
                      tone="slate"
                      ariaLabel="Filter orders by status"
                      value={statusFilter}
                      options={[
                        { value: "all", label: "All Orders" },
                        { value: "processing", label: "Processing" },
                        { value: "shipped", label: "Shipped" },
                        { value: "delivered", label: "Delivered" },
                        { value: "cancelled", label: "Cancelled" },
                        // "Returned" filter is a .in (INR) feature only.
                        ...(getRegion() === "IN" ? [{ value: "returned", label: "Returned" }] : []),
                      ]}
                      onChange={(v) => { setStatusFilter(v); setCurrentPage(1); setPastPage(1) }}
                      placeholder="Filter by status"
                    />
                  </div>

                  <DateField
                    className="min-w-0 flex-1 sm:min-w-[10.5rem] sm:max-w-[12rem] lg:shrink-0"
                    label="From"
                    placeholder="Any date"
                    tone="slate"
                    value={fromDate}
                    max={toDate || undefined}
                    onChange={(v) => { setFromDate(v); setCurrentPage(1); setPastPage(1) }}
                  />

                  <DateField
                    className="min-w-0 flex-1 sm:min-w-[10.5rem] sm:max-w-[12rem] lg:shrink-0"
                    label="To"
                    placeholder="Any date"
                    tone="slate"
                    value={toDate}
                    min={fromDate || undefined}
                    onChange={(v) => { setToDate(v); setCurrentPage(1); setPastPage(1) }}
                    align="right"
                  />

                  {filtersOn && (
                    <button
                      onClick={clearFilters}
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 sm:rounded-md"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Current Orders */}
              {currentOrders.length > 0 && (
                <div className="mb-6 sm:mb-8">
                  <Reveal as="h2" className="font-playfair text-xl sm:text-2xl font-semibold text-[#1a1a1a] tracking-tight mb-3 sm:mb-4">Current Orders</Reveal>
                  <div className="space-y-4 sm:space-y-6">
                    {paginatedCurrentOrders.map((order, index) => (
                      <Reveal key={order.id} delay={index * 90} className="group bg-white rounded-2xl ring-1 ring-black/5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-slate-200 p-4 sm:p-5 lg:p-6 hover:shadow-[0_18px_40px_rgba(0,0,0,0.12)] hover:-translate-y-1 hover:ring-[#e01a1b]/20 transition-all duration-500">
                        {/* Order Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3 sm:gap-4">
                          <div className="flex items-start sm:items-center flex-wrap gap-2 sm:gap-4 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="shrink-0">{getStatusIcon(order.status)}</span>
                              <div className="min-w-0">
                                <h3 className="font-semibold text-slate-900 text-sm sm:text-base break-all">{order.orderNumber}</h3>
                                <p className="text-xs sm:text-sm text-slate-600">Placed on {new Date(order.date).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <span className={`px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full text-xs sm:text-sm font-medium border whitespace-nowrap ${getStatusColor(order.status)}`}>
                              {formatStatus(order.status)}
                            </span>
                          </div>
                          <div className="text-left sm:text-right shrink-0">
                            <p className="text-base sm:text-lg font-bold text-slate-900">{money(order.total, order)}</p>
                            {order.trackingNumber && (
                              <p className="text-xs sm:text-sm text-slate-600 break-all">Tracking: {order.trackingNumber}</p>
                            )}
                          </div>
                        </div>

                        {/* Order Items */}
                        <div className="space-y-3 mb-4">
                          {(expandedOrders.has(order.id) ? order.items : order.items.slice(0, 2)).map((item) => (
                            <div key={item.id} className="flex items-start gap-3 sm:gap-4 p-3 bg-slate-50 rounded-lg">
                              <div className="relative w-14 h-14 sm:w-16 sm:h-16 bg-slate-100 rounded-lg overflow-hidden border border-slate-200 flex items-center justify-center shrink-0">
                                {item.image ? (
                                  <Image
                                    src={item.image}
                                    alt={item.name}
                                    fill
                                    sizes="64px"
                                    className="object-cover"
                                  />
                                ) : (
                                  <Package className="w-6 h-6 sm:w-8 sm:h-8 text-slate-400" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium text-slate-900 text-sm sm:text-base break-words">{item.name}</h4>
                                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-slate-600 mt-1">
                                  <span>Qty: {item.quantity}</span>
                                  {item.size && <span>Size: {item.size}</span>}
                                  {item.color && <span>Color: {cleanColorName(item.color)}</span>}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-semibold text-slate-900 text-sm sm:text-base">{money(item.price * item.quantity, order)}</p>
                                <p className="text-xs sm:text-sm text-slate-600">{money(item.price, order)} each</p>
                              </div>
                            </div>
                          ))}


                          {/* More/Less Button */}
                          {order.items.length > 2 && (
                            <div className="flex justify-center pt-2">
                              <button
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  toggleOrderExpansion(order.id)
                                }}
                                className="flex items-center gap-2 px-4 py-2 text-sm text-[#e01a1b] hover:text-[#c41617] hover:bg-[#e01a1b]/5 rounded-lg transition-colors"
                              >
                                {expandedOrders.has(order.id) ? (
                                  <>
                                    <ChevronRight className="w-4 h-4 rotate-180" />
                                    Show Less
                                  </>
                                ) : (
                                  <>
                                    <ChevronRight className="w-4 h-4 rotate-90" />
                                    Show {order.items.length - 2} More Items
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Order Actions */}
                        <div className="flex flex-wrap gap-2 sm:gap-3 pt-4 border-t border-slate-200">
                          <Link href={`/order/${order.orderNumber}`} className="flex-1 sm:flex-none">
                            <button className="btn-shine w-full flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm bg-[#e01a1b] text-white rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">
                              <Eye className="w-4 h-4" />
                              View Details
                            </button>
                          </Link>
                          {/* Track Order is hidden once the order is complete
                              (delivered/received) — there's nothing left to track. */}
                          {order.trackingNumber && order.status !== 'delivered' && (
                            <button
                              onClick={() => setTrackOrder(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-[#e01a1b] text-[#e01a1b] rounded-full hover:bg-[#e01a1b] hover:text-white transition-colors"
                            >
                              <Truck className="w-4 h-4" />
                              Track Order
                            </button>
                          )}
                          <button
                            onClick={() => handleDownloadInvoice(order.id)}
                            className="w-full sm:w-auto flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-full hover:bg-slate-200 transition-colors"
                          >
                            <Download className="w-4 h-4 shrink-0" />
                            <span className="truncate">Download Invoice</span>
                          </button>
                          {/* Order cancellation is not offered to customers at any
                              pre-delivery stage. */}
                          {/* A return already exists → show its status, no Return button.
                              Otherwise a delivered order can still be returned. */}
                          {returnsByOrder[order.orderNumber] ? (
                            (() => {
                              const rr = returnsByOrder[order.orderNumber]
                              const rst = returnStatusStyle(rr.status)
                              return (
                                <a
                                  href={`/profile?tab=returns&return=${rr.id}`}
                                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-full ${rst.bg} ${rst.text}`}
                                  title="View return details"
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${rst.dot}`} /> Return · {rr.status}
                                </a>
                              )
                            })()
                          ) : order.rawStatus === 'DELIVERED' && order.currency !== 'USD' && order.items.some((it) => it.returnable !== false) ? (
                            <button
                              onClick={() => setReturnModalOrder(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-full hover:bg-slate-50 transition-colors"
                            >
                              <RotateCcw className="w-4 h-4" /> Return
                            </button>
                          ) : order.rawStatus === 'DELIVERED' && order.currency === 'USD' ? (
                            <Link
                              href="/profile?tab=support"
                              onClick={() => stashSupportPrefill(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-full hover:bg-slate-50 transition-colors"
                            >
                              <LifeBuoy className="w-4 h-4" /> Contact Support
                            </Link>
                          ) : null}
                        </div>

                        {/* Estimated Delivery */}
                        {order.estimatedDelivery && order.status !== 'delivered' && order.status !== 'cancelled' && (
                          <div className="mt-4 p-3 bg-[#e01a1b]/5 border border-[#e01a1b]/20 rounded-lg">
                            <p className="text-sm text-[#c41617]">
                              <Clock className="w-4 h-4 inline mr-2" />
                              Estimated delivery: {new Date(order.estimatedDelivery).toLocaleDateString()}
                            </p>
                          </div>
                        )}
                      </Reveal>
                    ))}
                  </div>

                  {/* Current Orders Pagination — responsive: icon-only prev/next + smart range on mobile */}
                  {totalCurrentPages > 1 && (
                    <div className="flex items-center justify-between gap-2 pt-4 mt-2 border-t border-slate-200">
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        aria-label="Previous page"
                        className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                      >
                        <ChevronLeft className="w-4 h-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </button>
                      <div className="flex items-center gap-0.5 sm:gap-1 overflow-hidden">
                        {getPageRange(currentPage, totalCurrentPages).map((p, i) =>
                          p === '…' ? (
                            <span key={`cur-e-${i}`} className="px-1 sm:px-2 text-slate-400 text-sm">…</span>
                          ) : (
                            <button
                              key={`cur-p-${p}`}
                              onClick={() => setCurrentPage(p as number)}
                              aria-current={p === currentPage ? 'page' : undefined}
                              className={`min-w-8 h-8 sm:min-w-9 sm:h-9 px-1.5 sm:px-2 text-xs sm:text-sm font-medium rounded-lg transition-colors ${currentPage === p ? 'bg-[#e01a1b] text-white' : 'text-slate-700 bg-white border border-slate-300 hover:bg-slate-50'
                                }`}>
                              {p}
                            </button>
                          )
                        )}
                      </div>
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalCurrentPages, p + 1))}
                        disabled={currentPage === totalCurrentPages}
                        aria-label="Next page"
                        className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Past Orders */}
              {pastOrders.length > 0 && (
                <div>
                  <Reveal as="h2" className="font-playfair text-xl sm:text-2xl font-semibold text-[#1a1a1a] tracking-tight mb-4 sm:mb-6">Past Orders</Reveal>
                  <div className="space-y-4 sm:space-y-6">
                    {paginatedPastOrders.map((order, index) => (
                      <Reveal key={order.id} delay={index * 90} className="group bg-white rounded-2xl ring-1 ring-black/5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-slate-200 p-4 sm:p-5 lg:p-6 hover:shadow-[0_18px_40px_rgba(0,0,0,0.12)] hover:-translate-y-1 hover:ring-[#e01a1b]/20 transition-all duration-500">
                        {/* Order Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3 sm:gap-4">
                          <div className="flex items-start sm:items-center flex-wrap gap-2 sm:gap-4 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="shrink-0">{getStatusIcon(order.status)}</span>
                              <div className="min-w-0">
                                <h3 className="font-semibold text-slate-900 text-sm sm:text-base break-all">{order.orderNumber}</h3>
                                <p className="text-xs sm:text-sm text-slate-600">Placed on {new Date(order.date).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <span className={`px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full text-xs sm:text-sm font-medium border whitespace-nowrap ${getStatusColor(order.status)}`}>
                              {formatStatus(order.status)}
                            </span>
                          </div>
                          <div className="text-left sm:text-right shrink-0">
                            <p className="text-base sm:text-lg font-bold text-slate-900">{money(order.total, order)}</p>
                            {order.trackingNumber && (
                              <p className="text-xs sm:text-sm text-slate-600 break-all">Tracking: {order.trackingNumber}</p>
                            )}
                          </div>
                        </div>

                        {/* Order Items */}
                        <div className="space-y-3 mb-4">
                          {(expandedOrders.has(order.id) ? order.items : order.items.slice(0, 2)).map((item) => (
                            <div key={item.id} className="flex items-start gap-3 sm:gap-4 p-3 bg-slate-50 rounded-lg">
                              <div className="relative w-14 h-14 sm:w-16 sm:h-16 bg-slate-100 rounded-lg overflow-hidden border border-slate-200 flex items-center justify-center shrink-0">
                                {item.image ? (
                                  <Image
                                    src={item.image}
                                    alt={item.name}
                                    fill
                                    sizes="64px"
                                    className="object-cover"
                                  />
                                ) : (
                                  <Package className="w-6 h-6 sm:w-8 sm:h-8 text-slate-400" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium text-slate-900 text-sm sm:text-base break-words">{item.name}</h4>
                                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-slate-600 mt-1">
                                  <span>Qty: {item.quantity}</span>
                                  {item.size && <span>Size: {item.size}</span>}
                                  {item.color && <span>Color: {cleanColorName(item.color)}</span>}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-semibold text-slate-900 text-sm sm:text-base">{money(item.price * item.quantity, order)}</p>
                                <p className="text-xs sm:text-sm text-slate-600">{money(item.price, order)} each</p>
                              </div>
                            </div>
                          ))}


                          {/* More/Less Button */}
                          {order.items.length > 2 && (
                            <div className="flex justify-center pt-2">
                              <button
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  toggleOrderExpansion(order.id)
                                }}
                                className="flex items-center gap-2 px-4 py-2 text-sm text-[#e01a1b] hover:text-[#c41617] hover:bg-[#e01a1b]/5 rounded-lg transition-colors"
                              >
                                {expandedOrders.has(order.id) ? (
                                  <>
                                    <ChevronRight className="w-4 h-4 rotate-180" />
                                    Show Less
                                  </>
                                ) : (
                                  <>
                                    <ChevronRight className="w-4 h-4 rotate-90" />
                                    Show {order.items.length - 2} More Items
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Order Actions */}
                        <div className="flex flex-wrap gap-2 sm:gap-3 pt-4 border-t border-slate-200">
                          <Link href={`/order/${order.orderNumber}`} className="flex-1 sm:flex-none">
                            <button className="btn-shine w-full flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm bg-[#e01a1b] text-white rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">
                              <Eye className="w-4 h-4" />
                              View Details
                            </button>
                          </Link>
                          {/* Buy Again — re-add this order's items to the cart. */}
                          <button
                            onClick={() => handleBuyAgain(order)}
                            disabled={buyingAgainId === order.id}
                            className="btn-shine flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-[#e01a1b] text-[#e01a1b] rounded-full hover:bg-[#e01a1b] hover:text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {buyingAgainId === order.id ? (
                              <RefreshCw className="w-4 h-4 animate-spin" />
                            ) : (
                              <ShoppingCart className="w-4 h-4" />
                            )}
                            {buyingAgainId === order.id ? 'Adding…' : 'Buy Again'}
                          </button>
                          {order.status === 'received' && (
                            reviewedOrders.has(order.id) ? (
                              <div className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 bg-green-50 text-green-600 rounded-lg">
                                <CheckCircle className="w-4 h-4" />
                                <span className="text-sm font-medium">Reviewed</span>
                              </div>
                            ) : (
                              <button
                                onClick={() => setReviewModalState({ isOpen: true, orderId: order.id, items: order.items })}
                                className="btn-shine flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 bg-[#e01a1b] text-white rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300"
                              >
                                <FaceIcon value={5} className="w-4 h-4" />
                                <span className="text-sm font-medium">Write Review</span>
                              </button>
                            )
                          )}
                          {/* Track Order is hidden once the order is complete
                              (delivered/received) — there's nothing left to track. */}
                          {order.trackingNumber && order.status !== 'delivered' && (
                            <button
                              onClick={() => setTrackOrder(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-[#e01a1b] text-[#e01a1b] rounded-full hover:bg-[#e01a1b] hover:text-white transition-colors"
                            >
                              <Truck className="w-4 h-4" />
                              Track Order
                            </button>
                          )}
                          <button
                            onClick={() => handleDownloadInvoice(order.id)}
                            className="w-full sm:w-auto flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-full hover:bg-slate-200 transition-colors"
                          >
                            <Download className="w-4 h-4 shrink-0" />
                            <span className="truncate">Download Invoice</span>
                          </button>
                          {/* Order cancellation is not offered to customers at any
                              pre-delivery stage. */}
                          {/* A return already exists → show its status, no Return button.
                              Otherwise a delivered order can still be returned. */}
                          {returnsByOrder[order.orderNumber] ? (
                            (() => {
                              const rr = returnsByOrder[order.orderNumber]
                              const rst = returnStatusStyle(rr.status)
                              return (
                                <a
                                  href={`/profile?tab=returns&return=${rr.id}`}
                                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-full ${rst.bg} ${rst.text}`}
                                  title="View return details"
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${rst.dot}`} /> Return · {rr.status}
                                </a>
                              )
                            })()
                          ) : order.rawStatus === 'DELIVERED' && order.currency !== 'USD' && order.items.some((it) => it.returnable !== false) ? (
                            <button
                              onClick={() => setReturnModalOrder(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-full hover:bg-slate-50 transition-colors"
                            >
                              <RotateCcw className="w-4 h-4" /> Return
                            </button>
                          ) : order.rawStatus === 'DELIVERED' && order.currency === 'USD' ? (
                            <Link
                              href="/profile?tab=support"
                              onClick={() => stashSupportPrefill(order)}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-full hover:bg-slate-50 transition-colors"
                            >
                              <LifeBuoy className="w-4 h-4" /> Contact Support
                            </Link>
                          ) : null}
                        </div>
                      </Reveal>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty State */}
              {filteredOrders.length === 0 && (
                <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 lg:p-12 text-center">
                  <Package className="w-12 h-12 sm:w-16 sm:h-16 text-slate-300 mx-auto mb-3 sm:mb-4" />
                  <h3 className="font-playfair text-lg sm:text-xl font-semibold text-[#1a1a1a] mb-2">No Orders Found</h3>
                  <p className="text-sm sm:text-base text-slate-600 mb-4 sm:mb-6">
                    {filtersOn
                      ? "Try adjusting your search, status or dates"
                      : "You haven't placed any orders yet"
                    }
                  </p>
                  <Link href="/products">
                    <button className="btn-shine bg-[#e01a1b] text-white px-5 sm:px-6 py-2.5 sm:py-3 rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300 text-sm sm:text-base">
                      Start Shopping
                    </button>
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar - Product Recommendations */}
          <div className="xl:col-span-1">
            <div className="space-y-4 sm:space-y-6 xl:sticky xl:top-8">
              {/* Top Selling Products */}
              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-5 lg:p-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                  <Star className="w-5 h-5 text-yellow-500" />
                  Top Selling Products
                </h3>
                <div className="space-y-4">
                  {topSelling.map((item: any) => (
                    <Link key={item.id} href={`/products/${item.id}`}>
                      <div className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:shadow-md transition-shadow cursor-pointer group">
                        <div className="relative w-12 h-12 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                          {item.images?.[0] ? (
                            <Image src={item.images[0].url || item.images[0]} alt={item.name} fill sizes="48px" className="object-cover" />
                          ) : (
                            <Package className="w-6 h-6 text-slate-400 m-auto" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-slate-900 text-sm break-words group-hover:text-[#e01a1b] transition-colors">{item.name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-slate-900 font-semibold text-sm">{formatPrice(getRegionalPrice(item))}</span>
                          </div>
                          {Number(item.reviews) > 0 ? (
                            <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-[#F5A524] to-[#F59E0B] px-1.5 py-0.5 text-[11px] leading-none text-white shadow-[0_2px_9px_rgba(245,158,11,0.5)]">
                              <span className="font-bold tabular-nums">{(Number(item.rating) || 0).toFixed(1)}</span>
                              <Sparkles className="h-3 w-3 fill-white text-white" strokeWidth={1.5} />
                              <span className="tabular-nums text-white/85">{Number(item.reviews)}</span>
                            </div>
                          ) : (
                            <div className="mt-1 inline-flex items-center rounded-md bg-gradient-to-r from-[#6366F1] to-[#8B5CF6] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide leading-none text-white shadow-[0_2px_9px_rgba(99,102,241,0.5)]">
                              New
                            </div>
                          )}
                        </div>
                      </div>
                    </Link>
                  ))}
                  {topSelling.length === 0 && <p className="text-sm text-slate-400 text-center py-4">Loading...</p>}
                </div>
                <Link href="/products">
                  <button className="w-full mt-4 text-sm text-[#e01a1b] hover:text-white font-medium py-2 border border-[#e01a1b]/30 rounded-full hover:bg-[#e01a1b] transition-colors">
                    View All Products
                  </button>
                </Link>
              </div>

              {/* Best Seller */}
              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-5 lg:p-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                  <Package className="w-5 h-5 text-green-600" />
                  Best Seller
                </h3>
                <div className="space-y-4">
                  {bestSellers.map((item: any) => (
                    <Link key={item.id} href={`/products/${item.id}`}>
                      <div className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:shadow-md transition-shadow cursor-pointer group">
                        <div className="relative w-12 h-12 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                          {item.images?.[0] ? (
                            <Image src={item.images[0].url || item.images[0]} alt={item.name} fill sizes="48px" className="object-cover" />
                          ) : (
                            <Package className="w-6 h-6 text-slate-400 m-auto" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-slate-900 text-sm break-words group-hover:text-green-600 transition-colors">{item.name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-slate-900 font-semibold text-sm">{formatPrice(getRegionalPrice(item))}</span>
                            {item.discount && (
                              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">{item.discount}% OFF</span>
                            )}
                          </div>
                          {Number(item.reviews) > 0 ? (
                            <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-[#F5A524] to-[#F59E0B] px-1.5 py-0.5 text-[11px] leading-none text-white shadow-[0_2px_9px_rgba(245,158,11,0.5)]">
                              <span className="font-bold tabular-nums">{(Number(item.rating) || 0).toFixed(1)}</span>
                              <Sparkles className="h-3 w-3 fill-white text-white" strokeWidth={1.5} />
                              <span className="tabular-nums text-white/85">{Number(item.reviews)}</span>
                            </div>
                          ) : (
                            <div className="mt-1 inline-flex items-center rounded-md bg-gradient-to-r from-[#6366F1] to-[#8B5CF6] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide leading-none text-white shadow-[0_2px_9px_rgba(99,102,241,0.5)]">
                              New
                            </div>
                          )}
                        </div>
                      </div>
                    </Link>
                  ))}
                  {bestSellers.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No Best Sellers found</p>}
                </div>
                <Link href="/products">
                  <button className="w-full mt-4 text-sm text-green-600 hover:text-green-800 font-medium py-2 border border-green-200 rounded-lg hover:bg-green-50 transition-colors">
                    View Best Sellers
                  </button>
                </Link>
              </div>

              {/* Quick Actions */}
              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-5 lg:p-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-4">Quick Actions</h3>
                <div className="space-y-3">
                  <Link href="/products">
                    <button className="w-full flex items-center gap-3 p-3 text-left border border-slate-200 rounded-lg hover:shadow-md transition-all hover:border-[#e01a1b]/40">
                      <Package className="w-5 h-5 text-[#e01a1b]" />
                      <span className="font-medium text-slate-900">Browse Products</span>
                    </button>
                  </Link>
                  <Link href="/cart">
                    <button className="w-full flex items-center gap-3 p-3 text-left border border-slate-200 rounded-lg hover:shadow-md transition-all hover:border-green-300">
                      <ShoppingCart className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-slate-900">View Cart</span>
                    </button>
                  </Link>
                  <Link href="/profile">
                    <button className="w-full flex items-center gap-3 p-3 text-left border border-slate-200 rounded-lg hover:shadow-md transition-all hover:border-[#e01a1b]/40">
                      <Eye className="w-5 h-5 text-[#e01a1b]" />
                      <span className="font-medium text-slate-900">Account Settings</span>
                    </button>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ReviewModal
        isOpen={reviewModalState.isOpen}
        onClose={() => {
          const closedOrderId = reviewModalState.orderId
          setReviewModalState({ ...reviewModalState, isOpen: false })
          // Mark as reviewed if submission happened
          if (closedOrderId) {
            setReviewedOrders((prev) => new Set(prev).add(closedOrderId))
          }
        }}
        orderId={reviewModalState.orderId}
        items={reviewModalState.items}
      />

      {/* Multi-step return / refund / replacement flow */}
      <ReturnRequestModal
        open={!!returnModalOrder}
        order={returnModalOrder as any}
        onClose={() => setReturnModalOrder(null)}
        onSubmitted={() => { fetchOrders(); fetchMyReturns() }}
      />

      {/* Cancel / Return confirmation modal */}
      {actionModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]" onClick={() => !actionSubmitting && setActionModal(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5" onClick={(e) => e.stopPropagation()}>
            <div className={`h-1 w-full ${actionModal.type === 'cancel' ? 'bg-gradient-to-r from-red-500 to-rose-500' : 'bg-gradient-to-r from-slate-500 to-slate-600'}`} />
            <div className="p-6">
              <h3 className="text-[17px] font-bold text-slate-900">
                {actionModal.type === 'cancel' ? 'Cancel this order?' : 'Request a return'}
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Order #{actionModal.order.orderNumber}
                {actionModal.type === 'cancel'
                  ? ' — the order will be cancelled.'
                  : ' — tell us why, and our team will review your return.'}
              </p>

              <label className="mt-4 block text-sm font-medium text-slate-700">
                Reason <span className="text-red-500">*</span>
              </label>
              <div className="mt-2 space-y-1.5">
                {(actionModal.type === 'cancel' ? CANCEL_REASONS : RETURN_REASONS).map((r) => (
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

              {/* Refund — a paid (online) order is refunded to the M2C Wallet as
                  instant store credit. COD/unpaid: nothing to refund. */}
              {actionModal.type === 'cancel' && (
                actionModal.order.paymentStatus === 'PAID' ? (
                  <div className="mt-4 flex items-start gap-2.5 rounded-xl border-2 border-emerald-200 bg-emerald-50/50 p-3.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                      <RotateCcw className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
                        {money(actionModal.order.total, actionModal.order)} refund to M2C Wallet
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Instant</span>
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-slate-500">
                        Added to your wallet as store credit right away — use it on your next purchase, or withdraw it from your account later.
                      </span>
                    </span>
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl bg-slate-50 p-3 text-[12.5px] text-slate-500">
                    No online payment was captured for this order, so there&rsquo;s nothing to refund.
                  </p>
                )
              )}

              <div className="mt-5 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  disabled={actionSubmitting}
                  className="rounded-full border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  Keep Order
                </button>
                <button
                  type="button"
                  onClick={submitAction}
                  disabled={actionSubmitting}
                  className={`rounded-full px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${actionModal.type === 'cancel' ? 'bg-[#e01a1b] hover:bg-[#c41617]' : 'bg-slate-800 hover:bg-slate-900'}`}
                >
                  {actionSubmitting ? 'Submitting…' : actionModal.type === 'cancel' ? 'Cancel Order' : 'Submit Return'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Track-order modal — courier partner + tracking ID + courier website link */}
      {trackOrder && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]" onClick={() => setTrackOrder(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5" onClick={(e) => e.stopPropagation()}>
            <div className="h-1 w-full bg-gradient-to-r from-[#e01a1b] via-[#ff5a36] to-[#e01a1b]" />
            <div className="flex items-center gap-3 px-6 py-4">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]">
                <Truck className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[16px] font-bold text-slate-900">Track Order</h3>
                <p className="text-[12.5px] text-slate-500">#{trackOrder.orderNumber}</p>
              </div>
              <button onClick={() => setTrackOrder(null)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 px-6 pb-6">
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Courier Partner</p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {courierDisplayName({ shippingProvider: (trackOrder as any).shippingProvider, courier: trackOrder.courier }) || 'Courier'}
                </p>
              </div>

              <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Tracking ID</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-slate-900">{trackOrder.trackingNumber}</p>
                  <button
                    onClick={() => { navigator.clipboard?.writeText(trackOrder.trackingNumber || ''); showSuccessToast('Copied', 'Tracking ID copied'); }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-white"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                </div>
              </div>

              {(() => {
                const provider = (trackOrder as any).shippingProvider;
                const url = orderTrackingUrl({ shippingProvider: provider, courier: trackOrder.courier, trackingReference: trackOrder.trackingNumber });
                const name = courierDisplayName({ shippingProvider: provider, courier: trackOrder.courier });
                return url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-[#e01a1b] px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#c41617]"
                  >
                    Track on {name || 'courier'} website
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : (
                  <p className="text-center text-xs text-slate-500">
                    Use the tracking ID on {name || 'the courier'}&apos;s website to see live status.
                  </p>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}