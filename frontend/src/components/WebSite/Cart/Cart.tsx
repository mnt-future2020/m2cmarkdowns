"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"
import orderService from "@/services/orderService"
import { cartService, type PendingGift } from "@/services/cartService"
import { wishlistService } from "@/services/wishlistService"
import { couponService } from "@/services/couponService"
import { publicProductService, PublicProduct } from "@/services/publicProductService"
import { getRecentSearches, getRecentlyViewed } from "@/lib/browsingHistory"
import { userAuthService } from "@/services/userAuthService"
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils"
import { formatPrice, getRegionalPrice, getRegionalOriginalPrice, getCurrency, getRegion, convertINRtoUSD } from "@/lib/currency"
import { isIntrastate, gstRateRows } from "@/lib/gst"
import { companyInfoService } from "@/services/companyInfoService"
import addressService from "@/services/addressService"
import { applyOfferToPrice, type ActiveOffer } from "@/lib/offers"
import { calculateLogistics, type LogisticsConfig } from "@/lib/logistics"
import { courierName, transportModeLabel } from "@/lib/couriers"
import { courierService } from "@/services/courierService"
import courierIntegrationService from "@/services/courierIntegrationService"
import Reveal from "@/components/WebSite/Shared/Reveal"
import OfferCelebration from "@/components/WebSite/Shared/OfferCelebration"
import ProductCard from "@/components/WebSite/ProductCard/ProductCard"
import {
  ShoppingCart,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  Truck,
  Star,
  Heart,
  Share2,
  ArrowRight,
  Package,
  ArrowDown,
  Landmark,
  Lock,
  Check,
  X,
  Clock,
  CheckCircle,
  Sparkles,
  TrendingUp,
  Gift,
  RefreshCw,
  BadgePercent,
} from "lucide-react"

/**
 * A figure that runs up to its value rather than appearing at it.
 *
 * Eased out rather than linear: a linear count reads as a loading spinner,
 * where a decelerating one reads as an amount arriving and settling. Anyone
 * who has asked not to be moved is handed the final number immediately —
 * a count-up is motion whatever the CSS says, so it has to be checked here
 * rather than left to a media query.
 */
function CountUp({ value, duration = 700, delay = 0 }: { value: number; duration?: number; delay?: number }) {
  // Reduced motion is settled in the initialiser rather than by setting state
  // from inside the effect. Doing it in the effect costs a cascading render
  // AND paints a frame of zero first, so someone who asked not to be moved
  // would still see the figure flick.
  const [shown, setShown] = useState(() =>
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? value : 0)

  useEffect(() => {
    if (typeof window === 'undefined'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let start = 0
    const step = (t: number) => {
      if (!start) start = t
      const p = Math.min(1, (t - start - delay) / duration)
      if (p >= 0) setShown(value * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, duration, delay])

  return <>{formatPrice(shown)}</>
}

/**
 * The burst that goes off around the coupon stub.
 *
 * Fixed rather than random: Math.random would hand every render a different
 * burst, and React's double-invoke in development makes that flicker visible.
 * Angles are swept evenly with a small offset per piece so the ring does not
 * read as a clock face, and the vertical throw is squashed and biased upward
 * so it reads as a burst rather than a spill.
 *
 * No brand red in here. The seal and the figure are green because the
 * moment is 'this worked', not 'this is M2C', and confetti in the brand
 * colour would drag the shout back in through the side door.
 */
const COUPON_BURST = [
  { tx: 132, ty: -26, r: -200, d: 0, c: '#157f4a', w: 3, h: 13, round: false },
  { tx: 158, ty: 21, r: -103, d: 23, c: '#e8a33d', w: 4, h: 4, round: true },
  { tx: 153, ty: 82, r: -6, d: 46, c: '#bd8023', w: 7, h: 7, round: false },
  { tx: 102, ty: 56, r: 91, d: 69, c: '#1a8c53', w: 3, h: 13, round: false },
  { tx: 72, ty: 106, r: 188, d: 92, c: '#f0dcc0', w: 4, h: 4, round: true },
  { tx: 8, ty: 146, r: 285, d: 115, c: '#7c8f86', w: 7, h: 7, round: false },
  { tx: -6, ty: 100, r: -158, d: 138, c: '#157f4a', w: 3, h: 13, round: false },
  { tx: -78, ty: 117, r: -61, d: 161, c: '#e8a33d', w: 4, h: 4, round: true },
  { tx: -97, ty: 53, r: 36, d: 184, c: '#bd8023', w: 7, h: 7, round: false },
  { tx: -132, ty: 66, r: 133, d: 17, c: '#1a8c53', w: 3, h: 13, round: false },
  { tx: -200, ty: 34, r: 230, d: 40, c: '#f0dcc0', w: 4, h: 4, round: true },
  { tx: -155, ty: -26, r: 327, d: 63, c: '#7c8f86', w: 7, h: 7, round: false },
  { tx: -192, ty: -36, r: -116, d: 86, c: '#157f4a', w: 3, h: 13, round: false },
  { tx: -121, ty: -70, r: -19, d: 109, c: '#e8a33d', w: 4, h: 4, round: true },
  { tx: -118, ty: -121, r: 78, d: 132, c: '#bd8023', w: 7, h: 7, round: false },
  { tx: -133, ty: -150, r: 175, d: 155, c: '#1a8c53', w: 3, h: 13, round: false },
  { tx: -48, ty: -135, r: 272, d: 178, c: '#f0dcc0', w: 4, h: 4, round: true },
  { tx: -48, ty: -165, r: -171, d: 11, c: '#7c8f86', w: 7, h: 7, round: false },
  { tx: 23, ty: -198, r: -74, d: 34, c: '#157f4a', w: 3, h: 13, round: false },
  { tx: 74, ty: -139, r: 23, d: 57, c: '#e8a33d', w: 4, h: 4, round: true },
  { tx: 103, ty: -160, r: 120, d: 80, c: '#bd8023', w: 7, h: 7, round: false },
  { tx: 111, ty: -94, r: 217, d: 103, c: '#1a8c53', w: 3, h: 13, round: false },
  { tx: 170, ty: -67, r: 314, d: 126, c: '#f0dcc0', w: 4, h: 4, round: true },
  { tx: 209, ty: -64, r: -129, d: 149, c: '#7c8f86', w: 7, h: 7, round: false },
]

/**
 * The payment marks, drawn inline.
 *
 * None of the official artwork is anywhere in this repository -- I looked --
 * so these are built rather than imported. Mastercard's interlocking discs are
 * exact: two circles at r=7 with centres 10 apart, and the lens between them is
 * the pair of minor arcs joining their intersection points. The rest are
 * wordmarks set in type in the brands' own colours: recognisable at this size,
 * and honest about being type rather than a traced logo.
 *
 * To use the real files instead, drop the SVGs in public/assets/payments/ and
 * swap each case for an <img>. Nothing else here needs to change.
 */
function PaymentMark({ id }: { id: 'visa' | 'mastercard' | 'rupay' | 'upi' | 'netbanking' }) {
  const chip = 'inline-flex h-7 items-center justify-center gap-1 rounded-md bg-white px-2 ring-1 ring-[#e9ded2]'
  const face = { fontFamily: 'Arial, Helvetica, sans-serif' } as React.CSSProperties

  // RuPay and UPI carry the same mark: two leaning chevrons, orange then
  // green, set AFTER the wordmark. Both are NPCI marks, which is why they
  // share it.
  const npciArrow = (
    <svg viewBox="0 0 16 20" className="h-[15px] w-2.5 shrink-0" aria-hidden>
      <path d="M1 1 8.6 10 1 19Z" fill="#F58220" />
      <path d="M7.4 1 15 10 7.4 19Z" fill="#3EA33E" />
    </svg>
  )

  if (id === 'visa') {
    return (
      <span className={chip} role="img" aria-label="Visa">
        <span className="text-[13px] font-black italic leading-none tracking-tight text-[#1A1F71]" style={face}>VISA</span>
      </span>
    )
  }

  if (id === 'mastercard') {
    return (
      <span className={chip} role="img" aria-label="Mastercard">
        <svg viewBox="0 0 40 24" className="h-[18px] w-7" aria-hidden>
          <circle cx="15" cy="12" r="7" fill="#EB001B" />
          <circle cx="25" cy="12" r="7" fill="#F79E1B" />
          {/* where the two discs overlap */}
          <path d="M20 7.1A7 7 0 0 1 20 16.9A7 7 0 0 1 20 7.1Z" fill="#FF5F00" />
        </svg>
      </span>
    )
  }

  if (id === 'rupay') {
    return (
      <span className={chip} role="img" aria-label="RuPay">
        <span className="text-[12px] font-extrabold leading-none tracking-tight text-[#2E3192]" style={face}>RuPay</span>
        {npciArrow}
      </span>
    )
  }

  if (id === 'upi') {
    return (
      <span className={chip} role="img" aria-label="UPI">
        <span className="text-[12px] font-extrabold leading-none tracking-tight text-[#58595B]" style={face}>UPI</span>
        {npciArrow}
      </span>
    )
  }

  return (
    <span className={chip} role="img" aria-label="Netbanking">
      {/* Netbanking has no brand of its own, so it borrows the blue the
          other marks already use -- grey on white read as disabled beside
          four coloured neighbours. */}
      <Landmark className="h-3.5 w-3.5 text-[#1B5E9E]" strokeWidth={2.2} />
      <span className="text-[10px] font-bold uppercase tracking-wide leading-none text-[#0F2E52]">Netbanking</span>
    </span>
  )
}

interface OrderItem {
  id: string
  productId: string
  name: string
  price: number
  originalPrice?: number
  /** Automatic offer applied to this line + the pre-offer price to strike through. */
  activeOffer?: ActiveOffer
  offerStrikePrice?: number
  /** Free-gift line from a "Buy A get B free" offer (price 0, fixed qty). */
  isFreeGift?: boolean
  giftOfferId?: string | null
  images: string[]
  category: string
  rating?: number
  reviews?: number
  inStock: boolean
  quantity: number
  description?: string
  availableStock?: number
  material?: string
  discount?: number
  gstPercentage?: number
  /** Chosen shipping mode for this line. Required when the product offers a choice. */
  transportType?: 'AIR' | 'SHIP' | null
  /** Chosen courier partner id (see lib/couriers). Required for shipping products. */
  courier?: string | null
  variantDetails?: {
    size: string
    color: string
    colorHex?: string
    sku: string
  }
}

interface OrderSummary {
  subtotal: number
  shipping: number
  tax: number
  discount: number
  total: number
}

/** Modal that lets the customer pick their free gift when the offer's free set has
 *  multiple products (or a product with variants). */
function GiftChooserModal({ gift, initialProductId, busy, onClose, onChoose }: {
  gift: PendingGift
  initialProductId?: string
  busy: boolean
  onClose: () => void
  onChoose: (productId: string, variantId?: string) => void
}) {
  const [productId, setProductId] = useState(
    (initialProductId && gift.options.some((o) => o.productId === initialProductId) ? initialProductId : gift.options[0]?.productId) || ''
  )
  const [variantId, setVariantId] = useState('')
  const selected = gift.options.find((o) => o.productId === productId)
  const needsVariant = (selected?.variants?.length || 0) > 0
  const canAdd = !!productId && (!needsVariant || !!variantId)
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-[#2f1e1a]/60 p-4 backdrop-blur-[3px]" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-[#f2eae1] bg-white px-5 py-4">
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-[#157f4a]" />
            <h3 className="text-base font-bold text-[#1a1a1a]">Choose your free gift</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-[#8a807a] hover:text-[#1a1a1a]"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-[13px] text-[#7a5a52]">{gift.offerTitle} — pick your free item.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {gift.options.map((o) => {
              const on = o.productId === productId
              return (
                <button
                  key={o.productId}
                  type="button"
                  onClick={() => { setProductId(o.productId); setVariantId('') }}
                  className={`rounded-xl border p-2 text-left transition-all ${on ? 'border-[#157f4a] ring-2 ring-[#157f4a]/30' : 'border-[#eee4db] hover:border-[#157f4a]/40'}`}
                >
                  <div className="aspect-square w-full overflow-hidden rounded-lg bg-[#f6f1ea]">
                    {o.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.image} alt={o.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center"><Package className="h-6 w-6 text-[#c9aeab]" /></div>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[12px] font-medium text-[#1a1a1a]">{o.name}</p>
                </button>
              )
            })}
          </div>
          {needsVariant && (
            <div className="mt-4">
              <p className="mb-1.5 text-[13px] font-semibold text-[#1a1a1a]">Choose an option</p>
              <div className="flex flex-wrap gap-2">
                {selected!.variants.map((v) => {
                  const on = v.id === variantId
                  const oos = (v.stock ?? 0) <= 0
                  const label = [v.size, v.color].filter(Boolean).join(' / ') || 'Option'
                  return (
                    <button
                      key={v.id}
                      type="button"
                      disabled={oos}
                      onClick={() => setVariantId(v.id)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? 'border-[#157f4a] bg-[#157f4a] text-white' : 'border-[#ddd] text-[#555] hover:border-[#157f4a]/50'} ${oos ? 'cursor-not-allowed line-through opacity-40' : ''}`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-[#f2eae1] bg-white px-5 py-4">
          <button onClick={onClose} className="rounded-full px-4 py-2 text-sm text-[#8a807a] hover:text-[#1a1a1a]">Cancel</button>
          <button
            disabled={!canAdd || busy}
            onClick={() => onChoose(productId, needsVariant ? variantId : undefined)}
            className="rounded-full bg-[#157f4a] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#116b3e] disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add free gift'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Order() {
  const router = useRouter()
  const [cartItems, setCartItems] = useState<OrderItem[]>([])
  // Free gifts awaiting the customer's choice, the chooser data for changing a chosen
  // gift, and the descriptor currently open in the chooser modal.
  const [pendingGifts, setPendingGifts] = useState<PendingGift[]>([])
  const [giftOptions, setGiftOptions] = useState<PendingGift[]>([])
  const [giftChooser, setGiftChooser] = useState<PendingGift | null>(null)
  const [giftInitialProduct, setGiftInitialProduct] = useState<string | undefined>(undefined)
  const [addingGift, setAddingGift] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  // GST place-of-supply inputs: SUPPLIER = company registered state, PLACE OF
  // SUPPLY = the customer's default saved address state. Used only on `.in` to
  // split the tax into CGST+SGST / IGST; falls back to a combined "Tax (GST)"
  // row until both are known.
  const [gstSupplier, setGstSupplier] = useState<{ state: string | null; country: string | null }>({ state: null, country: null })
  const [gstCustomer, setGstCustomer] = useState<{ state: string | null; country: string | null }>({ state: null, country: null })
  useEffect(() => {
    if (getRegion() !== 'IN') return
    companyInfoService.getPublicCompanyInfo()
      .then((ci) => setGstSupplier({ state: ci?.state ?? null, country: ci?.country ?? null }))
      .catch(() => { /* keep fallback */ })
  }, [])
  useEffect(() => {
    if (getRegion() !== 'IN' || !isAuthenticated) return
    addressService.list()
      .then((list) => {
        const def = list.find((a) => a.isDefault) || list[0]
        if (def) setGstCustomer({ state: def.state ?? null, country: (def as any).country ?? null })
      })
      .catch(() => { /* keep fallback */ })
  }, [isAuthenticated])
  // Blocks the "Proceed to Checkout" click while the server re-validates the cart
  // (courier availability, shipping method, stock) so an invalid-but-selected
  // courier is caught HERE instead of after payment on the checkout page.
  const [validatingCheckout, setValidatingCheckout] = useState(false)

  const handleProceedToCheckout = async () => {
    try {
      setValidatingCheckout(true)
      await orderService.validateCheckout(getCurrency())
      router.push("/checkout")
    } catch (err: any) {
      showErrorToast('Cannot proceed to checkout', err?.message || 'Please review the shipping and courier for your items.')
    } finally {
      setValidatingCheckout(false)
    }
  }
  const [similarProducts, setSimilarProducts] = useState<PublicProduct[]>([])
  // Prime the admin-managed courier catalogue so courierName() resolves the DB
  // courier ids stored on cart lines to their display names (else it prints the id).
  const [, setCourierTick] = useState(0)
  useEffect(() => {
    courierService.getActiveCouriers().then(() => setCourierTick((t) => t + 1)).catch(() => {})
  }, [])

  // When the live courier integration (Delhivery) is active for India, it decides the
  // carrier, so India (INR) lines don't need a manually-chosen courier to check out.
  // International stays unchanged. Any failure is treated as "not live".
  const [liveCourierActiveIN, setLiveCourierActiveIN] = useState(false)
  useEffect(() => {
    courierIntegrationService.getPublicStatus()
      .then((res) => setLiveCourierActiveIN(!!res?.data?.liveActiveIN))
      .catch(() => setLiveCourierActiveIN(false))
  }, [])
  const courierPickerHidden = liveCourierActiveIN && getRegion() === 'IN'

  // Empty-cart discovery rails.
  const [suggested, setSuggested] = useState<PublicProduct[]>([])
  const [topSelling, setTopSelling] = useState<PublicProduct[]>([])
  const [recentlyViewed, setRecentlyViewed] = useState<PublicProduct[]>([])
  const emptyRailsLoaded = useRef(false)

  const pendingUpdates = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // While true, cart-changed events are ignored — set by the cart's own
  // mutations so a self-triggered event doesn't refetch over the optimistic
  // update. External adds (e.g. a similar product) arrive while it's false.
  const suppressRefetch = useRef(false)
  const suppressCartEvents = () => {
    suppressRefetch.current = true
    setTimeout(() => { suppressRefetch.current = false }, 1500)
  }

  // Similar products — same-category items as what's in the cart (excludes the
  // cart items themselves). Keyed by product+category so it doesn't refetch when
  // only quantities change; falls back to recent products if categories are sparse.
  const cartSignature = cartItems.map((i) => `${i.productId}:${i.category || ''}`).sort().join('|')
  useEffect(() => {
    if (cartItems.length === 0) { setSimilarProducts([]); return }
    let cancelled = false
    const TARGET = 6
    const run = async () => {
      const cats = Array.from(new Set(cartItems.map((i) => i.category).filter(Boolean))) as string[]
      const inCart = new Set(cartItems.map((i) => i.productId))
      const seen = new Set<string>()
      const list: PublicProduct[] = []
      // Collect distinct, not-in-cart products up to TARGET.
      const addFrom = (items: PublicProduct[]) => {
        for (const p of items) {
          if (list.length >= TARGET) break
          if (!p || inCart.has(p.id) || seen.has(p.id)) continue
          seen.add(p.id)
          list.push(p)
        }
      }
      try {
        if (cats.length) {
          const results = await Promise.all(
            cats.slice(0, 4).map((c) =>
              publicProductService
                .getProducts({ category: c, limit: 8 })
                .then((r) => (r.success && r.data ? r.data.items : []))
                .catch(() => [] as PublicProduct[]),
            ),
          )
          results.forEach(addFrom)
        }
        // Top up from recent products whenever the category pool didn't fill the
        // rail — including the common case where the cart's category contains only
        // the cart item itself (so every category result gets filtered out).
        if (list.length < TARGET) {
          const r = await publicProductService.getProducts({ limit: 12, sortBy: 'createdAt', sortOrder: 'desc' })
          if (r.success && r.data) addFrom(r.data.items)
        }
        if (!cancelled) setSimilarProducts(list)
      } catch {
        if (!cancelled) setSimilarProducts([])
      }
    }
    run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartSignature])

  // When the cart is empty, populate the three discovery rails:
  //   · Suggested for You — from the user's last search term, else random picks
  //   · Top Selling       — the "Top Selling" tagged catalogue
  //   · Recently Viewed   — products the user recently opened
  useEffect(() => {
    if (loading || cartItems.length > 0 || emptyRailsLoaded.current) return
    emptyRailsLoaded.current = true
    let cancelled = false

    const shuffle = <T,>(arr: T[]): T[] => {
      const a = [...arr]
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
          ;[a[i], a[j]] = [a[j], a[i]]
      }
      return a
    }

    const run = async () => {
      // Suggested — last search term, else a random sample of the catalogue.
      const searches = getRecentSearches()
      let sug: PublicProduct[] = []
      if (searches.length) {
        const r = await publicProductService.getProducts({ search: searches[0], limit: 8 }).catch(() => null)
        sug = r?.success && r.data ? r.data.items : []
      }
      if (sug.length === 0) {
        const r = await publicProductService.getProducts({ limit: 18, sortBy: 'createdAt', sortOrder: 'desc' }).catch(() => null)
        sug = shuffle(r?.success && r.data ? r.data.items : [])
      }
      if (!cancelled) setSuggested(sug.slice(0, 6))

      // Top Selling.
      const ts = await publicProductService.getTopSellingProducts(6).catch(() => null)
      if (!cancelled) setTopSelling(ts?.success && ts.data ? ts.data.items : [])

      // Recently viewed — resolve stored ids to live products.
      const ids = getRecentlyViewed().slice(0, 8)
      if (ids.length) {
        const results = await Promise.all(
          ids.map((id) =>
            publicProductService.getProduct(id).then((r) => (r.success ? r.data : null)).catch(() => null),
          ),
        )
        if (!cancelled) setRecentlyViewed(results.filter(Boolean).slice(0, 6) as PublicProduct[])
      }
    }
    run()
    return () => { cancelled = true }
  }, [loading, cartItems.length])

  const loadCart = useCallback(async (silent = false) => {
      try {
        if (!silent) setLoading(true)
        const authenticated = userAuthService.isAuthenticated()
        setIsAuthenticated(authenticated)

        if (!authenticated) {
          // Fetch from local storage for guest users
          const localCart = cartService.getLocalCart()
          const itemsPromises = localCart.map(async (item) => {
            try {
              const productRes = await publicProductService.getProduct(item.productId)
              if (productRes.success && productRes.data) {
                const product = productRes.data

                // If local cart has variantId, find the variant data inside the public product
                let variantDetails = undefined;
                let finalPrice = getRegionalPrice(product as any);
                let finalImages = product.images.map(img => img.url);
                let stock = product.totalStock;

                if (item.variantId && product.variants) {
                  const foundVariant = product.variants.find((v: any) => v.id === item.variantId);
                  if (foundVariant) {
                    variantDetails = {
                      size: foundVariant.size,
                      color: foundVariant.color,
                      colorHex: foundVariant.colorHex,
                      sku: foundVariant.sku
                    };
                    finalPrice = foundVariant.price;
                    stock = foundVariant.stock;
                    if (foundVariant.images && foundVariant.images.length > 0) {
                      finalImages = foundVariant.images;
                    }
                  }
                } else if ((product as any).singleUnitSize || (product as any).singleUnitColor) {
                  variantDetails = {
                    size: (product as any).singleUnitSize || '',
                    color: (product as any).singleUnitColor || '',
                    colorHex: (product as any).singleUnitColorHex,
                    sku: product.baseSku
                  };
                }

                // Automatic offer (attached by the public product endpoint).
                const activeOffer: ActiveOffer | undefined = (product as any).activeOffer;
                const effectivePrice = activeOffer
                  ? applyOfferToPrice(finalPrice, activeOffer, getCurrency(), item.quantity, convertINRtoUSD)
                  : finalPrice;
                const offerStrikePrice = activeOffer && effectivePrice < finalPrice ? finalPrice : undefined;

                return {
                  id: item.id, // Use local cart item ID
                  productId: item.productId,
                  name: product.name,
                  price: effectivePrice,
                  originalPrice: getRegionalOriginalPrice(product as any) ?? undefined,
                  activeOffer,
                  offerStrikePrice,
                  images: finalImages,
                  category: product.category,
                  rating: product.rating,
                  reviews: product.reviews,
                  inStock: product.inStock,
                  quantity: item.quantity,
                  availableStock: stock,
                  description: product.description,
                  material: product.material,
                  discount: product.discount,
                  gstPercentage: product.gstPercentage,
                  variantDetails,
                  product: product,
                }
              }
            } catch (err) {
              console.error(`Failed to fetch product ${item.productId}`, err)
            }
            return null
          })

          const resolvedItems = await Promise.all(itemsPromises)
          const items = resolvedItems.filter((item) => item !== null) as OrderItem[]
          setCartItems(items)
        } else {
          // Fetch from backend for authenticated users
          const response = await cartService.getCart()
          if (response.success && response.data) {
            const items = response.data.items.map((item: any) => {
              const hasVariant = !!item.variant;
              const hasVariantImg = hasVariant && item.variant.images?.length > 0;
              const hasProductImg = item.product?.images?.length > 0;

              const imgArray = hasVariantImg
                ? item.variant.images
                : (hasProductImg ? item.product.images.map((img: any) => img.url) : []);

              // Use live regional pricing
              const livePrice = hasVariant
                ? getRegionalPrice(item.variant as any)
                : getRegionalPrice(item.product as any);

              // Variant stock takes priority
              const liveStock = hasVariant
                ? item.variant.stock
                : (item.product?.availableStock ?? item.product?.totalStock);

              // Variant-specific discount/originalPrice (region-aware)
              const liveOriginalPrice = hasVariant
                ? getRegionalOriginalPrice(item.variant as any) ?? getRegionalOriginalPrice(item.product as any)
                : getRegionalOriginalPrice(item.product as any);
              const liveDiscount = hasVariant
                ? (item.variant.discount ?? item.product?.discount)
                : item.product?.discount;

              // Automatic offer (attached by the backend). Bake it into `price` so the
              // subtotal, tax and coupon math all use exactly what checkout will charge.
              const activeOffer: ActiveOffer | undefined = item.product?.activeOffer;
              const isFreeGift = !!item.isFreeGift;
              const effectivePrice = isFreeGift
                ? 0
                : activeOffer
                  ? applyOfferToPrice(livePrice, activeOffer, getCurrency(), item.quantity, convertINRtoUSD)
                  : livePrice;
              // Gift line: strike the normal price so the shopper sees the value they got free.
              const offerStrikePrice = isFreeGift
                ? livePrice
                : (activeOffer && effectivePrice < livePrice ? livePrice : undefined);

              return {
                id: item.id,
                productId: item.productId,
                name: item.product?.name || 'Unknown Product',
                price: effectivePrice,
                originalPrice: isFreeGift ? livePrice : (liveOriginalPrice ?? undefined),
                isFreeGift,
                giftOfferId: item.giftOfferId ?? null,
                activeOffer,
                offerStrikePrice,
                images: imgArray,
                category: item.product?.category || '',
                rating: item.product?.rating,
                reviews: item.product?.reviews,
                inStock: liveStock > 0 && (item.product?.inStock ?? true),
                availableStock: liveStock,
                quantity: item.quantity,
                description: item.product?.description,
                material: item.product?.material,
                discount: liveDiscount,
                gstPercentage: item.product?.gstPercentage,
                transportType: item.transportType ?? null,
                courier: item.courier ?? null,
                variantDetails: hasVariant ? {
                  size: item.variant.size,
                  color: item.variant.color,
                  colorHex: item.variant.colorHex,
                  sku: item.variant.sku
                } : (item.product?.singleUnitSize || item.product?.singleUnitColor) ? {
                  size: item.product.singleUnitSize || '',
                  color: item.product.singleUnitColor || '',
                  colorHex: item.product.singleUnitColorHex,
                  sku: item.product.baseSku || ''
                } : undefined,
                product: item.product || null,
              }
            })
            setCartItems(items)
            setPendingGifts(response.data.pendingGifts || [])
            setGiftOptions(response.data.giftOptions || [])
          }
        }
      } catch (error) {
        console.error('Failed to fetch cart:', error)
        showErrorToast('Error', 'Failed to load cart items')
      } finally {
        if (!silent) setLoading(false)
        setIsHydrated(true)
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { loadCart() }, [loadCart])

  // Claim a chosen free gift, then refresh so the gift line + celebration appear.
  const chooseGift = async (offerId: string, productId: string, variantId?: string) => {
    setAddingGift(true)
    try {
      const res = await cartService.addFreeGift(offerId, productId, variantId)
      if (res.success) {
        setGiftChooser(null)
        await loadCart(true)
        showSuccessToast('Free gift added', 'Enjoy your free item!')
      } else {
        showErrorToast('Could not add gift', res.error || res.message || 'Please try again')
      }
    } catch (e) {
      showErrorToast('Could not add gift', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setAddingGift(false)
    }
  }

  // Refresh when the cart changes elsewhere (e.g. adding a similar product below).
  // Self-triggered events are ignored — those already update state optimistically.
  useEffect(() => {
    const onCartChanged = () => {
      if (suppressRefetch.current) return
      loadCart(true)
    }
    window.addEventListener('cart-changed', onCartChanged)
    return () => window.removeEventListener('cart-changed', onCartChanged)
  }, [loadCart])

  const [promoCode, setPromoCode] = useState("")
  const [appliedPromo, setAppliedPromo] = useState("")
  /** Set only on a successful apply; the stub reads it and clears itself. */
  const [couponLanded, setCouponLanded] = useState<{ code: string; amount: number } | null>(null)
  const [discountAmount, setDiscountAmount] = useState(0)
  const [freeShippingApplied, setFreeShippingApplied] = useState(false)
  const [freeShippingMessage, setFreeShippingMessage] = useState("")

  // Automatic-offer celebration: a gift-box popup for BOGO, a coin "you saved ₹X"
  // popup for any other applied offer. Fires on every cart visit and names the offer.
  const [offerCelebration, setOfferCelebration] = useState<
    | { kind: 'bogo'; freeUnits: number; dealLabel: string; offerTitle: string; offerDescription: string }
    | { kind: 'savings'; amount: number; offerTitle: string; offerDescription: string }
    | null
  >(null)
  const offerCelebratedRef = useRef(false)

  // What did the automatic offers earn on this cart? Free units + deepest deal for
  // BOGO, and total rupee saving vs the pre-offer price for everything else.
  const offerAgg = useMemo(() => {
    let freeUnits = 0
    let savings = 0
    let bogoLabel = ''
    // The named offer that drives the celebration — the BOGO deal's offer if one
    // is unlocked, else the offer on the line that saved the most money — so the
    // popup can say exactly which offer was applied and what it is.
    let bogoOffer: { title?: string; description?: string | null } | null = null
    let bestSavingOffer: { title?: string; description?: string | null } | null = null
    let bestSaving = 0
    for (const it of cartItems) {
      // Free-gift lines have no activeOffer — celebrate them as a gift-box freebie.
      if (it.isFreeGift) {
        const strike = it.offerStrikePrice && it.offerStrikePrice > it.price ? it.offerStrikePrice : 0
        if (strike) {
          savings += (strike - it.price) * it.quantity
          freeUnits += it.quantity
          if (!bogoLabel) bogoLabel = 'Free gift unlocked'
          if (!bogoOffer) bogoOffer = { title: it.name, description: 'Added to your cart free' }
        }
        continue
      }
      const ao = it.activeOffer
      if (!ao) continue
      if (ao.type === 'BOGO' && ao.bogoMode !== 'CROSS') {
        const buy = Math.max(1, ao.minQty || 1)
        const free = Math.max(0, ao.getQty || 0)
        const group = buy + free
        const fu = group > 0 && it.quantity >= group ? free : 0
        if (fu > 0) {
          freeUnits += fu
          if (!bogoLabel) bogoLabel = `Buy ${buy} Get ${free} Free`
          if (!bogoOffer) bogoOffer = { title: ao.title, description: ao.description }
        }
      }
      const strike = it.offerStrikePrice && it.offerStrikePrice > it.price ? it.offerStrikePrice : 0
      if (strike) {
        const lineSaving = (strike - it.price) * it.quantity
        savings += lineSaving
        // Cross-product BOGO free line: each free unit saves its full price, so
        // freeUnits ≈ lineSaving / unit list price. Celebrate it as a freebie.
        if (ao.type === 'BOGO' && ao.bogoMode === 'CROSS') {
          const fu = Math.round(lineSaving / strike)
          if (fu > 0) {
            freeUnits += fu
            if (!bogoLabel) bogoLabel = ao.title || 'Free item'
            if (!bogoOffer) bogoOffer = { title: ao.title, description: ao.description }
          }
        }
        if (lineSaving > bestSaving) {
          bestSaving = lineSaving
          bestSavingOffer = { title: ao.title, description: ao.description }
        }
      }
    }
    const offer = freeUnits > 0 ? bogoOffer : bestSavingOffer
    return {
      freeUnits,
      savings: Math.round(savings * 100) / 100,
      bogoLabel,
      offerTitle: offer?.title || '',
      offerDescription: offer?.description || '',
    }
  }, [cartItems])

  // Trigger the celebration once, shortly after the cart has settled, so it lands
  // as a reward on arrival rather than fighting the page paint. Deferred via a timer
  // so we never setState synchronously inside the effect.
  useEffect(() => {
    if (loading || offerCelebratedRef.current) return
    if (offerAgg.freeUnits <= 0 && offerAgg.savings <= 0) return
    // Fire on every visit to the page (once per mount — the ref just stops it
    // double-firing while this mount is alive). No sessionStorage guard, so the
    // reward pops again each time the shopper opens the cart, as requested.
    offerCelebratedRef.current = true
    const t = setTimeout(() => {
      setOfferCelebration(
        offerAgg.freeUnits > 0
          ? { kind: 'bogo', freeUnits: offerAgg.freeUnits, dealLabel: offerAgg.bogoLabel, offerTitle: offerAgg.offerTitle, offerDescription: offerAgg.offerDescription }
          : { kind: 'savings', amount: offerAgg.savings, offerTitle: offerAgg.offerTitle, offerDescription: offerAgg.offerDescription }
      )
    }, 600)
    return () => clearTimeout(t)
  }, [loading, offerAgg, cartItems])

  useEffect(() => {
    const savedCoupon = localStorage.getItem('appliedCoupon')
    if (savedCoupon) {
      try {
        const { code, discountAmount, freeShipping, freeShippingMessage } = JSON.parse(savedCoupon)
        setAppliedPromo(code)
        setDiscountAmount(discountAmount || 0)
        setFreeShippingApplied(freeShipping || false)
        setFreeShippingMessage(freeShippingMessage || "")
      } catch {
        localStorage.removeItem('appliedCoupon')
      }
    }
    
    // Check for free shipping offers automatically
    checkFreeShippingOffers()
  }, [cartItems, isAuthenticated]) // Add dependencies

  // Check free shipping offers automatically
  const checkFreeShippingOffers = async () => {
    if (!isAuthenticated) return // Only for authenticated users
    
    try {
      const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
      const userData = JSON.parse(localStorage.getItem('userData') || '{}')
      
      if (userData.id && subtotal > 0) {
        const response = await couponService.applyFreeShippingOffer(userData.id, subtotal)
        
        if (response.success && response.data?.freeShipping) {
          setFreeShippingApplied(true)
          setFreeShippingMessage(response.message || "Free shipping available!")
          
          // Save free shipping info
          const currentCoupon = localStorage.getItem('appliedCoupon')
          const couponData = currentCoupon ? JSON.parse(currentCoupon) : {}
          localStorage.setItem('appliedCoupon', JSON.stringify({
            ...couponData,
            freeShipping: true,
            freeShippingMessage: response.message
          }))
        }
      }
    } catch (error) {
      console.warn('Free shipping check failed:', error)
    }
  }

  // Above the loading early-return below, not beside the coupon handlers:
  // everything under that return is skipped while the skeleton is showing,
  // so a hook placed there is called on some renders and not others and
  // React tears the page down with "rendered more hooks than during the
  // previous render".
  //
  // The stub is a notice, not a dialogue: it leaves on its own, and either
  // Escape or a click anywhere sends it early. No focus trap — trapping focus
  // in something that vanishes after two seconds strands the keyboard.
  useEffect(() => {
    if (!couponLanded) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCouponLanded(null) }
    const timer = setTimeout(() => setCouponLanded(null), reduce ? 1900 : 3600)
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey) }
  }, [couponLanded])

  if (!isHydrated || loading) {
    return (
      <div className="min-h-screen bg-[#f9f5f2] py-4 sm:py-6 lg:py-8 font-sans">
        <div className="max-w-7xl xl:max-w-420 mx-auto px-3 sm:px-4 md:px-6 lg:px-8">
          <div className="mb-5 sm:mb-6 lg:mb-8">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                {/* The same mark as the loaded masthead, unanimated. The
                    skeleton exists so the page does not jump when the cart
                    arrives, which it would if the two headers differed. */}
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-linear-to-b from-[#fdf1ef] to-[#f9e3df] ring-1 ring-[#f2d9d3] sm:h-14 sm:w-14">
                  <ShoppingCart className="h-6 w-6 text-[#e01a1b] sm:h-7 sm:w-7" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <h1 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#1a1a1a] mb-1 sm:mb-2">Shopping Cart</h1>
                  <p className="text-sm sm:text-base text-[#6b625b]">Review your items and proceed to checkout</p>
                </div>
              </div>
            </div>
          </div>
          <div className="animate-pulse space-y-3 sm:space-y-4">
            <div className="h-24 sm:h-32 bg-[#ece7e0] rounded-xl sm:rounded-2xl"></div>
            <div className="h-24 sm:h-32 bg-[#ece7e0] rounded-xl sm:rounded-2xl"></div>
            <div className="h-24 sm:h-32 bg-[#ece7e0] rounded-xl sm:rounded-2xl"></div>
          </div>
        </div>
      </div>
    )
  }

  /** Transport modes a product offers. >1 means the customer must choose. */
  const transportOptionsFor = (item: OrderItem): Array<'AIR' | 'SHIP'> => {
    const types = (item as any).product?.logisticsConfig?.transportTypes
    return Array.isArray(types) ? types : []
  }

  /** A line still needs a shipping decision (transport and/or courier) before checkout. */
  const needsTransportChoice = (item: OrderItem) => {
    const opts = transportOptionsFor(item)
    if (opts.length === 0) return false // no logistics — nothing to choose
    if (opts.length > 1 && !item.transportType) return true // must pick a mode
    if (courierPickerHidden) return false // live India integration assigns the carrier
    return !item.courier // shipping products must have a courier
  }

  const updateQuantity = (id: string, productId: string, newQuantity: number) => {
    if (newQuantity < 1) {
      removeItem(id)
      return
    }

    // Clamp to available stock
    const item = cartItems.find(i => i.id === id)
    if (item?.availableStock != null && newQuantity > item.availableStock) {
      newQuantity = item.availableStock
    }
    if (item && newQuantity === item.quantity) return

    // Optimistic update — instant UI feedback
    suppressCartEvents() // ignore the cart-changed we are about to cause
    setCartItems(items =>
      items.map(i => i.id === id ? { ...i, quantity: newQuantity } : i)
    )

    // Debounce API call — rapid clicks coalesce into one request
    if (pendingUpdates.current[id]) clearTimeout(pendingUpdates.current[id])
    pendingUpdates.current[id] = setTimeout(async () => {
      delete pendingUpdates.current[id]
      try {
        if (isAuthenticated) {
          await cartService.updateCartItem(id, newQuantity)
        } else {
          cartService.updateLocalCartItem(id, newQuantity)
        }
      } catch {
        // Rollback on failure — re-fetch cart
        showErrorToast('Error', 'Failed to update quantity')
        const response = await cartService.getCart()
        if (response.success && response.data) {
          // Re-run the mapping (simplified — just update quantity)
          setCartItems(items =>
            items.map(i => {
              const serverItem = response.data!.items.find((s: { id: string; quantity: number }) => s.id === i.id)
              return serverItem ? { ...i, quantity: serverItem.quantity } : i
            })
          )
        }
      }
    }, 400)
  }

  const removeItem = async (id: string, opts?: { silent?: boolean }) => {
    suppressCartEvents() // ignore the cart-changed we are about to cause
    try {
      if (!isAuthenticated) {
        cartService.removeFromLocalCart(id)
        setCartItems(items => items.filter(item => item.id !== id))
        if (!opts?.silent) showSuccessToast('Removed', 'Item removed from cart')
        return
      }

      // Remove via API
      await cartService.removeFromCart(id)
      setCartItems(items => items.filter(item => item.id !== id))
      if (!opts?.silent) showSuccessToast('Removed', 'Item removed from cart')
      } catch (error: unknown) {
        console.error('Failed to remove item:', error)
        showErrorToast('Error', 'Failed to remove item')
      }

  }

  // Move a cart line to the wishlist: ensure it's in the wishlist (add only if
  // it isn't already there), then remove it from the cart.
  const moveToWishlist = async (item: OrderItem) => {
    try {
      if (isAuthenticated) {
        const inList = wishlistService.isInWishlistSync(item.productId)
          || (await wishlistService.isInWishlist(item.productId))
        if (!inList) await wishlistService.addToWishlist(item.productId)
      } else {
        wishlistService.addToLocalWishlist(item.productId)
      }
    } catch (error) {
      console.error('Failed to move item to wishlist:', error)
      showErrorToast('Error', 'Could not move item to wishlist')
      return
    }
    await removeItem(item.id, { silent: true })
    showSuccessToast('Moved to Wishlist', `${item.name} moved to your wishlist`)
  }

  const applyPromoCode = async () => {
    if (!promoCode.trim()) {
      showErrorToast("Error", "Please enter a promo code")
      return;
    }

    try {
      // Calculate subtotal for validation
      const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)

      const response = await couponService.applyCoupon(promoCode, subtotal, getCurrency())

      if (response.success && response.data) {
        setAppliedPromo(response.data.code)
        // Ensure discount doesn't exceed total (though backend handles this, good to be safe)
        setDiscountAmount(response.data.discountAmount)
        setPromoCode("") // Clear input field
        // The centre stub says this, louder. Firing a toast as well would
        // announce one action twice, which reads as a bug rather than as
        // emphasis. Every other toast on the page is untouched.
        //
        // Only when the cart had no coupon on it a moment ago. Nothing stops
        // Apply being pressed again -- the button is live either way -- and
        // without this guard the same coupon threw its confetti on every
        // press. appliedPromo still holds the PREVIOUS value here, which is
        // exactly the question being asked: was anything already applied when
        // this press happened.
        //
        // Removing the coupon clears it, so a genuine re-add celebrates again.
        if (!appliedPromo) {
          setCouponLanded({ code: response.data.code, amount: response.data.discountAmount })
        }

        // Save to local storage for Checkout page to retrieve
        localStorage.setItem('appliedCoupon', JSON.stringify({
          code: response.data.code,
          discountAmount: response.data.discountAmount,
          freeShipping: response.data.freeShipping || false,
          freeShippingMessage: response.data.freeShipping ? "Free shipping included!" : ""
        }))
      } else {
        throw new Error(response.message || "Invalid coupon")
      }
      } catch (error: unknown) {
        console.error("Coupon error:", error)
        setAppliedPromo("")
        setDiscountAmount(0)
        localStorage.removeItem('appliedCoupon')
        const errorMessage = error instanceof Error ? error.message : "Failed to apply coupon"
        showErrorToast("Error", errorMessage)
      }
  }

  // Remove coupon
  const removeCoupon = () => {
    setAppliedPromo("")
    setDiscountAmount(0)
    setFreeShippingApplied(false)
    setFreeShippingMessage("")
    localStorage.removeItem('appliedCoupon')
    showSuccessToast("Removed", "Coupon removed")
  }

  const calculateSummary = (): OrderSummary => {
    const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
    // Calculate logistics-based shipping from product configs
    // Per-kg rates are stored in RUPEES — convert for a USD cart so the figure
    // matches what checkout quotes and what the server charges.
    let logisticsShippingInr = 0
    if (!freeShippingApplied) {
      for (const item of cartItems) {
        const config = (item as any).product?.logisticsConfig
        if (config) {
          // Price with the mode the customer picked; fall back to the only option
          // when there is no choice. Matches orderController's resolution exactly.
          const types = Array.isArray(config.transportTypes) ? config.transportTypes : []
          const mode = (item.transportType || types[0]) as 'AIR' | 'SHIP' | undefined
          const result = calculateLogistics(config as LogisticsConfig, item.quantity, mode, getRegion())
          logisticsShippingInr += result.totalShippingCost
        }
      }
    }
    // India live courier: the real shipping cost needs the delivery pincode and is
    // quoted by Delhivery at checkout, so the weight-based estimate is left out of
    // the cart total (the Delivery charges line shows "Calculated at checkout").
    const shipping = freeShippingApplied || courierPickerHidden
      ? 0
      : (getCurrency() === 'USD' ? convertINRtoUSD(logisticsShippingInr) : logisticsShippingInr)
    const discount = discountAmount

    // GST is charged on the POST-coupon net, per each product's own rate. A coupon
    // reduces the taxable value (it's an invoice-recorded, pre-supply discount), so
    // we allocate it across lines in proportion to their value and tax each net.
    // This mirrors the server (orderController) exactly, so the quoted tax equals
    // the charged tax. Product discounts / automatic offers are already inside
    // item.price, so they are taxed net too.
    // Tax/GST applies ONLY on the `.in` storefront. On `.com` and every other
    // region tax is 0 (mirrors the server, which gates on the order currency).
    const tax = getRegion() !== 'IN' ? 0 : cartItems.reduce((sum, item) => {
      const gross = item.price * item.quantity
      const couponShare = subtotal > 0 ? (gross / subtotal) * discount : 0
      const net = Math.max(0, gross - couponShare)
      const gstRate = item.gstPercentage ? item.gstPercentage / 100 : 0
      return sum + (net * gstRate)
    }, 0)

    const total = subtotal + shipping + tax - discount

    return { subtotal, shipping, tax, discount, total: total > 0 ? total : 0 }
  }

  const summary = calculateSummary()

  // GST breakup rows for the cart summary (IN only). Split when both the company
  // state and the customer's default address state are known; otherwise show a
  // single "Tax (GST)" row (place of supply is finalised at checkout).
  const gstLines = (() => {
    if (getRegion() !== 'IN' || summary.tax <= 0) return []
    const lines = cartItems.map((i) => {
      const gross = i.price * i.quantity
      const couponShare = summary.subtotal > 0 ? (gross / summary.subtotal) * summary.discount : 0
      return { net: Math.max(0, gross - couponShare), rate: i.gstPercentage || 0 }
    })
    const mode = (!gstSupplier.state || !gstCustomer.state)
      ? 'COMBINED' as const
      : (isIntrastate(gstSupplier.state, gstCustomer.state, gstSupplier.country, gstCustomer.country) ? 'INTRASTATE' as const : 'INTERSTATE' as const)
    return gstRateRows(lines, mode)
  })()

  // Rich, reconcilable savings breakdown for the Order Summary. Each line bridges
  // one step of the price ladder so the numbers add up top-to-bottom:
  //   Items subtotal (MRP)
  //     − Product discount   → after product-level % off
  //     − Offer discount     → after automatic offers (baked into item.price)
  //   = Taxable amount (the base GST is actually computed on)
  //     + Tax (GST) + Delivery − Coupon
  //   = Total payable
  // Product-level maths stay on each cart item; here we only show the aggregate.
  const round2 = (n: number) => Math.round(n * 100) / 100
  const listSubtotal = cartItems.reduce((s, it) => {
    const list = Math.max(it.originalPrice ?? 0, it.offerStrikePrice ?? 0, it.price)
    return s + list * it.quantity
  }, 0)
  const preOfferSubtotal = cartItems.reduce(
    (s, it) => s + (it.offerStrikePrice ?? it.price) * it.quantity, 0,
  )
  const productDiscount = Math.max(0, round2(listSubtotal - preOfferSubtotal))
  const offerDiscount = Math.max(0, round2(preOfferSubtotal - summary.subtotal))
  const couponDiscount = summary.discount
  const totalSavings = round2(productDiscount + offerDiscount + couponDiscount)

  return (
    <div className="min-h-screen bg-[#f9f5f2] py-4 sm:py-6 lg:py-8 font-sans">
      <style>{`
        /* ── The count leaving the cart ────────────────────────────────
           Two halves of one gesture, played whenever the number of lines
           changes: the basket rocks as though something has just been
           dropped into it, and the count comes out from underneath it,
           small and to the left, arriving where it sits.

           They are tied together by a React key on the item count, so both
           elements remount and replay the moment the count changes and at
           no other time. Nothing is scheduled, nothing is timed out, and
           there is no state to leave behind if the page unmounts mid-play.

           Transform only. Both animate composited properties, so neither
           can reflow the masthead or move the heading beside them.
           (No backticks in here — this is a JS template literal.) */
        @keyframes cartRock {
          0%   { transform: rotate(0deg) scale(1) }
          20%  { transform: rotate(-9deg) scale(1.07) }
          44%  { transform: rotate(7deg) scale(1.04) }
          68%  { transform: rotate(-3deg) scale(1.015) }
          100% { transform: rotate(0deg) scale(1) }
        }
        .cart-mark {
          animation: cartRock 620ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
          /* Low, so the badge tips on its bottom edge like something with
             weight in it, rather than spinning about its middle. */
          transform-origin: 50% 82%;
        }

        /* Starts small, low and tucked left — behind the basket — then
           travels out to rest. The overshoot at 62% is what makes it read
           as being tipped out rather than merely faded in. */
        @keyframes countOut {
          0%   { transform: translate(-14px, 4px) scale(0.5); opacity: 0 }
          62%  { transform: translate(0, 0) scale(1.12); opacity: 1 }
          100% { transform: translate(0, 0) scale(1); opacity: 1 }
        }
        .cart-count {
          animation: countOut 520ms 90ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }

        /* ── The coupon landing ────────────────────────────────────────
           A stub that arrives small and a little off-square, settles level,
           and is stamped a beat later.

           The delay between the two is the whole trick: the card has to look
           like it has come to rest before anything can be pressed onto it.
           Landing and stamp together would read as one flat pop.

           The overshoots are deliberate. 1.02 at 60 per cent and back reads
           as weight settling; travelling straight to 1 reads as a fade. The
           stamp arrives oversized and crooked, as though swung down onto the
           paper, and overshoots small before it comes to rest.
           (No backticks in here — this is a JS template literal.) */
        @keyframes couponScrim {
          from { opacity: 0 }
          to   { opacity: 1 }
        }
        .coupon-scrim { animation: couponScrim 200ms ease-out both }

        @keyframes couponIn {
          0%   { opacity: 0; transform: translateY(14px) scale(0.86) rotate(-2.5deg) }
          60%  { opacity: 1; transform: translateY(0) scale(1.02) rotate(0.6deg) }
          100% { opacity: 1; transform: translateY(0) scale(1) rotate(0deg) }
        }
        .coupon-card { animation: couponIn 460ms cubic-bezier(0.22, 1, 0.36, 1) both }

        @keyframes couponStamp {
          0%   { opacity: 0; transform: scale(2.3) rotate(-26deg) }
          55%  { opacity: 1; transform: scale(0.9) rotate(-5deg) }
          78%  { transform: scale(1.07) rotate(-10deg) }
          100% { opacity: 1; transform: scale(1) rotate(-8deg) }
        }
        .coupon-stamp { animation: couponStamp 540ms 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both }

        /* Out, then down. The 45 per cent stop is most of the throw, so the
           pieces decelerate on the way out and then fall away — one keyframe
           doing an arc rather than a straight line, which is the difference
           between confetti and a starburst clipart. */
        @keyframes couponBurst {
          0%   { opacity: 0; transform: translate(0, 0) scale(0.4) rotate(0deg) }
          12%  { opacity: 1 }
          45%  { transform: translate(calc(var(--tx) * 0.86), calc(var(--ty) * 0.82)) scale(1) rotate(calc(var(--r) * 0.55)) }
          70%  { opacity: 1 }
          100% { opacity: 0; transform: translate(var(--tx), calc(var(--ty) + 150px)) scale(0.85) rotate(var(--r)) }
        }
        .coupon-piece { animation: couponBurst 1500ms cubic-bezier(0.16, 0.72, 0.3, 1) both }

        /* One pass of light across the paper once the stamp is down. */
        @keyframes couponSheen {
          from { transform: translateX(-140%) skewX(-18deg) }
          to   { transform: translateX(420%) skewX(-18deg) }
        }
        .coupon-sheen { animation: couponSheen 950ms 460ms ease-in-out both }

        /* Anyone who has asked not to be moved gets both, instantly and
           in place. The fill mode is "both", so the resting frame is the one
           that sticks and nothing is left mid-rock or invisible.
           (Note the wording: a backtick here would close this very
           template literal, which is exactly how this block broke once.) */
        @media (prefers-reduced-motion: reduce) {
          .cart-mark, .cart-count { animation: none }
          .coupon-scrim, .coupon-card, .coupon-stamp { animation: none }
          .coupon-sheen, .coupon-piece { display: none }
        }
      `}</style>

      <div className="max-w-7xl xl:max-w-420 mx-auto px-3 sm:px-4 md:px-6 lg:px-8">
        {/* Header — Order-page style with icon + count */}
        <div className="mb-5 sm:mb-6 lg:mb-8">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              {/* A mark, not a loose glyph.
                  A bare 28px basket is thin for the one symbol this page is
                  named after, and `items-center` was centring it across a
                  TWO-LINE block — so it came to rest in the gap between the
                  title and the line under it, touching neither. Given a chip
                  of its own it has a size and a position: tall enough to span
                  both lines, and aligned to them rather than to the space
                  between them.

                  The chip is what rocks now. The glyph alone had barely any
                  area to move, so the gesture was easy to miss; a 56px badge
                  tilting on its lower edge is the same movement, legible. */}
              <span
                key={'cart-mark-' + cartItems.length}
                className="cart-mark flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-linear-to-b from-[#fdf1ef] to-[#f9e3df] ring-1 ring-[#f2d9d3] sm:h-14 sm:w-14"
              >
                <ShoppingCart className="h-6 w-6 text-[#e01a1b] sm:h-7 sm:w-7" strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                {/* The count sits with the title, not at the far edge of the
                    masthead. Pinned right it was a lone figure across a wide
                    empty band, related to nothing beside it; here it reads as
                    part of the heading it is counting. */}
                <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:mb-2">
                  <h1 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight text-[#1a1a1a]">Shopping Cart</h1>
                  <span
                    key={'cart-count-' + cartItems.length}
                    className="cart-count inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-semibold text-[#6b625b] ring-1 ring-[#efe6df] sm:text-[13px]"
                  >
                    <span className="font-bold tabular-nums text-[#c41617]">{cartItems.length}</span>
                    Items
                  </span>
                </div>
                <p className="text-sm sm:text-base text-[#6b625b]">Review your items and proceed to checkout</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
          {/* Cart Items — Order-page style: each item its own card with gaps between */}
          <div className="lg:col-span-2">
            {/* Free gift to claim — the buy condition is met but the free set has options,
                so the customer chooses which gift they want. */}
            {pendingGifts.map((pg) => (
              <div key={pg.offerId} className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-[#f3d9a0] bg-linear-to-r from-[#fff9ec] to-[#fdf3f0] p-4 shadow-[0_1px_2px_rgba(90,60,40,0.05)]">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#157f4a] text-white">
                  <Gift className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-[#1a1a1a]">You&apos;ve unlocked a free gift! 🎉</p>
                  <p className="text-[13px] text-[#7a5a52]">
                    {pg.offerTitle} — choose your free item{pg.getQty > 1 ? ` (×${pg.getQty})` : ''}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setGiftInitialProduct(undefined); setGiftChooser(pg) }}
                  className="shrink-0 rounded-full bg-[#157f4a] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#116b3e]"
                >
                  Choose free gift
                </button>
              </div>
            ))}

            {/* One panel, rows divided by a hairline. It was a card per
                item -- eight floating boxes each with its own ring, shadow
                and gap, which made a six-line cart read as six separate
                things rather than one list. Both references your senior
                named do the same thing: Amazon and Flipkart each put the
                whole cart on a single surface and divide it. */}
            {cartItems.length > 0 && (
              <div className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(90,60,40,0.05)] ring-1 ring-[#efe6df]">
                <ul className="divide-y divide-[#f2eae1]">
                  {cartItems.map((item) => {
                    // Mirror the product page exactly so the two never disagree.
                    // The product detail buy box strikes the PRE-OFFER selling
                    // price when a store offer is live (e.g. ₹350 -> ₹280 = 20%),
                    // and falls back to the MRP only when there is no offer
                    // (e.g. ₹400 -> ₹350). Taking the MAX of both bases (the old
                    // behaviour) measured the discount against the ₹400 MRP and
                    // produced 30% here while the product page showed 20% -- the
                    // same item reading two different discounts. So: prefer the
                    // offer strike price; otherwise the MRP; otherwise no badge.
                    const offerStrike = item.offerStrikePrice && item.offerStrikePrice > item.price
                      ? item.offerStrikePrice
                      : 0
                    const unitList = offerStrike
                      || (item.originalPrice && item.originalPrice > item.price ? item.originalPrice : item.price)
                    const lineList = unitList * item.quantity
                    const linePaid = item.price * item.quantity
                    const offPct = lineList > linePaid ? Math.round(((lineList - linePaid) / lineList) * 100) : 0
                    // Free-gift line ("buy A get B free"): a system-managed ₹0 line the
                    // customer got (or chose) for free. Fixed quantity, no controls.
                    const isCrossFree = !!item.isFreeGift
                    // Same-item Buy X Get Y (BOGO): a plain "33% off" pill hides what the
                    // deal actually is. Surface the terms ("Buy 2 Get 1") and, once enough
                    // units are in the cart to earn a free one, how many are free.
                    const bogo = item.activeOffer?.type === 'BOGO' && item.activeOffer?.bogoMode !== 'CROSS'
                      ? { buy: Math.max(1, item.activeOffer.minQty || 1), free: Math.max(0, item.activeOffer.getQty || 0) }
                      : null
                    const bogoGroup = bogo ? bogo.buy + bogo.free : 0
                    // Free granted ONCE at buy+get units, not multiplied per group.
                    const bogoFreeUnits = bogo && bogoGroup > 0 && item.quantity >= bogoGroup ? bogo.free : 0
                    // Hover text for the FREE tag: cross-BOGO names the free product;
                    // same-item BOGO explains which/how many of the units are free.
                    const freeTooltip = isCrossFree
                      ? `This ${item.name} is your free gift — you pay nothing for it.`
                      : (bogoFreeUnits > 0 && bogo)
                        ? `Buy ${bogo.buy} Get ${bogo.free} free — ${bogoFreeUnits} of your ${item.quantity} ${bogoFreeUnits === 1 ? 'unit is' : 'units are'} free.`
                        : ''
                    const lowStock = item.inStock && item.availableStock != null
                      && item.availableStock > 0 && item.availableStock <= 5
                    // The cart line carries no slug, only the product id -- and
                    // the public product route takes either, so the id is a
                    // valid address for the page. (backend getPublicProduct
                    // branches on whether the parameter looks like an ObjectId.)
                    const productHref = `/products/${item.productId}`

                    return (
                    <li key={item.id} className="@container px-4 py-4 sm:px-5 sm:py-5">
                      <div className="flex gap-3 sm:gap-4">
                        {/* Product Image. A link: the photograph is the first
                            thing anyone clicks when they want another look at
                            what they are about to buy, and it went nowhere. */}
                        <Link href={productHref} aria-label={`View ${item.name}`} className="shrink-0">
                          {item.images && item.images.length > 0 ? (
                            /* The frame crops and the picture moves inside it, so
                               the row's own geometry never changes on hover. */
                            <div className="group h-16 w-16 overflow-hidden rounded-lg ring-1 ring-[#efe6df] sm:h-20 sm:w-20 sm:rounded-xl">
                              <Image
                                src={item.images[0]}
                                alt={item.name}
                                width={96}
                                height={96}
                                className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.07]"
                              />
                            </div>
                          ) : (
                            <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-[#f6f1ea] ring-1 ring-[#efe6df] sm:h-20 sm:w-20 sm:rounded-xl">
                              <Package className="h-6 w-6 text-[#c9aeab] sm:h-7 sm:w-7" />
                            </div>
                          )}
                        </Link>

                        <div className="min-w-0 flex-1">
                          {/* Facts on the left, money on the right, exactly as
                              Amazon sets a cart line. The money block is sized
                              to its content and the facts take the slack, so
                              the figures form a column down the list. */}
                          <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
                            <div className="min-w-0 flex-1 basis-[13rem]">
                              <h3 className="text-sm font-semibold text-[#1a1a1a] break-words sm:text-[15px]">
                                <Link href={productHref} className="transition-colors hover:text-[#e01a1b]">{item.name}</Link>
                              </h3>

                              {item.variantDetails && (item.variantDetails.color || item.variantDetails.size) && (
                                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6b625b] sm:text-[13px]">
                                  {item.variantDetails.color && (
                                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                                      <span className="text-[#a1948a]">Color:</span>
                                      {item.variantDetails.colorHex && (
                                        <span
                                          className="inline-block h-3 w-3 rounded-full border border-[#e3dbd1]"
                                          style={{ backgroundColor: item.variantDetails.colorHex }}
                                        />
                                      )}
                                      <span className="font-medium text-[#4a423c]">{item.variantDetails.color}</span>
                                    </span>
                                  )}
                                  {item.variantDetails.size && (
                                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                                      <span className="text-[#a1948a]">Size:</span>
                                      <span className="font-medium text-[#4a423c]">{item.variantDetails.size}</span>
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Stock state, stated rather than implied. Both
                                  references put this on every line; we hold
                                  inStock on every product, so it costs nothing
                                  to say. */}
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-[13px]">
                                {!item.inStock ? (
                                  <span className="font-semibold text-[#c41617]">Out of stock</span>
                                ) : lowStock ? (
                                  <span className="font-semibold text-[#a86a12]">Only {item.availableStock} left</span>
                                ) : (
                                  <span className="font-medium text-[#157f4a]">In stock</span>
                                )}

                                {/* Which offer did this. The title was already
                                    in the payload and thrown away, so with two
                                    store-wide offers running neither the
                                    customer nor the admin could tell from the
                                    page which one had won. */}
                                {isCrossFree ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ef] px-2 py-0.5 font-semibold text-[#157f4a]">
                                    <Gift className="h-3 w-3" strokeWidth={2.2} />
                                    Free gift
                                  </span>
                                ) : bogo ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ef] px-2 py-0.5 font-semibold text-[#157f4a]">
                                    <Gift className="h-3 w-3" strokeWidth={2.2} />
                                    Buy {bogo.buy} Get {bogo.free} free
                                  </span>
                                ) : item.activeOffer?.title ? (
                                  <span className="inline-flex items-center gap-1 text-[#8a807a]">
                                    <span aria-hidden className="h-1 w-1 rounded-full bg-[#ded3c6]" />
                                    {item.activeOffer.title}
                                  </span>
                                ) : null}

                                {(item.reviews ?? 0) > 0 && item.rating ? (
                                  <span className="inline-flex items-center gap-1 text-[#8a807a]">
                                    <span aria-hidden className="h-1 w-1 rounded-full bg-[#ded3c6]" />
                                    <Star className="h-3 w-3 fill-current text-[#e8a33d]" />
                                    {item.rating}
                                    <span className="text-[#b0a087]">({item.reviews})</span>
                                  </span>
                                ) : null}
                              </div>

                              {/* Always-visible free-item note — a hover tooltip got
                                  clipped by the card's overflow, so the explanation
                                  ("1 of your 3 units is free" / which product is free)
                                  now sits inline where it can't be hidden. */}
                              {freeTooltip && (
                                <p className="mt-1.5 flex items-start gap-1 text-[12px] font-medium leading-snug text-[#157f4a]">
                                  <Gift className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2.2} />
                                  <span>{freeTooltip}</span>
                                </p>
                              )}
                            </div>

                            {/* Flipkart's price line: how much off, what it
                                was, what it is -- read left to right in that
                                order, on one line. */}
                            <div className="shrink-0 text-left @min-[24rem]:text-right">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 @min-[24rem]:justify-end">
                                {isCrossFree || bogoFreeUnits > 0 ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[#157f4a] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                                    <Gift className="h-3 w-3" strokeWidth={2.4} />
                                    {isCrossFree ? (linePaid <= 0 ? 'Free' : `${offPct}% off`) : `${bogoFreeUnits} free`}
                                  </span>
                                ) : offPct > 0 ? (
                                  <span className="inline-flex items-baseline gap-0.5 text-[13px] font-bold text-[#157f4a]">
                                    <ArrowDown className="h-3 w-3 self-center" strokeWidth={3} />
                                    {offPct}%
                                  </span>
                                ) : null}
                                {lineList > linePaid && (
                                  <span className="text-[13px] tabular-nums text-[#a1948a] line-through">{formatPrice(lineList)}</span>
                                )}
                                <span className="text-lg font-bold tabular-nums text-[#1a1a1a] sm:text-xl">{formatPrice(linePaid)}</span>
                              </div>
                              {item.quantity > 1 && (
                                <p className="mt-1 text-xs tabular-nums text-[#8a807a]">{formatPrice(item.price)} each</p>
                              )}
                            </div>
                          </div>

                          {/* Controls as a divided strip. A free-gift line is managed
                              by the offer — fixed quantity, no wishlist/remove — so it
                              shows a static note instead. */}
                          {isCrossFree ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eaf7ef] px-3 py-1.5 text-[12px] font-semibold text-[#157f4a]">
                                <Gift className="h-3.5 w-3.5" strokeWidth={2.2} />
                                Free gift · Qty {item.quantity}
                              </span>
                              {(() => {
                                const chooser = giftOptions.find((g) => g.offerId === item.giftOfferId)
                                return chooser ? (
                                  <button
                                    type="button"
                                    onClick={() => { setGiftInitialProduct(item.productId); setGiftChooser(chooser) }}
                                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-[#157f4a] ring-1 ring-[#c9e9d5] transition-colors hover:bg-[#eaf7ef]"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    Change gift
                                  </button>
                                ) : null
                              })()}
                            </div>
                          ) : (
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="flex items-center overflow-hidden rounded-full ring-1 ring-[#e9ded2]">
                              <button
                                onClick={() => updateQuantity(item.id, item.productId, item.quantity - 1)}
                                aria-label="Decrease quantity"
                                className="p-1.5 text-[#6b625b] transition-colors hover:bg-[#fdf1ef] hover:text-[#c41617] disabled:cursor-not-allowed disabled:opacity-30"
                                disabled={!item.inStock || item.quantity <= 1}
                              >
                                <Minus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                              </button>
                              <span className="px-3 py-1 text-sm font-semibold tabular-nums text-[#1a1a1a] sm:px-3.5">{item.quantity}</span>
                              <button
                                onClick={() => updateQuantity(item.id, item.productId, item.quantity + 1)}
                                aria-label="Increase quantity"
                                className="p-1.5 text-[#6b625b] transition-colors hover:bg-[#fdf1ef] hover:text-[#c41617] disabled:cursor-not-allowed disabled:opacity-30"
                                disabled={!item.inStock || (item.availableStock != null && item.quantity >= item.availableStock)}
                              >
                                <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                              </button>
                            </div>

                            <span aria-hidden className="h-4 w-px bg-[#eadfd2]" />

                            <button
                              onClick={() => moveToWishlist(item)}
                              title="Move this item to your wishlist and remove it from the cart"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6b625b] transition-colors hover:text-[#c41617] sm:text-[13px]"
                            >
                              <Heart className="h-3.5 w-3.5" />
                              Move to Wishlist
                            </button>

                            <span aria-hidden className="h-4 w-px bg-[#eadfd2]" />

                            <button
                              onClick={() => removeItem(item.id)}
                              title="Remove from cart"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6b625b] transition-colors hover:text-[#c41617] sm:text-[13px]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Remove
                            </button>
                          </div>
                          )}

                {transportOptionsFor(item).length >= 1 && (
                <div className="basis-full">
                    {/* Shipping method — only when the product actually offers a
                        choice. AIR and SHIP carry different rates and delivery
                        windows, so this changes what the customer pays. */}
                    {transportOptionsFor(item).length >= 1 && (() => {
                      // The rate/delivery + courier choice lives on the product page
                      // (its Shipping card). The cart deep-links there — highlighting
                      // that card — and the product page writes the choice back to
                      // this line and returns here.
                      const cfg = (item as any).product?.logisticsConfig || {}
                      const shippingHref = `/products/${item.productId}?selectShipping=1&cartItem=${item.id}`
                      if (needsTransportChoice(item)) {
                        return (
                          <Link
                            href={shippingHref}
                            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
                          >
                            <Truck className="w-4 h-4" />
                            Select shipping method
                            <span className="text-red-500">*</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </Link>
                        )
                      }
                      // India live courier: Delhivery picks the carrier/service and the
                      // rate+ETA come from checkout, so drop the mode/days/courier/Change
                      // and show a single neutral line.
                      if (courierPickerHidden) {
                        return (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[#efeae3] bg-[#faf7f3] px-3.5 py-2.5">
                            <Truck className="w-4 h-4 text-[#8a807a]" />
                            <span className="text-xs font-medium text-[#4a423c]">
                              Shipping: <span className="font-semibold text-[#1a1a1a]">handled by our courier partner</span>
                              <span className="text-[#b3a99f]"> · calculated at checkout</span>
                            </span>
                          </div>
                        )
                      }
                      const mode = item.transportType || (Array.isArray(cfg.transportTypes) ? cfg.transportTypes[0] : undefined)
                      // SHIP means Surface/Road domestically (.in) and Sea internationally
                      // (.com) — pick the matching delivery days + label for the region.
                      const isDomestic = getRegion() === 'IN'
                      const shipDays = isDomestic ? (cfg.surfaceDeliveryDays ?? cfg.shipDeliveryDays) : cfg.shipDeliveryDays
                      const days = mode === 'AIR' ? cfg.airDeliveryDays : shipDays
                      return (
                        <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[#efeae3] bg-[#faf7f3] px-3.5 py-2.5">
                          <Truck className="w-4 h-4 text-[#8a807a]" />
                          <span className="text-xs font-medium text-[#4a423c]">
                            Shipping: <span className="font-semibold text-[#1a1a1a]">{mode ? transportModeLabel(mode as 'AIR' | 'SHIP', getRegion()) : '—'}</span>
                            {days ? <span className="text-[#b3a99f]"> · {days} days</span> : null}
                            {item.courier ? <span className="text-[#b3a99f]"> · </span> : null}
                            {item.courier ? <span className="font-semibold text-[#1a1a1a]">{courierName(item.courier)}</span> : null}
                          </span>
                          <Link href={shippingHref} className="text-xs font-semibold text-[#e01a1b] hover:underline ml-1">
                            Change
                          </Link>
                        </div>
                      )
                    })()}
                </div>
                )}
                        </div>
                      </div>
                    </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* Empty State — Order-page style polished card */}
            {cartItems.length === 0 && (
              <Reveal className="bg-white rounded-2xl ring-1 ring-black/5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-6 sm:p-8 lg:p-12 text-center">
                <ShoppingCart className="w-12 h-12 sm:w-14 sm:h-14 lg:w-16 lg:h-16 text-[#d9d0c6] mx-auto mb-3 sm:mb-4" />
                <h3 className="font-playfair text-lg sm:text-xl font-semibold text-[#1a1a1a] mb-2">Your cart is empty</h3>
                <p className="text-sm sm:text-base text-[#6b625b] mb-5 sm:mb-6">Add some items to get started</p>
                <Link href="/products">
                  <button className="btn-shine inline-flex items-center justify-center gap-2 bg-[#e01a1b] text-white px-6 py-3 text-sm sm:text-base rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">
                    Continue Shopping
                  </button>
                </Link>
              </Reveal>
            )}
          </div>

          {/* Order Summary */}
          {cartItems.length > 0 && (
            <div className="lg:col-span-1">
              {/* ── Summary ──────────────────────────────────────────────
                  Promo code and totals in ONE card, not two stacked ones.
                  They are a single job — work out what this costs — and
                  splitting them put a heading, a border and a shadow between
                  a customer and the only number they are looking for. */}
              <div className="overflow-hidden rounded-xl bg-white shadow-[0_1px_2px_rgba(90,60,40,0.05)] ring-1 ring-[#efe6df] sm:rounded-2xl lg:sticky lg:top-8">
              <div className="border-b border-[#f0e8df] p-4 sm:p-5 lg:p-6">
                <h3 className="font-playfair text-base sm:text-lg font-semibold text-[#1a1a1a] mb-3 sm:mb-4">Coupon</h3>
                <div className="flex gap-2 sm:gap-3">
                  <input
                    type="text"
                    placeholder="Enter coupon code"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    className="flex-1 min-w-0 px-3 sm:px-4 py-2.5 sm:py-3 text-sm sm:text-base border border-[#e3dbd1] rounded-lg sm:rounded-xl focus:ring-2 focus:ring-[#e01a1b]/40 focus:border-[#e01a1b] outline-none"
                  />
                  {/* Dead while a code is already on the cart. Nothing stopped
                      Apply being pressed again, which re-ran the same coupon
                      against the same cart -- the shopper removes the current
                      one first, which is what the Remove button below is for. */}
                  <button
                    onClick={applyPromoCode}
                    disabled={!!appliedPromo}
                    title={appliedPromo ? 'Remove the current code before applying another' : undefined}
                    className="px-4 sm:px-6 py-2.5 sm:py-3 bg-[#1a1a1a] hover:bg-[#e01a1b] text-white font-medium rounded-lg sm:rounded-xl transition-colors text-sm sm:text-base shrink-0 disabled:cursor-not-allowed disabled:bg-[#cfc7bd] disabled:hover:bg-[#cfc7bd]"
                  >
                    Apply
                  </button>
                </div>
                {appliedPromo && (
                  <div className="mt-3 flex items-center justify-between text-green-600 bg-green-50 p-3 rounded-lg border border-green-100">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5" />
                      <div>
                        <span className="font-medium block">Code &quot;{appliedPromo}&quot; applied!</span>
                        <span className="text-xs text-green-700">You saved {formatPrice(discountAmount)}</span>
                      </div>
                    </div>
                    <button
                      onClick={removeCoupon}
                      className="text-red-500 hover:text-red-700 p-1 hover:bg-white rounded-full transition-colors"
                      title="Remove coupon"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
                
                {freeShippingApplied && !appliedPromo && (
                  <div className="mt-3 flex items-center justify-between text-blue-600 bg-blue-50 p-3 rounded-lg border border-blue-100">
                    <div className="flex items-center gap-2">
                      <Truck className="w-5 h-5" />
                      <div>
                        <span className="font-medium block">Free Shipping Available!</span>
                        <span className="text-xs text-blue-700">{freeShippingMessage}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

                <div className="border-b border-[#f0e8df] px-4 py-3.5 sm:px-6 sm:py-4">
                  <h2 className="font-playfair text-lg font-semibold text-[#1a1a1a] sm:text-xl">Order Summary</h2>
                </div>

                <div className="p-4 sm:p-5 lg:p-6">
                  {/* Price ladder — aggregated, reconcilable line by line. Discount
                      rows only appear when they exist, and read as green savings. */}
                  <div className="mb-4 space-y-2.5 text-[13.5px] sm:text-sm">
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

                    {/* Taxable amount + Tax (GST) are shown ONLY on the `.in`
                        storefront. On `.com`/other regions no tax is charged, so
                        the whole tax block is hidden. Taxable amount = subtotal −
                        all discounts (the coupon sits ABOVE, reducing the base). */}
                    {getRegion() === 'IN' && (
                      <>
                        <div className="flex items-center justify-between border-t border-dashed border-[#ece1d4] pt-2.5">
                          <span className="text-[#6b625b]">Taxable amount</span>
                          <span className="font-medium tabular-nums text-[#1a1a1a]">{formatPrice(Math.max(0, summary.subtotal - couponDiscount))}</span>
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
                      {courierPickerHidden ? (
                        <span className="text-xs font-medium text-[#a1948a]">Calculated at checkout</span>
                      ) : summary.shipping === 0 ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-[#157f4a]">
                          <Truck className="h-3.5 w-3.5" /> FREE
                        </span>
                      ) : (
                        <span className="tabular-nums text-[#1a1a1a]">{formatPrice(summary.shipping)}</span>
                      )}
                    </div>
                  </div>

                  {/* Savings highlight + the payable, with the strongest emphasis. */}
                  <div className="mb-4 border-t border-[#f0e8df] pt-4">
                    {totalSavings > 0 && (
                      <div className="mb-3 flex items-center justify-between rounded-xl bg-[#eaf7ef] px-3.5 py-2.5 ring-1 ring-[#cdebd8]">
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#157f4a]">
                          <BadgePercent className="h-4 w-4" /> You save
                        </span>
                        <span className="text-[15px] font-bold tabular-nums text-[#157f4a]">{formatPrice(totalSavings)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between">
                      <span className="text-[15px] font-semibold text-[#1a1a1a] sm:text-base">Total payable</span>
                      <span className="font-playfair text-[26px] font-bold tabular-nums text-[#1a1a1a] sm:text-[28px]">{formatPrice(summary.total)}</span>
                    </div>
                    {getRegion() === 'IN' && (
                      <p className="mt-1.5 text-[11.5px] leading-snug text-[#a1948a]">
                        Taxes are calculated based on applicable product tax rates.
                      </p>
                    )}
                  </div>

                  {cartItems.some(needsTransportChoice) ? (
                    <button
                      disabled
                      className="w-full bg-[#e8e2d9] text-[#8a807a] font-semibold py-4 px-6 rounded-xl shadow-none flex items-center justify-center gap-2 mb-4 cursor-not-allowed"
                    >
                      <Truck className="w-5 h-5" />
                      Choose a shipping method to proceed
                    </button>
                  ) : cartItems.some(item => !item.inStock || (item.availableStock !== undefined && item.quantity > item.availableStock)) ? (
                    <button
                      disabled
                      className="w-full bg-[#e8e2d9] text-[#8a807a] font-semibold py-4 px-6 rounded-xl shadow-none flex items-center justify-center gap-2 mb-4 cursor-not-allowed"
                    >
                      <CreditCard className="w-5 h-5" />
                      Remove out of stock items to proceed
                    </button>
                  ) : (
                    <button
                      onClick={handleProceedToCheckout}
                      disabled={validatingCheckout}
                      className="btn-shine w-full bg-[#e01a1b] text-white font-semibold py-4 px-6 rounded-full hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300 flex items-center justify-center gap-2 group mb-4 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
                    >
                      <CreditCard className="w-5 h-5" />
                      {validatingCheckout ? 'Checking availability…' : 'Proceed to Checkout'}
                      {!validatingCheckout && <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-300" />}
                    </button>
                  )}

                  {/* ── Reassurance under the button ──────────────────────
                      Three promises, then what we take. It replaced the
                      savings figure that used to sit here.

                      Two things in the reference could not be copied as they
                      stood, and both would have been lies on this site:

                      "7 days return" -- the Returns page promises THIRTY days
                      from delivery. Copying the reference would have shortened
                      a policy the business actually makes.

                      PayPal and Apple Pay logos -- neither appears anywhere in
                      this codebase. The only gateway wired up is Razorpay
                      (PayU exists but is switched off), so the methods listed
                      are the ones Razorpay actually settles. A payment badge
                      is a promise about what will work at the next step; a
                      wrong one is discovered at the worst possible moment. */}
                  <div className="mt-5 border-t border-[#f0e8df] pt-4">
                    <p className="flex items-center justify-center gap-1.5 text-[11px] font-medium text-[#8a807a] sm:text-xs">
                      <Lock className="h-3 w-3 shrink-0" strokeWidth={2.4} />
                      Secure checkout. Your data is protected.
                    </p>

                    <div className="mt-4 border-t border-[#f6efe6] pt-4">
                      <p className="text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-[#b3a99f]">We accept</p>
                      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
                        {(['visa', 'mastercard', 'rupay', 'upi', 'netbanking'] as const).map((m) => (
                          <PaymentMark key={m} id={m} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Recently Viewed - Removed for now, can be added later with proper backend integration */}
            </div>
          )}
        </div>

        {/* Similar Products — driven by the categories of items in the cart */}
        {similarProducts.length > 0 && (
          <section className="mt-8 sm:mt-10 lg:mt-12">
            <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
              <Package className="w-6 h-6 sm:w-7 sm:h-7 text-[#e01a1b] shrink-0" />
              <div>
                <h2 className="font-playfair text-xl sm:text-2xl font-semibold text-[#1a1a1a]">You Might Also Like</h2>
                <p className="text-xs sm:text-sm text-[#6b625b]">Similar products based on your cart</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3">
              {similarProducts.map((p) => (
                <ProductCard key={p.id} product={p} variant="showcase" />
              ))}
            </div>
          </section>
        )}

        {/* Empty-cart discovery rails */}
        {cartItems.length === 0 && (
          <>
            {[
              { key: 'sug', title: 'Suggested for You', subtitle: 'Picks based on what you’ve been searching for', Icon: Sparkles, items: suggested },
              { key: 'top', title: 'Top Selling', subtitle: 'Most loved by our customers', Icon: TrendingUp, items: topSelling },
              { key: 'rv', title: 'Recently Viewed', subtitle: 'Pick up where you left off', Icon: Clock, items: recentlyViewed },
            ].filter((s) => s.items.length > 0).map((s) => (
              <section key={s.key} className="mt-8 sm:mt-10 lg:mt-12">
                <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                  <s.Icon className="w-6 h-6 sm:w-7 sm:h-7 text-[#e01a1b] shrink-0" />
                  <div>
                    <h2 className="font-playfair text-xl sm:text-2xl font-semibold text-[#1a1a1a]">{s.title}</h2>
                    <p className="text-xs sm:text-sm text-[#6b625b]">{s.subtitle}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3">
                  {s.items.map((p) => (
                    <ProductCard key={p.id} product={p} variant="showcase" />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {/* ── The coupon stub ───────────────────────────────────────────────
          Three things carry the moment, and all three break the plain
          rectangle a card would otherwise be: a seal that hangs off the top
          edge, a burst that leaves the card entirely, and a scalloped foot.

          The masking does the notches at the tear line AND the scallop along
          the bottom, as three gradient layers intersected. Where
          mask-composite is not understood the layers add instead, which
          resolves to opaque everywhere and simply leaves the card a plain
          rectangle — the fallback is never a hole in the wrong place.

          The shadow lives on the outer wrapper because a mask clips
          everything an element paints, box-shadow included, so a shadow on
          the masked box would be sliced off at its own edge. */}
      {giftChooser && (
        <GiftChooserModal
          gift={giftChooser}
          initialProductId={giftInitialProduct}
          busy={addingGift}
          onClose={() => setGiftChooser(null)}
          onChoose={(pid, vid) => chooseGift(giftChooser.offerId, pid, vid)}
        />
      )}

      {offerCelebration && (
        <OfferCelebration
          open
          onClose={() => setOfferCelebration(null)}
          variant={offerCelebration.kind}
          freeUnits={offerCelebration.kind === 'bogo' ? offerCelebration.freeUnits : undefined}
          dealLabel={offerCelebration.kind === 'bogo' ? offerCelebration.dealLabel : undefined}
          amountLabel={offerCelebration.kind === 'savings' ? formatPrice(offerCelebration.amount) : undefined}
          offerTitle={offerCelebration.offerTitle}
          offerDescription={offerCelebration.offerDescription}
          autoCloseMs={6000}
        />
      )}

      {couponLanded && (
        <div
          className="coupon-scrim fixed inset-0 z-60 flex items-center justify-center bg-[#2f1e1a]/60 p-4 backdrop-blur-[3px]"
          onClick={() => setCouponLanded(null)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            {/* The burst. Outside the card and behind it, pinned to the
                middle of the stub so the pieces read as coming from under
                the seal rather than from the corners of the screen. */}
            <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0">
              {COUPON_BURST.map((p, i) => (
                <span
                  key={i}
                  className="coupon-piece absolute block"
                  style={{
                    width: p.w, height: p.h,
                    background: p.c,
                    borderRadius: p.round ? '9999px' : '1px',
                    animationDelay: p.d + 'ms',
                    ['--tx' as string]: p.tx + 'px',
                    ['--ty' as string]: p.ty + 'px',
                    ['--r' as string]: p.r + 'deg',
                  } as React.CSSProperties}
                />
              ))}
            </div>

            <div className="coupon-card relative w-[21rem] max-w-[calc(100vw-2rem)] rounded-t-2xl shadow-[0_34px_80px_-28px_rgba(50,25,12,0.8)]">
              {/* The seal, hanging off the top edge. It is the stamp — same
                  swung-down arrival — but round and overhanging, so it reads
                  as pressed onto the paper from outside rather than printed
                  within it.

                  A tick rather than a ticket. The card is ALREADY a ticket —
                  notched sides, tear line, scalloped foot — so a ticket glyph
                  on top of it said the same thing twice, and at this size the
                  glyph collapsed into an unreadable shape anyway. The seal's
                  job is the one thing the card cannot say for itself: that it
                  worked. */}
              <span className="coupon-stamp absolute -top-9 left-1/2 z-10 flex h-[4.5rem] w-[4.5rem] -translate-x-1/2 items-center justify-center rounded-full bg-linear-to-br from-[#1a8c53] to-[#116b3e] shadow-[0_10px_24px_-8px_rgba(17,107,62,0.85)] ring-4 ring-white">
                <Check className="h-10 w-10 text-white" strokeWidth={2.9} />
              </span>

              <div
                role="status"
                aria-live="polite"
                className="relative overflow-hidden rounded-t-2xl bg-white"
                style={{
                  WebkitMaskImage: 'radial-gradient(circle 11px at 0 calc(100% - 5.25rem), transparent 11px, #000 11.5px), radial-gradient(circle 11px at 100% calc(100% - 5.25rem), transparent 11px, #000 11.5px), radial-gradient(circle 8px at 8px 100%, transparent 8px, #000 8.5px)',
                  maskImage: 'radial-gradient(circle 11px at 0 calc(100% - 5.25rem), transparent 11px, #000 11.5px), radial-gradient(circle 11px at 100% calc(100% - 5.25rem), transparent 11px, #000 11.5px), radial-gradient(circle 8px at 8px 100%, transparent 8px, #000 8.5px)',
                  WebkitMaskSize: '100% 100%, 100% 100%, 16px 100%',
                  maskSize: '100% 100%, 100% 100%, 16px 100%',
                  WebkitMaskRepeat: 'no-repeat, no-repeat, repeat-x',
                  maskRepeat: 'no-repeat, no-repeat, repeat-x',
                  WebkitMaskComposite: 'source-in',
                  maskComposite: 'intersect',
                }}
              >
                {/* the weave the policy banners carry, and a warm wash from the seal */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-[0.035]"
                  style={{ backgroundImage:
                    'repeating-linear-gradient(90deg,#8a6a49 0 1px,transparent 1px 14px),'
                    + 'repeating-linear-gradient(0deg,#8a6a49 0 1px,transparent 1px 14px)' }}
                />
                <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_58%_at_50%_0%,rgba(21,127,74,0.10)_0%,rgba(21,127,74,0)_70%)]" />
                <span aria-hidden className="coupon-sheen pointer-events-none absolute inset-y-0 -left-1/4 w-1/4 bg-linear-to-r from-transparent via-white/75 to-transparent" />

                <div className="relative px-6 pb-7 pt-14 text-center">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.26em] text-[#4a7c62]">Coupon applied</p>
                  {/* The figure is the hero. The code is the receipt for it —
                      what the customer feels is the money, not the string
                      they typed. */}
                  <p className="mt-3 font-playfair text-[42px] font-semibold leading-none tabular-nums text-[#157f4a]">
                    <CountUp value={couponLanded.amount} delay={260} duration={800} />
                  </p>
                  <p className="mt-2.5 text-[13px] font-medium text-[#8a807a]">saved on this order</p>
                </div>

                {/* The tear line and the code below it. Fixed at 5.25rem so
                    the notches above have something constant to sit against,
                    whatever the code's length. */}
                <div className="relative flex h-[5.25rem] items-center justify-center border-t-2 border-dashed border-[#ede2d5] bg-[#fdfaf6] px-6 pb-2">
                  <span className="inline-flex items-center rounded-lg border border-dashed border-[#e3d2bb] bg-white px-3.5 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.14em] break-all text-[#2f1e1a]">
                    {couponLanded.code}
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setCouponLanded(null)}
              aria-label="Close"
              className="mx-auto mt-6 flex h-9 w-9 items-center justify-center rounded-full text-white/70 ring-1 ring-white/30 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
