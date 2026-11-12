"use client"

import { Calendar } from "lucide-react"
import { CheckoutFormData } from "../Checkout"
import { getCountryName, getCountryFlag, getStateName, formatPhoneForDisplay } from "./constants"

interface ReviewOrderProps {
  formData: CheckoutFormData
  /** Dynamic delivery estimate computed from the chosen courier/transport per line. */
  deliveryEstimate?: { days: number; dateLabel: string; mode?: 'AIR' | 'SHIP' } | null
  /** True when a live courier (Delhivery) handles the order — the ETA is confirmed by
   *  the carrier after dispatch, so we don't show the manual per-product estimate. */
  liveCourier?: boolean
}

export default function ReviewOrder({ formData, deliveryEstimate, liveCourier }: ReviewOrderProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-playfair text-lg font-semibold text-[#1a1a1a] mb-4">Shipping Information</h3>
        <div className="text-sm text-[#6b625b] space-y-1">
          <p className="font-semibold text-[#1a1a1a] border-b border-[#f5efe8] pb-1 mb-2">
            {[formData.firstName, formData.middleName, formData.lastName].filter(Boolean).join(" ")}
          </p>
          <div className="space-y-0.5">
            <p>{formData.address}</p>
            {formData.addressLine2 && <p>{formData.addressLine2}</p>}
            {formData.addressLine3 && <p>{formData.addressLine3}</p>}
            {formData.landmark && <p className="text-[#8a807a]">Landmark: {formData.landmark}</p>}
            <p>{formData.city}, {getStateName(formData.state, formData.country)} {formData.zipCode}</p>
            <p className="flex items-center gap-1.5 mt-1 text-[#8a807a] font-medium italic">
              Shipping to: {getCountryName(formData.country)} {getCountryFlag(formData.country)}
            </p>
          </div>
          <div className="mt-4 pt-4 border-t border-[#f0e8df] grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs uppercase tracking-wider text-[#a2968b]">
            <div>
              <p className="font-bold text-[#8a807a] mb-0.5">Email</p>
              <p className="normal-case tracking-normal text-[#6b625b] font-medium">{formData.email}</p>
            </div>
            <div>
              <p className="font-bold text-[#8a807a] mb-0.5">Phone</p>
              <p className="normal-case tracking-normal text-[#6b625b] font-medium">{formatPhoneForDisplay(formData.phone, formData.country)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[#f0e8df] pt-6">
        <h3 className="font-playfair text-lg font-semibold text-[#1a1a1a] mb-4">Payment Method</h3>
        <div className="text-sm text-[#6b625b]">
          {formData.paymentMethod === "razorpay" && (
            <>
              <p className="font-medium">Razorpay</p>
              <p>Pay securely via Razorpay</p>
            </>
          )}
          {formData.paymentMethod === "payu" && (
            <>
              <p className="font-medium">PayU</p>
              <p>Pay securely via PayU</p>
            </>
          )}
        </div>
      </div>

      <div className="rounded-2xl border-l-2 border-[#e01a1b] bg-[#fdf6f4] p-4 ring-1 ring-[#f4e2de]">
        <div className="flex items-center gap-3">
          <Calendar className="w-5 h-5 text-[#e01a1b]" />
          <div>
            <h4 className="font-semibold text-[#1a1a1a]">Estimated Delivery</h4>
            {liveCourier ? (
              <p className="text-sm text-[#5a524b]">Confirmed by our courier partner after dispatch</p>
            ) : deliveryEstimate ? (
              <p className="text-sm text-[#5a524b]">
                <span className="font-semibold text-[#1a1a1a]">Arrives by {deliveryEstimate.dateLabel}</span>
                <span className="text-[#8a807a]">
                  {" "}· {deliveryEstimate.days} {deliveryEstimate.days === 1 ? "day" : "days"}
                  {deliveryEstimate.mode ? ` via ${deliveryEstimate.mode === "AIR" ? "Air" : "Surface"}` : ""}
                </span>
              </p>
            ) : (
              <p className="text-sm text-[#5a524b]">Calculated once shipping is selected</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
