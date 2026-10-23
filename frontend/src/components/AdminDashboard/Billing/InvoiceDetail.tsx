"use client";

import { useState, useEffect, useRef, useCallback } from "react";

import { ArrowLeft, Printer, RefreshCw, FileText, CreditCard, CheckCircle2, Clock, Hash, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { showErrorToast } from "@/lib/toast-utils";
import { orderService, Order } from "@/services/orderService";
import { formatPrice } from "@/lib/currency";
import axios from "@/lib/axios";
import { hasPermission } from "@/lib/auth";
import { getCountryName, getStateName } from "@/components/WebSite/CheckOut/CheckoutProcess/constants";

interface InvoiceDetailProps {
  invoiceId: string; // can be order.id (ObjectId) or order.orderId (ORD-...) or order.invoiceNo (INV-...)
}

const fmtDate = (d?: string) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const fmtDateTime = (d?: string) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) : "—";

const isPaid = (s?: string) => ["PAID", "SUCCESS", "CAPTURED"].includes((s || "").toUpperCase());

export default function InvoiceDetail({ invoiceId }: InvoiceDetailProps) {
  const router = useRouter();
  const invoiceRef = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [companyName, setCompanyName] = useState("M2C Store");
  const [companyLogo, setCompanyLogo] = useState<string | null>(null);

  // ── Fetch order ────────────────────────────────────────────────────────────
  const fetchOrder = useCallback(async () => {
    setLoading(true);
    try {
      const [orderRes, companyRes] = await Promise.all([
        orderService.getAdminOrderById(invoiceId),
        axios.get('/company-info').catch(() => null),
      ]);
      if (orderRes.success) setOrder(orderRes.data);
      if (companyRes?.data?.success) {
        setCompanyName(companyRes.data.data?.companyName || "M2C Store");
        // No bundled logo fallback (logos are DB-driven); the invoice header
        // renders the logo only when one is set, otherwise it's omitted.
        setCompanyLogo(companyRes.data.data?.companyLogo || null);
      } else {
        setCompanyLogo(null);
      }
    } catch (err: any) {
      showErrorToast("Error", err.message || "Failed to load invoice");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);

  // ── Print via backend HTML ─────────────────────────────────────────────────
  const handlePrint = async () => {
    if (!order) return;
    setPrinting(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";
      const token = localStorage.getItem("adminToken") || sessionStorage.getItem("adminToken") || "";
      const response = await fetch(`${baseUrl}/orders/admin/${order.id}/invoice`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      const html = await response.text();
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        // Trigger print after content loads
        setTimeout(() => win.print(), 300);
      }
    } catch {
      showErrorToast("Error", "Failed to generate invoice for printing");
    } finally {
      setPrinting(false);
    }
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-slate-400 mr-3" />
        <span className="text-slate-500">Loading invoice…</span>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-20">
        <FileText className="h-12 w-12 text-slate-300 mx-auto mb-3" />
        <p className="text-slate-500">Invoice not found</p>
        <button onClick={() => router.back()} className="mt-4 text-sm text-indigo-600 hover:underline">
          Go back
        </button>
      </div>
    );
  }

  // Every figure on an invoice is denominated in the currency the customer was
  // actually charged in — never assume INR (a .com order is billed in USD).
  const money = (n: number) => formatPrice(n, order.currency === "USD" ? "USD" : "INR");

  const addr = typeof order.shippingAddress === "string"
    ? JSON.parse(order.shippingAddress)
    : order.shippingAddress || {};

  const stateDisplay = getStateName(addr.state || "", addr.country);
  const countryDisplay = getCountryName(addr.country);
  // Distinct from order.customerName (account holder) — this is the shipping
  // recipient (who actually receives the package), e.g. when the customer
  // ships a gift to someone else. Falls back to legacy addr.name.
  const recipientName = addr.firstName && addr.lastName
    ? `${addr.firstName} ${addr.lastName}`
    : addr.firstName || addr.name || "";
  const addrStr = [
    addr.addressLine1 || addr.street || addr.address,
    addr.addressLine2,
    addr.city && stateDisplay ? `${addr.city}, ${stateDisplay}` : (addr.city || stateDisplay),
    addr.postalCode || addr.zipCode,
    countryDisplay,
  ].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">

      {/* ── Action Bar ── */}
      <div className="flex items-center justify-between print:hidden">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-slate-600" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Invoice Detail</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-sm text-slate-500">Order: <span className="font-mono font-semibold">{order.orderId}</span></span>
              {order.invoiceNo && (
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-0.5">
                  <FileText className="h-3 w-3" />
                  {order.invoiceNo}
                </span>
              )}
            </div>
          </div>
        </div>
        {hasPermission("invoices:print") && (
          <button
            onClick={handlePrint}
            disabled={printing}
            className="flex items-center gap-2 px-5 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 transition-colors font-medium"
          >
            {printing
              ? <RefreshCw className="h-4 w-4 animate-spin" />
              : <Printer className="h-4 w-4" />}
            {printing ? "Generating…" : "Print Invoice"}
          </button>
        )}
      </div>

      {/* ── Payment Details (admin view — individual section) ── */}
      <div className="print:hidden">
        <div className="mb-3 flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-brand-500" />
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Payment Details</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {/* Amount */}
          <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-500">
              <Wallet className="h-3.5 w-3.5" /> Amount Paid
            </div>
            <p className="text-xl font-bold text-slate-900 tabular-nums">{money(order.totalAmount)}</p>
          </div>
          {/* Status */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Status
            </div>
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${
              isPaid(order.paymentStatus)
                ? "bg-green-100 text-green-700"
                : "bg-yellow-100 text-yellow-700"
            }`}>
              {order.paymentStatus || "PENDING"}
            </span>
          </div>
          {/* Method */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <CreditCard className="h-3.5 w-3.5" /> Payment Method
            </div>
            <p className="text-sm font-semibold capitalize text-slate-900">{order.paymentMethod || "—"}</p>
          </div>
          {/* Time */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <Clock className="h-3.5 w-3.5" /> Payment Time
            </div>
            <p className="text-sm font-semibold text-slate-900">{fmtDateTime(order.orderDate || order.createdAt)}</p>
          </div>
          {/* Txn ID */}
          <div className="col-span-2 rounded-xl border border-slate-200 bg-white p-4 sm:col-span-3 lg:col-span-1">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <Hash className="h-3.5 w-3.5" /> Transaction ID
            </div>
            <p className="break-all font-mono text-xs font-semibold text-slate-900">{order.paymentId || "—"}</p>
          </div>
        </div>
      </div>

      {/* ── Invoice Document — A4 proportions (210×297mm ≈ 794×1123px @96dpi),
          centred so it reads like a sheet instead of stretching full width. ── */}
      <div ref={invoiceRef} className="mx-auto flex w-full max-w-[794px] min-h-[1123px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_40px_-20px_rgba(0,0,0,0.25)]">

        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-r from-brand-600 via-brand-500 to-[#ff6a3d] px-8 py-7 flex justify-between items-start">
          {/* Soft decorative rings */}
          <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/10" />
          <span aria-hidden className="pointer-events-none absolute -left-10 -bottom-24 h-52 w-52 rounded-full bg-black/10" />

          <div className="relative flex items-center gap-4">
            {companyLogo && (
              <img
                src={companyLogo}
                alt={`${companyName} logo`}
                className="h-16 w-auto object-contain rounded-lg bg-white/95 p-1.5 shadow-sm"
              />
            )}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/80">Invoice</p>
              {(companyName !== "M2C Store" && companyName !== "M2C Marketplace Pvt Ltd" && companyName !== "M2C Markdowns Pvt Ltd") && (
                <p className="mt-0.5 text-xl font-bold text-white">{companyName}</p>
              )}
              <p className="mt-1 inline-flex items-center rounded-md bg-white/20 px-2.5 py-1 font-mono text-sm font-bold tracking-wide text-white ring-1 ring-white/30">
                {order.invoiceNo || order.orderId}
              </p>
            </div>
          </div>
          <div className="relative text-right">
            <p className="text-[11px] uppercase tracking-wider text-white/70 mb-1">Date</p>
            <p className="text-white font-semibold">{fmtDate(order.orderDate || order.createdAt)}</p>
            <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold shadow-sm ${
              isPaid(order.paymentStatus) ? "bg-green-500 text-white" : "bg-yellow-400 text-slate-900"
            }`}>
              {isPaid(order.paymentStatus) && <CheckCircle2 className="h-3.5 w-3.5" />}
              {order.paymentStatus || "PENDING"}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col p-8">
          {/* Bill To + Ship To + Order Info — standard 3-column invoice header.
              BILL TO = account holder (payer). SHIP TO = recipient + address. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 pb-8 border-b border-slate-100">
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Bill To</p>
              <p className="font-bold text-slate-900 text-base">{order.customerName || "—"}</p>
              <p className="text-sm text-slate-600 mt-1 break-words">{order.customerEmail}</p>
              <p className="text-sm text-slate-600">{order.customerPhone || "—"}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Ship To</p>
              {(recipientName || addrStr) ? (
                <div className="leading-relaxed">
                  {recipientName && (
                    <p className="font-bold text-slate-900 text-base">{recipientName}</p>
                  )}
                  {addrStr && <p className="text-sm text-slate-600 mt-1">{addrStr}</p>}
                </div>
              ) : (
                <p className="text-sm text-slate-400 italic">Same as billing</p>
              )}
            </div>
            <div className="md:text-right">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Order Info</p>
              <div className="space-y-1 text-sm">
                <div className="flex md:justify-end gap-4">
                  <span className="text-slate-500">Order ID</span>
                  <span className="font-mono font-semibold text-slate-900">{order.orderId}</span>
                </div>
                <div className="flex md:justify-end gap-4">
                  <span className="text-slate-500">Invoice No</span>
                  <span className="font-mono font-semibold text-indigo-700">{order.invoiceNo || "—"}</span>
                </div>
                <div className="flex md:justify-end gap-4">
                  <span className="text-slate-500">Payment</span>
                  <span className="font-semibold text-slate-900">{order.paymentMethod || "—"}</span>
                </div>
                {order.paymentId && (
                  <div className="flex md:justify-end gap-4">
                    <span className="text-slate-500">Txn ID</span>
                    <span className="font-mono text-xs text-slate-600 break-all max-w-[180px]">{order.paymentId}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="mb-8 overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">#</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Item</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">SKU</th>
                  <th className="text-center px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Qty</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Unit Price</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wide">Total</th>
                </tr>
              </thead>
              <tbody>
                {(order.items || []).map((item: any, i: number) => (
                  <tr key={item.id} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/40">
                    <td className="px-4 py-3.5 text-slate-400 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{item.productName}</div>
                      {item.vendorName && <div className="text-xs text-slate-500">Vendor: {item.vendorName}</div>}
                      {item.size && <div className="text-xs text-slate-500">Size: {item.size}</div>}
                      {item.color && <div className="text-xs text-slate-500">Color: {item.color}</div>}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-500">{item.sku || "—"}</td>
                    <td className="px-4 py-3.5 text-center tabular-nums">{item.quantity}</td>
                    <td className="px-4 py-3.5 text-right tabular-nums">{money(item.unitPrice)}</td>
                    <td className="px-4 py-3.5 text-right font-semibold tabular-nums">{money(item.totalPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end">
            {/* Subtotal → Discount → Taxable amount → Tax → Shipping → Grand Total:
                the coupon reduces the taxable base, so GST is on the post-coupon net. */}
            <div className="w-64 space-y-2 text-sm">
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-medium">{money(order.subtotal)}</span>
              </div>
              {order.discount > 0 && (
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-green-600">Discount</span>
                  <span className="font-medium text-green-600">− {money(order.discount)}</span>
                </div>
              )}
              {order.discount > 0 && (
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Taxable amount</span>
                  <span className="font-medium">{money(Math.max(0, order.subtotal - order.discount))}</span>
                </div>
              )}
              {order.tax > 0 && (
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Tax (GST)</span>
                  <span className="font-medium">{money(order.tax)}</span>
                </div>
              )}
              {order.shippingCost > 0 && (
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Shipping</span>
                  <span className="font-medium">{money(order.shippingCost)}</span>
                </div>
              )}
              <div className="mt-3 flex items-center justify-between rounded-xl bg-gradient-to-r from-brand-600 to-[#ff6a3d] px-4 py-3.5 text-white shadow-[0_8px_24px_-10px_rgba(224,26,27,0.6)]">
                <span className="text-base font-bold">Grand Total</span>
                <span className="text-lg font-extrabold tabular-nums">{money(order.totalAmount)}</span>
              </div>
            </div>
          </div>

          {/* Footer — pinned to the bottom of the A4 sheet */}
          <div className="mt-auto pt-6 border-t border-slate-100 text-center">
            <p className="text-sm text-slate-500">Thank you for your purchase!</p>
            <p className="text-xs text-slate-400 mt-1">This is a computer-generated invoice and does not require a signature.</p>
            <a
              href="https://www.m2cmarkdowns.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 text-xs font-semibold text-brand-500 hover:underline"
            >
              www.m2cmarkdowns.com
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
