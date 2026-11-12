"use client";

import { useState, useEffect, useMemo } from "react";
import { ArrowLeft, Package, CreditCard, User, MapPin, Truck, Star, CheckCircle, XCircle, AlertTriangle, RotateCcw, ExternalLink, MapPinned } from "lucide-react";
import { useRouter } from "next/navigation";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import { orderService, Order, VendorShipment } from "@/services/orderService";
import { courierService, type Courier } from "@/services/courierService";
import courierIntegrationService from "@/services/courierIntegrationService";
import { courierName, transportModeLabel } from "@/lib/couriers";
import adminProductService from "@/services/adminProductService";
import Dropdown from "@/components/UI/Dropdown";
import { formatOrderAmount } from "@/lib/currency";
import { hasPermission } from "@/lib/auth";
import { getCountryName, getStateName, formatPhoneForDisplay } from "@/components/WebSite/CheckOut/CheckoutProcess/constants";

interface HubToCustomerDetailProps {
  orderId: string;
}

// Order can be cancelled by admin at any stage up to (but not including) shipment.
// Once shipped/delivered it goes through Return, not Cancel.
const CANCELLABLE_ORDER_STATUSES = new Set([
  "ORDER_CREATED",
  "VENDOR_PROCESSING",
  "PACKED_BY_VENDOR",
  "IN_TRANSIT_TO_ADMIN_HUB",
  "RECEIVED_AT_ADMIN_HUB",
  "APPROVED_BY_ADMIN_HUB",
  "REJECTED_BY_ADMIN_HUB",
]);

const ADMIN_CANCEL_REASONS = [
  "Customer requested cancellation",
  "Item out of stock / unavailable",
  "Payment issue",
  "Suspected fraud",
  "Vendor unable to fulfil",
  "Pricing / listing error",
  "Other",
];

// "SHIPPED_TO_CUSTOMER" → "Shipped To Customer"
const formatStatusLabel = (status: string) =>
  String(status || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());

// ISO → "17 Aug 2026, 2:09 PM" (null on bad input)
const formatTimelineDate = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
};

// Who moved the order into this status.
const actorLabel = (updatedByType?: string): string => {
  switch (String(updatedByType || "").toLowerCase()) {
    case "admin": return "Admin";
    case "customer": return "Customer";
    case "vendor": return "Vendor";
    case "system": return "System";
    default: return "System";
  }
};

const isNegativeStatus = (status: string) =>
  ["CANCELLED", "RETURNED", "REJECTED_BY_ADMIN_HUB"].includes(String(status || "").toUpperCase());

// Build the ordered timeline from status history, oldest first. Synthesises an
// ORDER_CREATED step at the order's creation time when history doesn't record one
// (older orders predate status-history logging).
const buildTimeline = (
  history: any[] | undefined,
  createdAt?: string,
): Array<{ status: string; timestamp?: string; updatedByType?: string; comment?: string }> => {
  const rows = [...(history || [])]
    .filter((h) => h && h.status)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const hasCreated = rows.some((r) => String(r.status).toUpperCase() === "ORDER_CREATED");
  if (!hasCreated && createdAt) {
    rows.unshift({ status: "ORDER_CREATED", timestamp: createdAt, updatedByType: "system", comment: "Order placed" });
  }
  return rows;
};

export default function HubToCustomerDetail({ orderId }: HubToCustomerDetailProps) {
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Ship-to-customer dispatch modal — courier partner + tracking ID.
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [showShipModal, setShowShipModal] = useState(false);
  const [shipCourier, setShipCourier] = useState("");
  const [shipTracking, setShipTracking] = useState("");
  const [submittingShip, setSubmittingShip] = useState(false);

  // Live courier (Delhivery) — whether integration is on+connected. When it is and
  // the order is an India (INR) order, dispatch goes through Delhivery: the admin
  // creates a shipment (AWB) here instead of entering a courier + tracking ID by hand.
  const [courierSettings, setCourierSettings] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const [creatingShipment, setCreatingShipment] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState(false);
  const [trackingShipment, setTrackingShipment] = useState(false);
  const [cancellingShipment, setCancellingShipment] = useState(false);
  const [trackInfo, setTrackInfo] = useState<{
    found?: boolean;
    status?: string;
    statusDateTime?: string;
    instructions?: string;
    scans?: any[];
  } | null>(null);
  // Return-request review.
  const [returnDeciding, setReturnDeciding] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  // Admin order cancellation (whole order, any pre-shipment stage).
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelChoice, setCancelChoice] = useState("");
  const [cancelOther, setCancelOther] = useState("");
  const [cancelling, setCancelling] = useState(false);
  // Restock decision: a cancellation does NOT return stock to inventory unless
  // the admin explicitly approves it here. Default = do not restock.
  const [cancelRestock, setCancelRestock] = useState<boolean | null>(null);

  const handleCancelOrder = async () => {
    const reason = cancelChoice === "Other" ? cancelOther.trim() : cancelChoice;
    if (!reason) {
      showErrorToast("Please select or enter a cancellation reason.");
      return;
    }
    if (cancelRestock === null) {
      showErrorToast("Please choose whether to return the stock to inventory.");
      return;
    }
    try {
      setCancelling(true);
      const res = await orderService.cancelAdminOrder(orderId, reason, cancelRestock === true);
      if (res.success) {
        const paid = ["PAID", "SUCCESS", "CAPTURED"].includes(String(order?.paymentStatus || "").toUpperCase());
        showSuccessToast("Order cancelled" + (paid ? " — refund initiated" : "") + (cancelRestock ? " · stock restored" : " · stock not restocked"));
        setOrder(res.data);
        setShowCancelModal(false);
        setCancelChoice("");
        setCancelOther("");
        setCancelRestock(null);
      }
    } catch (error: any) {
      showErrorToast(error.message || "Failed to cancel order");
    } finally {
      setCancelling(false);
    }
  };

  const handleReturnDecision = async (decision: "approve" | "reject") => {
    if (!order) return;
    if (decision === "reject" && !rejectNote.trim()) {
      showErrorToast("Reason required", "Please add a reason for rejecting the return.");
      return;
    }
    try {
      setReturnDeciding(true);
      const res = await orderService.decideReturn(order.id, decision, rejectNote.trim() || undefined);
      showSuccessToast(decision === "approve" ? "Return Approved" : "Return Rejected", res.message || "");
      setOrder(res.data);
      setShowReject(false);
      setRejectNote("");
    } catch (e: any) {
      showErrorToast("Failed", e?.message || "Please try again.");
    } finally {
      setReturnDeciding(false);
    }
  };

  useEffect(() => {
    fetchOrderDetails();
  }, [orderId]);

  // Load live-courier integration state once — tells us whether dispatch is manual
  // (courier + tracking ID) or via Delhivery (create shipment → AWB).
  useEffect(() => {
    courierIntegrationService
      .getSettings()
      .then((res) => {
        if (res?.success && res.data) {
          setCourierSettings({ enabled: !!res.data.enabled, connected: !!res.data.connected });
        }
      })
      .catch(() => setCourierSettings(null));
  }, []);

  // Load the region's courier partners for the dispatch dropdown.
  useEffect(() => {
    if (!order?.currency) return;
    const region = order.currency === "USD" ? "US" : "IN";
    courierService.getActiveCouriers(region).then(setCouriers).catch(() => setCouriers([]));
  }, [order?.currency]);

  // Couriers the admin configured for the product(s) in this order — the dispatch
  // dropdown is restricted to these (union across the order's products).
  const [allowedCourierIds, setAllowedCourierIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!order?.items?.length) return;
    const productIds = [...new Set(order.items.map((i) => i.productId).filter(Boolean))];
    Promise.all(
      productIds.map((pid) => adminProductService.getProduct(pid).then((r) => r.data).catch(() => null)),
    ).then((products) => {
      const ids = new Set<string>();
      for (const p of products) {
        const cids = (p?.logisticsConfig as { courierIds?: string[] } | undefined)?.courierIds;
        if (Array.isArray(cids)) cids.forEach((id) => id && ids.add(id));
      }
      setAllowedCourierIds(ids);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  // The courier the customer chose at checkout (first item that has one) — used as
  // the pre-selected default in the dispatch modal.
  const customerCourierId = useMemo(
    () => order?.items?.map((i) => i.logistics?.courier || i.courier).find(Boolean) || "",
    [order?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Dropdown options: the product's configured couriers (plus the customer's choice
  // as a safety net); falls back to all region couriers for legacy products with no
  // courier config.
  const courierOptions = useMemo(() => {
    const list = allowedCourierIds.size > 0
      ? couriers.filter((c) => allowedCourierIds.has(c.id) || c.id === customerCourierId)
      : couriers;
    return list.map((c) => ({ value: c.id, label: c.name }));
  }, [couriers, allowedCourierIds, customerCourierId]);

  const fetchOrderDetails = async () => {
    try {
      setIsLoading(true);
      const res = await orderService.getAdminOrderById(orderId);
      if (res.success) {
        setOrder(res.data);
      }
    } catch (error: any) {
      showErrorToast(error.message || "Failed to load order details");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateStatus = async (newStatus: string) => {
    try {
      const res = await orderService.updateAdminOrderStatus(orderId, newStatus);
      if (res.success) {
        showSuccessToast(`Order marked as ${newStatus.replace(/_/g, " ")}`);
        setOrder(res.data);
        if (newStatus === "DELIVERED") {
          setTimeout(() => {
            router.push("/admin/dashboard/orders/hub-to-customer");
          }, 1500);
        }
      }
    } catch (error: any) {
      showErrorToast(error.message || "Failed to update order status");
    }
  };

  // Opens the dispatch modal instead of updating directly — the admin must
  // pick a courier partner and enter the tracking ID before shipping.
  const handleMarkOutForDelivery = () => {
    // Pre-select the courier the customer chose; admin can change it below.
    setShipCourier(customerCourierId || "");
    setShipTracking("");
    setShowShipModal(true);
  };

  const handleConfirmShip = async () => {
    // Live courier (Delhivery) orders ship against the stored AWB — the backend
    // rejects manual courier/tracking values, so we send none. Manual orders still
    // require a courier partner + tracking ID.
    const live = !!courierSettings?.enabled && !!courierSettings?.connected && order?.currency === "INR";
    if (!live) {
      if (!shipCourier) {
        showErrorToast("Please select a courier partner.");
        return;
      }
      if (!shipTracking.trim()) {
        showErrorToast("Please enter the tracking ID.");
        return;
      }
    }
    try {
      setSubmittingShip(true);
      const res = await orderService.updateAdminOrderStatus(
        orderId,
        "SHIPPED_TO_CUSTOMER",
        undefined,
        live ? undefined : { courier: shipCourier, trackingReference: shipTracking.trim() },
      );
      if (res.success) {
        showSuccessToast("Order shipped to customer — tracking details sent");
        setOrder(res.data);
        setShowShipModal(false);
      }
    } catch (error: any) {
      showErrorToast(error.message || "Failed to update order status");
    } finally {
      setSubmittingShip(false);
    }
  };

  // ── Live courier (Delhivery) per-order operations ──────────────────────────
  // Create the Delhivery shipment — generates the AWB the backend then uses to
  // mark the order shipped. Refreshes the order so the AWB/label surface here.
  const handleCreateShipment = async () => {
    if (!order) return;
    try {
      setCreatingShipment(true);
      const res = await courierIntegrationService.createShipment(order.id);
      if (res.success) {
        showSuccessToast(res.message || `Shipment created — AWB ${res.data?.awb}`);
        await fetchOrderDetails();
      } else {
        showErrorToast(res.message || "Failed to create shipment");
      }
    } catch (error: any) {
      showErrorToast(error.response?.data?.error || error.message || "Failed to create shipment");
    } finally {
      setCreatingShipment(false);
    }
  };

  // Open the Delhivery label. Uses the stored URL when present, else (re)fetches it.
  const handleDownloadLabel = async () => {
    if (!order) return;
    if (order.shippingLabelUrl) {
      window.open(order.shippingLabelUrl, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      setLoadingLabel(true);
      const res = await courierIntegrationService.getLabel(order.id);
      const url = res?.data?.labelUrl;
      if (res.success && url) {
        window.open(url, "_blank", "noopener,noreferrer");
        setOrder((prev) => (prev ? { ...prev, shippingLabelUrl: url } : prev));
      } else {
        showErrorToast("Label is not available yet");
      }
    } catch (error: any) {
      showErrorToast(error.response?.data?.error || error.message || "Failed to fetch label");
    } finally {
      setLoadingLabel(false);
    }
  };

  // Pull the latest tracking status + scan history from Delhivery.
  const handleTrackShipment = async () => {
    if (!order) return;
    try {
      setTrackingShipment(true);
      const res = await courierIntegrationService.track(order.id);
      if (res.success) {
        setTrackInfo(res.data || null);
        const latest = res.data?.status;
        showSuccessToast(latest ? `Latest status: ${latest}` : "Tracking refreshed");
        // Keep the small status line in sync without a full refetch.
        if (latest) {
          setOrder((prev) =>
            prev ? { ...prev, lastCourierStatus: latest, lastCourierStatusAt: new Date().toISOString() } : prev,
          );
        }
      } else {
        showErrorToast("Failed to track shipment");
      }
    } catch (error: any) {
      showErrorToast(error.response?.data?.error || error.message || "Failed to track shipment");
    } finally {
      setTrackingShipment(false);
    }
  };

  // Cancel (RTO) the Delhivery shipment after confirmation.
  const handleCancelShipment = async () => {
    if (!order) return;
    if (!window.confirm(`Cancel the Delhivery shipment for AWB ${order.trackingReference}? This cannot be undone.`)) {
      return;
    }
    try {
      setCancellingShipment(true);
      const res = await courierIntegrationService.cancelShipment(order.id);
      if (res.success) {
        showSuccessToast(res.message || "Shipment cancelled");
        setTrackInfo(null);
        await fetchOrderDetails();
      } else {
        showErrorToast(res.message || "Failed to cancel shipment");
      }
    } catch (error: any) {
      showErrorToast(error.response?.data?.error || error.message || "Failed to cancel shipment");
    } finally {
      setCancellingShipment(false);
    }
  };

  const handleMarkAsDelivered = () => {
    handleUpdateStatus("DELIVERED");
  };

  if (isLoading) {
    return <div className="p-6 text-center text-slate-500">Loading order details...</div>;
  }

  if (!order) {
    return <div className="p-6 text-center text-red-500">Order not found</div>;
  }

  const { status } = order;
  // Every figure below is stored in the currency the buyer was charged in, so a .com
  // order holds USD. Show that as the source of truth, with an INR equivalent from the
  // order's own rate snapshot (never the live rate, which would rewrite history).
  const money = (amount?: number) => {
    const { charged, inrEquivalent } = formatOrderAmount(amount || 0, order.currency, order.exchangeRate);
    return (
      <>
        {charged}
        {inrEquivalent && <span className="block text-xs font-normal text-slate-500">≈ {inrEquivalent}</span>}
      </>
    );
  };

  // Check shipment readiness for multi-vendor orders
  const shipments = order.shipments || [];
  const hasShipments = shipments.length > 0;
  const terminalStatuses = new Set(['CANCELLED', 'RETURNED']);
  const nonTerminalShipments = shipments.filter((s) => !terminalStatuses.has(s.status));
  const nonCancelledShipments = nonTerminalShipments;
  const allShipmentsApproved = hasShipments && nonTerminalShipments.every((s) => s.status === 'APPROVED_BY_ADMIN_HUB');
  const hasRejectedShipment = nonCancelledShipments.some((s) => s.status === 'REJECTED_BY_ADMIN_HUB');
  const canShipToCustomer = !hasShipments || allShipmentsApproved;

  // Shipment progress counts — used by the banner and by the inline status sub-text
  // so admin sees blockers / progress without having to scroll to the Vendor Shipments
  // section at the bottom of the page.
  const approvedCount = nonCancelledShipments.filter((s) => s.status === 'APPROVED_BY_ADMIN_HUB').length;
  const totalShipmentCount = nonCancelledShipments.length;
  const atVendorCount = nonCancelledShipments.filter((s) =>
    ['ORDER_CREATED', 'VENDOR_PROCESSING', 'PACKED_BY_VENDOR', 'IN_TRANSIT_TO_ADMIN_HUB'].includes(s.status),
  ).length;
  const atHubAwaitingReviewCount = nonCancelledShipments.filter((s) => s.status === 'RECEIVED_AT_ADMIN_HUB').length;
  const rejectedShipmentCount = nonCancelledShipments.filter((s) => s.status === 'REJECTED_BY_ADMIN_HUB').length;
  const isTerminal = status === 'CANCELLED' || status === 'RETURNED';

  // Live courier (Delhivery) is in play only when the integration is on + connected
  // AND this is an India (INR) order. International / live-off orders keep the manual
  // courier + tracking-ID dispatch flow untouched.
  const liveActive = !!courierSettings?.enabled && !!courierSettings?.connected && order.currency === 'INR';
  // A Delhivery AWB exists once a shipment has been created for this order.
  const hasAwb = !!order.trackingReference && order.shippingProvider === 'delhivery';

  const atShipStage = ['RECEIVED_AT_ADMIN_HUB', 'APPROVED_BY_ADMIN_HUB'].includes(status) && canShipToCustomer && !hasRejectedShipment;
  // For live orders the admin must create the Delhivery shipment (AWB) before the
  // order can be marked out for delivery — the backend ships against the stored AWB.
  const canMarkOutForDelivery = atShipStage && (!liveActive || hasAwb);
  // Show the "Mark Out for Delivery" affordance for any pre-shipped, non-terminal state so
  // admin sees the next action up front. Disabled state + tooltip explains the blocker.
  const showOutForDeliveryButton = !isTerminal && status !== 'SHIPPED_TO_CUSTOMER' && status !== 'DELIVERED';

  // Build the action banner shown at the top of the page. One source of truth for what
  // state the order is in and what the admin should do next. Tone drives color scheme.
  type BannerTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  const buildActionBanner = (): { tone: BannerTone; title: string; message: string } | null => {
    if (status === 'DELIVERED') {
      return { tone: 'success', title: 'Order delivered', message: 'This order has been delivered to the customer. The lifecycle is complete.' };
    }
    if (status === 'SHIPPED_TO_CUSTOMER') {
      return { tone: 'info', title: 'Out for delivery', message: 'Mark this order as delivered once the customer receives it.' };
    }
    if (status === 'CANCELLED') {
      return { tone: 'neutral', title: 'Order cancelled', message: 'No further actions are available for this order.' };
    }
    if (status === 'RETURNED') {
      return { tone: 'neutral', title: 'Order returned', message: 'This order was returned. No further delivery actions are available.' };
    }
    if (rejectedShipmentCount > 0) {
      return {
        tone: 'danger',
        title: 'Vendor shipment rejected',
        message: `${rejectedShipmentCount} of ${totalShipmentCount} vendor shipment(s) were rejected. Resolve them (reinspection or replacement) before shipping to the customer.`,
      };
    }
    if (hasShipments && allShipmentsApproved && status !== 'SHIPPED_TO_CUSTOMER') {
      return {
        tone: 'success',
        title: 'Ready to ship to customer',
        message: `All ${totalShipmentCount} vendor shipment(s) approved at the hub. Click "Mark Out for Delivery" to send the order to the customer.`,
      };
    }
    if (atHubAwaitingReviewCount > 0 && atVendorCount === 0) {
      return {
        tone: 'warning',
        title: 'Vendor shipments awaiting approval',
        message: `${approvedCount} of ${totalShipmentCount} shipment(s) approved. ${atHubAwaitingReviewCount} received at hub and pending review — approve them in Vendor Shipments below to enable delivery.`,
      };
    }
    if (atVendorCount > 0) {
      return {
        tone: 'warning',
        title: 'Waiting for vendor shipments',
        message: `${approvedCount} of ${totalShipmentCount} vendor shipment(s) approved. ${atVendorCount} still with the vendor or in transit to the hub — delivery unavailable until they arrive.`,
      };
    }
    return null;
  };
  const actionBanner = buildActionBanner();

  const bannerToneClasses: Record<BannerTone, { wrap: string; title: string; message: string; iconColor: string }> = {
    success: { wrap: 'bg-green-50 border-green-200', title: 'text-green-900', message: 'text-green-800', iconColor: 'text-green-600' },
    warning: { wrap: 'bg-amber-50 border-amber-200', title: 'text-amber-900', message: 'text-amber-800', iconColor: 'text-amber-600' },
    danger: { wrap: 'bg-red-50 border-red-200', title: 'text-red-900', message: 'text-red-800', iconColor: 'text-red-600' },
    info: { wrap: 'bg-blue-50 border-blue-200', title: 'text-blue-900', message: 'text-blue-800', iconColor: 'text-blue-600' },
    neutral: { wrap: 'bg-slate-50 border-slate-200', title: 'text-slate-900', message: 'text-slate-700', iconColor: 'text-slate-500' },
  };
  const renderBannerIcon = (tone: BannerTone) => {
    const cls = `h-5 w-5 ${bannerToneClasses[tone].iconColor}`;
    if (tone === 'success') return <CheckCircle className={cls} />;
    if (tone === 'warning') return <AlertTriangle className={cls} />;
    if (tone === 'danger') return <XCircle className={cls} />;
    if (tone === 'info') return <Truck className={cls} />;
    return <Package className={cls} />;
  };

  // Tooltip text for the disabled "Mark Out for Delivery" button — same source of truth
  // as the banner message so admins get consistent reasoning whether they hover or read.
  const outForDeliveryBlockerReason = (() => {
    if (status === 'VENDOR_PROCESSING' || status === 'ORDER_CREATED' || status === 'PACKED_BY_VENDOR' || status === 'IN_TRANSIT_TO_ADMIN_HUB') {
      return 'Order is still with the vendor or in transit — waiting for it to arrive at the hub.';
    }
    if (hasRejectedShipment) return 'One or more vendor shipments are rejected. Resolve them before shipping.';
    if (!canShipToCustomer) return 'All vendor shipments must be approved at the hub before delivery.';
    if (liveActive && !hasAwb) return 'Create the Delhivery shipment (AWB) below before marking this order out for delivery.';
    return '';
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-slate-600" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Hub to Customer Order</h1>
            <p className="text-sm text-slate-600 mt-1">Order ID: {order.orderId}</p>
          </div>
        </div>
        <div className="flex gap-3">
          {showOutForDeliveryButton && hasPermission('hub_to_customer:update_status') && (
            <button
              onClick={handleMarkOutForDelivery}
              disabled={!canMarkOutForDelivery}
              className={`px-6 py-2 rounded-lg transition-colors font-medium ${canMarkOutForDelivery
                ? "bg-orange-600 text-white hover:bg-orange-700"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
              }`}
              title={!canMarkOutForDelivery ? outForDeliveryBlockerReason : ""}
            >
              Mark Out for Delivery
            </button>
          )}
          {status === "SHIPPED_TO_CUSTOMER" && hasPermission('hub_to_customer:update_status') && (
            <button
              onClick={handleMarkAsDelivered}
              className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
            >
              Mark as Delivered
            </button>
          )}
          {status === "DELIVERED" && (
            <div className="px-6 py-2 bg-green-50 text-green-700 border border-green-200 rounded-lg font-medium border border-green-300">
              Order Delivered
            </div>
          )}
          {CANCELLABLE_ORDER_STATUSES.has(status) && hasPermission('hub_to_customer:update_status') && (
            <button
              onClick={() => setShowCancelModal(true)}
              className="px-6 py-2 rounded-lg border border-red-300 bg-white text-red-600 hover:bg-red-50 transition-colors font-medium"
            >
              Cancel Order
            </button>
          )}
        </div>
      </div>

      {/* Action / Status Banner — single source of truth at the top of the page so
          admins see the current blocker and next action without scrolling. */}
      {actionBanner && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-lg border p-4 flex items-start gap-3 ${bannerToneClasses[actionBanner.tone].wrap}`}
        >
          <div className="shrink-0 mt-0.5">{renderBannerIcon(actionBanner.tone)}</div>
          <div className="min-w-0 flex-1">
            <h3 className={`text-sm font-semibold ${bannerToneClasses[actionBanner.tone].title}`}>
              {actionBanner.title}
            </h3>
            <p className={`text-sm mt-0.5 ${bannerToneClasses[actionBanner.tone].message}`}>
              {actionBanner.message}
            </p>
          </div>
        </div>
      )}

      {/* Live Courier (Delhivery) dispatch — shown only for INR orders when the
          integration is on + connected. Replaces the manual courier + tracking-ID
          dispatch: the admin creates the Delhivery shipment (AWB) here, then marks
          the order out for delivery (the backend ships against the stored AWB). */}
      {liveActive && (atShipStage || hasAwb) && hasPermission('hub_to_customer:update_status') && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="flex items-center gap-2 mb-4">
            <Truck className="h-5 w-5 text-orange-600" />
            <h2 className="text-lg font-semibold text-slate-900">Live Courier — Delhivery</h2>
          </div>

          {/* Last known courier status (from the latest track / cancel) */}
          {order.lastCourierStatus && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
              <MapPinned className="h-4 w-4 text-slate-500 shrink-0" />
              <p className="text-sm text-slate-700">
                <span className="font-medium">{order.lastCourierStatus}</span>
                {order.lastCourierStatusAt && (
                  <span className="text-slate-400"> · {formatTimelineDate(order.lastCourierStatusAt) || ""}</span>
                )}
              </p>
            </div>
          )}

          {!hasAwb ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                This India order ships via Delhivery. Create the shipment to generate the AWB,
                then mark the order out for delivery.
              </p>
              <button
                onClick={handleCreateShipment}
                disabled={creatingShipment}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Truck className="h-4 w-4" />
                {creatingShipment ? "Creating shipment…" : "Create Delhivery Shipment"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">AWB</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-slate-900">{order.trackingReference}</p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleDownloadLabel}
                  disabled={loadingLabel}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                >
                  <ExternalLink className="h-4 w-4" />
                  {loadingLabel ? "Opening…" : "Download Label"}
                </button>
                <button
                  onClick={handleTrackShipment}
                  disabled={trackingShipment}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                >
                  <MapPinned className="h-4 w-4" />
                  {trackingShipment ? "Tracking…" : "Track"}
                </button>
                {!isTerminal && status !== 'DELIVERED' && (
                  <button
                    onClick={handleCancelShipment}
                    disabled={cancellingShipment}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    {cancellingShipment ? "Cancelling…" : "Cancel Shipment"}
                  </button>
                )}
              </div>

              {/* Tracking summary — latest status + a few recent scans */}
              {trackInfo && (
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  {trackInfo.found === false ? (
                    <p className="text-sm text-slate-500">No tracking information is available for this AWB yet.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <p className="text-sm font-semibold text-slate-900">{trackInfo.status || "—"}</p>
                        {trackInfo.statusDateTime && (
                          <span className="text-xs text-slate-400">{formatTimelineDate(trackInfo.statusDateTime) || trackInfo.statusDateTime}</span>
                        )}
                      </div>
                      {trackInfo.instructions && (
                        <p className="mt-0.5 text-xs text-slate-500">{trackInfo.instructions}</p>
                      )}
                      {Array.isArray(trackInfo.scans) && trackInfo.scans.length > 0 && (
                        <ul className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                          {trackInfo.scans
                            .slice(-4)
                            .reverse()
                            .map((raw: any, i: number) => {
                              const sc = raw?.ScanDetail || raw || {};
                              const label = sc.Scan || sc.ScanType || sc.Status || "Scan";
                              const loc = sc.ScannedLocation || sc.ScanLocation || "";
                              const when = sc.ScanDateTime || sc.StatusDateTime;
                              const instr = sc.Instructions || sc.Instruction || "";
                              return (
                                <li key={i} className="text-xs text-slate-600">
                                  <span className="font-medium text-slate-800">{label}</span>
                                  {loc ? <span className="text-slate-500"> · {loc}</span> : null}
                                  {when ? <span className="text-slate-400"> · {formatTimelineDate(when) || when}</span> : null}
                                  {instr ? <span className="block text-slate-400">{instr}</span> : null}
                                </li>
                              );
                            })}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Cancellation — shown when the order was cancelled (reason + refund) */}
      {order.status === 'CANCELLED' && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="mb-3 flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-500" />
            <h2 className="text-lg font-semibold text-slate-900">Cancellation</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Reason</p>
              <p className="mt-0.5 text-slate-900">{order.cancelReason || '— (no reason given)'}</p>
            </div>

            {/* Refund details — mirrors what the customer sees on their order page */}
            <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Refund</p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">Payment Status</span>
                  <span className={`font-semibold ${
                    ['PAID', 'SUCCESS', 'CAPTURED'].includes(String(order.paymentStatus || '').toUpperCase())
                      ? 'text-green-600' : 'text-amber-600'
                  }`}>
                    {order.paymentStatus || '—'}
                  </span>
                </div>
                {(() => {
                  const map: Record<string, { label: string; cls: string }> = {
                    INITIATED: { label: 'Refund Initiated', cls: 'text-blue-600' },
                    PROCESSED: { label: 'Refunded', cls: 'text-green-600' },
                    MANUAL: { label: 'Manual Refund Pending', cls: 'text-amber-600' },
                    FAILED: { label: 'Refund Failed', cls: 'text-red-600' },
                    NONE: { label: 'No Refund', cls: 'text-slate-600' },
                  };
                  const s = String(order.refundStatus || '').toUpperCase();
                  const info = map[s];
                  if (!order.refundStatus) return null;
                  return (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-500">Refund Status</span>
                        <span className={`font-semibold ${info?.cls || 'text-slate-700'}`}>
                          {info?.label || order.refundStatus}
                        </span>
                      </div>
                      {typeof order.refundAmount === 'number' && order.refundAmount > 0 && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-slate-500">Refund Amount</span>
                          <span className="text-right font-semibold text-slate-800">{money(order.refundAmount)}</span>
                        </div>
                      )}
                      {order.refundId && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-slate-500">Refund ID</span>
                          <span className="break-all text-right font-mono text-xs text-slate-600">{order.refundId}</span>
                        </div>
                      )}
                      {s === 'FAILED' && (
                        <p className="pt-1 text-xs text-slate-500">Automatic refund failed at the gateway — process this refund manually.</p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Return Request — shown when a customer has raised one */}
      {order.returnRequest && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <RotateCcw className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-semibold text-slate-900">Return Request</h2>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              order.returnRequest.status === "Requested" ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                : order.returnRequest.status === "Approved" ? "bg-green-50 text-green-700 ring-1 ring-green-200"
                : "bg-red-50 text-red-700 ring-1 ring-red-200"
            }`}>
              {order.returnRequest.status}
            </span>
          </div>

          <div className="space-y-2 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Reason</p>
              <p className="mt-0.5 text-slate-900">{order.returnRequest.reason || "—"}</p>
            </div>
            {order.returnRequest.requestedAt && (
              <p className="text-xs text-slate-500">Requested on {new Date(order.returnRequest.requestedAt).toLocaleString("en-IN")}</p>
            )}
            {order.returnRequest.note && (
              <p className="text-xs text-slate-500">Admin note: {order.returnRequest.note}</p>
            )}
            {order.refundStatus && (
              <p className="text-xs text-slate-500">
                Refund: <span className="font-semibold text-slate-700">{order.refundStatus}</span>
                {order.refundId ? ` · ${order.refundId}` : ""}
              </p>
            )}
          </div>

          {order.returnRequest.status === "Requested" && (
            <div className="mt-4">
              {!showReject ? (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => handleReturnDecision("approve")}
                    disabled={returnDeciding}
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
                  >
                    <CheckCircle className="h-4 w-4" /> Approve & Refund
                  </button>
                  <button
                    onClick={() => setShowReject(true)}
                    disabled={returnDeciding}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-5 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    rows={2}
                    placeholder="Reason for rejecting the return (shown to the customer)…"
                    className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
                  />
                  <div className="flex items-center gap-3">
                    <button onClick={() => handleReturnDecision("reject")} disabled={returnDeciding} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60">Confirm Reject</button>
                    <button onClick={() => { setShowReject(false); setRejectNote(""); }} disabled={returnDeciding} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Order Timeline — full status history with date, time and who acted */}
      {(() => {
        const timeline = buildTimeline(order.statusHistory, order.createdAt);
        if (timeline.length === 0) return null;
        return (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4">
              <Truck className="h-5 w-5 text-slate-600" />
              <h2 className="text-lg font-semibold text-slate-900">Order Timeline</h2>
            </div>
            <ol className="relative">
              {timeline.map((step, i) => {
                const negative = isNegativeStatus(step.status);
                const isLast = i === timeline.length - 1;
                return (
                  <li key={i} className="flex gap-3 pb-5 last:pb-0">
                    <div className="flex flex-col items-center">
                      {negative
                        ? <XCircle className="h-5 w-5 shrink-0 text-red-500" />
                        : <CheckCircle className="h-5 w-5 shrink-0 text-green-600" />}
                      {!isLast && <span className="mt-1 w-px flex-1 bg-slate-200" />}
                    </div>
                    <div className="-mt-0.5 min-w-0 flex-1">
                      <p className={`text-sm font-semibold ${negative ? "text-red-600" : "text-slate-900"}`}>
                        {formatStatusLabel(step.status)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatTimelineDate(step.timestamp) || "—"}
                        <span className="text-slate-400"> · by {actorLabel(step.updatedByType)}</span>
                      </p>
                      {step.comment && (
                        <p className="mt-0.5 text-xs text-slate-500">{step.comment}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}

      {/* Order Details */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-4">
          <Package className="h-5 w-5 text-slate-600" />
          <h2 className="text-lg font-semibold text-slate-900">Order Information</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-slate-600">Order Date</p>
            <p className="text-base font-medium text-slate-900 mt-1">
              {new Date(order.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Status</p>
            <p className={`text-base font-medium mt-1 ${["RECEIVED_AT_ADMIN_HUB", "APPROVED_BY_ADMIN_HUB"].includes(status) ? "text-teal-600" :
              status === "SHIPPED_TO_CUSTOMER" ? "text-orange-600" :
                status === "DELIVERED" ? "text-green-600" : "text-slate-600"
              }`}>
              {status.replace(/_/g, " ")}
            </p>
            {hasShipments && !isTerminal && status !== 'DELIVERED' && (
              <p className="text-xs text-slate-500 mt-1">
                {approvedCount} of {totalShipmentCount} vendor shipment{totalShipmentCount === 1 ? '' : 's'} approved
              </p>
            )}
          </div>
          {/* TODO: Uncomment when tracking reference feature is implemented
          <div>
            <p className="text-sm text-slate-600">Tracking Ref</p>
            <p className="text-base font-medium text-slate-900 mt-1">
              {order.trackingReference || "N/A"}
            </p>
          </div>
          */}
        </div>
        {/* Subtotal → Discount → Taxable → Tax → Shipping → Total: the coupon
            reduces the taxable base (GST is charged on the post-coupon net). */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mt-6 pt-4 border-t border-slate-200">
          <div>
            <p className="text-sm text-slate-600">Subtotal</p>
            <p className="text-base font-medium text-slate-900 mt-1">
              {money(order.subtotal)}
            </p>
          </div>
          {order.discount > 0 && (
            <div>
              <p className="text-sm text-slate-600">Discount</p>
              <p className="text-base font-medium text-green-600 mt-1">
                −{money(order.discount)}
              </p>
            </div>
          )}
          {order.discount > 0 && (
            <div>
              <p className="text-sm text-slate-600">Taxable amount</p>
              <p className="text-base font-medium text-slate-900 mt-1">
                {money(Math.max(0, order.subtotal - order.discount))}
              </p>
            </div>
          )}
          <div>
            <p className="text-sm text-slate-600">Tax</p>
            <p className="text-base font-medium text-slate-900 mt-1">
              {money(order.tax)}
            </p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Shipping</p>
            <p className="text-base font-medium text-slate-900 mt-1">
              {money(order.shippingCost)}
            </p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Total Amount</p>
            <p className="text-lg font-bold text-slate-900 mt-1">
              {money(order.totalAmount)}
            </p>
          </div>
        </div>
      </div>

      {/* Product Details */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Product Details</h2>
        <div className="space-y-4">
          {order.items?.map((item: any) => (
            <div key={item.id} className="flex gap-4 p-4 border border-slate-100 rounded-lg">
              <img
                src={item.productImage || "/assets/images/placeholder.jpg"}
                alt={item.productName}
                className="w-24 h-24 object-cover rounded-lg border border-slate-200"
              />
              <div className="flex-1">
                <h3 className="text-base font-semibold text-slate-900">{item.productName}</h3>
                <p className="text-sm text-slate-600 mt-1">SKU: {item.sku}</p>
                {(item.size || item.color) && (
                  <div className="flex items-center gap-2 mt-1">
                    {item.size && <p className="text-sm text-slate-600">Size: {item.size}</p>}
                    {item.size && item.color && <span className="text-slate-300">|</span>}
                    {item.color && (
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm text-slate-600">Color:</p>
                        <div 
                          className="w-4 h-4 rounded-full border border-slate-300 shadow-sm"
                          style={{ backgroundColor: item.colorHex || item.color }}
                          title={item.color}
                        />
                        <span className="text-xs text-slate-500 capitalize">{item.color}</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                  <div>
                    <p className="text-sm text-slate-600">Quantity</p>
                    <p className="text-base font-medium text-slate-900">{item.quantity}</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Unit Price</p>
                    <p className="text-base font-medium text-slate-900">
                      {money(item.unitPrice)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Total Price</p>
                    <p className="text-base font-medium text-slate-900">
                      {money(item.totalPrice ?? item.unitPrice * item.quantity)}
                    </p>
                  </div>
                </div>

                {/* Customer's Selected Delivery — the courier / transport / ETA the
                    customer chose at checkout, frozen on the order line. Lets the admin
                    see the choice before dispatching (and spot a courier change).
                    Always shown; falls back to a note for legacy/free-shipping lines
                    that carry no delivery snapshot. */}
                {(() => {
                  const lc = item.logistics?.courier || item.courier || null;
                  const lt = item.logistics?.transportType || item.transportType || null;
                  const ld = item.logistics?.deliveryDays ?? null;
                  const ls = item.logistics?.shippingCostInr ?? null;
                  const hasAny = !!lc || !!lt || ld != null;
                  const region = order.currency === "USD" ? "US" : "IN";
                  return (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Truck className="h-4 w-4 text-slate-500" />
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Customer&apos;s Selected Delivery</p>
                      </div>
                      {hasAny ? (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div>
                            <p className="text-xs text-slate-500">Courier</p>
                            <p className="text-sm font-medium text-slate-900">{lc ? courierName(lc) : "—"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500">Mode</p>
                            <p className="text-sm font-medium text-slate-900">{lt ? transportModeLabel(lt, region) : "—"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500">Delivery Estimate</p>
                            <p className="text-sm font-medium text-slate-900">{ld != null ? `${ld} day${ld === 1 ? "" : "s"}` : "—"}</p>
                          </div>
                          {order.currency === "INR" && ls != null && (
                            <div>
                              <p className="text-xs text-slate-500">Shipping</p>
                              <p className="text-sm font-medium text-slate-900">{ls > 0 ? `₹${ls.toLocaleString("en-IN")}` : "Free"}</p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-400 italic">No courier preference recorded for this item (free-shipping or a legacy order placed before courier selection).</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Payment Method */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-4">
          <CreditCard className="h-5 w-5 text-slate-600" />
          <h2 className="text-lg font-semibold text-slate-900">Payment Information</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-slate-600">Payment Method</p>
            <p className="text-base font-medium text-slate-900 mt-1">{order.paymentMethod}</p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Transaction ID</p>
            <p className="text-base font-medium text-slate-900 mt-1">{order.paymentId || "N/A"}</p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Payment Status</p>
            <p className="text-base font-medium text-green-600 mt-1">{order.paymentStatus}</p>
          </div>
        </div>
      </div>

      {/* Customer Details — unified layout shared with VendorToHubDetail and OrderDetail */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-4">
          <User className="h-5 w-5 text-slate-600" />
          <h2 className="text-lg font-semibold text-slate-900">Customer Details</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-slate-900 mb-2">Customer Info</h3>
            <p className="text-sm text-slate-600">{order.customerName}</p>
            <p className="text-sm text-slate-600">{order.customerEmail}</p>
            {order.customerPhone && (
              <p className="text-sm text-slate-600">{formatPhoneForDisplay(order.customerPhone, order?.shippingAddress?.country)}</p>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-slate-900 mb-2">Delivery Address</h3>
            <div className="text-sm text-slate-600">
              {order?.shippingAddress ? (
                <>
                  {(() => {
                    const a = order.shippingAddress;
                    const recipient = a.firstName && a.lastName
                      ? `${a.firstName} ${a.lastName}`
                      : a.firstName || a.name || "";
                    return recipient ? (
                      <p className="font-medium text-slate-900">{recipient}</p>
                    ) : null;
                  })()}
                  <p>{order.shippingAddress.address || order.shippingAddress.street}</p>
                  {order.shippingAddress.addressLine2 && <p>{order.shippingAddress.addressLine2}</p>}
                  <p>
                    {order.shippingAddress.city}, {getStateName(order.shippingAddress.state ?? "", order.shippingAddress.country)} {order.shippingAddress.zipCode || order.shippingAddress.postalCode}
                  </p>
                  <p>{getCountryName(order.shippingAddress.country)}</p>
                </>
              ) : "N/A"}
            </div>
          </div>
        </div>
      </div>

      {/* Hub Location */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-4">
          <MapPin className="h-5 w-5 text-slate-600" />
          <h2 className="text-lg font-semibold text-slate-900">Hub Information</h2>
        </div>
        <div className="bg-teal-50 border border-teal-200 p-4 rounded-lg">
          <p className="text-sm text-teal-800">
            Order processing from <span className="font-semibold">{order.hub?.name || "Admin Central Hub"}</span>
          </p>
        </div>
      </div>

      {/* Vendor Shipments Summary */}
      {hasShipments && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="flex items-center gap-2 mb-4">
            <Truck className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-semibold text-slate-900">Vendor Shipments</h2>
            <span className="text-sm text-slate-500 ml-auto">
              {nonCancelledShipments.filter((s) => s.status === 'APPROVED_BY_ADMIN_HUB').length}/{nonCancelledShipments.length} approved
            </span>
          </div>
          {hasRejectedShipment && (
            <div className="bg-red-50 border border-red-200 p-3 rounded-lg mb-4 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              <p className="text-sm text-red-800">
                One or more vendor shipments were rejected. Resolve before shipping to customer.
              </p>
            </div>
          )}
          <div className="space-y-3">
            {shipments.map((s) => {
              const reviewData = (s as VendorShipment & { adminReviews?: Array<{ approved?: boolean; rating?: number; rejectionReason?: string | null; qualityCheckNotes?: string | null; reviewComments?: string | null }> }).adminReviews?.[0];
              const isRejected = s.status === 'REJECTED_BY_ADMIN_HUB';
              const hasRejectionDetail = isRejected && (reviewData?.rejectionReason || reviewData?.qualityCheckNotes || reviewData?.reviewComments);
              return (
                <div key={s.id} className="overflow-hidden rounded-lg border border-slate-100">
                  <div className="flex items-center gap-4 p-3">
                    {s.status === 'APPROVED_BY_ADMIN_HUB' ? (
                      <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                    ) : s.status === 'REJECTED_BY_ADMIN_HUB' ? (
                      <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                    ) : s.status === 'CANCELLED' ? (
                      <XCircle className="h-5 w-5 text-slate-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900">{s.vendorName}</p>
                      <p className="text-xs text-slate-500">
                        {s.items?.length || 0} item{(s.items?.length || 0) !== 1 ? 's' : ''} &middot; {s.status.replace(/_/g, ' ')}
                      </p>
                    </div>
                    {s.vendorCarrier && (
                      <p className="text-xs text-slate-500 shrink-0">
                        {s.vendorCarrier}: {s.vendorTrackingId}
                      </p>
                    )}
                    {reviewData?.approved && typeof reviewData.rating === 'number' && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                        <span className="text-xs font-medium text-slate-700">{reviewData.rating}/5</span>
                      </div>
                    )}
                  </div>

                  {/* Why the hub rejected this vendor shipment — the reason + QC notes the
                      admin recorded at review time, so it's visible without digging. */}
                  {hasRejectionDetail && (
                    <div className="border-t border-red-100 bg-red-50 px-3 py-2.5">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
                        <XCircle className="h-3.5 w-3.5" /> Rejection reason
                      </p>
                      {reviewData?.rejectionReason && (
                        <p className="mt-1 text-sm text-red-800">{reviewData.rejectionReason}</p>
                      )}
                      {reviewData?.qualityCheckNotes && (
                        <p className="mt-1 text-xs text-red-700/80"><span className="font-medium">QC notes:</span> {reviewData.qualityCheckNotes}</p>
                      )}
                      {reviewData?.reviewComments && (
                        <p className="mt-1 text-xs text-red-700/80"><span className="font-medium">Comments:</span> {reviewData.reviewComments}</p>
                      )}
                    </div>
                  )}
                  {isRejected && !hasRejectionDetail && (
                    <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700/80">
                      Rejected at the hub — no written reason was recorded.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Delivery Instructions */}
      {status !== "DELIVERED" && (
        <div className="bg-blue-50 border border-blue-200 p-6 rounded-lg">
          <h3 className="text-sm font-semibold text-blue-900 mb-2">Delivery Instructions</h3>
          <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
            <li>Verify customer identity before delivery</li>
            <li>Ensure product is in good condition</li>
            <li>Get customer signature or confirmation</li>
            <li>Update delivery status immediately after handover</li>
            <li>Contact customer if delivery address is unclear</li>
          </ul>
        </div>
      )}

      {/* Delivery Completed Message */}
      {status === "DELIVERED" && (
        <div className="bg-green-50 border border-green-200 p-6 rounded-lg">
          <h3 className="text-sm font-semibold text-green-900 mb-2">Order Delivered Successfully</h3>
          <p className="text-sm text-green-800">
            This order has been successfully delivered to the customer. The order lifecycle is now complete.
          </p>
        </div>
      )}

      {/* Ship-to-customer dispatch modal — courier partner + tracking ID */}
      {showShipModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div className="h-1 w-full bg-gradient-to-r from-orange-500 via-orange-400 to-orange-500" />
            <div className="flex items-center gap-3 px-6 py-4">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-orange-50 text-orange-600">
                <Truck className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-[16px] font-bold text-slate-900">Ship to Customer</h3>
                <p className="text-[12.5px] text-slate-500">Order #{order.orderId}</p>
              </div>
            </div>

            <div className="space-y-4 px-6 pb-2">
              {liveActive ? (
                /* Live courier (Delhivery): ships against the already-created AWB —
                   no manual courier / tracking entry. */
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Delhivery AWB</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-slate-900">{order.trackingReference}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    This order ships via Delhivery. Confirming marks it out for delivery using the AWB above —
                    the customer is notified with this tracking number.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Courier Partner <span className="text-orange-600">*</span>
                    </label>
                    <Dropdown
                      value={shipCourier}
                      options={courierOptions}
                      onChange={(v) => setShipCourier(v as string)}
                      placeholder={courierOptions.length ? "Select a courier partner" : "No couriers configured"}
                      disabled={submittingShip}
                    />
                    {customerCourierId && shipCourier === customerCourierId && (
                      <p className="mt-1.5 text-xs text-slate-500">Defaulted to the courier the customer selected — change it if needed.</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Tracking ID <span className="text-orange-600">*</span>
                    </label>
                    <input
                      type="text"
                      value={shipTracking}
                      onChange={(e) => setShipTracking(e.target.value)}
                      disabled={submittingShip}
                      placeholder="Enter the courier tracking ID"
                      className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none transition-all focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 disabled:bg-slate-50"
                    />
                    <p className="mt-1.5 text-xs text-slate-500">The customer is notified with this tracking ID.</p>
                  </div>
                </>
              )}
            </div>

            <div className="mt-2 flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowShipModal(false)}
                disabled={submittingShip}
                className="rounded-full border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmShip}
                disabled={submittingShip || (!liveActive && (!shipCourier || !shipTracking.trim()))}
                className="inline-flex items-center gap-2 rounded-full bg-orange-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submittingShip ? "Shipping…" : "Confirm & Ship"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Order modal — whole order, any pre-shipment stage */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-1 flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <h3 className="text-lg font-semibold text-slate-900">Cancel Order</h3>
            </div>
            <p className="mb-4 text-sm text-slate-500">
              This cancels the entire order{["PAID", "SUCCESS", "CAPTURED"].includes(String(order.paymentStatus || "").toUpperCase())
                ? " and automatically refunds the customer"
                : ""}. All pending vendor settlements will be cancelled. This can&apos;t be undone.
            </p>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">Reason</label>
            <div className="space-y-2">
              {ADMIN_CANCEL_REASONS.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="admin-cancel-reason"
                    value={r}
                    checked={cancelChoice === r}
                    onChange={() => setCancelChoice(r)}
                    className="h-4 w-4 accent-red-600"
                  />
                  {r}
                </label>
              ))}
            </div>
            {cancelChoice === "Other" && (
              <textarea
                value={cancelOther}
                onChange={(e) => setCancelOther(e.target.value)}
                placeholder="Enter the reason…"
                rows={3}
                className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm text-slate-700 focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
              />
            )}

            {/* Restock decision — cancellation does not add stock back unless approved here. */}
            <label className="mb-1.5 mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">Return stock to inventory?</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCancelRestock(true)}
                className={`rounded-lg border-2 px-3 py-2.5 text-left text-sm font-semibold transition-all ${cancelRestock === true ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}
              >
                Yes, add back
                <span className="mt-0.5 block text-[11px] font-normal text-slate-400">Units return to sellable stock</span>
              </button>
              <button
                type="button"
                onClick={() => setCancelRestock(false)}
                className={`rounded-lg border-2 px-3 py-2.5 text-left text-sm font-semibold transition-all ${cancelRestock === false ? "border-red-500 bg-red-50 text-red-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}
              >
                No, write off
                <span className="mt-0.5 block text-[11px] font-normal text-slate-400">Stock is not restocked</span>
              </button>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setShowCancelModal(false); setCancelRestock(null); }}
                disabled={cancelling}
                className="rounded-full border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                Keep Order
              </button>
              <button
                type="button"
                onClick={handleCancelOrder}
                disabled={cancelling || !cancelChoice || (cancelChoice === "Other" && !cancelOther.trim()) || cancelRestock === null}
                className="inline-flex items-center gap-2 rounded-full bg-red-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelling ? "Cancelling…" : "Cancel Order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
