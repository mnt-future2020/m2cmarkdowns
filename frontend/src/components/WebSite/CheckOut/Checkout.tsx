"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  CreditCard,
  ArrowLeft,
  CheckCircle,
  Truck,
  Lock,
  Shield,
  Loader2,
  ShoppingBag,
  BadgePercent,
  AlertCircle
} from "lucide-react"
import { calculateLogistics, type LogisticsConfig } from "@/lib/logistics"
import { formatPrice, getCurrency, getRegion, getRegionalPrice, getRegionalOriginalPrice, convertUSDtoINR, convertINRtoUSD } from '@/lib/currency'
import courierIntegrationService from '@/services/courierIntegrationService'
import { isIntrastate, gstRateRows } from '@/lib/gst'
import { companyInfoService } from '@/services/companyInfoService'
import { applyOfferToPrice, type ActiveOffer } from '@/lib/offers'
import ShippingForm from "./CheckoutProcess/ShippingForm"
import PaymentForm from "./CheckoutProcess/PaymentForm"
import ReviewOrder from "./CheckoutProcess/ReviewOrder"
import AddressSelector from "./CheckoutProcess/AddressSelector"
import Reveal from "@/components/WebSite/Shared/Reveal"
import OfferCelebration from "@/components/WebSite/Shared/OfferCelebration"
import cartService, { CartItem } from "@/services/cartService"
import orderService, { CreateOrderParams } from "@/services/orderService"
import { stashRecentOrder } from "@/lib/recentOrder"
import paymentService from "@/services/paymentService"
import { walletService } from "@/services/walletService"
import creditPointsService, { CreditPointsSettings } from "@/services/creditPointsService"
import { deliveryZoneService } from "@/services/deliveryZoneService"
import { userProfileService } from "@/services/userProfileService"
import { userAuthService } from "@/services/userAuthService"
import { paymentSettingsService, PublicPaymentSettings } from "@/services/paymentSettingsService"
import { addressService, MAX_SAVED_ADDRESSES, type SavedAddress, type AddressPayload } from "@/services/addressService"
import { DEFAULT_COUNTRY_ISO, normalizeCountryToIso, toE164, formatPhoneAsYouType, validatePhone } from "./CheckoutProcess/constants"

// Declare Razorpay type for TypeScript
declare global {
  interface Window {
    Razorpay: any;
  }
}

/**
 * Split a stored full name into first / middle / last. The first token is the
 * first name, the last token is the last name, and anything between is treated
 * as the middle name (so "A B C D" → first "A", middle "B C", last "D").
 */
function splitFullName(full?: string | null): { firstName: string; middleName: string; lastName: string } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: "", middleName: "", lastName: "" }
  if (parts.length === 1) return { firstName: parts[0], middleName: "", lastName: "" }
  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(" "),
    lastName: parts[parts.length - 1],
  }
}

/** Compose first / middle / last back into a single stored name. */
function joinFullName(firstName: string, middleName: string, lastName: string): string {
  return [firstName, middleName, lastName].map((s) => (s || "").trim()).filter(Boolean).join(" ")
}

export interface CheckoutFormData {
  // Shipping Information
  firstName: string
  middleName: string
  lastName: string
  email: string
  phone: string
  address: string
  addressLine2: string
  addressLine3: string
  landmark: string
  city: string
  state: string
  zipCode: string
  country: string

  // Payment Information
  paymentMethod: "razorpay" | "payu"
  cardNumber: string
  expiryDate: string
  cvv: string
  cardName: string
  upiId: string

  // Options
  saveInfo: boolean
  sameAsBilling: boolean
  shippingMethod: string
}

export default function Checkout() {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState(1)

  /**
   * Whether the order list is showing every line or just the first few.
   *
   * A basket of nine put nine full rows in the summary card, so the card ran
   * far past the form beside it and the page scrolled a long way to reach a
   * total that was already decided. The card now shows the first three and
   * offers the rest, which keeps it near the height of the step it sits
   * beside. Totals are never collapsed — they are the reason for the card.
   */
  const [showAllItems, setShowAllItems] = useState(false)
  const [shippingValid, setShippingValid] = useState(false)
  const [loading, setLoading] = useState(true)
  const [placingOrder, setPlacingOrder] = useState(false)
  const [cartItems, setCartItems] = useState<CartItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paymentSettings, setPaymentSettings] = useState<PublicPaymentSettings | null>(null)

  // Wallet store credit (balance always INR).
  const [walletBalanceInr, setWalletBalanceInr] = useState(0)
  const [useWallet, setUseWallet] = useState(false)

  // Credit (loyalty) points — a tender applied AFTER wallet. Value is INR-based;
  // shown/capped in the order currency, re-clamped authoritatively by the server.
  const [pointsSettings, setPointsSettings] = useState<Partial<CreditPointsSettings>>({})
  const [pointsBalance, setPointsBalance] = useState(0)
  const [usePoints, setUsePoints] = useState(false)
  const [pointsInput, setPointsInput] = useState(0)

  // Saved addresses state
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([])
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null)
  const [useNewAddress, setUseNewAddress] = useState(false)
  const [saveNewAddressToBook, setSaveNewAddressToBook] = useState(false)
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null)

  const [formData, setFormData] = useState<CheckoutFormData>({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
    phone: "",
    address: "",
    addressLine2: "",
    addressLine3: "",
    landmark: "",
    city: "",
    state: "",
    zipCode: "",
    country: DEFAULT_COUNTRY_ISO,
    paymentMethod: "razorpay", // Default to razorpay, will be updated based on available gateways
    cardNumber: "",
    expiryDate: "",
    cvv: "",
    cardName: "",
    upiId: "",
    saveInfo: false,
    sameAsBilling: true,
    shippingMethod: "standard"
  })

  // Shipping costs
  const shippingCosts: Record<string, number> = {
    standard: 0,
    express: 9.99,
    overnight: 24.99
  }

  const [discountAmount, setDiscountAmount] = useState(0)
  const [couponCode, setCouponCode] = useState("")
  const [freeShippingApplied, setFreeShippingApplied] = useState(false)
  const [freeShippingMessage, setFreeShippingMessage] = useState("")

  const [orderSummary, setOrderSummary] = useState({
    subtotal: 0,
    shipping: 0,
    shippingTax: 0,
    tax: 0,
    discount: 0,
    total: 0
  })

  // Destination delivery zone: availability + flat fee + shipping GST. Weight
  // shipping (INR) is lifted out of calculateTotals so the quote effect can use it.
  const [weightShipInr, setWeightShipInr] = useState(0)
  const [delivery, setDelivery] = useState<{ checked: boolean; serviceable: boolean; zoneName?: string; feeOrderCcy: number; taxOrderCcy: number; gstPct: number }>(
    { checked: false, serviceable: true, feeOrderCcy: 0, taxOrderCcy: 0, gstPct: 0 }
  )

  // Admin/Company registered State = GST SUPPLIER state (place-of-supply split).
  // Fetched from public company info; falls back to a single "Tax (GST)" row
  // until it loads (and for any legacy config without a state set).
  const [supplierLocation, setSupplierLocation] = useState<{ state: string | null; country: string | null }>({ state: null, country: null })
  useEffect(() => {
    companyInfoService.getPublicCompanyInfo()
      .then((ci) => setSupplierLocation({ state: ci?.state ?? null, country: ci?.country ?? null }))
      .catch(() => { /* keep fallback */ })
  }, [])

  // Dynamic delivery estimate: the slowest line decides when the whole order lands.
  // Days come from each item's chosen transport (Air/Surface) in its logistics config;
  // the date is today + that many days. Computed in an effect so `new Date()` never runs
  // during render (the repo forbids impure calls there).
  const [deliveryEstimate, setDeliveryEstimate] = useState<{ days: number; dateLabel: string; mode?: 'AIR' | 'SHIP' } | null>(null)

  // When the live courier integration (Delhivery) is active for India, it assigns the
  // carrier, so India (INR) lines don't carry a manually-chosen courier. Don't block
  // order placement on a missing courier in that case. International is unchanged.
  const [liveCourierActiveIN, setLiveCourierActiveIN] = useState(false)
  const [useLiveRatesIN, setUseLiveRatesIN] = useState(false)
  useEffect(() => {
    courierIntegrationService.getPublicStatus()
      .then((res) => { setLiveCourierActiveIN(!!res?.data?.liveActiveIN); setUseLiveRatesIN(!!res?.data?.useLiveRates) })
      .catch(() => { setLiveCourierActiveIN(false); setUseLiveRatesIN(false) })
  }, [])
  const courierPickerHidden = liveCourierActiveIN && getRegion() === 'IN'

  // Live Delhivery shipping rate for India orders (replaces the weight-based rate).
  // Fetched once a 6-digit delivery pincode is known; null → use the manual rate.
  // The backend computes the cart weight the same way createOrder does, so this
  // figure, the payment amount, and the final order all match.
  const [liveShipInr, setLiveShipInr] = useState<number | null>(null)
  useEffect(() => {
    if (!useLiveRatesIN || getRegion() !== 'IN' || !cartItems.length) { setLiveShipInr(null); return }
    const pin = (formData.zipCode || '').trim()
    if (!/^\d{6}$/.test(pin)) { setLiveShipInr(null); return }
    let cancelled = false
    courierIntegrationService.getCartLiveRate(pin)
      .then((res) => {
        if (cancelled) return
        const d = res?.data
        setLiveShipInr(d?.liveRate && typeof d.shippingInr === 'number' ? d.shippingInr : null)
      })
      .catch(() => { if (!cancelled) setLiveShipInr(null) })
    return () => { cancelled = true }
  }, [useLiveRatesIN, formData.zipCode, cartItems])

  useEffect(() => {
    if (!cartItems.length) { setDeliveryEstimate(null); return }
    let maxDays = 0
    const modes = new Set<'AIR' | 'SHIP'>()
    for (const item of cartItems) {
      const config = (item.product as any)?.logisticsConfig
      if (!config) continue
      const types = Array.isArray(config.transportTypes) ? config.transportTypes : []
      const mode = ((item as any).transportType || types[0]) as 'AIR' | 'SHIP' | undefined
      const result = calculateLogistics(config as LogisticsConfig, item.quantity, mode, getRegion())
      if (result.deliveryDays > maxDays) maxDays = result.deliveryDays
      if (result.selectedTransport) modes.add(result.selectedTransport)
    }
    if (maxDays <= 0) { setDeliveryEstimate(null); return }
    const d = new Date()
    d.setDate(d.getDate() + maxDays)
    const dateLabel = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    setDeliveryEstimate({ days: maxDays, dateLabel, mode: modes.size === 1 ? [...modes][0] : undefined })
  }, [cartItems])

  useEffect(() => {
    fetchCart()
    fetchUserProfile()
    fetchSavedAddresses()
    fetchPaymentSettings()
    loadRazorpayScript()

    // Load applied coupon
    const savedCoupon = localStorage.getItem('appliedCoupon')
    if (savedCoupon) {
      try {
        const { code, discountAmount, freeShipping, freeShippingMessage } = JSON.parse(savedCoupon)
        setCouponCode(code || "")
        setDiscountAmount(discountAmount || 0)
        setFreeShippingApplied(freeShipping || false)
        setFreeShippingMessage(freeShippingMessage || "")
      } catch (e) {
        console.error("Failed to parse coupon", e)
      }
    }

  }, [])

  useEffect(() => {
    calculateTotals()
  }, [cartItems, formData.shippingMethod, discountAmount, freeShippingApplied, delivery.feeOrderCcy, delivery.taxOrderCcy, liveShipInr])

  // Destination delivery-zone quote: serviceability + flat fee + shipping GST.
  // Runs when the shipping address or the weight-based shipping changes. INR
  // figures are converted to the order currency for the summary + payment.
  useEffect(() => {
    const country = formData.country, state = formData.state, city = formData.city
    if (!country || !state || !city) { setDelivery({ checked: false, serviceable: true, feeOrderCcy: 0, taxOrderCcy: 0, gstPct: 0 }); return }
    let cancelled = false
    deliveryZoneService.quote({ country, state, city, pincode: formData.zipCode, currency: getCurrency(), weightShippingInr: weightShipInr, freeShipping: freeShippingApplied })
      .then((q) => {
        if (cancelled) return
        if (!q.serviceable) { setDelivery({ checked: true, serviceable: false, feeOrderCcy: 0, taxOrderCcy: 0, gstPct: 0 }); return }
        const toCcy = (inr: number) => getCurrency() === 'USD' ? convertINRtoUSD(inr) : inr
        setDelivery({
          checked: true, serviceable: true, zoneName: q.zone?.name,
          feeOrderCcy: toCcy(q.flatFeeInr || 0),
          taxOrderCcy: toCcy(q.shippingTaxInr || 0),
          gstPct: q.shippingGstPct || 0,
        })
      })
    return () => { cancelled = true }
  }, [formData.country, formData.state, formData.city, formData.zipCode, weightShipInr, freeShippingApplied])

  // Load the customer's wallet balance so it can be offered at checkout.
  useEffect(() => {
    walletService.getMyWallet()
      .then((res) => setWalletBalanceInr(res.data?.balance || 0))
      .catch(() => setWalletBalanceInr(0))
  }, [])

  // Load the credit-points settings + balance for the redeem widget.
  useEffect(() => {
    creditPointsService.getPublicSettings()
      .then((res) => {
        setPointsSettings(res.data?.settings || {})
        setPointsBalance(res.data?.balance || 0)
      })
      .catch(() => { setPointsSettings({}); setPointsBalance(0) })
  }, [])

  // Wallet redemption (tender applied after the total). Balance is INR; show/cap it
  // in the order currency. walletApplied never exceeds the balance or the total.
  const money2 = (n: number) => Number((n || 0).toFixed(2))
  const walletBalanceOrderCcy = getCurrency() === 'USD' ? money2(convertINRtoUSD(walletBalanceInr)) : money2(walletBalanceInr)
  const walletApplied = useWallet ? money2(Math.min(walletBalanceOrderCcy, orderSummary.total)) : 0
  // Wallet alone covers the whole order → no gateway needed (points are irrelevant here).
  const walletCoversAll = walletApplied > 0 && money2(orderSummary.total - walletApplied) <= 0.009

  // Credit points redemption — applied AFTER wallet in the tender order. Mirrors the
  // backend caps (pts ≤ balance; value ≤ max-redeem % of total AND ≤ amount left after
  // wallet; below the min-to-redeem floor nothing applies). Server re-clamps, so this
  // is UX only. Per-point value is INR; convert to the order currency for display.
  const pointsRegionOk = (() => {
    const region = pointsSettings.region || 'BOTH'
    if (region === 'IN_ONLY') return getCurrency() === 'INR'
    if (region === 'COM_ONLY') return getCurrency() === 'USD'
    return true
  })()
  const pointValueOrderCcy = (() => {
    const perInr = Number(pointsSettings.redeemValuePerPointInr) || 0
    return getCurrency() === 'USD' ? convertINRtoUSD(perInr) : perInr
  })()
  const remainingAfterWallet = Math.max(0, money2(orderSummary.total - walletApplied))
  const pointsMinToRedeem = Math.max(1, Number(pointsSettings.minPointsToRedeem) || 0)
  const pointsHeadroomValue = Math.min(
    money2(orderSummary.total * (Number(pointsSettings.maxRedeemPercent) || 0) / 100),
    remainingAfterWallet,
  )
  const maxRedeemablePoints = pointValueOrderCcy > 0
    ? Math.min(pointsBalance, Math.floor(pointsHeadroomValue / pointValueOrderCcy))
    : 0
  const pointsEligible = !!pointsSettings.enabled && pointsRegionOk && pointsBalance > 0
    && orderSummary.total > 0 && maxRedeemablePoints >= pointsMinToRedeem
  const pointsToApply = usePoints && pointsEligible
    ? Math.min(Math.max(0, Math.floor(pointsInput) || 0), maxRedeemablePoints)
    : 0
  const pointsValueApplied = pointsToApply >= pointsMinToRedeem ? money2(pointsToApply * pointValueOrderCcy) : 0

  // Net still payable via gateway after BOTH wallet and points.
  const netPayable = Math.max(0, money2(orderSummary.total - walletApplied - pointsValueApplied))
  // Any store-credit tender applied (drives "You pay now" vs "Total payable").
  const anyTenderApplied = walletApplied > 0 || pointsValueApplied > 0

  const fetchCart = async () => {
    try {
      setLoading(true)
      const response = await cartService.getCart()
      if (response.success && response.data) {
        setCartItems(response.data.items)
        const hasOutOfStock = response.data.items.some((item: any) =>
          item.product?.inStock === false ||
          (item.product?.availableStock !== undefined && item.quantity > item.product?.availableStock)
        );
        if (hasOutOfStock) {
          setError("Some items in your cart are out of stock or have insufficient quantity. Please return to the cart to remove them.")
        }
      }
    } catch (err: any) {
      setError("Failed to load cart items")
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const fetchUserProfile = async () => {
    try {
      if (!userAuthService.isAuthenticated()) {
        return; // Don't fetch profile for guests
      }

      const response = await userProfileService.getProfile()
      if (response.success && response.data) {
        const userData = response.data

        // Split the stored full name into first / middle / last.
        const { firstName, middleName, lastName } = splitFullName(userData.name)

        // Pre-fill personal info only. Shipping address is sourced from saved addresses
        // (see fetchSavedAddresses) so it isn't overridden by legacy flat User.address fields.
        // Only carry over the profile phone if it parses cleanly for the current country —
        // otherwise we'd surface a "invalid phone" error on a field the user hasn't touched.
        setFormData(prev => {
          const incomingPhone = userData.phoneNumber || ''
          const candidatePhone = prev.phone || incomingPhone
          const reformatted = candidatePhone
            ? formatPhoneAsYouType(candidatePhone, prev.country || DEFAULT_COUNTRY_ISO)
            : ''
          const usePhone = reformatted && validatePhone(reformatted, prev.country || DEFAULT_COUNTRY_ISO)
            ? reformatted
            : prev.phone
          return {
            ...prev,
            firstName: prev.firstName || firstName,
            middleName: prev.middleName || middleName,
            lastName: prev.lastName || lastName,
            email: userData.email,
            phone: usePhone,
          }
        })
      }
    } catch (err: any) {
      console.error('Failed to load user profile:', err)
      // Don't show error to user, just log it
      // User can still manually enter address
    }
  }

  const fetchSavedAddresses = async () => {
    try {
      if (!userAuthService.isAuthenticated()) return
      const list = await addressService.list()
      setSavedAddresses(list)
      // Auto-select default if user has addresses; otherwise go straight to new-address entry
      const def = list.find((a) => a.isDefault) || list[0]
      if (def) {
        setSelectedAddressId(def.id)
        setUseNewAddress(false)
        applySavedAddressToForm(def)
      } else {
        setUseNewAddress(true)
      }
    } catch (err) {
      console.error("Failed to load saved addresses:", err)
      setUseNewAddress(true)
    }
  }

  const applySavedAddressToForm = (addr: SavedAddress) => {
    const { firstName, middleName, lastName } = splitFullName(addr.name)
    const countryIso = normalizeCountryToIso(addr.country)
    const displayPhone = addr.phone ? formatPhoneAsYouType(addr.phone, countryIso) : ""
    setFormData((prev) => ({
      ...prev,
      firstName,
      middleName,
      lastName,
      phone: displayPhone || prev.phone,
      address: addr.address || "",
      addressLine2: addr.addressLine2 || "",
      addressLine3: addr.addressLine3 || "",
      landmark: addr.landmark || "",
      city: addr.city || "",
      state: addr.state || "",
      zipCode: addr.zipCode || "",
      country: countryIso,
    }))
  }

  const handleSelectSavedAddress = (id: string) => {
    const addr = savedAddresses.find((a) => a.id === id)
    if (!addr) return
    setSelectedAddressId(id)
    setUseNewAddress(false)
    setSaveNewAddressToBook(false)
    applySavedAddressToForm(addr)
  }

  const handleEditAddress = (id: string) => {
    const addr = savedAddresses.find((a) => a.id === id)
    if (!addr) return
    setEditingAddressId(id)
    setSelectedAddressId(id)
    setUseNewAddress(true)
    setSaveNewAddressToBook(false)
    applySavedAddressToForm(addr)
  }

  const handleChooseNewAddress = () => {
    setUseNewAddress(true)
    setSelectedAddressId(null)
    setEditingAddressId(null)
    // Clear shipping fields so the user enters fresh data; keep email so it's not lost
    setFormData((prev) => ({
      ...prev,
      firstName: "",
      middleName: "",
      lastName: "",
      phone: "",
      address: "",
      addressLine2: "",
      addressLine3: "",
      landmark: "",
      city: "",
      state: "",
      zipCode: "",
      country: DEFAULT_COUNTRY_ISO,
    }))
  }

  // True when Step 1 can proceed: either a saved address is selected, or the new-address form is valid.
  const canAdvanceShipping = useNewAddress ? shippingValid : !!selectedAddressId

  // The server rejects an order whose line has an unresolved shipping mode or missing
  // courier, so block here too — reaching /checkout directly must not bypass the
  // cart's choice. A shipping product (>=1 transport) always needs a courier.
  const itemsMissingTransport = cartItems.filter((item) => {
    const types = (item.product as any)?.logisticsConfig?.transportTypes
    if (!Array.isArray(types) || types.length === 0) return false
    if (types.length > 1 && !(item as any).transportType) return true
    if (courierPickerHidden) return false // live India integration assigns the carrier
    return !(item as any).courier
  })

  // If the user opted to save a new address to the address book, persist it before advancing.
  // A save failure is surfaced but does NOT block checkout — the user should still be able to complete the order.
  const handleShippingStepAdvance = async () => {
    const isAuthed = userAuthService.isAuthenticated()

    // Editing an existing saved address — update it in the address book
    if (useNewAddress && editingAddressId && isAuthed) {
      try {
        const existing = savedAddresses.find(a => a.id === editingAddressId)
        const payload: AddressPayload = {
          type: existing?.type || "home",
          name: joinFullName(formData.firstName, formData.middleName, formData.lastName),
          phone: toE164(formData.phone, formData.country),
          address: formData.address,
          addressLine2: formData.addressLine2 || undefined,
          addressLine3: formData.addressLine3 || undefined,
          landmark: formData.landmark || undefined,
          city: formData.city,
          state: formData.state,
          zipCode: formData.zipCode,
          country: formData.country,
          isDefault: existing?.isDefault || false,
        }
        const updated = await addressService.update(editingAddressId, payload)
        setSavedAddresses((prev) => prev.map(a => a.id === editingAddressId ? updated : a))
        setSelectedAddressId(editingAddressId)
        setEditingAddressId(null)
        setUseNewAddress(false)
      } catch (err: any) {
        console.error("Failed to update address:", err)
        // Warn but do not block checkout — the form data is still valid for shipping
        setError(err?.message || "Could not update address — your changes will still be used for this order")
      }
    }
    // Saving a new address to the address book
    else if (
      useNewAddress &&
      saveNewAddressToBook &&
      isAuthed &&
      savedAddresses.length < MAX_SAVED_ADDRESSES
    ) {
      try {
        const payload: AddressPayload = {
          type: "home",
          name: joinFullName(formData.firstName, formData.middleName, formData.lastName),
          phone: toE164(formData.phone, formData.country),
          address: formData.address,
          addressLine2: formData.addressLine2 || undefined,
          addressLine3: formData.addressLine3 || undefined,
          landmark: formData.landmark || undefined,
          city: formData.city,
          state: formData.state,
          zipCode: formData.zipCode,
          country: formData.country,
          isDefault: savedAddresses.length === 0,
        }
        const created = await addressService.create(payload)
        setSavedAddresses((prev) => [created, ...prev])
        setSelectedAddressId(created.id)
        setSaveNewAddressToBook(false)
      } catch (err: any) {
        console.error("Failed to save address to book:", err)
        // Warn but do not block checkout — the form data is still valid for shipping
        setError(err?.message || "Could not save address to your address book — your details will still be used for this order")
      }
    }
    setCurrentStep((s) => s + 1)
  }

  const fetchPaymentSettings = async () => {
    try {
      const response = await paymentSettingsService.getPublicPaymentSettings()
      if (response.success && response.data) {
        setPaymentSettings(response.data)

        // Set default payment method based on what's enabled
        if (response.data.razorpayEnabled) {
          setFormData(prev => ({ ...prev, paymentMethod: 'razorpay' }))
        } else if (response.data.payuEnabled) {
          setFormData(prev => ({ ...prev, paymentMethod: 'payu' }))
        } else {
          // If no payment gateway is enabled, show error
          setError('No payment gateway is configured. Please contact support.')
        }
      }
    } catch (err: any) {
      console.error('Failed to load payment settings:', err)
      setError('Unable to load payment options. Please try again later.')
    }
  }

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      // Check if script already loaded
      if (window.Razorpay) {
        resolve(true)
        return
      }

      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve(true)
      script.onerror = () => resolve(false)
      document.body.appendChild(script)
    })
  }

  /** Resolve the correct regional price for a checkout cart item, offer applied.
   *  Applying the offer here flows it into subtotal, tax, total and therefore the
   *  Razorpay amount — which the server's createOrder re-derives and reconciles, so
   *  the quoted total always equals the charged total. */
  const getItemPrice = (item: CartItem) => {
    if (item.isFreeGift) return 0 // free-gift line — charged nothing, matches the server
    const base = item.variant
      ? getRegionalPrice(item.variant as any)
      : item.product
        ? getRegionalPrice(item.product as any)
        : item.price
    const offer: ActiveOffer | undefined = item.product?.activeOffer
    return offer ? applyOfferToPrice(base, offer, getCurrency(), item.quantity, convertINRtoUSD) : base
  }

  // Rate-wise GST rows for the summary: CGST+SGST (intrastate) / IGST (interstate),
  // bucketed by product rate. Until both the company state and the customer's
  // chosen state are known, a neutral per-rate "GST" row is shown instead.
  const gstLines = (() => {
    if (getRegion() !== 'IN' || orderSummary.tax <= 0) return []
    const lines = cartItems.map((item) => {
      const gross = getItemPrice(item) * item.quantity
      const couponShare = orderSummary.subtotal > 0 ? (gross / orderSummary.subtotal) * orderSummary.discount : 0
      return { net: Math.max(0, gross - couponShare), rate: item.product?.gstPercentage || 0 }
    })
    const mode = (!supplierLocation.state || !formData.state)
      ? 'COMBINED' as const
      : (isIntrastate(supplierLocation.state, formData.state, supplierLocation.country, formData.country) ? 'INTRASTATE' as const : 'INTERSTATE' as const)
    return gstRateRows(lines, mode)
  })()

  // Automatic-offer celebration on the checkout page (gift box for BOGO, coin for
  // savings). Shares the sessionStorage guard with the cart so it fires only once
  // per offer-state across the two pages.
  const [offerCelebration, setOfferCelebration] = useState<
    { kind: 'bogo'; freeUnits: number; dealLabel: string } | { kind: 'savings'; amount: number } | null
  >(null)
  const offerCelebratedRef = useRef(false)

  const offerAgg = useMemo(() => {
    let freeUnits = 0
    let savings = 0
    let bogoLabel = ''
    for (const it of cartItems) {
      // Free-gift line — celebrate as a gift-box freebie.
      if (it.isFreeGift) {
        const base = it.variant ? getRegionalPrice(it.variant as any) : it.product ? getRegionalPrice(it.product as any) : 0
        if (base > 0) { freeUnits += it.quantity; savings += base * it.quantity; if (!bogoLabel) bogoLabel = 'Free gift unlocked' }
        continue
      }
      const ao = it.product?.activeOffer
      if (!ao) continue
      if (ao.type === 'BOGO' && ao.bogoMode !== 'CROSS') {
        const buy = Math.max(1, ao.minQty || 1)
        const free = Math.max(0, ao.getQty || 0)
        const group = buy + free
        const fu = group > 0 && it.quantity >= group ? free : 0
        if (fu > 0) {
          freeUnits += fu
          if (!bogoLabel) bogoLabel = `Buy ${buy} Get ${free} Free`
        }
      }
      const base = it.variant
        ? getRegionalPrice(it.variant as any)
        : it.product
          ? getRegionalPrice(it.product as any)
          : it.price
      const paid = getItemPrice(it)
      if (base > paid) {
        const lineSaving = (base - paid) * it.quantity
        savings += lineSaving
        // Cross-product BOGO free line — count the freebie for the gift-box popup.
        if (ao.type === 'BOGO' && ao.bogoMode === 'CROSS') {
          const fu = Math.round(lineSaving / base)
          if (fu > 0) {
            freeUnits += fu
            if (!bogoLabel) bogoLabel = ao.title || 'Free item'
          }
        }
      }
    }
    return { freeUnits, savings: Math.round(savings * 100) / 100, bogoLabel }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartItems])

  useEffect(() => {
    if (loading || offerCelebratedRef.current) return
    if (offerAgg.freeUnits <= 0 && offerAgg.savings <= 0) return
    const sig = `${offerAgg.freeUnits}|${offerAgg.savings}|${cartItems.map((i) => i.productId).sort().join(',')}`
    try { if (sessionStorage.getItem('offerCelebrated') === sig) { offerCelebratedRef.current = true; return } } catch { /* ignore */ }
    offerCelebratedRef.current = true
    const t = setTimeout(() => {
      try { sessionStorage.setItem('offerCelebrated', sig) } catch { /* ignore */ }
      setOfferCelebration(
        offerAgg.freeUnits > 0
          ? { kind: 'bogo', freeUnits: offerAgg.freeUnits, dealLabel: offerAgg.bogoLabel }
          : { kind: 'savings', amount: offerAgg.savings }
      )
    }, 600)
    return () => clearTimeout(t)
  }, [loading, offerAgg, cartItems])

  const calculateTotals = () => {
    // Round PER LINE, exactly as the server does (orderController: each itemTotal
    // is round2'd before being added to subtotal). Summing raw floats here and
    // rounding once at the end drifts a cent or two from the server's figure —
    // and since this total is what Razorpay charges while the server's is what
    // the invoice states, that gap is a real payment/invoice mismatch.
    const r2line = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const subtotal = cartItems.reduce((sum, item) => sum + r2line(getItemPrice(item) * item.quantity), 0)
    // Calculate logistics-based shipping from product configs. The per-kg rates
    // are stored in RUPEES, so a USD order must convert — otherwise a ₹50 charge
    // would display as $50. Mirrors utils/logistics.js on the server, which is
    // what actually charges it.
    let logisticsShippingInr = 0;
    if (!freeShippingApplied) {
      for (const item of cartItems) {
        const config = (item.product as any)?.logisticsConfig;
        if (config) {
          // Price with the mode chosen in the cart; fall back to the only option
          // when there is no choice. Matches orderController's resolution exactly.
          const types = Array.isArray(config.transportTypes) ? config.transportTypes : [];
          const mode = ((item as any).transportType || types[0]) as 'AIR' | 'SHIP' | undefined;
          const result = calculateLogistics(config as LogisticsConfig, item.quantity, mode, getRegion());
          logisticsShippingInr += result.totalShippingCost;
        }
      }
    }
    // Lift the weight-based shipping (INR) so the delivery-zone quote effect can use it.
    // When Delhivery live rates are active for India, the carrier's quote REPLACES the
    // weight-based rate (the zone flat fee + GST still apply on top, as on the server).
    const weightInr = freeShippingApplied ? 0 : (liveShipInr != null ? liveShipInr : logisticsShippingInr);
    setWeightShipInr(weightInr);
    const weightShipCcy = r2line(getCurrency() === 'USD' ? convertINRtoUSD(weightInr) : weightInr);
    // Final shipping = weight rate + the destination zone's flat fee (converted).
    const deliveryFeeCcy = freeShippingApplied ? 0 : (delivery.feeOrderCcy || 0);
    const shippingTaxCcy = freeShippingApplied ? 0 : (delivery.taxOrderCcy || 0);
    const shipping = r2line(weightShipCcy + deliveryFeeCcy);
    // Same per-line rounding and same base (the rounded line total) the server
    // uses, so the tax shown here equals the tax the server will store.
    // GST on the POST-coupon net: allocate the coupon across lines in proportion
    // to their value and tax each net at its own rate, matching orderController.
    // Tax/GST applies ONLY on the `.in` storefront; 0 for `.com`/other regions
    // (mirrors the server, which gates on the order currency).
    const tax = getRegion() !== 'IN' ? 0 : cartItems.reduce((sum, item) => {
      const gross = r2line(getItemPrice(item) * item.quantity)
      const couponShare = subtotal > 0 ? (gross / subtotal) * discountAmount : 0
      const net = Math.max(0, gross - couponShare)
      const gstRate = item.product?.gstPercentage ? item.product.gstPercentage / 100 : 0
      return sum + r2line(net * gstRate)
    }, 0)

    // Round every component to 2dp BEFORE summing, mirroring the server
    // (orderController `round2`). Each line is displayed to 2dp, so summing the
    // raw floats produced a total that didn't match the lines shown above it
    // (e.g. 16.76 + 2.01 − 1.68 displayed as 17.10 instead of 17.09) and the
    // same drift then carried onto the invoice and the payment amount.
    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const roundedSubtotal = r2(subtotal)
    const roundedShipping = r2(shipping)
    const roundedShippingTax = r2(shippingTaxCcy)
    const roundedTax = r2(tax)
    const roundedDiscount = r2(discountAmount)

    // Calculate total with discount, ensure >= 0. Shipping GST is added on top.
    const total = Math.max(
      0,
      r2(roundedSubtotal + roundedShipping + roundedShippingTax + roundedTax - roundedDiscount)
    )

    setOrderSummary({
      subtotal: roundedSubtotal,
      shipping: roundedShipping,
      shippingTax: roundedShippingTax,
      tax: roundedTax,
      discount: roundedDiscount,
      total
    })
  }

  const updateFormData = <K extends keyof CheckoutFormData>(field: K, value: CheckoutFormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handlePlaceOrder = async () => {
    try {
      setPlacingOrder(true)
      setError(null)

      // Validate payment gateway is configured
      if (!paymentSettings?.razorpayEnabled && !paymentSettings?.payuEnabled) {
        setError('No payment gateway is configured. Please contact support.')
        setPlacingOrder(false)
        return
      }

      // Check for out of stock items
      const hasOutOfStock = cartItems.some((item) =>
        item.product?.inStock === false ||
        (item.product?.availableStock !== undefined && item.quantity > item.product?.availableStock)
      );
      if (hasOutOfStock) {
        setError("Some items in your cart are out of stock. Please return to the cart to remove them.");
        setPlacingOrder(false);
        return;
      }

      // Pre-payment fulfilment check. Confirm the server can actually place this
      // cart (courier availability, shipping method, stock) BEFORE we open the
      // payment gateway — otherwise the customer gets charged and createOrder then
      // rejects the order, leaving them stranded on checkout being asked to pay again.
      try {
        await orderService.validateCheckout(getCurrency())
      } catch (validationErr: any) {
        setError(validationErr?.message || "Your order can't be placed. Please review your cart.")
        setPlacingOrder(false)
        return
      }

      const shippingAddress = {
        firstName: formData.firstName,
        middleName: formData.middleName || "",
        lastName: formData.lastName,
        email: formData.email,
        phone: toE164(formData.phone, formData.country),
        street: formData.address,
        addressLine2: formData.addressLine2 || "",
        addressLine3: formData.addressLine3 || "",
        landmark: formData.landmark || "",
        city: formData.city,
        state: formData.state,
        zipCode: formData.zipCode,
        country: formData.country,
      }

      // Wallet covers the whole order → no gateway, place it straight away.
      if (walletCoversAll) {
        await createOrderAfterPayment(shippingAddress, undefined, undefined, undefined, 'WALLET')
        return
      }

      // Handle Razorpay payment
      if (formData.paymentMethod === 'razorpay') {
        await handleRazorpayPayment(shippingAddress)
      } else if (formData.paymentMethod === 'payu') {
        await handlePayUPayment(shippingAddress)
      } else {
        setError('Invalid payment method selected')
        setPlacingOrder(false)
      }

    } catch (err: any) {
      console.error(err)
      setError(err.message || "An error occurred while processing payment")
      setPlacingOrder(false)
    }
  }

  const handleRazorpayPayment = async (shippingAddress: any) => {
    try {
      // Check if Razorpay script is loaded
      if (!window.Razorpay) {
        const loaded = await loadRazorpayScript()
        if (!loaded) {
          throw new Error('Failed to load Razorpay SDK. Please check your internet connection.')
        }
      }

      // Create Razorpay order. Send the currency the total is actually quoted
      // in — the server converts USD → INR before charging. Hardcoding 'INR'
      // here charged a USD figure as rupees (a $9.39 order collected ₹9.39).
      // Charge only the net payable after wallet credit.
      const orderResponse = await paymentService.createRazorpayOrder(
        netPayable,
        getCurrency()
      )

      if (!orderResponse.success) {
        throw new Error('Failed to initialize payment')
      }

      const { orderId, amount, currency, keyId } = orderResponse.data

      // Razorpay options
      const options = {
        key: keyId,
        amount: amount,
        currency: currency,
        name: 'M2C Marketplace',
        description: 'Order Payment',
        order_id: orderId,
        prefill: {
          name: `${formData.firstName} ${formData.lastName}`,
          email: formData.email,
          contact: formData.phone
        },
        theme: {
          color: '#222222'
        },
        handler: async function (response: any) {
          try {
            // Signature verification now happens inline inside createOrder
            // (one round trip instead of two — saves a Vercel cold-start
            // hop after the Razorpay handler fires).
            await createOrderAfterPayment(
              shippingAddress,
              response.razorpay_payment_id,
              response.razorpay_order_id,
              response.razorpay_signature,
            )
          } catch (error: any) {
            setError(error.message || 'Payment verification failed')
            setPlacingOrder(false)
          }
        },
        modal: {
          ondismiss: function () {
            setPlacingOrder(false)
            setError('Payment cancelled by user')
          }
        }
      }

      const razorpay = new window.Razorpay(options)
      razorpay.open()

    } catch (error: any) {
      throw error
    }
  }

  const handlePayUPayment = async (shippingAddress: any) => {
    // PayU integration - to be implemented
    setError('PayU payment is not yet implemented')
    setPlacingOrder(false)
  }

  const createOrderAfterPayment = async (
    shippingAddress: CreateOrderParams['shippingAddress'],
    paymentId?: string,
    razorpayOrderId?: string,
    razorpaySignature?: string,
    paymentMethodOverride?: string,
  ) => {
    try {
      const response = await orderService.createOrder({
        shippingAddress,
        // 'WALLET' when store credit covers the whole order (no gateway payment).
        paymentMethod: paymentMethodOverride || formData.paymentMethod,
        paymentId,
        razorpayOrderId,
        razorpaySignature,
        shippingCost: orderSummary.shipping,
        tax: orderSummary.tax,
        discount: orderSummary.discount,
        freeShipping: freeShippingApplied,
        // Required: the server re-validates this coupon and derives the discount
        // from it. Omitting it makes the server compute a zero discount, which
        // then fails the payment-amount reconciliation.
        couponCode: couponCode || undefined,
        currency: getCurrency(),
        // Wallet store credit applied (order currency). Server clamps + debits it.
        walletApplied: walletApplied > 0 ? walletApplied : undefined,
        // Credit points redeemed (whole points, applied after wallet). Server clamps + debits.
        pointsRedeemed: pointsToApply > 0 ? pointsToApply : undefined,
      })

      if (response.success && response.data) {
        // Hand the order off via sessionStorage so the confirmation page can
        // render immediately without re-fetching what we already have.
        stashRecentOrder(response.data)
        localStorage.removeItem('appliedCoupon')
        router.push(`/order-confirmation?id=${response.data.id}`)
      } else {
        localStorage.removeItem('appliedCoupon')
        router.push("/order-confirmation")
      }
    } catch (error: any) {
      throw new Error(error.message || 'Failed to create order')
    } finally {
      setPlacingOrder(false)
    }
  }

  const steps = [
    { id: 1, name: "Shipping", icon: Truck },
    { id: 2, name: "Payment", icon: CreditCard },
    { id: 3, name: "Review", icon: CheckCircle }
  ]

  /**
   * The step rail.
   *
   * It was a bordered white pill floating above the form, which made three
   * words look like a fourth panel on a page that already had two. Here it is
   * just type on the page: a number, a name, and a rule between them that
   * fills as you go. Nothing to draw a box around.
   */
  const renderStepIndicator = () => (
    <ol className="mb-8 flex items-center gap-2 sm:gap-3 lg:mb-10">
      {steps.map((step, index) => {
        const done = currentStep > step.id
        const active = currentStep === step.id
        return (
          <li key={step.id} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 last:flex-none">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums transition-colors duration-300 sm:h-8 sm:w-8 sm:text-xs ${
                done
                  ? 'bg-[#1f7a4d] text-white'
                  : active
                    ? 'bg-[#e01a1b] text-white shadow-[0_4px_14px_-4px_rgba(224,26,27,0.7)]'
                    : 'bg-[#f1e9e2] text-[#a2968b]'
              }`}
            >
              {done ? <CheckCircle className="h-4 w-4" /> : step.id}
            </span>

            <span
              className={`truncate text-[13px] font-semibold transition-colors duration-300 sm:text-sm ${
                active ? 'text-[#1a1a1a]' : done ? 'text-[#6b625b]' : 'text-[#a2968b]'
              } ${active ? 'inline' : 'hidden sm:inline'}`}
            >
              {step.name}
            </span>

            {/* The connector belongs to the step BEFORE it, and fills only
                once that step is behind you — so the rule is a record of
                progress rather than a decoration between labels. */}
            {index < steps.length - 1 && (
              <span aria-hidden className="ml-1 h-px min-w-4 flex-1 bg-[#eadfd4] sm:ml-2">
                <span
                  className={`block h-px origin-left bg-[#1f7a4d] transition-transform duration-500 ease-out ${
                    done ? 'scale-x-100' : 'scale-x-0'
                  }`}
                />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )

  const renderShippingForm = () => {
    const canSaveMore = savedAddresses.length < MAX_SAVED_ADDRESSES
    const isAuthed = userAuthService.isAuthenticated()
    return (
      <div className="space-y-6">
        {savedAddresses.length > 0 && (
          <AddressSelector
            addresses={savedAddresses}
            selectedId={selectedAddressId}
            useNewAddress={useNewAddress}
            onSelect={handleSelectSavedAddress}
            onChooseNew={handleChooseNewAddress}
            onEdit={handleEditAddress}
            disabled={placingOrder}
          />
        )}

        {useNewAddress && (
          <>
            {savedAddresses.length > 0 && (
              <div className="border-t border-[#f0e8df] pt-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-playfair text-base font-semibold text-[#1a1a1a]">
                    {editingAddressId ? "Edit shipping address" : "Enter new shipping address"}
                  </h3>
                  {editingAddressId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingAddressId(null)
                        setUseNewAddress(false)
                        if (selectedAddressId) {
                          const addr = savedAddresses.find(a => a.id === selectedAddressId)
                          if (addr) applySavedAddressToForm(addr)
                        }
                      }}
                      className="px-4 py-1.5 text-sm font-medium text-[#4a423c] bg-[#f3ece5] border border-[#e5dbd0] rounded-lg hover:bg-[#ece3d9] transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
            <ShippingForm
              formData={formData}
              updateFormData={updateFormData}
              disabled={placingOrder}
              onValidityChange={setShippingValid}
            />
            {isAuthed && !editingAddressId && canSaveMore && (
              <label className="flex items-center gap-3 cursor-pointer select-none pt-2">
                <input
                  type="checkbox"
                  checked={saveNewAddressToBook}
                  onChange={(e) => setSaveNewAddressToBook(e.target.checked)}
                  disabled={placingOrder}
                  className="w-4 h-4 accent-[#e01a1b]"
                />
                <span className="text-sm text-[#4a423c]">
                  Save this address to my address book
                  <span className="text-[#a2968b] ml-1">
                    ({savedAddresses.length}/{MAX_SAVED_ADDRESSES} used)
                  </span>
                </span>
              </label>
            )}
            {isAuthed && !canSaveMore && (
              <p className="text-xs text-[#8a807a] pt-2">
                You&apos;ve reached the {MAX_SAVED_ADDRESSES}-address limit — this address won&apos;t be saved to your address book.
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  const renderPaymentForm = () => (
    <PaymentForm formData={formData} updateFormData={updateFormData} paymentSettings={paymentSettings} />
  )

  const renderReview = () => (
    <ReviewOrder formData={formData} deliveryEstimate={courierPickerHidden ? null : deliveryEstimate} liveCourier={courierPickerHidden} />
  )

  if (loading) {
    /* Skeleton mirrors the checkout layout (form on left, order summary on right). */
    return (
      <div className="min-h-screen bg-[#faf6f2] py-4 sm:py-6 lg:py-8">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-2 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-[#f0e8df] p-4 sm:p-5 lg:p-6 space-y-3">
                <div className="h-5 w-40 bg-[#ece3d9] rounded animate-pulse" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <div key={j} className="space-y-2">
                      <div className="h-3 w-20 bg-[#f3ece5] rounded animate-pulse" />
                      <div className="h-10 w-full bg-[#ece3d9] rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="bg-white rounded-xl border border-[#f0e8df] p-4 sm:p-5 lg:p-6 space-y-4 h-fit">
            <div className="h-5 w-32 bg-[#ece3d9] rounded animate-pulse" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-3 items-center">
                <div className="w-12 h-12 bg-[#ece3d9] rounded-lg animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-[#ece3d9] rounded animate-pulse" />
                  <div className="h-3 w-1/2 bg-[#f3ece5] rounded animate-pulse" />
                </div>
              </div>
            ))}
            <div className="border-t border-[#f5efe8] pt-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <div className="h-4 w-20 bg-[#f3ece5] rounded animate-pulse" />
                  <div className="h-4 w-16 bg-[#ece3d9] rounded animate-pulse" />
                </div>
              ))}
            </div>
            <div className="h-11 w-full bg-[#ece3d9] rounded-lg animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  if (!loading && cartItems.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf6f2]">
        <div className="text-center max-w-md mx-auto p-8">
          <ShoppingBag className="w-16 h-16 text-[#d0c4b8] mx-auto mb-4" />
          <h2 className="font-playfair text-2xl font-semibold text-[#1a1a1a] mb-2">Your cart is empty</h2>
          <p className="text-[#8a807a] mb-6">Add some items to your cart before proceeding to checkout.</p>
          <Link href="/products">
            <button className="btn-shine inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#e01a1b] text-white rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300 font-semibold">
              Browse Products
            </button>
          </Link>
        </div>
      </div>
    )
  }

  // Rich, reconcilable savings breakdown — same model as the cart's Order Summary.
  // MRP → product discount → offer discount (baked into getItemPrice) → coupon →
  // taxable amount → tax → delivery → total. Reads the same price ladder as the cart.
  const round2 = (n: number) => Math.round(n * 100) / 100
  const mrpOf = (it: CartItem) => {
    const src = (it.variant ?? it.product) as any
    return (src ? (getRegionalOriginalPrice(src) ?? getRegionalPrice(src)) : it.price) || 0
  }
  const sellingOf = (it: CartItem) => {
    const src = (it.variant ?? it.product) as any
    return (src ? getRegionalPrice(src) : it.price) || 0
  }
  const listSubtotal = cartItems.reduce((s, it) => s + Math.max(mrpOf(it), sellingOf(it), getItemPrice(it)) * it.quantity, 0)
  const preOfferSubtotal = cartItems.reduce((s, it) => s + sellingOf(it) * it.quantity, 0)
  const productDiscount = Math.max(0, round2(listSubtotal - preOfferSubtotal))
  const offerDiscount = Math.max(0, round2(preOfferSubtotal - orderSummary.subtotal))
  const couponDiscount = orderSummary.discount
  const totalSavings = round2(productDiscount + offerDiscount + couponDiscount)

  return (
    /**
     * ── Two panes, not two cards ─────────────────────────────────────────
     *
     * The page was a 3-column grid of boxes on a grey ground: a white card
     * with a solid red banner across it, and a second white card beside it.
     * Three surfaces competing on a page whose whole job is to hold attention
     * on one thing at a time.
     *
     * Now the page IS the layout. The flow sits on white and the order sits
     * on a dark warm panel that runs to the right edge of the screen and the
     * full height of the viewport. There is no card chrome anywhere: the only
     * two regions are the thing you are doing and the thing you are buying,
     * and they are told apart by ground colour rather than by borders.
     *
     * The grid is deliberately NOT capped by a max-width container — a panel
     * that stops short of the edge is a stripe, not a pane. The CONTENT is
     * capped instead, and the two columns are pulled toward the seam
     * (justify-self end / start) so they stay a readable pair on a wide
     * screen while the outer margins take the slack.
     *
     * Below lg the panes stack and the order falls beneath the form, which is
     * the existing behaviour: on a phone the first thing wanted is the field
     * to fill, not the arithmetic.
     */
    <div className="min-h-screen bg-[#faf6f2] font-sans">
      {offerCelebration && (
        <OfferCelebration
          open
          onClose={() => setOfferCelebration(null)}
          variant={offerCelebration.kind}
          freeUnits={offerCelebration.kind === 'bogo' ? offerCelebration.freeUnits : undefined}
          dealLabel={offerCelebration.kind === 'bogo' ? offerCelebration.dealLabel : undefined}
          amountLabel={offerCelebration.kind === 'savings' ? formatPrice(offerCelebration.amount) : undefined}
        />
      )}
      {/* An ordinary contained page.
          Two earlier attempts made this a pair of full-height panes running to
          the screen edge. Both failed for the same reason: a pane has to be as
          wide as its column, and the order summary is only ever ~26rem of
          content — so the rest of the column was empty ground, first dark and
          then cream, with nothing in it. A card is sized by what it holds.

          So: one centred container, the flow on the page itself, and the order
          as a card beside it. Nothing bleeds, nothing is stretched to fill. */}
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-12">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-8 xl:grid-cols-[minmax(0,1fr)_23rem] xl:gap-10">
          <div>
          <div className="w-full">
            <Link href="/cart">
              <button className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-[#6b625b] transition-colors hover:text-[#e01a1b] sm:mb-6">
                <ArrowLeft className="h-4 w-4" />
                Back to Cart
              </button>
            </Link>

            <div className="mb-7 flex items-center gap-3 sm:gap-4 lg:mb-9">
              {/* The same mark language as the cart: a chip with weight,
                  aligned to the two-line block rather than to the gap in it. */}
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-linear-to-b from-[#fdf1ef] to-[#f9e3df] ring-1 ring-[#f2d9d3] sm:h-14 sm:w-14">
                <Lock className="h-6 w-6 text-[#e01a1b] sm:h-7 sm:w-7" strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <h1 className="font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl lg:text-4xl">
                  Checkout
                </h1>
                <p className="mt-1 text-sm text-[#6b625b] sm:text-base">Complete your purchase securely</p>
              </div>
            </div>

            {renderStepIndicator()}

            {/* The step's own name, as a heading on the page. This was set in
                white on a solid red bar across the top of the card — the
                loudest element on a page where the loudest thing should be
                the button that finishes it. */}
            {/* Ruled caption above the heading — the same device the policy
                pages and the category banners use. Bare type on bare white was
                the flattest part of the page. */}
            <div className="mb-5 sm:mb-6">
              <span className="inline-flex items-center gap-2.5 text-[10.5px] font-semibold uppercase tracking-[0.24em] text-[#c41617]">
                <span aria-hidden className="h-px w-6 bg-[#e01a1b]" />
                Step {currentStep} of 3
              </span>
              <h2 className="mt-2 font-playfair text-xl font-semibold text-[#1a1a1a] sm:text-2xl">
                {currentStep === 1 && "Shipping Information"}
                {currentStep === 2 && "Payment Information"}
                {currentStep === 3 && "Review Your Order"}
              </h2>
            </div>

            {/* The step sits on a card, like the order beside it.
                An earlier draft had the flow directly on the page, which suited
                a full-bleed two-pane layout. That layout is gone, and what was
                left was a form with nothing behind it: white inputs floating on
                the page's own colour while the order summary next to it sat on
                a proper surface. A field needs a ground to sit on, or the eye
                cannot tell the form from the page. */}
            {/* Keyed on the step, so the card is a NEW element every time you
                advance and the reveal plays again. Without the key React would
                reuse the same node, the observer would have long since fired,
                and only the very first step would ever animate.

                The animation belongs here and not on the order card beside it:
                `.reveal` carries will-change, which opens a containing block —
                and the order card is sticky, which a containing block would
                quietly break. */}
            <Reveal key={`step-${currentStep}`} className="rounded-2xl bg-white p-5 shadow-[0_2px_4px_rgba(120,80,50,0.05)] ring-1 ring-[#efe4d6] sm:p-6 lg:p-7">
              {error && (
                <div className="mb-5 rounded-xl border border-[#f2d0cd] bg-[#fdf1ef] p-3 text-sm text-[#c41617] sm:p-4">
                  {error}
                </div>
              )}

              {currentStep === 1 && renderShippingForm()}
              {currentStep === 2 && renderPaymentForm()}
              {currentStep === 3 && renderReview()}

              {/* ── Navigation ──────────────────────────────────────────── */}
              <div className="mt-8 border-t border-[#f0e8df] pt-6 sm:mt-10">
              <div className="flex items-center justify-between gap-3">
                {/* Hidden on the first step rather than shown greyed out. A
                    disabled control that can never be enabled is furniture,
                    and "Back to Cart" above already goes where it would. */}
                {currentStep > 1 ? (
                  <button
                    onClick={() => setCurrentStep(Math.max(1, currentStep - 1))}
                    disabled={placingOrder}
                    className="rounded-full px-5 py-2.5 text-sm font-semibold text-[#6b625b] ring-1 ring-[#e5dbd0] transition-colors hover:bg-[#faf6f2] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50 sm:px-6 sm:py-3 sm:text-base"
                  >
                    Previous
                  </button>
                ) : (
                  <span />
                )}

                <button
                  onClick={() => {
                    if (currentStep === 1 && !canAdvanceShipping) {
                      return;
                    }
                    if (currentStep < 3) {
                      if (currentStep === 1) {
                        void handleShippingStepAdvance()
                      } else {
                        setCurrentStep(currentStep + 1)
                      }
                    } else {
                      handlePlaceOrder()
                    }
                  }}
                  disabled={
                    placingOrder ||
                    cartItems.some(item =>
                      item.product?.inStock === false ||
                      (item.product?.availableStock !== undefined && item.quantity > item.product?.availableStock)
                    ) ||
                    itemsMissingTransport.length > 0 ||
                    (currentStep === 1 && !canAdvanceShipping) ||
                    (delivery.checked && !delivery.serviceable)
                  }
                  className="btn-shine flex items-center gap-2 rounded-full bg-[#e01a1b] px-6 py-2.5 text-sm font-semibold text-white shadow-[0_6px_20px_rgba(224,26,27,0.3)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#c41617] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0 sm:px-8 sm:py-3 sm:text-base"
                >
                  {placingOrder && <Loader2 className="h-4 w-4 animate-spin" />}
                  {currentStep === 3 ? (placingOrder ? "Placing Order..." : "Place Order") : "Continue"}
                </button>
                </div>

                {/* A disabled button with no reason is a dead end — say what's wrong
                    and where to fix it. */}
                {itemsMissingTransport.length > 0 && (
                  <p className="mt-3 text-right text-xs text-amber-700">
                    Choose a shipping method for{" "}
                    {itemsMissingTransport.map((i) => i.product?.name).filter(Boolean).join(", ")} in your{" "}
                    <Link href="/cart" className="font-semibold underline">cart</Link>.
                  </p>
                )}
              </div>
            </Reveal>
          </div>
        </div>

        {/* ── The order ────────────────────────────────────────────────────
            Dark, warm, and running to the edge. Sticky and its own scroller
            from lg, so a long basket scrolls INSIDE the panel while the form
            stays where it is — the list used to be a 240px box with its own
            scrollbar sitting inside a card inside a column. */}
        {/* ── The order ──────────────────────────────────────────────────
            A card: white, with a warm hairline and a soft shadow, sticky from
            lg so it follows you down the steps. It ends where its content
            ends, which is the whole reason for a card over a pane.

            One dark object inside it — the Total. Being the heaviest thing on
            the page is the point there; it was not the point across 37% of the
            screen, which is what the first build did. */}
        <aside className="mt-8 lg:mt-0">
          <div className="relative overflow-hidden rounded-2xl bg-white p-5 shadow-[0_2px_4px_rgba(120,80,50,0.05)] ring-1 ring-[#efe4d6] sm:p-6 lg:sticky lg:top-8">
            {/* The weave, at a whisper — the same warp-and-weft hairlines the
                policy banner carries. It is the one texture this business owns,
                and it keeps a plain white card from looking undesigned. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(90deg,#8a6a49 0 1px,transparent 1px 15px),' +
                  'repeating-linear-gradient(0deg,#8a6a49 0 1px,transparent 1px 15px)',
              }}
            />

            <div className="relative">
              <h2 className="mb-6 font-playfair text-lg font-semibold text-[#1a1a1a] sm:text-xl">Order Summary</h2>

              {(() => { const VISIBLE_LINES = 3; const hiddenCount = cartItems.length - VISIBLE_LINES; return (
              <>
              <ul className="mb-4 space-y-3.5">
                {(showAllItems ? cartItems : cartItems.slice(0, VISIBLE_LINES)).map((item) => {
                  const hasVariantImg = item.variant?.images && item.variant.images.length > 0;
                  const displayImgUrl = hasVariantImg
                    ? item.variant?.images?.[0]
                    : item.product?.images?.[0]?.url;

                  const itemColor = item.variant?.color || item.product?.singleUnitColor;
                  const itemSize = item.variant?.size || item.product?.singleUnitSize;
                  const itemColorHex = item.variant?.colorHex || item.product?.singleUnitColorHex;

                  return (
                    <li key={item.id} className="flex gap-3 text-sm">
                      {/* The quantity rides on the thumbnail as a badge, the way
                          it does on the header cart. It was a "Qty: 2" line
                          competing with the colour and size beneath the name.

                          Two elements, not one. The badge sits OUTSIDE the
                          frame that clips the photograph: putting it inside
                          meant overflow-hidden — which is what rounds the
                          image — cut the badge in half, so it showed as a
                          sliver of red with the number missing. The clip has
                          to belong to the picture alone. */}
                      <div className="relative shrink-0">
                        <div className="h-14 w-14 overflow-hidden rounded-lg bg-white ring-1 ring-[#ece0cf]">
                          {displayImgUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={displayImgUrl} alt={item.product?.name || "Product"} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-[#b3a99f]">No Img</div>
                          )}
                        </div>
                        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#2f1e1a] px-1 text-[10px] font-bold leading-none tabular-nums text-white ring-2 ring-white">
                          {item.quantity}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium leading-snug text-[#1a1a1a]">{item.product?.name || "Product"}</p>
                        {(itemColor || itemSize) && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#8a807a]">
                            {itemColor && (
                              <span className="flex items-center gap-1 whitespace-nowrap">
                                {itemColorHex && (
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-black/15"
                                    style={{ backgroundColor: itemColorHex }}
                                  />
                                )}
                                {itemColor}
                              </span>
                            )}
                            {itemSize && <span className="whitespace-nowrap">Size: {itemSize}</span>}
                          </div>
                        )}
                        {item.isFreeGift ? (
                          <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[#eaf7ef] px-1.5 py-0.5 text-[9px] font-bold text-[#157f4a] ring-1 ring-[#c9e9d5]">
                            🎁 FREE GIFT
                          </span>
                        ) : item.product?.activeOffer && (
                          <span className="mt-1.5 inline-flex items-center rounded-full bg-[#fdf1ef] px-1.5 py-0.5 text-[9px] font-bold text-[#c41617] ring-1 ring-[#f4dcd7]">
                            {item.product.activeOffer.badge}
                          </span>
                        )}
                      </div>

                      <span className="shrink-0 font-semibold tabular-nums text-[#1a1a1a]">
                        {item.isFreeGift ? <span className="text-[#157f4a]">FREE</span> : formatPrice(getItemPrice(item) * item.quantity)}
                      </span>
                    </li>
                  )
                })}
              </ul>

              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllItems((v) => !v)}
                  aria-expanded={showAllItems}
                  className="mb-5 inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-full bg-[#f6f0e8] py-2.5 text-xs font-semibold text-[#4a423c] ring-1 ring-[#e8dccd] transition-colors hover:bg-[#efe6da] hover:text-[#1a1a1a]"
                >
                  {showAllItems ? 'Show fewer items' : `Show all ${cartItems.length} items`}
                  <span aria-hidden className={`transition-transform duration-200 ${showAllItems ? 'rotate-180' : ''}`}>
                    &#9662;
                  </span>
                </button>
              )}
              </>
              ); })()}

              {/* Price ladder — same aggregated, reconcilable breakdown as the
                  cart's Order Summary. Discount rows only show when they exist and
                  read as green savings; the coupon sits above the taxable amount. */}
              <div className="space-y-2.5 border-t border-[#eee2d2] pt-5 text-[13.5px] sm:text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[#6b625b]">Items subtotal</span>
                  <span className="tabular-nums text-[#1a1a1a]">{formatPrice(listSubtotal)}</span>
                </div>

                {productDiscount > 0 && (
                  <div className="flex items-center justify-between text-[#157f4a]">
                    <span>Product discount</span>
                    <span className="font-medium tabular-nums">−{formatPrice(productDiscount)}</span>
                  </div>
                )}
                {offerDiscount > 0 && (
                  <div className="flex items-center justify-between text-[#157f4a]">
                    <span>Offer discount</span>
                    <span className="font-medium tabular-nums">−{formatPrice(offerDiscount)}</span>
                  </div>
                )}
                {couponDiscount > 0 && (
                  <div className="flex items-center justify-between text-[#157f4a]">
                    <span>Coupon discount</span>
                    <span className="font-medium tabular-nums">−{formatPrice(couponDiscount)}</span>
                  </div>
                )}

                {/* Taxable amount + Tax (GST) only on the `.in` storefront;
                    hidden on `.com`/other regions where no tax is charged. */}
                {getRegion() === 'IN' && (
                  <>
                    <div className="flex items-center justify-between border-t border-dashed border-[#ece1d4] pt-2.5">
                      <span className="text-[#6b625b]">Taxable amount</span>
                      <span className="font-medium tabular-nums text-[#1a1a1a]">{formatPrice(Math.max(0, orderSummary.subtotal - couponDiscount))}</span>
                    </div>

                    {gstLines.map((row) => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-[#6b625b]">{row.label}</span>
                        <span className="tabular-nums text-[#1a1a1a]">{formatPrice(row.amount)}</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-[#6b625b]">Delivery charges</span>
                  {orderSummary.shipping === 0 ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-[#157f4a]">
                      <Truck className="h-3.5 w-3.5" /> FREE
                    </span>
                  ) : (
                    <span className="tabular-nums text-[#1a1a1a]">{formatPrice(orderSummary.shipping)}</span>
                  )}
                </div>

                {orderSummary.shippingTax > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[#6b625b]">Shipping GST{delivery.gstPct ? ` (${delivery.gstPct}%)` : ''}</span>
                    <span className="tabular-nums text-[#1a1a1a]">{formatPrice(orderSummary.shippingTax)}</span>
                  </div>
                )}

                {delivery.checked && !delivery.serviceable && (
                  <div className="mt-1 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-700 ring-1 ring-red-100">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Delivery is not available to this location. Please choose a different delivery address to continue.</span>
                  </div>
                )}
              </div>

              {totalSavings > 0 && (
                <div className="mt-4 flex items-center justify-between rounded-xl bg-[#eaf7ef] px-3.5 py-2.5 ring-1 ring-[#cdebd8]">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#157f4a]">
                    <BadgePercent className="h-4 w-4" /> You save
                  </span>
                  <span className="text-[15px] font-bold tabular-nums text-[#157f4a]">{formatPrice(totalSavings)}</span>
                </div>
              )}

              {/* Wallet store credit — a tender applied after the total. */}
              {walletBalanceInr > 0 && orderSummary.total > 0 && (
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3.5">
                  <input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-semibold text-emerald-900">Use M2C Wallet</span>
                      <span className="text-[12.5px] font-medium text-emerald-700">Balance {formatPrice(walletBalanceOrderCcy)}</span>
                    </span>
                    <span className="mt-0.5 block text-[12px] text-emerald-800/70">
                      {useWallet
                        ? `−${formatPrice(walletApplied)} applied${walletCoversAll ? ' — wallet covers the full amount' : ''}`
                        : 'Apply your store credit to this order.'}
                    </span>
                  </span>
                </label>
              )}

              {/* Credit (loyalty) points — a separate tender applied after wallet. */}
              {pointsEligible && (
                <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-3.5">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" checked={usePoints}
                      onChange={(e) => { setUsePoints(e.target.checked); if (e.target.checked) setPointsInput(maxRedeemablePoints) }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-semibold text-amber-900">Use Credit Points</span>
                        <span className="text-[12.5px] font-medium text-amber-700">Balance {pointsBalance} pts</span>
                      </span>
                      <span className="mt-0.5 block text-[12px] text-amber-800/70">
                        {usePoints && pointsValueApplied > 0
                          ? `−${formatPrice(pointsValueApplied)} applied (${pointsToApply} points)`
                          : `Redeem up to ${maxRedeemablePoints} points on this order.`}
                      </span>
                    </span>
                  </label>
                  {usePoints && (
                    <div className="mt-3 flex items-center gap-2 pl-7">
                      <input type="number" min={0} max={maxRedeemablePoints} step={1} value={pointsInput}
                        onChange={(e) => setPointsInput(Math.min(maxRedeemablePoints, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                        className="w-24 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-[13px] tabular-nums outline-none focus:border-amber-500" />
                      <span className="text-[12px] text-amber-800/70">of {maxRedeemablePoints} pts</span>
                      <button type="button" onClick={() => setPointsInput(maxRedeemablePoints)}
                        className="ml-auto rounded-lg border border-amber-300 px-2.5 py-1.5 text-[12px] font-semibold text-amber-800 hover:bg-amber-100">
                        Max
                      </button>
                    </div>
                  )}
                  {usePoints && pointsToApply > 0 && pointsToApply < pointsMinToRedeem && (
                    <p className="mt-2 pl-7 text-[11.5px] text-amber-700">Redeem at least {pointsMinToRedeem} points to apply.</p>
                  )}
                </div>
              )}

              {/* The one dark object on the page, and the only one that earns
                  it: the figure the whole checkout exists to arrive at. */}
              <div className="mt-5 rounded-2xl bg-linear-to-br from-[#2f1e1a] to-[#1f1312] px-5 py-4 text-white shadow-[0_14px_34px_-20px_rgba(70,40,25,0.85)]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base font-semibold sm:text-lg">{anyTenderApplied ? 'You pay now' : 'Total payable'}</span>
                  <span className="font-playfair text-2xl font-semibold tabular-nums sm:text-[28px]">
                    {formatPrice(anyTenderApplied ? netPayable : orderSummary.total)}
                  </span>
                </div>
                {anyTenderApplied && (
                  <p className="mt-1 text-[12px] text-white/60">
                    Order total {formatPrice(orderSummary.total)}
                    {walletApplied > 0 && ` · wallet −${formatPrice(walletApplied)}`}
                    {pointsValueApplied > 0 && ` · points −${formatPrice(pointsValueApplied)}`}
                  </p>
                )}
                {getRegion() === 'IN' && (
                  <p className="mt-1.5 text-[11.5px] leading-snug text-white/55">
                    Taxes are calculated based on applicable product tax rates.
                  </p>
                )}
                {/*
                  Our Razorpay account settles in INR, so a USD order is
                  converted server-side before the payment is created.
                  Say so here — otherwise the gateway suddenly quoting
                  rupees reads as a wrong amount. Same rate the server
                  uses, so the figure matches the actual charge.
                */}
                {getCurrency() === 'USD' && (anyTenderApplied ? netPayable : orderSummary.total) > 0 && (
                  <p className="mt-2 text-xs leading-relaxed text-white/55">
                    Charged as {formatPrice(convertUSDtoINR(anyTenderApplied ? netPayable : orderSummary.total), 'INR')} — billed in INR at today&apos;s exchange rate.
                  </p>
                )}
              </div>

              <div className="mt-7 space-y-2.5 border-t border-[#eee2d2] pt-5">
                <div className="flex items-center gap-3 text-xs text-[#6b625b] sm:text-sm">
                  <Lock className="h-4 w-4 text-[#1f7a4d]" />
                  <span>SSL Encrypted Checkout</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-[#6b625b] sm:text-sm">
                  <Shield className="h-4 w-4 text-[#3f6ea8]" />
                  <span>Money Back Guarantee</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
        </div>
      </div>
    </div>
  )
}
