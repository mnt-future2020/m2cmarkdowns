'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { productService, Product, ProductVariant } from '@/services/productService';
import { publicProductService, type PublicProduct } from '@/services/publicProductService';
import ProductCard from '@/components/WebSite/ProductCard/ProductCard';
import { cartService } from '@/services/cartService';
import { userAuthService } from '@/services/userAuthService';
import { Heart, Truck, Shield, RotateCcw, Package, Plane, Ship, AlertTriangle, Info, Box, Check, User, Award, Clock, ChevronDown, Tag, Search, ThumbsUp, X, ChevronLeft, ChevronRight, Share2, Home } from 'lucide-react';
import { createPortal } from 'react-dom';
import { hasManufacturerInfo, manufacturerDisplayName } from '@/lib/manufacturerInfo';
import { useToast } from '@/hooks/use-toast';
import { showSuccessToast, showErrorToast, showWarningToast } from '@/lib/toast-utils';
import { wishlistService } from '@/services/wishlistService';
import { trackProductView } from '@/services/analyticsService';
import { recordRecentlyViewed } from '@/lib/browsingHistory';
import reviewService from '@/services/reviewService';
import { getCountryName, getCountryFlag } from '@/components/WebSite/CheckOut/CheckoutProcess/constants';
import Image from 'next/image';
import { formatPrice, getRegionalPrice, getRegionalOriginalPrice, isVisibleInRegion, getCurrency, getRegion, convertINRtoUSD } from '@/lib/currency';
import { transportModeLabel, isSurfaceRegion, type Courier } from '@/lib/couriers';
import { FaceIcon, FACE_LABELS, positiveFace, lovedPercent, type FaceValue } from '@/components/WebSite/Shared/FaceRating';
import { courierService } from '@/services/courierService';
import courierIntegrationService from '@/services/courierIntegrationService';
import { applyOfferToPrice, offerEndsLabel, type ActiveOffer, type PublicOffer } from '@/lib/offers';
import { offerService } from '@/services/offerService';
import { couponService, type PopupCoupon } from '@/services/couponService';
import { calculateLogistics, formatWeight, formatDimensions, LogisticsConfig } from '@/lib/logistics';
import PromotionalPopup from '@/components/WebSite/PromotionalPopup/PromotionalPopup';
import CourierBadge from '@/components/Shared/CourierBadge';
import FeaturedProducts from '@/components/WebSite/Featured/Products';
// Same care-symbol catalogue the vendor picks from on the product form, so the
// storefront shows the exact icons they selected.
import { CARE_INSTRUCTIONS, CareIcon } from '@/components/VendorDashboard/Products/CareInstructionModal';

/** A soft ground behind each care symbol, matched to its category. */
/**
 * Each promise is drawn differently: its own ground, its own colour, its own
 * shape behind the icon and its own flourish. Four facts set as four copies of
 * one tile read as a spec strip; four facts drawn four ways read as a set.
 * Cycles by position, so a product with five promises gets the first motif
 * again rather than an undesigned fifth.
 */
const PROMISE_MOTIFS = [
  {
    card: 'bg-[#f7f5ec] ring-[#e8e4d3]',
    numeral: 'text-[#c2c79f]',
    numPos: 'left-4 top-3 sm:left-5 sm:top-4',
    icon: 'bg-[#edeada] text-[#78814e] rounded-t-[2.25rem] rounded-b-lg',
    rule: 'bg-[#78814e]',
    blob: 'bg-[#78814e]/25',
  },
  {
    card: 'bg-[#eef4fc] ring-[#dae7f6]',
    numeral: 'text-[#a7c3e6]',
    // The round card has no corner to sit in -- tucked further in so the
    // curve passes outside the numeral instead of through it.
    numPos: 'left-4 top-3 sm:left-10 sm:top-7',
    icon: 'bg-[#dfebf9] text-[#1f5faa] rounded-full',
    rule: 'bg-[#1f5faa]',
    blob: 'bg-[#1f5faa]/20',
  },
  {
    card: 'bg-[#fdf7f2] ring-[#f2e2d3]',
    numeral: 'text-[#eab48c]',
    numPos: 'left-4 top-3 sm:left-5 sm:top-4',
    icon: 'bg-[#fbe9da] text-[#c86a2e] rounded-lg',
    rule: 'bg-[#c86a2e]',
    blob: 'bg-[#c86a2e]/30',
  },
  {
    card: 'bg-[#faf7f3] ring-[#ebe1d6]',
    numeral: 'text-[#c8b6a5]',
    numPos: 'left-4 top-3 sm:left-5 sm:top-4',
    icon: 'bg-[#f0e7dc] text-[#6b5240] [clip-path:polygon(50%_0%,100%_25%,100%_75%,50%_100%,0%_75%,0%_25%)]',
    rule: 'bg-[#6b5240]',
    blob: 'bg-[#8a6a4c]/30',
  },
] as const;

/** The orders the reviews can be read in. Module scope so the identity is
 *  stable and the control's effects do not re-run on every render. */
const REVIEW_SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'highest', label: 'Most loved' },
  { value: 'lowest', label: 'Least loved' },
];

/**
 * The reviews sort control.
 *
 * A native <select> hands its open list to the operating system: a square
 * white box with a blue highlight, dropped over a page drawn down to the
 * hairline. This is the same control drawn to match, and it keeps the keyboard
 * behaviour the native one gave away for free -- arrows, Enter, Escape, and
 * closing on a click anywhere else.
 */
function ReviewSortSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const current = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // The row the arrow keys start from is decided as the list opens, not in an
  // effect afterwards -- there is nothing to react to, it is part of opening.
  const openList = () => {
    setFocused(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative w-full sm:w-44 lg:w-full">
      <style>{`
        @keyframes m2cSortIn {
          from { opacity: 0; transform: translateY(-6px) }
          to   { opacity: 1; transform: none }
        }
        .m2c-sort-panel { animation: m2cSortIn 150ms cubic-bezier(0.22, 1, 0.36, 1) }
        @media (prefers-reduced-motion: reduce) { .m2c-sort-panel { animation: none } }
      `}</style>

      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openList();
          }
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-full border bg-white py-2 pl-4 pr-3 text-sm font-medium text-gray-700 transition ${
          open ? 'border-[#e01a1b]/40 ring-2 ring-[#e01a1b]/15' : 'border-[#eadfd4] hover:border-[#e01a1b]/30'
        }`}
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-[#a1948a] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((i) => (i + 1) % options.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((i) => (i - 1 + options.length) % options.length); return; }
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[focused].value); }
          }}
          className="m2c-sort-panel absolute right-0 z-30 mt-2 w-full min-w-[11.5rem] overflow-hidden rounded-2xl border border-[#eadfd4] bg-white p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.13)] outline-none"
        >
          {options.map((o, i) => {
            const on = o.value === value;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={on}
                onClick={() => choose(o.value)}
                onMouseEnter={() => setFocused(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                  on
                    ? 'bg-[#e01a1b]/[0.06] font-semibold text-[#e01a1b]'
                    : focused === i
                      ? 'bg-[#f7f2ec] text-gray-800'
                      : 'text-gray-700'
                }`}
              >
                <span>{o.label}</span>
                {on && <Check className="h-4 w-4 shrink-0" strokeWidth={2.6} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The three information cards.
 *
 * They were transparent columns divided by hairlines, which read as one band
 * with lines through it. Each is its own object now, with a coloured edge
 * along the top so the three are told apart before a word is read.
 */
const INFO_CARD =
  'relative overflow-hidden rounded-2xl bg-white p-5 shadow-[0_2px_14px_rgba(0,0,0,0.045)] ring-1 ring-[#efe6df] transition-shadow duration-300 hover:shadow-[0_10px_34px_rgba(0,0,0,0.07)] sm:p-6';

/** A faint dot grid, used as a corner flourish on two of the promise cards. */
const DOT_GRID = 'bg-[radial-gradient(circle,currentColor_1.1px,transparent_1.1px)] bg-[length:9px_9px]';

/** How many specification rows the hero shows before "Show all". */
const SPEC_PREVIEW = 6;


/** Motion is off for anyone who has asked their system for less of it. */
const reduceMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

interface ProductDetailProps {
  productSlug: string;
}

const ProductDetail = ({ productSlug }: ProductDetailProps) => {
  const [product, setProduct] = useState<Product | null>(null);
  // "You may also like" — same-category products, fetched once the product loads.
  const [relatedProducts, setRelatedProducts] = useState<PublicProduct[]>([]);
  // Live store promotions for the promo banner below related products.
  const [promoOffers, setPromoOffers] = useState<PublicOffer[]>([]);
  // A category coupon (highest-priority promo in the sticky rail's Offers card).
  const [categoryCoupon, setCategoryCoupon] = useState<PopupCoupon | null>(null);
  /**
   * The store's live coupons, used only when this product's category has no
   * coupon of its own. Checked against the running backend: no coupon in the
   * database is flagged "show as popup" for any category, so `categoryCoupon`
   * is null on every product and the panel was showing the offer alone.
   */
  const [promoCoupons, setPromoCoupons] = useState<Array<{ message: string; image: string | null; link: string }>>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAllDetails, setShowAllDetails] = useState(false);
  /** The hero spec table opens short. Thirteen rows beside the price is a wall. */
  const [showAllSpecs, setShowAllSpecs] = useState(false);
  /** Bumped on every face tap so the bounce replays, even on the same face --
   *  a keyed remount is the only way to restart a CSS animation. */
  const [facePulse, setFacePulse] = useState(0);
  const [isImageHovered, setIsImageHovered] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [imageRef, setImageRef] = useState<HTMLImageElement | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [transportOverride, setTransportOverride] = useState<'AIR' | 'SHIP' | null>(null);
  // Courier partner chosen for this line. Required before checkout whenever the
  // product ships. Cleared when the transport mode changes (the list is mode-specific).
  const [selectedCourier, setSelectedCourier] = useState<string | null>(null);

  // Deep-link from the cart: "?selectShipping=1&cartItem=<id>" means the shopper
  // came here specifically to choose a shipping method for a line already in their
  // cart. We scroll to + highlight the Shipping card and, on save, write the choice
  // back to that cart line and return them to the cart.
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnCartItemId = searchParams.get('cartItem');
  const shouldSelectShipping = searchParams.get('selectShipping') === '1';
  const shippingCardRef = useRef<HTMLDivElement | null>(null);
  const [highlightShipping, setHighlightShipping] = useState(false);
  const [savingShipping, setSavingShipping] = useState(false);
  // Reviews
  const [reviews, setReviews] = useState<{ id: string; rating: number; comment?: string; images?: string[]; createdAt: string; user?: { name: string; image?: string | null; country?: string | null } }[]>([]);
  const [showReviews] = useState(true); // reviews are always shown
  const [loadingReviews, setLoadingReviews] = useState(true);
  // Review toolbar state (all client-side over the fetched list)
  const [reviewSort, setReviewSort] = useState<'newest' | 'oldest' | 'highest' | 'lowest'>('newest');
  const [reviewStar, setReviewStar] = useState<number>(0); // 0 = all
  const [reviewSearch, setReviewSearch] = useState('');
  const [reviewShown, setReviewShown] = useState(5); // Load-more window
  const [showAllModal, setShowAllModal] = useState(false); // "View all reviews" modal
  const [helpfulIds, setHelpfulIds] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const [showMakerModal, setShowMakerModal] = useState(false);

  // ── Filtering the reviews ────────────────────────────────────────────────
  // Tapping a face used to make the list snap to its new arrangement. These
  // hold a FLIP: every visible review's position is read just before the
  // filter changes, then each one is put back where it was and released, so
  // the survivors travel to their new places instead of jumping. Reviews that
  // were not on screen before fade up rather than appearing mid-air.
  const reviewRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const reviewRects = useRef<Map<string, DOMRect>>(new Map());
  const snapshotReviews = () => {
    if (reduceMotion()) return;
    const map = new Map<string, DOMRect>();
    reviewRefs.current.forEach((el, id) => map.set(id, el.getBoundingClientRect()));
    reviewRects.current = map;
  };

  // Is the hero's description actually cut off, or is that all there is?
  // Measured, not guessed: the 4-line clamp starts hiding text at 208
  // characters in a 346px phone column, 314 on desktop and 414 on a tablet, so
  // no single character count can answer it. A vendor writing two lines was
  // still being offered "Read full description", which scrolled the best part
  // of a thousand pixels to show the same two lines again.
  const descRef = useRef<HTMLParagraphElement | null>(null);
  const [descHasMore, setDescHasMore] = useState(false);

  /**
   * Whether the description band's six-line clamp is actually hiding anything.
   *
   * This used to be `description.length > 260`, and a character count cannot
   * know where text wraps: the same 243 characters are five lines on a desktop
   * and eight on a phone. On a phone that hid the closing sentence with no
   * button to open it. Measured on the paragraph instead, through a callback
   * ref -- deciding this is part of the paragraph appearing, not something to
   * react to afterwards.
   */
  const [fullDescClamped, setFullDescClamped] = useState(false);
  const fullDescWatch = useRef<ResizeObserver | null>(null);
  const measureFullDesc = useCallback((el: HTMLParagraphElement | null) => {
    fullDescWatch.current?.disconnect();
    fullDescWatch.current = null;
    if (!el) return;
    const check = () => setFullDescClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    // Width changes the line count, so it is re-measured whenever the
    // paragraph's box changes -- including when the clamp comes off.
    if (typeof ResizeObserver === 'undefined') return;
    fullDescWatch.current = new ResizeObserver(check);
    fullDescWatch.current.observe(el);
  }, []);

  // Reviews are always shown — load them automatically once the product is known.
  useEffect(() => {
    const pid = product?.id;
    if (!pid) return;
    let cancelled = false;

    setLoadingReviews(true);
    reviewService.getProductReviews(pid)
      .then((res) => { if (!cancelled && res.success && res.data) setReviews(res.data); })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoadingReviews(false); });
    return () => { cancelled = true; };
  }, [product?.id]);

  // Client-side search + star-filter + sort over the fetched review list.
  const filteredReviews = useMemo(() => {
    const q = reviewSearch.trim().toLowerCase();
    const list = reviews.filter((r) => {
      if (reviewStar && Math.round(r.rating || 0) !== reviewStar) return false;
      if (q && !`${r.comment || ''} ${r.user?.name || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      if (reviewSort === 'highest') return (b.rating || 0) - (a.rating || 0);
      if (reviewSort === 'lowest') return (a.rating || 0) - (b.rating || 0);
      const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return reviewSort === 'oldest' ? d : -d;
    });
  }, [reviews, reviewSort, reviewStar, reviewSearch]);

  // Reset the load-more window whenever the filters change.
  useEffect(() => { setReviewShown(5); }, [reviewSort, reviewStar, reviewSearch]);

  useLayoutEffect(() => {
    const before = reviewRects.current;
    if (!before.size) return;
    reviewRects.current = new Map();
    if (reduceMotion()) return;

    const moved: HTMLDivElement[] = [];
    const arrived: HTMLDivElement[] = [];
    reviewRefs.current.forEach((el, id) => {
      const was = before.get(id);
      if (!was) { arrived.push(el); return; }
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(el);
    });
    if (!moved.length && !arrived.length) return;

    // Every card has to be sitting at its old position on screen before any of
    // them is released, or there is nothing to travel from and it snaps. The
    // same trap as the wishlist: reading a rect flushes the PREVIOUS element,
    // so without this the last one in the loop is the only one that jumps.
    arrived.forEach((el) => { el.style.transition = 'none'; el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; });
    void document.body.offsetHeight;

    requestAnimationFrame(() => {
      [...moved, ...arrived].forEach((el) => {
        el.style.transition = 'transform 460ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms ease';
        el.style.transform = '';
        el.style.opacity = '';
        const done = () => { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; };
        el.addEventListener('transitionend', done, { once: true });
        window.setTimeout(done, 560);
      });
    });
  }, [reviewStar, reviewSort, reviewSearch, reviewShown]);

  // Escape closes the "view all" modal; lock body scroll while it is open.
  useEffect(() => {
    if (!showAllModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAllModal(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [showAllModal]);

  /**
   * One review row — reused by the compact on-page feed and the "view all"
   * modal so both stay identical. avatar → sentiment/verified → text → meta,
   * with Helpful on the right. `withRef` wires the on-page scroll snapshot; the
   * modal copies pass false so the two never fight over the same ref map.
   */
  const renderReviewRow = (review: (typeof reviews)[number], withRef: boolean) => {
    const countryName = getCountryName(review.user?.country);
    const flag = countryName ? getCountryFlag(review.user?.country) : '';
    const imgs = (review.images || []).filter(Boolean);
    const helped = helpfulIds.has(review.id);
    const face = (Math.min(5, Math.max(1, Math.round(review.rating))) || 3) as FaceValue;
    const said = (review.comment || '').trim();
    return (
      <div
        key={review.id}
        ref={withRef ? (el) => { if (el) reviewRefs.current.set(review.id, el); else reviewRefs.current.delete(review.id); } : undefined}
        className="group/rev flex gap-3.5 py-5 sm:gap-5 sm:py-6"
      >
        <div className="shrink-0">
          {review.user?.image ? (
            <Image src={review.user.image} alt="" width={44} height={44} className="h-10 w-10 rounded-full object-cover ring-1 ring-black/5 sm:h-11 sm:w-11" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f2ece5] text-sm font-bold text-[#a1948a] sm:h-11 sm:w-11">
              {(review.user?.name || 'C')[0].toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <FaceIcon value={face} className="h-5 w-5 shrink-0" />
              <span className="text-[13px] font-semibold text-[#2b2320]">{FACE_LABELS[face]}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
              <Check className="h-3 w-3" /> Verified
            </span>
          </div>
          {said && (
            <blockquote className="mt-2 whitespace-pre-line font-playfair text-[16px] leading-relaxed text-[#2b2320] sm:text-[17px]">{said}</blockquote>
          )}
          {imgs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {imgs.map((src, idx) => (
                <button key={idx} onClick={() => setLightbox({ images: imgs, index: idx })} className="group/img relative h-16 w-16 overflow-hidden rounded-lg ring-1 ring-gray-200 transition-all hover:ring-[#e01a1b]/50">
                  <Image src={src} alt="" fill sizes="64px" className="object-cover transition-transform duration-300 group-hover/img:scale-110" />
                </button>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[#a1948a]">
            <span className="font-semibold text-[#4a423c]">{review.user?.name || 'Customer'}</span>
            <span aria-hidden className="text-[#d8cabb]">&middot;</span>
            <span>{new Date(review.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            {countryName && (<><span aria-hidden className="text-[#d8cabb]">&middot;</span><span>{flag ? `${flag} ` : ''}{countryName}</span></>)}
          </div>
        </div>
        <div className="shrink-0 self-start">
          <button
            onClick={() => setHelpfulIds((prev) => { const n = new Set(prev); if (n.has(review.id)) n.delete(review.id); else n.add(review.id); return n; })}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${helped ? 'border-[#e01a1b]/30 bg-[#fff1f1] text-[#e01a1b]' : 'border-[#e6dcd2] text-[#6b625b] hover:border-[#d6c8bb] hover:text-[#1a1a1a]'}`}
          >
            <ThumbsUp className={`h-3.5 w-3.5 ${helped ? 'fill-[#e01a1b]' : ''}`} /> <span className="hidden sm:inline">{helped ? 'Marked helpful' : 'Helpful'}</span>
          </button>
        </div>
      </div>
    );
  };

  /** The existing emoji rating summary, kept identical — only regrouped. The
   *  sidebar variant stacks the five faces vertically; the modal variant lays
   *  them out horizontally where there is more width. */
  const renderRatings = (variant: 'sidebar' | 'modal') => {
    const total = reviews.length;
    const withText = reviews.filter((r) => r.comment && r.comment.trim()).length;
    const dist = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => Math.round(r.rating || 0) === star).length }));
    const faceBtn = (star: number, count: number) => {
      const v = star as FaceValue;
      const active = reviewStar === star;
      const empty = count === 0;
      const onClick = () => { snapshotReviews(); setFacePulse((n) => n + 1); setReviewStar(active ? 0 : star); };
      if (variant === 'sidebar') {
        return (
          <button key={star} type="button" disabled={empty} onClick={onClick} aria-pressed={active}
            className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${empty ? 'cursor-default opacity-40' : 'hover:bg-[#faf5ef]'} ${active ? 'bg-[#fff1f1] ring-1 ring-[#e01a1b]/25' : ''}`}>
            <FaceIcon value={v} className="h-6 w-6 shrink-0" />
            <span className={`flex-1 text-[13px] font-medium ${active ? 'text-[#e01a1b]' : 'text-[#4a423c]'}`}>{FACE_LABELS[v]}</span>
            <span className={`text-[13px] font-bold tabular-nums ${active ? 'text-[#e01a1b]' : 'text-[#1a1a1a]'}`}>{count}</span>
          </button>
        );
      }
      return (
        <button key={star} type="button" disabled={empty} onClick={onClick} aria-pressed={active}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors ${empty ? 'cursor-default opacity-40' : 'hover:bg-[#faf5ef]'} ${active ? 'border-[#e01a1b]/40 bg-[#fff1f1]' : 'border-[#eadfd4]'}`}>
          <FaceIcon value={v} className="h-5 w-5 shrink-0" />
          <span className={`text-[12.5px] font-semibold ${active ? 'text-[#e01a1b]' : 'text-[#4a423c]'}`}>{FACE_LABELS[v]}</span>
          <span className={`text-[12.5px] font-bold tabular-nums ${active ? 'text-[#e01a1b]' : 'text-[#1a1a1a]'}`}>{count}</span>
        </button>
      );
    };
    const countLine = (
      <p className="text-[12px] text-[#6b625b]">
        <span className="font-semibold tabular-nums text-[#1a1a1a]">{total}</span> rating{total === 1 ? '' : 's'} &middot;{' '}
        <span className="font-semibold tabular-nums text-[#1a1a1a]">{withText}</span> review{withText === 1 ? '' : 's'}
      </p>
    );
    if (variant === 'sidebar') {
      return (
        <aside className="rounded-2xl border border-[#eadfd4] bg-white/70 p-5 lg:sticky lg:top-40">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a1948a]">Ratings</p>
          <div className="mt-1.5">{countLine}</div>
          <div className="mt-4 space-y-1">{dist.map((d) => faceBtn(d.star, d.count))}</div>
          {dist[0].count > 0 && (
            <p className="mt-4 border-t border-[#f2e9df] pt-3 text-[12px] text-[#6b625b]">
              <span className="font-semibold tabular-nums text-[#1a1a1a]">{total}</span> {total === 1 ? 'person' : 'people'} &middot; <span className="font-semibold tabular-nums text-[#1a1a1a]">{dist[0].count}</span> loved it
            </p>
          )}
          {reviewStar !== 0 && (
            <button onClick={() => { snapshotReviews(); setReviewStar(0); }} className="mt-2 text-[12px] font-semibold text-[#e01a1b] hover:text-[#c41617]">
              Showing {FACE_LABELS[reviewStar as FaceValue]} — clear
            </button>
          )}
        </aside>
      );
    }
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a1948a]">Ratings</p>
          {countLine}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">{dist.map((d) => faceBtn(d.star, d.count))}</div>
      </div>
    );
  };

  // Re-measured whenever the text or the column changes, so a phone rotating
  // to landscape gets the right answer too.
  const productDescription = product?.description;
  useEffect(() => {
    const el = descRef.current;
    if (!el) { setDescHasMore(false); return; }
    const measure = () => setDescHasMore(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [productDescription]);

  // Close the manufacturer modal on Escape.
  useEffect(() => {
    if (!showMakerModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowMakerModal(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMakerModal]);

  useEffect(() => {
    const fetchProduct = async () => {
      try {
        setLoading(true);
        const response = await productService.getPublicProduct(productSlug);

        if (response.success && response.data) {
          setProduct(response.data);

          // Track product view for analytics heat map
          let source = 'direct';
          try {
            const ref = typeof document !== 'undefined' ? document.referrer : '';
            if (ref) {
              if (ref.includes('/categories')) source = 'category';
              else if (ref.includes('/search')) source = 'search';
              else if (ref.includes('/products')) source = 'related';
              else {
                try {
                  if (new URL(ref).pathname === '/') source = 'home';
                } catch {/* ignore bad URL */}
              }
            }
          } catch {/* keep default 'direct' */}

          const viewedKey = `m2c_viewed_${response.data.id}`;
          if (!sessionStorage.getItem(viewedKey)) {
            sessionStorage.setItem(viewedKey, '1');
            trackProductView({
              productId: response.data.id,
              productName: response.data.name,
              category: response.data.category,
              source,
            });
          }
          // Keep a client-side "recently viewed" list for the empty-cart page.
          recordRecentlyViewed(response.data.id);
        }
      } catch (error) {
        console.error('Failed to fetch product:', error);
        showErrorToast('Error', 'Failed to load product details');
      } finally {
        setLoading(false);
      }
    };

    fetchProduct();
  }, [productSlug]);

  // Live store promotions (offers page feed). Purely additive — the banner hides
  // itself when there are no active offers.
  useEffect(() => {
    let cancelled = false;
    offerService.getActiveOffers()
      .then((offers) => { if (!cancelled) setPromoOffers(Array.isArray(offers) ? offers.slice(0, 6) : []); })
      .catch(() => { if (!cancelled) setPromoOffers([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    couponService.getPromotionalCoupons(8)
      .then((c) => { if (!cancelled) setPromoCoupons(Array.isArray(c) ? c : []); })
      .catch(() => { if (!cancelled) setPromoCoupons([]); });
    return () => { cancelled = true; };
  }, []);

  // Category coupon (marked show-as-popup) — the top-priority promo for this product.
  useEffect(() => {
    if (!product?.category) { setCategoryCoupon(null); return; }
    let cancelled = false;
    couponService.getPopupCoupon(product.category)
      .then((c) => { if (!cancelled) setCategoryCoupon(c); })
      .catch(() => { if (!cancelled) setCategoryCoupon(null); });
    return () => { cancelled = true; };
  }, [product?.category]);

  // Related products — matched by category → sub-category → recent, then ordered
  // to surface the same fabric type first. Broadening the net (instead of category
  // only) means the section reliably populates even when a category is sparse.
  useEffect(() => {
    if (!product?.id) { setRelatedProducts([]); return; }
    let cancelled = false;
    const subCat = (product as { subCategory?: string }).subCategory;
    (async () => {
      const seen = new Map<string, PublicProduct>();
      const add = (items?: PublicProduct[]) => {
        (items || []).forEach((p) => { if (p.id !== product.id && !seen.has(p.id)) seen.set(p.id, p); });
      };
      try {
        if (product.category) {
          const r = await publicProductService.getProducts({ category: product.category, limit: 12 });
          if (r.success) add(r.data?.items);
        }
        if (seen.size < 4 && subCat) {
          const r = await publicProductService.getProducts({ subCategory: subCat, limit: 12 });
          if (r.success) add(r.data?.items);
        }
        // Fallback so the section isn't empty when the category is sparse.
        if (seen.size < 4) {
          const r = await publicProductService.getProducts({ limit: 12, sortBy: 'createdAt', sortOrder: 'desc' });
          if (r.success) add(r.data?.items);
        }
        let list = Array.from(seen.values());
        // Prefer the same fabric type (closest match) first.
        if (product.fabricType) {
          const ft = product.fabricType;
          list = list.sort((a, b) => Number(b.fabricType === ft) - Number(a.fabricType === ft));
        }
        if (!cancelled) setRelatedProducts(list.slice(0, 4));
      } catch {
        if (!cancelled) setRelatedProducts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [product?.id, product?.category, product?.fabricType]);

  // Check wishlist status after product loads
  useEffect(() => {
    if (!product?.id) return;
    wishlistService.isInWishlist(product.id).then(setIsWishlisted).catch(() => {});
  }, [product?.id]);

  // Smart logistics calculation (must be before any conditional returns)
  const logisticsResult = useMemo(() => {
    if (!product?.logisticsConfig) return null;
    return calculateLogistics(product.logisticsConfig as LogisticsConfig, quantity, transportOverride || undefined, getRegion());
  }, [product?.logisticsConfig, quantity, transportOverride]);

  // Admin-managed couriers, loaded once for this region (also primes the registry so
  // courierName resolves this order's courier later in the cart/checkout).
  const [allCouriers, setAllCouriers] = useState<Courier[]>([]);
  useEffect(() => {
    courierService.getActiveCouriers(getRegion()).then(setAllCouriers).catch(() => setAllCouriers([]));
  }, []);

  // When the live courier integration (Delhivery) is active for India, it decides the
  // carrier, so the shopper does NOT pick a courier for India (INR) orders. Fetch the
  // public flag once; treat any failure as "not live" so the manual picker stays as before.
  const [liveCourierActiveIN, setLiveCourierActiveIN] = useState(false);
  useEffect(() => {
    courierIntegrationService.getPublicStatus()
      .then((res) => setLiveCourierActiveIN(!!res?.data?.liveActiveIN))
      .catch(() => setLiveCourierActiveIN(false));
  }, []);
  // Hide the manual courier picker only for India when the integration is live;
  // international (.com / USD) always keeps the manual picker.
  const courierPickerHidden = liveCourierActiveIN && getRegion() === 'IN';

  // Courier partners available for this shopper's region + chosen transport mode. When
  // the product has selected specific couriers (logisticsConfig.courierIds), restrict to
  // those; otherwise (legacy products) show all region+mode couriers. AIR vs SHIP narrows.
  const courierOptions = useMemo(() => {
    if (!logisticsResult) return [];
    const region = getRegion();
    const mode = logisticsResult.selectedTransport;
    if (!mode) return []; // no shipping method chosen yet → no couriers to show
    const picked = (product?.logisticsConfig as { courierIds?: string[] } | undefined)?.courierIds;
    return allCouriers.filter((c) =>
      c.region === region &&
      c.modes.includes(mode) &&
      (!picked || picked.length === 0 || picked.includes(c.id))
    );
  }, [allCouriers, logisticsResult, product?.logisticsConfig]);

  // Whenever the transport mode changes, drop a courier that no longer belongs to the
  // new list (e.g. picked an AIR courier, then switched to SHIP).
  useEffect(() => {
    if (selectedCourier && !courierOptions.some((c) => c.id === selectedCourier)) {
      setSelectedCourier(null);
    }
  }, [courierOptions, selectedCourier]);

  // Arrived from the cart to pick a shipping method: scroll the Shipping card into
  // view and pulse a highlight so it's obvious what to do. MUST stay above the early
  // returns below — a hook after a conditional return changes hook order across
  // renders (Rules of Hooks). The guard lives inside the effect, not around it.
  useEffect(() => {
    if (!shouldSelectShipping || !product?.logisticsConfig) return;
    const t = setTimeout(() => {
      shippingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightShipping(true);
      setTimeout(() => setHighlightShipping(false), 2600);
    }, 300);
    return () => clearTimeout(t);
  }, [shouldSelectShipping, product?.logisticsConfig]);

  if (loading) {
    /*
      Skeleton mirrors the product detail layout: 2-column grid with an
      aspect-square main image + thumbnails on the left and the title /
      rating / price / details / stock / shipping stack on the right.
      Same outer max-w-360 container so the page doesn't reflow when the
      fetch resolves.
    */
    return (
      <div className="max-w-7xl xl:max-w-420 mx-auto px-3 sm:px-4 md:px-6 lg:px-8 pt-1 pb-4 sm:pb-6 lg:pb-8">
        <div className="flex items-center gap-2 mb-4 sm:mb-6 overflow-hidden">
          <div className="h-4 w-12 bg-gray-200 rounded animate-pulse shrink-0" />
          <div className="h-4 w-4 bg-gray-100 rounded animate-pulse shrink-0" />
          <div className="h-4 w-20 bg-gray-200 rounded animate-pulse shrink-0" />
          <div className="h-4 w-4 bg-gray-100 rounded animate-pulse shrink-0" />
          <div className="h-4 w-32 bg-gray-200 rounded animate-pulse shrink-0" />
        </div>
        <div className="bg-white rounded-2xl overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            {/* Image column skeleton */}
            <div className="p-4 sm:p-6 lg:p-12 bg-linear-to-br from-gray-50 to-white">
              <div className="aspect-square bg-gray-200 rounded-xl animate-pulse mb-4 sm:mb-6" />
              <div className="flex gap-2 sm:gap-3 overflow-x-auto scrollbar-hide">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="w-14 h-14 sm:w-20 sm:h-20 bg-gray-200 rounded-lg animate-pulse shrink-0" />
                ))}
              </div>
            </div>

            {/* Details column skeleton */}
            <div className="p-4 sm:p-6 lg:p-12 space-y-4 sm:space-y-6">
              {/* Title */}
              <div className="space-y-3">
                <div className="h-9 w-3/4 bg-gray-200 rounded animate-pulse" />
                <div className="h-9 w-1/2 bg-gray-200 rounded animate-pulse" />
              </div>

              {/* Rating row */}
              <div className="flex items-center gap-2">
                <div className="h-5 w-28 bg-gray-200 rounded animate-pulse" />
                <div className="h-4 w-20 bg-gray-100 rounded animate-pulse" />
              </div>

              {/* Price card */}
              <div className="border border-gray-100 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-28 bg-gray-200 rounded animate-pulse" />
                  <div className="h-6 w-20 bg-gray-100 rounded animate-pulse" />
                  <div className="h-6 w-20 bg-gray-200 rounded animate-pulse" />
                </div>
                <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
              </div>

              {/* Product details card */}
              <div className="border border-gray-100 rounded-xl p-5 space-y-4">
                <div className="h-5 w-32 bg-gray-200 rounded animate-pulse" />
                <div className="flex items-center gap-3">
                  <div className="h-4 w-16 bg-gray-100 rounded animate-pulse" />
                  <div className="w-7 h-7 bg-gray-200 rounded-full animate-pulse" />
                  <div className="h-8 w-32 bg-gray-200 rounded animate-pulse" />
                </div>
              </div>

              {/* Stock card */}
              <div className="border border-gray-100 rounded-xl p-5 space-y-2">
                <div className="h-5 w-40 bg-gray-200 rounded animate-pulse" />
                <div className="h-4 w-64 bg-gray-100 rounded animate-pulse" />
              </div>

              {/* Shipping card */}
              <div className="border border-gray-100 rounded-xl p-5 space-y-3">
                <div className="flex justify-between items-center">
                  <div className="h-5 w-40 bg-gray-200 rounded animate-pulse" />
                  <div className="h-6 w-24 bg-gray-100 rounded-full animate-pulse" />
                </div>
                <div className="flex justify-between">
                  <div className="h-4 w-24 bg-gray-100 rounded animate-pulse" />
                  <div className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="h-12 bg-gray-200 rounded-lg animate-pulse" />
                  <div className="h-12 bg-gray-100 rounded-lg animate-pulse" />
                </div>
              </div>

              {/* Add to cart button */}
              <div className="h-12 w-full bg-gray-200 rounded-lg animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!product || !isVisibleInRegion((product as any).priceVisibility)) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 lg:px-8 py-10 sm:py-12 lg:py-16">
        <div className="text-center">
          <h1 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#1a1a1a] mb-3 sm:mb-4 tracking-tight">Product Not Available</h1>
          <p className="text-sm sm:text-base text-gray-600 mb-5 sm:mb-8">This product is not available in your region or no longer exists.</p>
          <a href="/products" className="btn-shine inline-flex items-center justify-center bg-[#e01a1b] text-white px-6 py-3 text-sm sm:text-base rounded-full font-semibold hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 transition-all duration-300">
            Back to Products
          </a>
        </div>
      </div>
    );
  }

  // Filter variants by region visibility
  const visibleVariants = product.variants?.filter(
    (v: any) => isVisibleInRegion(v.priceVisibility)
  ) || [];

  // Get images - use variant images if variant is selected, otherwise use product images.
  // Drop any blank/whitespace urls so the thumbnail rail never shows an empty tile.
  const displayImages = (selectedVariant?.images && selectedVariant.images.length > 0
    ? selectedVariant.images.map((url: string) => ({ url, isPrimary: false }))
    : product.images || []
  ).filter((img: any) => img && typeof img.url === 'string' && img.url.trim() !== '');

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!imageRef) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    setMousePosition({ x, y });
  };

  const handleMouseEnter = () => {
    setIsImageHovered(true);
  };

  const handleMouseLeave = () => {
    setIsImageHovered(false);
  };

  const handleAddToCart = async () => {
    if (!product) return;

    // Check if user is authenticated
    const isAuthenticated = userAuthService.isAuthenticated();

    if (!isAuthenticated) {
      showErrorToast('Login Required', 'Please login to add items to cart');
      // Redirect to login page after a short delay
      setTimeout(() => {
        window.location.href = '/login';
      }, 1500);
      return;
    }

    // A shipping product must have a courier chosen — it travels with the order.
    // Skipped when the live India courier integration picks the carrier for us.
    if (product.logisticsConfig && logisticsResult && !selectedCourier && !courierPickerHidden) {
      showErrorToast('Courier required', 'Please choose a courier partner before adding to cart.');
      shippingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightShipping(true);
      setTimeout(() => setHighlightShipping(false), 2600);
      return;
    }

    try {
      // Add to cart via API — carry the shipping choice so the line lands ready to
      // check out (both are re-validated server-side at order time).
      await cartService.addToCart(product.id, quantity, selectedVariant?.id,
        logisticsResult
          ? { transportType: logisticsResult.selectedTransport, courier: selectedCourier }
          : undefined
      );

      const variantInfo = selectedVariant ? ` (${[selectedVariant.size, selectedVariant.color].filter(Boolean).join(" - ")})` : 
        (product.singleUnitSize || product.singleUnitColor ? ` (${[product.singleUnitSize, product.singleUnitColor].filter(Boolean).join(' - ')})` : '');

      showSuccessToast(
        'Added to Cart!',
        `${quantity} x ${product.name}${variantInfo} has been added to your cart.`
      );

      // Reset quantity after adding
      setQuantity(1);
    } catch (error: any) {
      console.error('Error adding to cart:', error);
      showErrorToast('Failed to Add', error.message || 'Unable to add item to cart. Please try again.');
    }
  };

  // Persist the chosen method to the originating cart line, then go back to the cart.
  const handleSaveShippingAndReturn = async () => {
    if (!returnCartItemId || !logisticsResult) return;
    if (!logisticsResult.selectedTransport) {
      showErrorToast('Shipping method required', 'Please choose a shipping method before continuing.');
      return;
    }
    if (!selectedCourier && !courierPickerHidden) {
      showErrorToast('Courier required', 'Please choose a courier partner before continuing.');
      return;
    }
    setSavingShipping(true);
    try {
      await cartService.setShipping(returnCartItemId, logisticsResult.selectedTransport, selectedCourier);
      showSuccessToast('Shipping method saved', 'Returning you to your cart.');
      router.push('/cart');
    } catch (error: any) {
      showErrorToast('Could not save', error?.message || 'Please try again.');
      setSavingShipping(false);
    }
  };

  // Handle quantity increment — cap at available stock
  const handleIncrement = () => {
    setQuantity(prev => (prev < availableStock ? prev + 1 : prev));
  };

  // Handle quantity decrement
  const handleDecrement = () => {
    if (quantity > 1) {
      setQuantity(prev => prev - 1);
    }
  };

  // Handle manual quantity input
  const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === '') {
      setQuantity(0 as any); // temporary empty state while typing
      return;
    }
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0) {
      if (num > availableStock) {
        showWarningToast('Stock Limit', `Only ${availableStock} ${product?.uom || 'pcs'} available in stock`);
        setQuantity(availableStock);
      } else {
        setQuantity(num);
      }
    }
  };

  // On blur, ensure quantity is at least 1
  const handleQuantityBlur = () => {
    if (!quantity || quantity < 1) {
      setQuantity(1);
    }
  };

  // Buy Now — same guards as Add to Cart, add the line, then jump straight to checkout.
  const handleBuyNow = async () => {
    if (!product) return;

    if (!userAuthService.isAuthenticated()) {
      showErrorToast('Login Required', 'Please login to continue to checkout');
      setTimeout(() => { window.location.href = '/login'; }, 1500);
      return;
    }

    // A shipping product must have a courier chosen — it travels with the order.
    // Skipped when the live India courier integration picks the carrier for us.
    if (product.logisticsConfig && logisticsResult && !selectedCourier && !courierPickerHidden) {
      showErrorToast('Courier required', 'Please choose a courier partner before checking out.');
      shippingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightShipping(true);
      setTimeout(() => setHighlightShipping(false), 2600);
      return;
    }

    try {
      await cartService.addToCart(product.id, quantity, selectedVariant?.id,
        logisticsResult
          ? { transportType: logisticsResult.selectedTransport, courier: selectedCourier }
          : undefined
      );
      router.push('/checkout');
    } catch (error: any) {
      showErrorToast('Checkout Failed', error?.message || 'Unable to proceed to checkout. Please try again.');
    }
  };

  /**
   * Hand the product to whatever the device offers -- the platform share sheet
   * on a phone, the clipboard on a desktop browser that has none. A cancelled
   * sheet is not a failure and is not reported as one.
   */
  const shareProduct = async () => {
    if (!product) return;
    // Build the canonical product URL from origin + slug rather than
    // window.location.href — the current URL can carry query params (e.g.
    // ?selectShipping=… from the cart deep-link), which would be shared as a
    // "wrong" link. Falls back to the current href only if origin is unavailable.
    const slug = product.slug || productSlug;
    const url = typeof window !== 'undefined'
      ? (slug ? `${window.location.origin}/products/${slug}` : window.location.href)
      : '';
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        // Deliberately NO `text` field: on macOS/iOS the native share sheet's
        // "Copy" action copies the `text` string instead of the `url` when both
        // are present — which is why Copy was yielding the wrong content. With
        // only title + url, Copy reliably puts the product link on the clipboard.
        await navigator.share({ title: product.name, url });
        return;
      } catch (error) {
        // Cancelling the sheet is a decision, not a failure -- stop there.
        // Anything else (desktop Chrome defines share() and rejects it on
        // plenty of setups) falls through to the clipboard rather than
        // leaving the customer with a toast and no link.
        if (error instanceof Error && error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showSuccessToast('Link copied', 'Product link copied to your clipboard');
    } catch {
      showErrorToast('Share failed', 'Could not share this product. Please try again.');
    }
  };

  const handleWishlistToggle = async () => {
    if (!product) return;

    const isAuthenticated = userAuthService.isAuthenticated();

    if (!isAuthenticated) {
      showErrorToast('Login Required', 'Please login to add items to your wishlist');
      // Redirect to login page after a short delay
      setTimeout(() => {
        window.location.href = '/login';
      }, 1500);
      return;
    }

    // Optimistic update — UI changes instantly
    const wasWishlisted = isWishlisted;
    setIsWishlisted(!wasWishlisted);

    try {
      if (wasWishlisted) {
        await wishlistService.removeFromWishlist(product.id);
        showSuccessToast('Removed from Wishlist', `${product.name} has been removed from your wishlist.`);
      } else {
        await wishlistService.addToWishlist(product.id);
        showSuccessToast('Added to Wishlist!', `${product.name} has been saved to your wishlist.`);
      }
    } catch (error: any) {
      if (error.message?.includes('already in wishlist')) {
        setIsWishlisted(true);
      } else {
        setIsWishlisted(wasWishlisted);
        showErrorToast('Wishlist Error', 'Unable to update wishlist. Please try again.');
      }
    }
  };

  // Get available stock based on selected variant or base stock
  const availableStock = selectedVariant
    ? selectedVariant.stock
    : (product.inventory?.baseStock ?? product.totalStock ?? 0);

  // A variant product is still purchasable through its BASE unit (the "Default
  // Variant" card, selectedVariant === null) — that is a valid selection, not an
  // empty one. So the only truly un-buyable state is a variant product whose base
  // has no stock AND every variant is hidden in this region: nothing to sell.
  const baseHasStock = (product.inventory?.baseStock ?? product.totalStock ?? 0) > 0;
  const nothingBuyable = product.hasVariants && visibleVariants.length === 0 && !baseHasStock;
  // A shipping product needs a courier before it can be added — see the shipping card.
  const courierMissing = !courierPickerHidden && !!(product.logisticsConfig && logisticsResult) && !selectedCourier;

  // Get current price based on region + selected variant
  const currentPrice = selectedVariant
    ? getRegionalPrice(selectedVariant)
    : getRegionalPrice(product);
  const originalPrice = selectedVariant
    ? getRegionalOriginalPrice(selectedVariant) ?? selectedVariant.originalPrice
    : getRegionalOriginalPrice(product) ?? product.originalPrice;

  // Automatic offer for this product (attached by the backend). It targets the product
  // (or its category/store), so it applies whether or not a variant is selected. The
  // effective price is the offer applied to the current selling price; the pre-offer
  // price becomes the strike-through. Checkout re-resolves this server-side.
  const activeOffer: ActiveOffer | undefined = (product as { activeOffer?: ActiveOffer }).activeOffer;
  const offeredPrice = activeOffer
    ? applyOfferToPrice(currentPrice, activeOffer, getCurrency(), quantity, convertINRtoUSD)
    : currentPrice;
  const hasOfferSaving = activeOffer != null && offeredPrice < currentPrice;
  const offerEnds = activeOffer ? offerEndsLabel(activeOffer.endsAt) : null;

  // Get current image URL
  const currentImageUrl = displayImages[selectedImage]?.url;

  /** The photograph that sits behind the care panel: whatever the gallery is
   *  showing, so choosing a variant changes it too. */
  const carePhoto = currentImageUrl || displayImages[0]?.url || null;

  // A short table of the facts a shopper checks before buying, shown in the
  // hero beside the image. Amazon does the same and keeps the full list further
  // down the page -- here that is the Specifications tab, which builds its own
  // longer set including fabric specs, product code and availability. Six rows
  // is the cap; past that it stops being a glance and becomes the tab again.
  //
  // A plain const, not useMemo: this sits below the loading/not-found returns
  // above, so a hook here would be called on some renders and not others.

  // ── The specification, built once ──────────────────────────────────────
  // This used to be built twice: a six-row cut in the hero called "Product
  // details", and the full table again in a "Specifications" section below.
  // On the terry towel that meant thirteen labels -- material, fabric, weight,
  // category, size, colour, dimensions, GSM ... -- printed twice on one page,
  // and the hero column ending 281px short of the buy box beside it. One table,
  // in the hero, fills that gap with the thing the reader came for.
  const fabricSpec: Record<string, any> = (product.fabricSpecifications && typeof product.fabricSpecifications === 'object')
    ? (product.fabricSpecifications as Record<string, any>) : {};
  const specItems = (() => {
    const FS_LABELS: Record<string, string> = {
      weightValue: 'Fabric Weight', gsm: 'GSM', length: 'Length', breadth: 'Width',
      weave: 'Type of Weave', composition: 'Composition',
    };
    const FS_UNITS: Record<string, string> = { weightValue: 'g', length: 'cm', breadth: 'cm', gsm: 'GSM' };
    const out: { label: string; value: string; hex?: string | null }[] = [];
    if (product.baseSku) out.push({ label: 'Product Code', value: product.baseSku });
    if (product.category) out.push({ label: 'Category', value: product.category });
    // Size and colour belong to the variant when there is one, and the picker
    // under the gallery already says which is selected.
    if (!product.hasVariants && product.singleUnitSize) out.push({ label: 'Size', value: product.singleUnitSize });
    if (!product.hasVariants && product.singleUnitColor) out.push({ label: 'Color', value: product.singleUnitColor, hex: product.singleUnitColorHex });
    if (product.material) out.push({ label: 'Material', value: product.material });
    if (product.fabricType) out.push({ label: 'Fabric', value: product.fabricType });
    if (product.dimensions) out.push({ label: 'Dimensions', value: product.dimensions });
    if (product.weight) out.push({ label: 'Weight', value: `${product.weight}${product.weightUnit && !/[a-z]/i.test(String(product.weight)) ? ` ${product.weightUnit}` : ''}` });
    if (product.uom) out.push({ label: 'Sold as', value: product.uom });
    Object.entries(fabricSpec)
      .filter(([k]) => !['careInstructions', 'weightUnit', 'basis', 'type'].includes(k))
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .forEach(([k, v]) => {
        const label = FS_LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
        const unit = FS_UNITS[k];
        const raw = Array.isArray(v) ? v.join(', ') : String(v);
        const value = unit && /^[\d.,\s]+$/.test(raw.trim()) ? `${raw} ${unit}` : raw;
        out.push({ label, value });
      });
    if (product.hasVariants) out.push({ label: 'Variants', value: String(visibleVariants.length) });
    if (product.packagingType) {
      const unpackedLabel = product.unpackedType === 'STITCHED' ? ' — Stitched'
        : product.unpackedType === 'UNSTITCHED' ? ' — Unstitched'
        : product.unpackedType === 'OTHER' ? ' — Other' : '';
      const packLabel = product.packagingType === 'PACKED'
        ? `Packed${product.packingType === 'BALE' ? ' — Bale pack' : product.packingType === 'CARTON' ? ' — Carton box' : ''}`
        : `Unpacked${unpackedLabel}`;
      out.push({ label: 'Packaging', value: packLabel });
      if (product.packagingType === 'UNPACKED' && product.unpackedNote) {
        out.push({ label: 'Packaging Note', value: product.unpackedNote });
      }
    }
    out.push({ label: 'Availability', value: availableStock > 0 ? `In stock (${availableStock})` : 'Out of stock' });
    out.push({
      label: 'Return Policy',
      value: product.returnable !== false
        ? 'Easy return within 7 days of delivery'
        : 'This product is not eligible for return',
    });
    return out;
  })();
  const careList: string[] = Array.isArray(fabricSpec.careInstructions) ? fabricSpec.careInstructions : [];

  const whyChoose: { icon: any; title: string; desc: string }[] = [];
  if (product.dispatchTimeline) whyChoose.push({ icon: Truck, title: 'Fast Dispatch', desc: 'Fast delivery' });
  if (logisticsResult && logisticsResult.totalShippingCost === 0) whyChoose.push({ icon: Ship, title: 'Free Shipping', desc: 'No shipping charge on this item' });
  if (availableStock > 0) whyChoose.push({ icon: Check, title: 'In Stock', desc: `${availableStock} unit${availableStock === 1 ? '' : 's'} available now` });
  if (product.returnable !== false) whyChoose.push({ icon: RotateCcw, title: 'Easy Returns', desc: 'Return within 7 days of delivery' });
  if (hasManufacturerInfo(product.manufacturerInfo)) {
    const m = product.manufacturerInfo!;
    const detail = (m.experience && m.experience.trim())
      ? `${m.experience} of experience`
      : (m.role && m.role.trim() ? m.role : `Crafted by ${manufacturerDisplayName(m)}`);
    whyChoose.push({ icon: Award, title: 'Trusted Manufacturer', desc: detail });
  }

  return (
    <>
      <PromotionalPopup category={product.category} />

      <div className="bg-[#f9f5f2] min-h-screen font-sans">
        {/* Custom styles for image magnification */}
        <style jsx>{`
          .product-info-container {
            position: relative;
          }
          @media (min-width: 1024px) {
            .product-info-container {
              min-height: 600px;
            }
          }

          /* Smooth transitions for image switching */
          .magnify-image {
            animation: fadeIn 0.3s ease-in-out;
          }

          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }

          /* Gentle float for the CTA banner image collage (GPU-friendly). */
          .cta-float { animation: ctaFloat 5s ease-in-out infinite; will-change: transform; }
          .cta-float-2 { animation: ctaFloat 6.5s ease-in-out infinite; animation-delay: 0.8s; will-change: transform; }
          @keyframes ctaFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
          @media (prefers-reduced-motion: reduce) {
            .cta-float, .cta-float-2 { animation: none; }
          }
        `}</style>

        <div className="max-w-7xl xl:max-w-420 mx-auto px-3 sm:px-4 md:px-6 lg:px-8 pt-1 pb-4 sm:pb-6 lg:pb-8">
          {/* Breadcrumb, above the card rather than inside the middle column.
              It is page-level furniture -- where you are in the catalogue --
              so it belongs over the whole hero, not in one of its three
              columns where it read as a caption on the title. */}
          {(product.category || product.subCategory) && (
            <nav aria-label="Breadcrumb" className="mb-2.5 flex flex-wrap items-center gap-1 text-[11px] text-gray-500 sm:text-xs">
              <Link href="/" className="transition-colors hover:text-[#e01a1b]">Home</Link>
              {product.category && (
                <>
                  <ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-gray-300" />
                  <Link
                    href={`/products?category=${encodeURIComponent(product.category)}`}
                    className="transition-colors hover:text-[#e01a1b]"
                  >
                    {product.category}
                  </Link>
                </>
              )}
              {product.subCategory && (
                <>
                  <ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-gray-300" />
                  <span className="font-medium text-gray-700">{product.subCategory}</span>
                </>
              )}
            </nav>
          )}
          <div className="bg-white rounded-xl sm:rounded-2xl overflow-clip">
            <div className="grid grid-cols-1 lg:grid-cols-[4.5fr_3.5fr_4fr] gap-0">
              {/* Product Images */}
              <div className="p-3 sm:p-4 lg:p-6 bg-linear-to-br from-[#faf9f7] to-white">
                <div className="lg:sticky lg:top-40">
                  {/*
                    Gallery — vertical thumbnail rail beside the image on desktop,
                    horizontal strip beneath it on mobile. One markup drives both:
                    DOM order is [thumbs, image]; `flex-col-reverse` puts the image
                    on top for mobile, `lg:flex-row` puts the rail on the left.
                  */}
                  <div className="flex flex-col-reverse lg:flex-row gap-3 sm:gap-4">
                    {/* Image Thumbnails — on desktop they distribute down the rail
                        (justify-between) so the column fills the main image's height
                        instead of leaving dead space below the last thumbnail. */}
                    {displayImages.length > 1 && (
                      <div className="flex lg:flex-col lg:justify-between gap-2 sm:gap-3 overflow-x-auto lg:overflow-visible scrollbar-hide shrink-0 -mx-1 px-1 lg:mx-0 lg:px-0">
                        {displayImages.map((image: any, index: number) => (
                          <button
                            key={index}
                            onClick={() => setSelectedImage(index)}
                            onMouseEnter={() => setSelectedImage(index)}
                            className={`relative w-14 h-14 sm:w-16 sm:h-16 lg:w-[68px] lg:h-[68px] rounded-xl overflow-hidden transition-all duration-300 shrink-0 lg:hover:scale-105 ring-1 ${selectedImage === index
                              ? 'ring-2 ring-[#e01a1b] shadow-[0_6px_18px_rgba(224,26,27,0.28)]'
                              : 'ring-black/[0.08] hover:ring-[#e01a1b]/40 hover:shadow-md'
                              }`}
                          >
                            {image.url ? (
                              <Image
                                src={image.url}
                                alt={`${product.name} ${index + 1}`}
                                width={80}
                                height={80}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-gray-100">
                                <Package className="w-6 h-6 sm:w-8 sm:h-8 text-gray-400" />
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Main Image with Custom Magnification */}
                    <div
                      className="flex-1 min-w-0 aspect-square bg-white rounded-2xl overflow-hidden ring-1 ring-black/5 shadow-[0_8px_30px_rgba(0,0,0,0.08)] relative lg:cursor-crosshair"
                      onMouseMove={handleMouseMove}
                      onMouseEnter={handleMouseEnter}
                      onMouseLeave={handleMouseLeave}
                    >
                      {currentImageUrl ? (
                        <Image
                          ref={setImageRef}
                          src={currentImageUrl}
                          alt={product.name}
                          width={600}
                          height={600}
                          className="w-full h-full object-cover transition-opacity duration-300"
                          style={{ opacity: isImageHovered ? 0.8 : 1 }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gray-100">
                          <Package className="w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24 text-gray-400" />
                        </div>
                      )}

                      {/* Lens overlay — desktop only */}
                      {isImageHovered && currentImageUrl && (
                        <div
                          className="hidden lg:block absolute w-24 h-24 border-2 border-[#e01a1b] bg-transparent pointer-events-none rounded-lg"
                          style={{
                            left: `${mousePosition.x}%`,
                            top: `${mousePosition.y}%`,
                            transform: 'translate(-50%, -50%)',
                          }}
                        />
                      )}
                    </div>
                  </div>

                  {/* Variant selector — lives under the gallery so picking a variant
                      sits next to the imagery it swaps, and the buy panel on the
                      right stays focused on price + purchase. */}
                  {product.hasVariants && visibleVariants.length > 0 && (
                    <div className="mt-5 sm:mt-6">
                      <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2 sm:mb-3 break-words">
                        Select Variant: {selectedVariant ? `${[selectedVariant.size, selectedVariant.color].filter(Boolean).join(" - ")}` :
                          ([product.singleUnitSize, product.singleUnitColor].filter(Boolean).join(' - ') || 'Base Variant')}
                      </h3>
                      <div className="grid grid-cols-2 gap-2">
                        {/* Default Variant Option */}
                        <button
                          onClick={() => {
                            setSelectedVariant(null);
                            setSelectedImage(0);
                            setQuantity(1);
                          }}
                          className={`group relative p-2 rounded-xl border text-left overflow-hidden transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#e01a1b]/30 ${!selectedVariant
                            ? 'border-[#e01a1b] bg-[#e01a1b]/[0.04] ring-1 ring-[#e01a1b]/20 shadow-sm'
                            : 'border-gray-200/90 bg-white hover:border-gray-300 hover:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.15)]'
                            }`}
                        >
                          {/* Selected tick — replaces the loud ring/scale with a quiet marker */}
                          {!selectedVariant && (
                            <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[#e01a1b] text-white flex items-center justify-center shadow-sm">
                              <Check className="w-2.5 h-2.5" strokeWidth={3} />
                            </span>
                          )}
                          <div className="flex items-center gap-2.5 min-w-0">
                            {/* Product Main Image Preview */}
                            {product.images && product.images.length > 0 && (
                              <div className="h-10 w-10 rounded-lg overflow-hidden ring-1 ring-gray-200/80 shrink-0 bg-gray-50">
                                <Image
                                  src={product.images.find(img => img.isPrimary)?.url || product.images[0].url}
                                  alt="Default"
                                  width={48}
                                  height={48}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            )}

                            <div className="min-w-0 flex-1 pr-3.5">
                              {/* Name + colour swatch share a line to keep the card short */}
                              <div className="flex items-center gap-1.5 min-w-0">
                                {product.singleUnitColorHex && (
                                  <span
                                    className="h-4 w-4 rounded-full shrink-0 ring-1 ring-black/15 ring-offset-1 ring-offset-white"
                                    style={{ backgroundColor: product.singleUnitColorHex }}
                                    title={product.singleUnitColor}
                                  />
                                )}
                                <span className="font-semibold text-gray-900 text-[13px] leading-tight truncate">
                                  {product.singleUnitSize ? product.singleUnitSize : (product.singleUnitColor ? product.singleUnitColor : 'Base Variant')}
                                </span>
                              </div>
                              <div className="text-[10px] font-medium text-gray-400 mt-1 uppercase tracking-wide">
                                {(product.inventory?.baseStock ?? product.totalStock ?? 0) > 0
                                  ? `${product.inventory?.baseStock ?? product.totalStock} in stock`
                                  : 'Out of stock'}
                              </div>
                            </div>
                          </div>
                        </button>
                        {visibleVariants.map((variant) => (
                          <button
                            key={variant.id}
                            onClick={() => {
                              if (selectedVariant?.id === variant.id) {
                                setSelectedVariant(null); // Deselect if already selected
                              } else {
                                setSelectedVariant(variant);
                              }
                              setSelectedImage(0); // Reset to first image
                              setQuantity(1); // Reset quantity on variant change
                            }}
                            className={`group relative p-2 rounded-xl border text-left overflow-hidden transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#e01a1b]/30 ${selectedVariant?.id === variant.id
                              ? 'border-[#e01a1b] bg-[#e01a1b]/[0.04] ring-1 ring-[#e01a1b]/20 shadow-sm'
                              : 'border-gray-200/90 bg-white hover:border-gray-300 hover:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.15)]'
                              }`}
                          >
                            {selectedVariant?.id === variant.id && (
                              <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[#e01a1b] text-white flex items-center justify-center shadow-sm">
                                <Check className="w-2.5 h-2.5" strokeWidth={3} />
                              </span>
                            )}
                            <div className="flex items-center gap-2.5 min-w-0">
                              {/* Variant Image Preview in Selector */}
                              {variant.images && variant.images.length > 0 && (
                                <div className="h-10 w-10 rounded-lg overflow-hidden ring-1 ring-gray-200/80 shrink-0 bg-gray-50">
                                  <Image
                                    src={variant.images[0]}
                                    alt={variant.variantName || variant.color || 'Variant'}
                                    width={48}
                                    height={48}
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                              )}
                              <div className="min-w-0 flex-1 pr-3.5">
                                {/* Name + colour swatch share a line to keep the card short */}
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {variant.colorHex && (
                                    <span
                                      className="h-4 w-4 rounded-full shrink-0 ring-1 ring-black/15 ring-offset-1 ring-offset-white"
                                      style={{ backgroundColor: variant.colorHex }}
                                      title={variant.color}
                                    />
                                  )}
                                  <span className="font-semibold text-gray-900 text-[13px] leading-tight truncate">
                                    {variant.variantName || variant.color}
                                  </span>
                                </div>
                                <div className="text-[10px] font-medium text-gray-400 mt-1 uppercase tracking-wide">
                                  {variant.stock > 0 ? `${variant.stock} in stock` : 'Out of stock'}
                                </div>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* Product Info - Shows magnified image when hovering (desktop only) */}
              <div className="product-info-container relative p-3 sm:p-4 lg:p-6 lg:pl-4">
                {/* Magnified Image Overlay - Desktop only (hover-driven). lg:hidden on mobile so info always shows. */}
                {isImageHovered && currentImageUrl && (
                  <div className="hidden lg:flex w-full items-start justify-center bg-white rounded-r-2xl lg:sticky lg:top-40">
                    <div className="w-full aspect-[5/6] bg-white rounded-xl border-2 border-gray-200 shadow-2xl overflow-hidden">
                      <div
                        className="w-full h-full bg-cover bg-no-repeat transition-all duration-150"
                        style={{
                          backgroundImage: `url(${currentImageUrl})`,
                          backgroundPosition: `${mousePosition.x}% ${mousePosition.y}%`,
                          backgroundSize: '300%',
                        }}
                      />
                    </div>
                  </div>
                )}
                {/* Normal Product Info Content — always shown on mobile; hidden on lg when hovering */}
                <div className={`space-y-2 sm:space-y-3 ${isImageHovered ? 'lg:hidden' : ''}`}>
                    {/* Header Section */}
                    <div className="pb-0">
                      <div className="flex items-start justify-between gap-3 mb-1.5 sm:mb-2">
                        <div className="flex-1 min-w-0">
                          <h1 className="font-playfair text-lg sm:text-xl md:text-2xl lg:text-3xl font-semibold text-[#1a1a1a] mb-2 sm:mb-2.5 leading-tight break-words tracking-tight">{product.name}</h1>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                          {/* Share. The page had no way to send a product to
                              anyone -- and this is the page people want to
                              send, not the listing it came from. */}
                          <button
                            onClick={shareProduct}
                            aria-label="Share this product"
                            title="Share this product"
                            className="shrink-0 rounded-full bg-gray-50 p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#1a1a1a] sm:p-3"
                          >
                            <Share2 className="h-5 w-5 sm:h-6 sm:w-6" />
                          </button>
                          <button
                            onClick={handleWishlistToggle}
                            aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                            className={`p-2 sm:p-3 rounded-full transition-colors shrink-0 ${isWishlisted ? 'bg-red-50 hover:bg-red-100' : 'bg-gray-50 hover:bg-gray-100'}`}
                          >
                            <Heart className={`w-5 h-5 sm:w-6 sm:h-6 ${isWishlisted ? 'fill-current text-red-500' : 'text-gray-400'}`} />
                          </button>
                        </div>
                      </div>

                      {/* Rating. The listing payload carries an average and a
                          count but no per-star breakdown, so the percentage
                          version of this line lives in the reviews section
                          below, which loads the reviews themselves. Here it is
                          a face and a count -- and no face at all when the
                          score is not one we would advertise. */}
                      <div className="flex items-center flex-wrap gap-2 sm:gap-x-4 sm:gap-y-2 mb-1 sm:mb-1.5">
                        {(() => {
                          // Once the approved reviews have loaded, trust their actual
                          // count so this header always matches the reviews section
                          // below (the stored product.reviews aggregate can lag).
                          const n = loadingReviews ? (product.reviews || 0) : reviews.length;
                          const face = positiveFace(Number(product.rating) || 0);
                          if (n === 0) return <span className="text-[13px] font-medium text-gray-400 sm:text-sm">No reviews yet</span>;
                          return (
                            <span className="inline-flex items-center gap-1.5">
                              {face && <FaceIcon value={face} className="h-5 w-5" />}
                              <span className="text-[13px] font-semibold text-gray-700 sm:text-sm">
                                {face ? <><span className="tabular-nums">{n}</span> loved this</> : <><span className="tabular-nums">{n}</span> review{n === 1 ? '' : 's'}</>}
                              </span>
                            </span>
                          );
                        })()}
                        {(loadingReviews ? (product.reviews || 0) : reviews.length) > 0 ? (
                          <button
                            onClick={() => document.getElementById('customer-reviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                            className="text-xs sm:text-sm text-[#e01a1b] hover:text-[#c41617] cursor-pointer font-medium"
                          >
                            See all reviews
                          </button>
                        ) : null}
                      </div>

                      {/* ── Who made this ────────────────────────────────
                          The full "Meet the Maker" panel is 2,241px down the
                          page on desktop and 3,799px down on a phone -- four
                          screens of scrolling before anyone learns there is a
                          person behind the product. This is the same fact at
                          the top, where the customer meets the product, and it
                          opens that panel's profile when tapped. */}
                      {hasManufacturerInfo(product.manufacturerInfo) && (() => {
                        const m = product.manufacturerInfo!;
                        const name = manufacturerDisplayName(m);
                        const under = [m.role, m.experience].filter((x) => x && x.trim()).join(' · ');
                        return (
                          <button
                            type="button"
                            onClick={() => setShowMakerModal(true)}
                            className="group mb-2 flex w-full items-center gap-3 rounded-xl bg-[linear-gradient(120deg,#fdf9f5_0%,#faf7f3_60%,#f8f3ed_100%)] px-3 py-3 text-left ring-1 ring-[#efe6df] transition-all duration-300 hover:shadow-[0_6px_18px_rgba(0,0,0,0.05)] hover:ring-[#e0d2c4] sm:mb-2.5 sm:gap-4 sm:rounded-2xl sm:px-4 sm:py-4"
                          >
                            {m.photo ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={m.photo} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-full object-cover shadow-[0_4px_14px_rgba(0,0,0,0.12)] ring-2 ring-white sm:h-16 sm:w-16" />
                            ) : (
                              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-[#a1948a] shadow-[0_4px_14px_rgba(0,0,0,0.08)] ring-2 ring-white sm:h-16 sm:w-16">
                                <Award className="h-6 w-6" />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[#b9a99b] sm:text-[11px]">Made by</span>
                              <span className="block truncate text-[15px] font-bold text-[#1a1a1a] sm:text-[17px]">{name || 'Our maker'}</span>
                              {under && <span className="mt-0.5 block truncate text-[12px] text-[#6b625b] sm:text-[13px]">{under}</span>}
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#4a423c] ring-1 ring-[#e6dcd2] transition-colors group-hover:text-[#e01a1b] sm:text-[13px]">
                              <span className="hidden sm:inline">View profile</span>
                              <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                            </span>
                          </button>
                        );
                      })()}

                      {/* Price moved into the purchase panel (below quantity / stock / dispatch) */}
                    </div>

                    {/* Purchase Options — the variant selector now lives under the
                        gallery, so this column is a simple stack at full width. */}
                    <div className="space-y-4">

                      {/* The headline price. It stays in this column -- Amazon
                          keeps the big figure with the product facts and repeats a
                          compact one in the buy box, because by the time you have
                          read the details the number you are committing to should
                          be beside the button, not a column away. */}
                      <div className="bg-[#fdfdfd] rounded-xl sm:rounded-2xl ring-1 ring-black/[0.06] p-4 mb-3">
                        {activeOffer && (
                          <div className="flex items-center flex-wrap gap-2 mb-2">
                            <span className="inline-flex items-center gap-1 rounded-full bg-linear-to-r from-[#e01a1b] to-[#ff5a36] px-2.5 py-1 text-[11px] sm:text-xs font-bold tracking-wide text-white shadow-sm">
                              {activeOffer.badge}
                            </span>
                            <span className="text-xs sm:text-sm text-gray-700 font-medium">{activeOffer.title}</span>
                            {offerEnds && (
                              <span className="text-[11px] text-[#e01a1b] font-semibold">· {offerEnds}</span>
                            )}
                          </div>
                        )}
                        <div className="flex items-baseline flex-wrap gap-x-2 sm:gap-x-3 gap-y-1">
                          <span className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">{formatPrice(offeredPrice || 0)}</span>
                          {hasOfferSaving ? (
                            <>
                              <span className="text-base sm:text-lg lg:text-xl text-gray-500 line-through">{formatPrice(currentPrice)}</span>
                              <span className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 px-2 py-0.5 sm:px-3 sm:py-1 rounded-full text-xs sm:text-sm font-semibold">
                                Save {formatPrice(currentPrice - offeredPrice)}
                              </span>
                            </>
                          ) : originalPrice && originalPrice > currentPrice ? (
                            <>
                              <span className="text-base sm:text-lg lg:text-xl text-gray-500 line-through">{formatPrice(originalPrice)}</span>
                              <span className="bg-gray-100 text-gray-800 px-2 py-0.5 sm:px-3 sm:py-1 rounded-full text-xs sm:text-sm font-semibold">
                                Save {formatPrice(originalPrice - currentPrice)}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>

                      {/* About this item -- the opening of the description, with the
                          rest a click away in the tab below rather than repeated
                          here. Amazon leads with this; we had the text but buried
                          all of it under a tab the shopper had to go looking for. */}
                      {product.description && (
                        <div>
                          <h2 className="mb-2 text-[14px] font-bold uppercase tracking-[0.08em] text-gray-900">About this item</h2>
                          <p ref={descRef} className="line-clamp-4 whitespace-pre-line text-[14.5px] leading-relaxed text-gray-600 sm:text-[15px]">{product.description}</p>
                          {descHasMore && (
                            <button
                              type="button"
                              onClick={() => document.getElementById('product-information')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                              className="mt-2 inline-flex items-center gap-1 text-[14px] font-semibold text-[#e01a1b] transition-colors hover:text-[#c41617]"
                            >
                              Read full description
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {/* The tags live in the description section further
                              down -- but that section is skipped when the hero
                              has already shown everything, so they come up here
                              instead of vanishing with it. */}
                          {!descHasMore && product.tags && product.tags.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {product.tags.map((tag, i) => (
                                <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-[#e01a1b]/[0.06] px-3 py-1.5 text-[13px] font-semibold text-[#e01a1b]">
                                  <Check className="h-3.5 w-3.5" /> {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* The whole specification, not a six-row taste of it.
                          The full table used to sit in its own band lower down,
                          repeating every row of this one. */}
                      {specItems.length > 0 && (
                        <div>
                          <h2 className="mb-2.5 text-[14px] font-bold uppercase tracking-[0.08em] text-gray-900">Specifications</h2>
                          <dl className="divide-y divide-gray-100 overflow-hidden rounded-xl ring-1 ring-black/[0.06]">
                            {(showAllSpecs ? specItems : specItems.slice(0, SPEC_PREVIEW)).map((f) => (
                              <div key={f.label} className="flex items-start gap-3 bg-white px-4 py-3 text-[14.5px]">
                                <dt className="w-24 shrink-0 text-gray-500 sm:w-28">{f.label}</dt>
                                <dd className="flex min-w-0 flex-1 items-center gap-2 font-medium text-gray-900">
                                  {f.hex && (
                                    <span
                                      aria-hidden
                                      className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-gray-300"
                                      style={{ backgroundColor: f.hex }}
                                    />
                                  )}
                                  <span className="break-words">{f.value}</span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                          {/* Six rows, then the rest on request. The whole table
                              in the hero was a wall of thirteen lines beside the
                              price -- the top few are what anyone actually
                              checks before deciding. */}
                          {specItems.length > SPEC_PREVIEW && (
                            <button
                              type="button"
                              onClick={() => setShowAllSpecs((v) => !v)}
                              className="mt-2.5 inline-flex items-center gap-1 text-[14px] font-semibold text-[#e01a1b] transition-colors hover:text-[#c41617]"
                            >
                              {showAllSpecs ? 'Show less' : `Show all ${specItems.length} specifications`}
                              <ChevronDown className={`h-4 w-4 transition-transform ${showAllSpecs ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                        </div>
                      )}

                    </div>
                  </div>
              </div>

              {/* ══ Buy box ══
                  One column holding the whole purchase decision: price, stock,
                  how it ships, what that costs, quantity, and the two buttons.
                  The page used to split them -- actions in the middle column, a
                  read-only Order Summary beside it -- so the running total was
                  never next to the button it described, and choosing Air vs Sea
                  changed a figure in a different column from the control.

                  It is no longer `hidden lg:flex`. That matters now: the actions
                  live in here, so hiding the rail below lg would have taken Add
                  to Cart off every phone. Below lg it simply stacks under the
                  product facts. */}
              <aside className="flex flex-col gap-5 self-start p-3 sm:p-4 lg:sticky lg:top-40 lg:p-6 lg:pl-2">
                <div className="rounded-2xl bg-white p-4 ring-1 ring-black/[0.07] sm:p-5">
                  {/* The asking price again, compact, at the top of the box. */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pb-3">
                    <span className="text-2xl font-bold tabular-nums text-gray-900">{formatPrice(offeredPrice || 0)}</span>
                    {hasOfferSaving ? (
                      <span className="text-sm tabular-nums text-gray-500 line-through">{formatPrice(currentPrice)}</span>
                    ) : originalPrice && originalPrice > currentPrice ? (
                      <span className="text-sm tabular-nums text-gray-500 line-through">{formatPrice(originalPrice)}</span>
                    ) : null}
                    <span className="text-xs text-gray-500">/ {product?.uom || 'pcs'}</span>
                  </div>
                    {/* Stock Status */}
                    <div className="mb-3">
                      {availableStock > 0 ? (
                        <div className="flex items-center space-x-2">
                          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                          <span className="text-green-600 font-bold text-base">In stock</span>
                          <span className="text-gray-600 text-sm">({availableStock} available)</span>
                        </div>
                      ) : (
                        <div className="flex items-center space-x-2">
                          <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
                          <span className="text-red-500 font-bold text-base">Out of Stock</span>
                        </div>
                      )}
                    </div>

                    {/* Quantity — sits at the top of the shipping/logistics area. */}
                    {availableStock > 0 && (
                      <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
                        <span className="text-sm font-semibold text-gray-700">Quantity:</span>
                        {/* The stepper is one group, so a wrap in the narrow
                            buy box breaks after the label rather than
                            through the middle of the control. */}
                        <div className="flex items-center gap-2 sm:gap-3">
                          <button
                            onClick={handleDecrement}
                            disabled={quantity <= 1}
                            aria-label="Decrease quantity"
                            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center border-2 border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            <span className="text-xl font-semibold">−</span>
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={availableStock}
                            value={quantity || ''}
                            onChange={handleQuantityChange}
                            onBlur={handleQuantityBlur}
                            aria-label="Quantity"
                            className="w-16 sm:w-20 text-center font-bold text-base sm:text-lg border-2 border-gray-300 rounded-lg py-1 focus:outline-none focus:ring-2 focus:ring-[#e01a1b]/40 focus:border-[#e01a1b] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <button
                            onClick={handleIncrement}
                            disabled={quantity >= availableStock}
                            aria-label="Increase quantity"
                            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center border-2 border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            <span className="text-xl font-semibold">+</span>
                          </button>
                          <span className="text-sm font-medium text-gray-500">{product?.uom || 'pcs'}</span>
                        </div>
                      </div>
                    )}

                    {/* Smart Logistics Section */}
                    {logisticsResult && product.logisticsConfig && (
                      <div
                        ref={shippingCardRef}
                        id="shipping-logistics"
                        className={`order-5 bg-white border rounded-xl p-4 mt-4 space-y-3 transition-all duration-500 ${
                          highlightShipping
                            ? 'border-[#e01a1b] ring-4 ring-[#e01a1b]/25 shadow-lg'
                            : 'border-gray-200'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                            <Truck className="w-4 h-4 text-[#e01a1b]" />
                            Shipping & Logistics
                          </h3>
                          {logisticsResult.recommendedTransport === logisticsResult.selectedTransport && (
                            <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">
                              Recommended
                            </span>
                          )}
                        </div>

                        {/* Total Weight */}
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-600">Total Weight</span>
                          <span className="font-semibold text-gray-900">
                            {formatWeight(logisticsResult.totalWeightKg)}
                            <span className="text-xs text-gray-500 ml-1">
                              ({quantity} x {formatWeight(logisticsResult.unitWeightKg)}/unit)
                            </span>
                          </span>
                        </div>

                        {/* Transport Toggle — hidden for India live courier: Delhivery
                            picks the service, so the shopper doesn't choose Air/Surface. */}
                        {!courierPickerHidden && (product.logisticsConfig as LogisticsConfig).transportTypes.length > 1 && (
                          <div className="flex gap-2">
                            {(product.logisticsConfig as LogisticsConfig).transportTypes.map((type) => {
                              const isSelected = logisticsResult.selectedTransport === type;
                              const isRecommended = logisticsResult.recommendedTransport === type;
                              return (
                                <button
                                  key={type}
                                  onClick={() => setTransportOverride(type)}
                                  aria-label={`Select ${transportModeLabel(type, getRegion())} shipping`}
                                  aria-pressed={isSelected}
                                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border-2 text-sm font-semibold transition-all duration-200 ${
                                    isSelected
                                      ? 'border-[#e01a1b] bg-[#fff1f1] text-[#c41617] ring-2 ring-[#e01a1b]/25'
                                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#e01a1b]/40'
                                  }`}
                                >
                                  {type === 'AIR' ? <Plane className="w-4 h-4" /> : isSurfaceRegion(getRegion()) ? <Truck className="w-4 h-4" /> : <Ship className="w-4 h-4" />}
                                  {transportModeLabel(type, getRegion())}
                                  {isRecommended && !isSelected && (
                                    <span className="text-[9px] bg-green-100 text-green-600 px-1.5 py-0.5 rounded font-bold">Best</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {/* Single transport display — also hidden for India live courier. */}
                        {!courierPickerHidden && (product.logisticsConfig as LogisticsConfig).transportTypes.length === 1 && (() => {
                          // Single-transport products always have a resolved mode.
                          const only = logisticsResult.selectedTransport ?? (product.logisticsConfig as LogisticsConfig).transportTypes[0]
                          return (
                          <div className="flex items-center gap-2 py-2 px-3 rounded-lg bg-[#fff1f1] border border-[#ffc1c1] text-sm font-semibold text-[#c41617]">
                            {only === 'AIR' ? <Plane className="w-4 h-4" /> : isSurfaceRegion(getRegion()) ? <Truck className="w-4 h-4" /> : <Ship className="w-4 h-4" />}
                            {transportModeLabel(only, getRegion())}
                          </div>
                          )
                        })()}

                        {/* Courier partner — region- and mode-specific. Required
                            before checkout: the chosen carrier travels with the
                            order to fulfilment/admin. When the live India courier
                            integration is active, Delhivery picks the carrier, so the
                            manual picker is replaced with a neutral note. */}
                        {!courierPickerHidden && courierOptions.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                                {getRegion() === 'IN' ? 'Domestic courier' : 'International courier'}
                              </span>
                              {!selectedCourier && (
                                <span className="text-[10px] font-semibold text-[#e01a1b]">Required</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {courierOptions.map((c) => {
                                const isSelected = selectedCourier === c.id;
                                return (
                                  <button
                                    key={c.id}
                                    type="button"
                                    onClick={() => setSelectedCourier(c.id)}
                                    aria-pressed={isSelected}
                                    aria-label={`Select ${c.name}`}
                                    title={c.name}
                                    className={`group/courier relative p-1 rounded-lg border transition-all duration-200 ${
                                      isSelected
                                        ? 'border-[#e01a1b] bg-[#fff1f1] ring-1 ring-[#e01a1b]/25'
                                        : 'border-gray-200 bg-white hover:border-gray-300'
                                    }`}
                                  >
                                    <CourierBadge courier={c} className="w-9 h-9 rounded-md" codeClassName="text-[10px]" />
                                    {isSelected && (
                                      <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#e01a1b] flex items-center justify-center ring-2 ring-white">
                                        <Check className="w-2.5 h-2.5 text-white" />
                                      </span>
                                    )}
                                    {/* Name tooltip on hover/focus */}
                                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 group-hover/courier:opacity-100 group-focus/courier:opacity-100 transition-opacity duration-150 z-20">
                                      {c.name}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* No courier available for this region + shipping method — tell the
                            shopper instead of showing a silent empty picker they can't act on. */}
                        {!courierPickerHidden && courierOptions.length === 0 && (
                          <div className="flex items-start gap-2 py-2 px-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                            <Truck className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>
                              No courier partner is available for this shipping method in your region.
                              Try the other shipping method{getRegion() === 'IN' ? '' : ', or contact us'} — or the admin can add one under Courier Partners.
                            </span>
                          </div>
                        )}

                        {/* Delivery & Cost — hidden for India live courier: the exact
                            rate and ETA come from Delhivery at checkout once the
                            delivery pincode is known (the neutral note above covers it). */}
                        {!courierPickerHidden && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-lg bg-[#faf7f3] p-2.5 text-center">
                            <div className="text-xs text-gray-500 mb-0.5">Delivery Time</div>
                            <div className="text-sm font-bold text-gray-900">{logisticsResult.deliveryDays} days</div>
                          </div>
                          <div className="rounded-lg bg-[#faf7f3] p-2.5 text-center">
                            <div className="text-xs text-gray-500 mb-0.5">Shipping Cost</div>
                            <div className="text-sm font-bold text-gray-900">
                              {logisticsResult.totalShippingCost === 0
                                ? 'FREE'
                                : formatPrice(getCurrency() === 'USD' ? convertINRtoUSD(logisticsResult.totalShippingCost) : logisticsResult.totalShippingCost)}
                            </div>
                          </div>
                        </div>
                        )}

                        {/* Dimensions */}
                        {(product.logisticsConfig as LogisticsConfig).dimensions && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <Box className="w-3.5 h-3.5" />
                            <span>Dimensions: {formatDimensions((product.logisticsConfig as LogisticsConfig).dimensions)}</span>
                          </div>
                        )}

                        {/* CBM (volumetric) breakdown — auto-calculated per unit,
                            then scaled to the chosen quantity. */}
                        {(product.logisticsConfig as LogisticsConfig).dimensions && (() => {
                          const d = (product.logisticsConfig as LogisticsConfig).dimensions!;
                          const unit = (d.unit || 'CM').toUpperCase();
                          const toM = (v: number) => (unit === 'IN' ? v * 0.0254 : v / 100);
                          const perUnit = toM(d.length) * toM(d.width) * toM(d.height);
                          const total = perUnit * quantity;
                          const formula = unit === 'IN' ? '× 2.54³ ÷ 1,000,000' : '÷ 1000 ÷ 1000';
                          return (
                            <div className="rounded-lg border border-[#f0e8df] bg-[#faf7f3]/70 p-3 text-xs">
                              <div className="mb-1.5 flex items-center justify-between">
                                <span className="flex items-center gap-1.5 font-semibold text-gray-700">
                                  <Box className="h-3.5 w-3.5" /> CBM (Volumetric)
                                </span>
                                <span className="font-bold tabular-nums text-gray-900">{total.toFixed(4)} m³</span>
                              </div>
                              <div className="space-y-0.5 text-[11px] leading-relaxed text-gray-500">
                                <div>
                                  Per unit: {d.length} × {d.width} × {d.height} {formula} ={' '}
                                  <span className="font-medium tabular-nums text-gray-700">{perUnit.toFixed(4)} m³</span>
                                </div>
                                <div>
                                  Total: {perUnit.toFixed(4)} × {quantity} {quantity === 1 ? 'unit' : 'units'} ={' '}
                                  <span className="font-medium tabular-nums text-gray-700">{total.toFixed(4)} m³</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Max weight warning */}
                        {logisticsResult.exceedsMaxWeight && (
                          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-700">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>
                              Total weight ({formatWeight(logisticsResult.totalWeightKg)}) exceeds the maximum limit of {formatWeight(logisticsResult.maxWeightKg)}. Please reduce quantity or contact support.
                            </span>
                          </div>
                        )}

                        {/* Notes */}
                        {(product.logisticsConfig as LogisticsConfig).notes && (
                          <div className="flex items-start gap-1.5 text-xs text-gray-500">
                            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>{(product.logisticsConfig as LogisticsConfig).notes}</span>
                          </div>
                        )}

                        {/* Save & return — only when the shopper came here from the
                            cart to fill in this line's shipping method. */}
                        {returnCartItemId && (
                          <button
                            onClick={handleSaveShippingAndReturn}
                            disabled={savingShipping || (!selectedCourier && !courierPickerHidden)}
                            className="w-full mt-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#e01a1b] text-white text-sm font-semibold hover:bg-[#c41617] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                          >
                            <Check className="w-4 h-4" />
                            {savingShipping
                              ? 'Saving…'
                              : (!selectedCourier && !courierPickerHidden)
                                ? 'Select a courier to continue'
                                : `Use ${logisticsResult.selectedTransport === 'AIR' ? 'Air' : isSurfaceRegion(getRegion()) ? 'Surface' : 'Sea'} & return to cart`}
                          </button>
                        )}
                      </div>
                    )}

                  {availableStock > 0 && (
                    <>
                  {/* The running total, directly above the buttons instead of in a
                      separate card beside them. Quantity and the freight choice both
                      move this figure, so it belongs next to the controls that change
                      it -- which is exactly what the old split layout could not do. */}
                  {availableStock > 0 && (() => {
                    const unit = offeredPrice || 0;
                    const subtotal = unit * (quantity || 0);
                    const shipINR = logisticsResult ? logisticsResult.totalShippingCost : null;
                    const shipDisplay = shipINR == null ? null : (getCurrency() === 'USD' ? convertINRtoUSD(shipINR) : shipINR);
                    // India live courier: the real shipping cost needs the delivery
                    // pincode, so it's resolved at checkout and left out of this total.
                    const total = courierPickerHidden ? subtotal : subtotal + (shipDisplay || 0);
                    return (
                      <div className="mt-4 space-y-2 border-t border-gray-100 pt-4 text-sm">
                        <div className="flex items-center justify-between text-gray-600">
                          <span>Subtotal <span className="text-gray-400">({quantity} {product?.uom || 'pcs'})</span></span>
                          <span className="font-semibold tabular-nums text-gray-900">{formatPrice(subtotal)}</span>
                        </div>
                        <div className="flex items-center justify-between text-gray-600">
                          <span className="flex items-center gap-1.5">
                            Shipping
                            {!courierPickerHidden && logisticsResult && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                                {logisticsResult.selectedTransport === 'AIR' ? <Plane className="w-3 h-3" /> : isSurfaceRegion(getRegion()) ? <Truck className="w-3 h-3" /> : <Ship className="w-3 h-3" />}
                                {logisticsResult.selectedTransport === 'AIR' ? 'Air' : isSurfaceRegion(getRegion()) ? 'Road' : 'Sea'}
                              </span>
                            )}
                          </span>
                          <span className="font-semibold tabular-nums text-gray-900">
                            {courierPickerHidden
                              ? <span className="text-xs font-medium text-gray-500">Calculated at checkout</span>
                              : shipDisplay == null ? '—' : shipDisplay === 0 ? 'FREE' : formatPrice(shipDisplay)}
                          </span>
                        </div>
                        {!courierPickerHidden && logisticsResult && (
                          <div className="flex items-center justify-between text-gray-600">
                            <span>Delivery</span>
                            <span className="font-semibold text-gray-900">{logisticsResult.deliveryDays} days</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between border-t border-gray-100 pt-2">
                          <span className="text-base font-bold text-gray-900">Total</span>
                          <span className="text-xl font-extrabold tabular-nums text-[#e01a1b]">{formatPrice(total)}</span>
                        </div>
                      </div>
                    );
                  })()}
                            {/* Add to Cart / Buy Now — below the Shipping & Logistics block */}
                            <div className="w-full mt-4">
                              <div className="flex gap-2">
                                <button
                                  onClick={handleAddToCart}
                                  disabled={nothingBuyable || courierMissing}
                                  className="flex-1 flex justify-center items-center bg-white text-[#e01a1b] ring-2 ring-[#e01a1b] hover:bg-[#fff1f1] hover:-translate-y-0.5 py-3 px-4 rounded-full font-bold uppercase transition-all duration-300 active:scale-95 text-xs tracking-[1.5px] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                                >
                                  {nothingBuyable ? 'Not available' : 'Add to cart'}
                                </button>
                                <button
                                  onClick={handleBuyNow}
                                  disabled={nothingBuyable || courierMissing}
                                  className="btn-shine flex-1 flex justify-center items-center bg-[#e01a1b] text-white hover:bg-[#c41617] shadow-[0_6px_20px_rgba(224,26,27,0.3)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] hover:-translate-y-0.5 py-3 px-4 rounded-full font-bold uppercase transition-all duration-300 active:scale-95 text-xs tracking-[1.5px] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                                >
                                  Buy Now
                                </button>
                              </div>
                              {nothingBuyable ? (
                                <p className="text-xs text-amber-700 mt-2 text-center">
                                  This product isn&apos;t available in your region right now.
                                </p>
                              ) : courierMissing && (
                                <p className="text-xs text-amber-700 mt-2 text-center">
                                  Select a courier partner to continue.
                                </p>
                              )}
                            </div>
                    </>
                  )}
                </div>

              </aside>
            </div>
          </div>


          {/* ══ Product information ══ */}
          {(() => {
            // "Why choose this?" now lives in the hero rail (under the manufacturer);
            // this rail carries only the Offers card.

            // Rail "Offers" promo — priority order:
            //   1) a coupon for this product's category (highest),
            //   2) an offer that targets this product / category,
            //   3) otherwise a store offer, deterministic per product so different
            //      products surface different promos.
            type RailPromo = { kind: 'coupon' | 'offer'; image?: string | null; badge: string; title: string; desc?: string | null; code?: string; endsLabel?: string | null; savingLabel?: string | null };
            let railPromo: RailPromo | null = null;
            if (categoryCoupon) {
              const badge = categoryCoupon.discountType === 'PERCENTAGE'
                ? `${categoryCoupon.discountValue}% OFF`
                : `${formatPrice(categoryCoupon.discountValue)} OFF`;
              railPromo = {
                kind: 'coupon',
                image: categoryCoupon.popupImage,
                badge,
                title: categoryCoupon.popupTitle || 'Special Coupon',
                desc: categoryCoupon.popupMessage || categoryCoupon.description || null,
                code: categoryCoupon.code,
              };
            }
            if (!railPromo && activeOffer) {
              railPromo = {
                kind: 'offer',
                image: null,
                badge: activeOffer.badge,
                title: activeOffer.title,
                desc: activeOffer.description ?? null,
                endsLabel: offerEnds,
                savingLabel: hasOfferSaving ? `Save ${formatPrice(currentPrice - (offeredPrice || 0))}/unit` : null,
              };
            }
            if (!railPromo && promoOffers.length > 0) {
              const matched = promoOffers.find((o) =>
                (o.scope === 'PRODUCT' && o.productIds?.includes(product.id)) ||
                (o.scope === 'CATEGORY' && o.categoryNames?.includes(product.category))
              );
              const hash = product.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
              const chosen = matched || promoOffers[hash % promoOffers.length];
              if (chosen) {
                railPromo = {
                  kind: 'offer',
                  image: chosen.bannerImage,
                  badge: chosen.badge,
                  title: chosen.title,
                  desc: chosen.description ?? null,
                  endsLabel: chosen.endsAt ? offerEndsLabel(chosen.endsAt) : null,
                  savingLabel: null,
                };
              }
            }

            // Only when there is more of it than the hero already printed.
            // Two lines under a large heading, repeated from a screen above,
            // is a section that costs the reader a scroll and returns nothing.
            const hasDescription = descHasMore;
            // Shipping tab shows admin-configured logistics only (delivery time +
            // shipping cost). The vendor's dispatch timeline is intentionally not shown.
            const hasShipping = !!(logisticsResult || product.logisticsConfig);

            // Nothing known about this product at all: skip the band rather than
            // render an empty card. This used to be `tabs.length === 0`, back when
            // each of these sections was a tab.
            if (!hasDescription && whyChoose.length === 0 && careList.length === 0 && !hasShipping) return null;

            // Full-width bands were measured at 1,382px wide carrying 169px of
            // content -- 88 per cent air. These sit side by side instead, and
            // the column count follows how many there actually are so a lone
            // section is never stretched across the page on its own.
            // The description is no longer one of these: it has a band of
            // its own above the row, so the row is the four promises, the care
            // symbols and the journey -- three related blocks, three columns,
            // and never a fourth that wraps under the other three.
            const bandCount = (whyChoose.length > 0 ? 1 : 0) + (careList.length > 0 ? 1 : 0) + (hasShipping ? 1 : 0);
            // A single band was pinned to the left of a 1,382px row with the
            // rest of it empty; centred, the same card reads as deliberate.
            // A lone card was capped at 699px and centred, which left the
            // rest of the row blank beside it. It takes the whole row now, and
            // what is inside spreads to match -- see `soloBand` below.
            const bandCols = bandCount >= 3 ? 'lg:grid-cols-3' : bandCount === 2 ? 'lg:grid-cols-2' : '';
            const soloBand = bandCount === 1;

            return (
              <div className="mt-4 space-y-4 sm:mt-5 sm:space-y-5">
                {/* ══ Product information — stacked, full width, no tabs ══
                    It was a 2/3 tab panel beside a 1/3 promo rail, which meant
                    three of the four things this page knows about the product
                    were hidden behind a click, and the widest surface on the
                    page was spent on a promo card. Everything is open now, one
                    section per hairline, and the body type is a step larger --
                    13px in a 900px-wide column was hard to read. */}
                <div className={`grid grid-cols-1 gap-4 sm:gap-5 ${bandCols}`}>
                  {whyChoose.length > 0 && (
                    <section className={`${INFO_CARD} flex flex-col`}>
                      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#e01a1b_0%,#f0a03a_100%)]" />
                      <span aria-hidden className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-[#e01a1b]/[0.05]" />
                      <div className="relative flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#e01a1b]/[0.08] text-[#e01a1b]">
                          <Check className="h-4 w-4" strokeWidth={2.2} />
                        </span>
                        <div>
                          <h2 className="font-playfair text-xl font-semibold tracking-tight text-[#1a1a1a] sm:text-2xl">Why choose this</h2>
                          <p className="mt-0.5 text-[12.5px] text-[#a1948a]">What you get with this order</p>
                        </div>
                      </div>
                      {/* Two across on a phone where each card has room to stand
                          up, one column from lg where the card lies down inside
                          its own column of the row. */}
                      <div className={`mt-4 grid flex-1 grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:auto-rows-fr lg:gap-2 ${soloBand ? 'lg:grid-cols-2' : 'lg:grid-cols-1'}`}>
                        {whyChoose.map((w, i) => {
                          const Icon = w.icon;
                          const m = PROMISE_MOTIFS[i % PROMISE_MOTIFS.length];
                          return (
                            <article
                              key={i}
                              className={`group relative flex flex-col items-center justify-center overflow-hidden rounded-2xl px-4 py-3.5 text-center ring-1 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_14px_34px_rgba(0,0,0,0.07)] lg:flex-row lg:items-center lg:justify-start lg:gap-4 lg:px-4 lg:py-2.5 lg:text-left ${m.card}`}
                            >
                              {/* Top left while the card stands up; once it lies
                                  down the icon owns that corner, so it crosses
                                  to the right. */}
                              <span aria-hidden className={`absolute left-3.5 top-2.5 font-playfair text-[20px] font-semibold leading-none tracking-tight lg:left-auto lg:right-4 lg:top-1/2 lg:-translate-y-1/2 lg:text-[20px] ${m.numeral}`}>
                                {String(i + 1).padStart(2, '0')}
                              </span>

                              {/* The corner flourishes are for a card with room
                                  in its corners. Lying down there is none, and
                                  they landed on the icon and the words. */}
                              <span aria-hidden className="lg:hidden">
                                {i % 4 === 0 && (
                                  <span className={`absolute bottom-3 left-3 h-8 w-12 text-[#78814e]/35 ${DOT_GRID}`} />
                                )}
                                {i % 4 === 1 && (
                                  <span className={`absolute -bottom-8 -left-8 h-24 w-24 rounded-full ${m.blob}`} />
                                )}
                                {i % 4 === 2 && (
                                  <>
                                    <span className={`absolute -right-5 -top-5 h-14 w-14 rounded-full ${m.blob}`} />
                                    <span className="absolute right-2.5 top-2.5 h-6 w-6 rounded-tr-md border-r-2 border-t-2 border-[#c86a2e]/70" />
                                    <span className="absolute bottom-2.5 left-2.5 h-6 w-6 rounded-bl-md border-b-2 border-l-2 border-[#c86a2e]/70" />
                                  </>
                                )}
                                {i % 4 === 3 && (
                                  <>
                                    <span className={`absolute -right-4 bottom-6 h-14 w-12 [clip-path:polygon(50%_0%,100%_25%,100%_75%,50%_100%,0%_75%,0%_25%)] ${m.blob}`} />
                                    <span className={`absolute right-3 top-3 h-8 w-10 text-[#8a6a4c]/35 ${DOT_GRID}`} />
                                  </>
                                )}
                              </span>

                              {/* The disc belongs to the icon, so it travels
                                  with it into either layout. */}
                              <span className="relative flex shrink-0">
                                {i % 4 === 0 && (
                                  <span aria-hidden className={`absolute -right-4 top-1 h-12 w-12 rounded-full ${m.blob}`} />
                                )}
                                <span className={`relative flex h-10 w-10 items-center justify-center shadow-[0_3px_12px_rgba(0,0,0,0.06)] transition-transform duration-300 group-hover:scale-110 ${m.icon}`}>
                                  <Icon className="h-5 w-5" strokeWidth={1.6} />
                                </span>
                              </span>

                              <div className="relative flex min-w-0 flex-col items-center lg:items-start">
                                <h3 className="font-playfair text-[13.5px] font-semibold leading-tight text-[#2b2320] mt-2.5 lg:mt-0">{w.title}</h3>
                                <p className="mt-0.5 max-w-[15rem] text-[11.5px] leading-snug text-[#8a807a]">{w.desc}</p>
                                <span aria-hidden className={`mt-1.5 h-[2px] w-7 rounded-full ${m.rule}`} />
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {careList.length > 0 && (
                  <section className={`${INFO_CARD} flex flex-col`}>
                    {/* z-10 because the product photograph bleeds in from the right and
                        would otherwise paint over the last third of this line,
                        leaving it looking broken. */}
                    <span aria-hidden className="absolute inset-x-0 top-0 z-10 h-1 bg-[linear-gradient(90deg,#78814e_0%,#b08a5e_100%)]" />
                    {/* The product itself, bleeding in from the right and
                        fading into the ground so it reads as a backdrop rather
                        than a second gallery. Hidden on narrow screens, where
                        there is no width to spare for atmosphere. */}
                    {carePhoto && (
                      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] lg:block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={carePhoto} alt="" loading="lazy" className="h-full w-full object-cover object-center" />
                        {/* Fades on BOTH edges. Fading only the left left a
                            hard vertical cut where the photograph met the
                            shipping panel, which read as a crop rather than a
                            backdrop. */}
                        {/* The fades are tuned to the ground they sit on. That
                            used to be the page's linen; the panel is a white
                            card now, so fading to linen left a grey block
                            against the card's own white. */}
                        <span className="absolute inset-0 bg-[linear-gradient(90deg,#ffffff_0%,rgba(255,255,255,0.94)_20%,rgba(255,255,255,0.6)_48%,rgba(255,255,255,0.66)_72%,rgba(255,255,255,0.96)_92%,#ffffff_100%)]" />
                        <span className="absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,#ffffff_0%,transparent_100%)]" />
                        <span className="absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(0deg,#ffffff_0%,transparent_100%)]" />
                      </div>
                    )}

                    <div className="relative flex flex-1 flex-col">
                      <p className="font-playfair text-[15px] italic tracking-wide text-[#b08a5e]">Keep it fresh</p>
                      <h2 className="mt-1 font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl">How to care for it</h2>
                      <p className="mt-1.5 max-w-md text-[13px] text-[#a1948a] sm:text-sm">
                        A little care goes a long way in keeping it soft and long lasting.
                      </p>

                      {/* Same card design as "Why choose this" — motif card, index
                          numeral, icon disc, title + its category, accent rule. */}
                      <div className={`mt-4 grid flex-1 grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 sm:mt-5 lg:auto-rows-fr lg:gap-2 ${soloBand ? 'lg:grid-cols-2' : 'lg:grid-cols-1'}`}>
                        {careList.map((instruction, index) => {
                          const item = CARE_INSTRUCTIONS.find((c) => c.label === instruction);
                          const m = PROMISE_MOTIFS[index % PROMISE_MOTIFS.length];
                          return (
                            <article
                              key={index}
                              className={`group relative flex flex-col items-center justify-center overflow-hidden rounded-2xl px-4 py-3.5 text-center ring-1 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_14px_34px_rgba(0,0,0,0.07)] lg:flex-row lg:items-center lg:justify-start lg:gap-4 lg:px-4 lg:py-2.5 lg:text-left ${m.card}`}
                            >
                              <span aria-hidden className={`absolute left-3.5 top-2.5 font-playfair text-[20px] font-semibold leading-none tracking-tight lg:left-auto lg:right-4 lg:top-1/2 lg:-translate-y-1/2 lg:text-[20px] ${m.numeral}`}>
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span className="relative flex shrink-0">
                                <span className={`relative flex h-10 w-10 items-center justify-center shadow-[0_3px_12px_rgba(0,0,0,0.06)] transition-transform duration-300 group-hover:scale-110 ${m.icon}`}>
                                  {item ? <CareIcon paths={item.paths} className="h-5 w-5" /> : <span className="text-[13px] font-bold">{index + 1}</span>}
                                </span>
                              </span>
                              <div className="relative flex min-w-0 flex-col items-center lg:items-start">
                                <h3 className="mt-2.5 font-playfair text-[13.5px] font-semibold leading-tight text-[#2b2320] lg:mt-0">{instruction}</h3>
                                {/* The second line is the symbol's own category,
                                    which is real data — not invented advice. */}
                                {item && <p className="mt-0.5 max-w-[15rem] text-[11.5px] leading-snug text-[#8a807a]">{item.category}</p>}
                                <span aria-hidden className={`mt-1.5 h-[2px] w-7 rounded-full ${m.rule}`} />
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                  )}

                  {hasShipping && (
                  <section className={`${INFO_CARD} flex flex-col text-center`}>
                    <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#1f5faa_0%,#157f4a_100%)]" />
                    <style>{`
                      /* The dashes travel along the curve, from the first stop
                         to the last, so the line reads as a route rather than
                         a border. Offset only -- nothing reflows.
                         (No backticks in here: this is a JS template literal.) */
                      @keyframes m2cRouteFlow { to { stroke-dashoffset: -24 } }
                      .m2c-route { animation: m2cRouteFlow 1.4s linear infinite }
                      @media (prefers-reduced-motion: reduce) {
                        .m2c-route { animation: none }
                      }
                    `}</style>

                    <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#f4efe8] text-[#b08a5e]">
                      <Package className="h-4 w-4" />
                    </span>
                    <h2 className="mt-2.5 font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl">Getting it to you</h2>
                    <p className="mt-1.5 text-[13px] text-[#a1948a] sm:text-sm">Straight from the people who made it</p>

                    {/* Grows to fill the card so the journey + note sit centred
                        in the leftover height instead of leaving the card empty
                        below. */}
                    <div className="flex flex-1 flex-col justify-center">
                    {logisticsResult ? (() => {
                      // India live courier: carrier, rate and ETA are decided by
                      // Delhivery at checkout, so this journey stays neutral instead
                      // of quoting a specific mode/cost/day count.
                      const cost = courierPickerHidden
                        ? 'Calculated at checkout'
                        : logisticsResult.totalShippingCost === 0
                        ? 'Free shipping'
                        : `${formatPrice(getCurrency() === 'USD' ? convertINRtoUSD(logisticsResult.totalShippingCost) : logisticsResult.totalShippingCost)} shipping`;
                      const days = product.dispatchTimeline?.processingDays;
                      const stops = [
                        {
                          icon: Package,
                          pill: days ? `Day ${days}` : 'First',
                          title: 'Packed',
                          detail: days ? `${days} day${days === 1 ? '' : 's'} to dispatch` : 'Prepared for despatch',
                        },
                        {
                          icon: courierPickerHidden ? Truck : isSurfaceRegion() ? Truck : Plane,
                          pill: courierPickerHidden ? 'Courier partner' : logisticsResult.selectedTransport ? transportModeLabel(logisticsResult.selectedTransport, getRegion()) : 'Shipping',
                          title: 'On its way',
                          detail: cost,
                        },
                        {
                          icon: Home,
                          pill: courierPickerHidden ? 'At your door' : `Within ${logisticsResult.deliveryDays} days`,
                          title: 'At your door',
                          detail: courierPickerHidden ? 'Calculated at checkout' : `${logisticsResult.deliveryDays} day estimate`,
                        },
                      ];
                      return (
                        <div className="relative mx-auto mt-7 max-w-2xl sm:mt-8">
                          {/* The route, drawn behind the stops. Two gentle
                              curves so it wanders between them rather than
                              ruling a straight line through. */}
                          <svg
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 top-[3.15rem] h-8 w-full sm:top-[3.4rem]"
                            viewBox="0 0 300 30"
                            preserveAspectRatio="none"
                            fill="none"
                          >
                            <path
                              d="M 62 15 C 92 -2, 118 32, 150 15 C 182 -2, 208 32, 238 15"
                              stroke="#d8c9b8"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeDasharray="6 6"
                              className="m2c-route"
                            />
                          </svg>

                          <div className="relative grid grid-cols-3 gap-2">
                            {stops.map((s) => {
                              const Icon = s.icon;
                              return (
                                <div key={s.title} className="flex flex-col items-center text-center">
                                  <span className="rounded-full bg-[#f2e7d8] px-2.5 py-1 text-[10.5px] font-semibold text-[#8a6a44] sm:text-[11.5px]">
                                    {s.pill}
                                  </span>
                                  <span className="mt-2.5 flex h-14 w-14 items-center justify-center rounded-full bg-white text-[#b08a5e] shadow-[0_4px_16px_rgba(0,0,0,0.07)] sm:h-16 sm:w-16">
                                    <Icon className="h-6 w-6 sm:h-7 sm:w-7" />
                                  </span>
                                  <p className="mt-2.5 text-[13.5px] font-bold text-[#2b2320] sm:text-[15px]">{s.title}</p>
                                  <p className="mt-0.5 text-[11.5px] leading-snug text-[#a1948a] sm:text-[12.5px]">{s.detail}</p>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })() : null}

                    <p className="mx-auto mt-7 max-w-md text-[12.5px] leading-relaxed text-[#a1948a]">
                      Shipping method and final delivery estimate are confirmed in the purchase panel above.
                    </p>
                    </div>
                  </section>
                  )}
                </div>

                {/* The description first, on its own and centred. It is prose,
                    and prose does not want to be one of three narrow columns
                    beside a grid of symbols and a delivery route. */}
                {hasDescription && (
                  <div id="product-information" className={`scroll-mt-40 ${INFO_CARD}`}>
                    <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#b08a5e_0%,#e01a1b_100%)]" />
                    <span aria-hidden className="absolute -left-10 -bottom-10 h-32 w-32 rounded-full bg-[#b08a5e]/[0.05]" />
                    {/* The heading and the tags take a rail on the left so the
                        text is not asked to stretch across the whole row: one
                        paragraph at 1,400px is a 200-character line. */}
                    <section className="relative lg:grid lg:grid-cols-[15rem_1fr] lg:gap-10">
                      <div className="lg:pt-1">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#b08a5e]/[0.12] text-[#8a6a44]">
                            <Info className="h-4 w-4" strokeWidth={2.2} />
                          </span>
                          <div>
                            <h2 className="font-playfair text-xl font-semibold tracking-tight text-[#1a1a1a] sm:text-2xl">Product description</h2>
                            <p className="mt-0.5 text-[12.5px] text-[#a1948a]">What it is made of</p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 lg:mt-0">
                      {product.description && (
                        <>
                          {/* Two columns once it is open, one while it is
                              clamped -- line-clamp uses -webkit-box, which a
                              multi-column box cannot also be. */}
                          <p
                            ref={measureFullDesc}
                            className={`whitespace-pre-line text-[15px] leading-7 text-[#4a423c] sm:text-base ${showAllDetails ? 'lg:columns-2 lg:gap-12' : 'line-clamp-5'}`}
                          >
                            {product.description}
                          </p>
                          {/* Once it is open the clamp hides nothing, so the
                              measurement goes false -- `showAllDetails` keeps
                              "Read less" on screen to close it again. */}
                          {(fullDescClamped || showAllDetails) && (
                            <button
                              onClick={() => setShowAllDetails(!showAllDetails)}
                              className="mt-3 inline-flex items-center gap-1 text-[14px] font-semibold text-[#e01a1b] hover:text-[#c41617]"
                            >
                              {showAllDetails ? 'Read less' : 'Read more'}
                              <ChevronDown className={`h-4 w-4 transition-transform ${showAllDetails ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                        </>
                      )}
                      </div>
                    </section>
                    <div className="relative">
                      {product.tags && product.tags.length > 0 && (
                        <div className="mt-5 flex flex-wrap gap-2 border-t border-[#f2e9df] pt-4">
                          {product.tags.map((tag, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-[#e01a1b]/[0.06] px-3 py-1.5 text-[13px] font-semibold text-[#e01a1b]">
                              <Check className="h-3.5 w-3.5" /> {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ══ Offers & coupons ══
                    Led by the artwork. Both the offer and the coupon carry a
                    real banner in the database and neither was being shown --
                    the panel was two lines of small print, which is not how
                    anybody notices a discount. Two cards, each with its picture
                    on top, the discount stamped on it, and the code underneath.

                    The coupon falls back to a store-wide one when this
                    product's category has none of its own, because as it
                    stands no coupon in the database is flagged for a
                    category and the coupon half was simply never drawn. */}
                {(() => {
                  const offerArt = activeOffer
                    ? (promoOffers.find((o) => o.id === activeOffer.offerId)?.bannerImage || null)
                    : null;

                  // What the coupon would take off on top of the offer price.
                  // Only ever quoted for a category coupon, where the discount
                  // type and value are known figures rather than words parsed
                  // out of a sentence. Deliberately labelled as an estimate:
                  // whether it clears its own minimum-order and eligibility
                  // rules is decided server-side at checkout, not here.
                  const withCoupon = (() => {
                    if (!categoryCoupon || !offeredPrice) return null;
                    const off = categoryCoupon.discountType === 'PERCENTAGE'
                      ? offeredPrice * (categoryCoupon.discountValue / 100)
                      : categoryCoupon.discountValue;
                    const p = Math.round(Math.max(0, offeredPrice - off) * 100) / 100;
                    return p < offeredPrice ? p : null;
                  })();

                  const coupon = (() => {
                    if (categoryCoupon) {
                      return {
                        image: categoryCoupon.popupImage,
                        title: categoryCoupon.popupTitle || 'Coupon',
                        message: categoryCoupon.popupMessage || categoryCoupon.description || 'Enter this code in the cart.',
                        code: categoryCoupon.code,
                        badge: categoryCoupon.discountType === 'PERCENTAGE'
                          ? `${categoryCoupon.discountValue}% OFF`
                          : `${formatPrice(categoryCoupon.discountValue)} OFF`,
                      };
                    }
                    if (!promoCoupons.length) return null;
                    // Prefer one pointed at this product's category, else any.
                    const cat = (product.category || '').trim().toLowerCase();
                    const forCat = cat
                      ? promoCoupons.find((c) => {
                          try { return decodeURIComponent(c.link || '').toLowerCase().includes(cat); }
                          catch { return false; }
                        })
                      : undefined;
                    const chosen = forCat || promoCoupons[0];
                    if (!chosen) return null;
                    // The promotional feed carries a sentence, not fields --
                    // "Use code NEWFEST123 for 10% off" -- so the code and the
                    // rate are read out of it, and anything unreadable simply
                    // leaves that part off rather than guessing.
                    const code = (chosen.message.match(/code\s+([A-Z0-9][A-Z0-9_-]{2,})/i) || [])[1] || null;
                    const pct = (chosen.message.match(/(\d+)\s*%/) || [])[1] || null;
                    return {
                      image: chosen.image,
                      title: 'Coupon',
                      message: chosen.message,
                      code,
                      badge: pct ? `${pct}% OFF` : 'COUPON',
                    };
                  })();

                  if (!activeOffer && !coupon) return null;

                  const card = 'group relative flex flex-col overflow-hidden rounded-xl bg-white ring-1 ring-black/[0.06] transition-shadow duration-300 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] sm:rounded-2xl';
                  // 16/7 at full width made each banner 684x299 -- the two of
                  // them were the biggest thing on the page by a distance. A
                  // longer ratio in a narrower panel keeps the artwork legible
                  // without letting it run the page.
                  const art = 'relative block aspect-[21/6] w-full overflow-hidden bg-[linear-gradient(135deg,#fff4f0_0%,#fdeeee_100%)]';

                  return (
                    <div>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:mb-4">
                        <h2 className="inline-flex items-center gap-2.5 font-playfair text-lg font-semibold tracking-tight text-[#1a1a1a] sm:text-xl">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#e01a1b]/[0.09] text-[#e01a1b]">
                            <Tag className="h-4 w-4" />
                          </span>
                          Offers &amp; coupons
                        </h2>
                        {withCoupon != null && (
                          <span className="text-right">
                            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a1948a]">With the coupon below</span>
                            <span className="text-xl font-extrabold tabular-nums text-[#157f4a] sm:text-2xl">{formatPrice(withCoupon)}</span>
                            <span className="ml-1.5 text-[12px] text-gray-400">at checkout, if it applies</span>
                          </span>
                        )}
                      </div>

                      <div className={`grid grid-cols-1 gap-3 sm:gap-4 ${activeOffer && coupon ? 'md:grid-cols-2' : 'lg:max-w-xl'}`}>
                        {activeOffer && (
                          <div className={card}>
                            <div className={art}>
                              {offerArt ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={offerArt} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.04]" />
                              ) : (
                                <span className="flex h-full w-full items-center justify-center font-playfair text-3xl font-semibold text-[#e01a1b]/70">
                                  {activeOffer.title}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-1 flex-col gap-1 p-3 sm:p-4">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="rounded-md bg-[#e01a1b] px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-white">{activeOffer.badge}</span>
                                <span className="text-[15px] font-bold text-[#1a1a1a] sm:text-base">{activeOffer.title}</span>
                                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200">Already applied</span>
                                {offerEnds && <span className="text-[11.5px] font-bold text-[#c41617]">{offerEnds}</span>}
                              </div>
                              <p className="text-[13.5px] leading-snug text-gray-500 sm:text-sm">
                                {activeOffer.description || 'Included in the price shown above.'}
                              </p>
                              {hasOfferSaving && (
                                <p className="mt-auto pt-2 text-[15px] font-bold tabular-nums text-[#157f4a]">
                                  &minus;{formatPrice(currentPrice - offeredPrice)}
                                  <span className="ml-1 text-[12px] font-medium text-gray-400">/ {product?.uom || 'unit'}</span>
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {coupon && (
                          <div className={card}>
                            <div className={art}>
                              {coupon.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={coupon.image} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.04]" />
                              ) : (
                                <span className="flex h-full w-full items-center justify-center font-playfair text-3xl font-semibold text-[#157f4a]/70">
                                  {coupon.title}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-1 flex-col gap-1 p-3 sm:p-4">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="rounded-md bg-[#157f4a] px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-white">{coupon.badge}</span>
                                <span className="text-[15px] font-bold text-[#1a1a1a] sm:text-base">{coupon.title}</span>
                              </div>
                              <p className="text-[13.5px] leading-snug text-gray-500 sm:text-sm">{coupon.message}</p>
                              {coupon.code && (
                                <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                                  <code className="rounded-lg border border-dashed border-[#e01a1b]/45 bg-[#fff7f5] px-3.5 py-2 text-[14px] font-bold tracking-[0.18em] text-[#e01a1b]">{coupon.code}</code>
                                  <button
                                    type="button"
                                    onClick={() => { try { navigator.clipboard?.writeText(coupon.code!); showSuccessToast('Copied', `Coupon ${coupon.code} copied`); } catch { /* clipboard unavailable */ } }}
                                    className="rounded-lg bg-[#e01a1b] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#c41617]"
                                  >
                                    Copy
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}


              </div>
            );
          })()}

          {/* Customer Reviews */}
          {showReviews && (
            <div id="customer-reviews" className="mt-8 scroll-mt-48 border-t border-[#eadfd4] pt-6 sm:mt-10 sm:pt-8">
              <div className="flex items-center justify-between gap-3 mb-4 sm:mb-5">
                <h3 className="font-playfair text-lg sm:text-xl font-semibold text-[#1a1a1a] tracking-tight">Customer Reviews</h3>
                <button
                  onClick={() => { window.location.href = userAuthService.isAuthenticated() ? '/order' : '/login'; }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#e01a1b] px-3.5 py-1.5 text-xs sm:text-[13px] font-semibold text-white hover:bg-[#c41617] transition-colors shrink-0"
                >
                  {userAuthService.isAuthenticated() ? 'Write a Review' : 'Sign in to Review'}
                </button>
              </div>
              {loadingReviews ? (
                /* Skeleton mirrors the review list — 3 review-row placeholders. */
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="border-b border-gray-100 pb-4 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gray-200 rounded-full animate-pulse" />
                        <div className="space-y-1">
                          <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
                          <div className="h-3 w-20 bg-gray-100 rounded animate-pulse" />
                        </div>
                      </div>
                      <div className="h-4 w-full bg-gray-100 rounded animate-pulse" />
                      <div className="h-4 w-3/4 bg-gray-100 rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : reviews.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-10">
                  <div className="mb-3 flex items-center gap-1.5">
                    {/* In colour, not muted. Everywhere else on this page a face
                        stands in for a rating, and `muted` is how an unselected
                        one steps back. Here there is no rating to report -- these
                        are a preview of the one-tap question the button below
                        opens -- so greying them just made the invitation look
                        disabled. */}
                    {([5, 4, 3, 2, 1] as FaceValue[]).map((v) => <FaceIcon key={v} value={v} className="h-7 w-7" />)}
                  </div>
                  <p className="text-sm font-semibold text-gray-700">No reviews yet</p>
                  <p className="mt-1 text-xs text-gray-400">Be the first customer to review this product.</p>
                  <button
                    onClick={() => { window.location.href = userAuthService.isAuthenticated() ? '/order' : '/login'; }}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#e01a1b] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#c41617] transition-colors"
                  >
                    {userAuthService.isAuthenticated() ? 'Write a Review' : 'Sign in to Review'}
                  </button>
                </div>
              ) : (
                <>
                  {/* Summary across the top, reviews underneath -- the section
                      used to be a tall narrow chart on the left with a single
                      column of full-width rows beside it, so one short review
                      sat alone on a 900px line and the chart's own column was
                      mostly air below it. */}
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
                    {/* Ratings — a compact card on the right (desktop) / above the feed (mobile) */}
                    <div className="lg:order-2">{renderRatings('sidebar')}</div>
                    {/* Review feed — the primary content, left/main column */}
                    <div className="min-w-0 space-y-4 sm:space-y-5 lg:order-1">
                    {/* Old full-width summary band, superseded by the sidebar card above. */}
                    {false && (() => {
                      const total = reviews.length;
                      const avg = total ? reviews.reduce((s, r) => s + (r.rating || 0), 0) / total : 0;
                      const withText = reviews.filter((r) => r.comment && r.comment.trim()).length;
                      const dist = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => Math.round(r.rating || 0) === star).length }));
                      const ratings = reviews.map((r) => r.rating || 0);
                      const loved = lovedPercent(ratings);
                      // Two separate gates, and both have to pass before a face goes up.
                      //
                      //  wellRated  - is this a score we would advertise at all? Without
                      //               it, six reviews averaging 3.2 with one 5 among them
                      //               still put a big happy face over "1 loved this".
                      //  enough     - a percentage needs a sample before it means
                      //               anything. "100% loved it" off one review reads as
                      //               invented, which is the same argument the listing
                      //               badge uses for showing a count instead.
                      const wellRated = positiveFace(avg) !== null;
                      const enough = total >= 5;
                      const showPct = wellRated && enough && loved >= 50;


                      return (
                        <div>
                          <div className="relative border-b border-[#eadfd4] pb-5 sm:pb-6">
                           {/* The top face, very faint, sitting behind the
                               figures -- the section had no mark of its own and
                               read as a settings panel.

                               It is clipped by a box of its own rather than by
                               the band, because the band holds the sort list
                               and that has to be allowed to hang below it. */}
                           <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                             <span className="absolute -right-6 -top-8 block opacity-[0.06]">
                               <FaceIcon value={5} className="h-40 w-40" />
                             </span>
                           </span>
                           <div className="flex flex-col items-center gap-4 text-center">
                            <div className="relative">
                            {/* A fixed heading, so the top of this card is the same
                                thing every time. It used to change shape with the data:
                                a percentage, or a single word, or nothing at all. The
                                word was the confusing one -- with one review the heading
                                read "Loved it" and the very first bar underneath read
                                "Loved it  1", so the card said the same thing twice and
                                looked like a control rather than a summary.
                                The percentage stays: it says something the bars do not,
                                which is one figure for the whole product. */}
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a1948a]">Ratings</p>
                            {showPct && (
                              <div className="mt-2">
                                <div className="flex items-center gap-2.5">
                                  {/* Always the top face: the number beside it counts
                                      that face and nothing else. Taking it from the
                                      average let the Liked-it face sit next to "loved". */}
                                  <FaceIcon value={5} className="h-11 w-11 shrink-0" />
                                  <span className="text-3xl font-extrabold leading-none text-gray-900 sm:text-4xl">
                                    <span className="tabular-nums">{loved}</span>%
                                  </span>
                                </div>
                                <div className="mt-1.5 text-[13px] font-semibold text-gray-700">loved it</div>
                              </div>
                            )}
                            <div className="mt-1.5 text-[12px] text-gray-500">{total} rating{total === 1 ? '' : 's'}{withText > 0 ? ` • ${withText} review${withText === 1 ? '' : 's'}` : ''}</div>
                            </div>

                            {/* ── The five faces ───────────────────────────
                                One face per RATING, not one per review. A face
                                for every review is fine at thirty and absurd at
                                two thousand -- it made the row a texture rather
                                than a control. Five, evenly spaced, each with
                                its word and its count, and each one a filter.
                                This also replaces the chip row that sat under
                                the band repeating the same five words. */}
                            <div className="relative mx-auto w-full max-w-2xl">
                              <div className="grid grid-cols-5 gap-1 sm:gap-2">
                                {dist.map(({ star, count }) => {
                                  const v = star as FaceValue;
                                  const active = reviewStar === star;
                                  const empty = count === 0;
                                  return (
                                    <button
                                      key={star}
                                      type="button"
                                      disabled={empty}
                                      onClick={() => { snapshotReviews(); setFacePulse((n) => n + 1); setReviewStar(active ? 0 : star); }}
                                      title={empty ? `No ${FACE_LABELS[v]} reviews yet` : `${FACE_LABELS[v]} — show only these`}
                                      aria-label={`${FACE_LABELS[v]} — show only these`}
                                      aria-pressed={active}
                                      className={`m2c-face-wobble group/face flex flex-col items-center gap-1.5 rounded-xl px-1 py-2 transition-all duration-300 ${
                                        empty ? 'cursor-default opacity-30' : 'hover:bg-white/70'
                                      } ${active ? 'bg-white shadow-[0_2px_12px_rgba(0,0,0,0.06)] ring-1 ring-[#e01a1b]/25' : ''}`}
                                    >
                                      <span
                                        key={active ? `p${facePulse}` : `s${star}`}
                                        className={`inline-block transition-transform duration-300 ${active ? 'm2c-face-bounce' : 'group-hover/face:scale-110'}`}
                                      >
                                        <FaceIcon value={v} className="h-8 w-8 sm:h-9 sm:w-9" />
                                      </span>
                                      <span className={`text-[10px] font-semibold leading-tight sm:text-[11px] ${active ? 'text-[#e01a1b]' : 'text-[#6b625b]'}`}>
                                        {FACE_LABELS[v]}
                                      </span>
                                      <span className={`text-[12px] font-bold leading-none tabular-nums ${active ? 'text-[#e01a1b]' : 'text-[#1a1a1a]'}`}>
                                        {count}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="mt-3 text-[12.5px] text-[#6b625b]">
                                <span className="font-semibold tabular-nums text-[#1a1a1a]">{total}</span> {total === 1 ? 'person' : 'people'}
                                {dist[0].count > 0 && (
                                  <> &middot; <span className="font-semibold tabular-nums text-[#1a1a1a]">{dist[0].count}</span> loved it</>
                                )}
                                {reviewStar !== 0 && (
                                  <>
                                    {' '}&middot;{' '}
                                    <button
                                      onClick={() => { snapshotReviews(); setReviewStar(0); }}
                                      className="font-semibold text-[#e01a1b] hover:text-[#c41617]"
                                    >
                                      showing {FACE_LABELS[reviewStar as FaceValue]}{' '}&mdash; clear
                                    </button>
                                  </>
                                )}
                              </p>
                            </div>
                           </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Review toolbar: count + search + sort on one axis ── */}
                    <div className="flex flex-col gap-3 border-b border-[#eadfd4] pb-5 sm:flex-row sm:items-center sm:justify-between sm:pb-6">
                      <p className="text-[15px] font-semibold text-[#1a1a1a]">
                        <span className="tabular-nums">{filteredReviews.length}</span> Review{filteredReviews.length === 1 ? '' : 's'}
                      </p>
                      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                        <div className="relative sm:w-64">
                          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                          <input
                            value={reviewSearch}
                            onChange={(e) => setReviewSearch(e.target.value)}
                            placeholder="Search reviews..."
                            className="w-full rounded-full border border-[#eadfd4] bg-white py-2 pl-9 pr-3 text-sm text-gray-700 transition placeholder:text-gray-400 focus:border-[#e01a1b]/40 focus:outline-none focus:ring-2 focus:ring-[#e01a1b]/15"
                          />
                        </div>
                        <ReviewSortSelect
                          value={reviewSort}
                          options={REVIEW_SORTS}
                          onChange={(v) => { snapshotReviews(); setReviewSort(v as typeof reviewSort); }}
                        />
                      </div>
                    </div>

                    {/* ── Photographs from customers ──────────────────────
                        Every review's pictures, gathered into one strip. They
                        were only visible by scrolling to the review that
                        happened to carry them, which is the least likely way
                        anyone finds a photograph of the thing they are about
                        to buy. Real data: nothing is drawn when nobody has
                        sent a picture. */}
                    {(() => {
                      const shots = reviews.flatMap((r) => (r.images || []).filter(Boolean).map((src) => ({ src, id: r.id })));
                      if (shots.length === 0) return null;
                      const all = shots.map((x) => x.src);
                      return (
                        <div className="border-b border-[#eadfd4] pb-5 sm:pb-6">
                          <div className="mb-3 flex items-baseline gap-2">
                            <h4 className="text-[13px] font-bold uppercase tracking-[0.12em] text-[#a1948a]">Photos from customers</h4>
                            <span className="text-[12px] tabular-nums text-gray-400">{shots.length}</span>
                          </div>
                          <div className="scrollbar-hide -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
                            {shots.slice(0, 12).map((shot, i) => (
                              <button
                                key={shot.id + '-' + i}
                                onClick={() => setLightbox({ images: all, index: i })}
                                className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl ring-1 ring-gray-200 transition-all hover:ring-[#e01a1b]/50 sm:h-24 sm:w-24"
                              >
                                <Image src={shot.src} alt="" fill sizes="96px" className="object-cover transition-transform duration-500 group-hover:scale-110" />
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── The reviews themselves ── */}
                    <div className="min-w-0">

                      {/* The quotations. Narrow and centred when there are few
                          of them -- a single quotation across a 1,382px row is
                          a third of a line of text and two-thirds of nothing. */}
                      {filteredReviews.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-8">No reviews match your filters.</p>
                      ) : (
                        /* A single-column feed: every review is one full-width
                           row — avatar left, what they said in the middle, the
                           Helpful action on the right — separated by thin rules.
                           A professional product-review list, not a wall of
                           floating cards. */
                        <div className="max-h-[min(68vh,640px)] divide-y divide-[#eadfd4] overflow-y-auto pr-1 [scrollbar-width:thin]">
                          {filteredReviews.slice(0, 8).map((review) => {
                            const countryName = getCountryName(review.user?.country);
                            const flag = countryName ? getCountryFlag(review.user?.country) : '';
                            const imgs = (review.images || []).filter(Boolean);
                            const helped = helpfulIds.has(review.id);
                            const face = (Math.min(5, Math.max(1, Math.round(review.rating))) || 3) as FaceValue;
                            const said = (review.comment || '').trim();
                            return (
                              <div
                                key={review.id}
                                ref={(el) => {
                                  if (el) reviewRefs.current.set(review.id, el);
                                  else reviewRefs.current.delete(review.id);
                                }}
                                className="group/rev flex gap-3.5 py-5 sm:gap-5 sm:py-6"
                              >
                                {/* LEFT — the reviewer */}
                                <div className="shrink-0">
                                  {review.user?.image ? (
                                    <Image src={review.user.image} alt="" width={44} height={44} className="h-10 w-10 rounded-full object-cover ring-1 ring-black/5 sm:h-11 sm:w-11" />
                                  ) : (
                                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f2ece5] text-sm font-bold text-[#a1948a] sm:h-11 sm:w-11">
                                      {(review.user?.name || 'C')[0].toUpperCase()}
                                    </span>
                                  )}
                                </div>

                                {/* CENTRE — sentiment, then words, then who + when */}
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                    <span className="inline-flex items-center gap-1.5">
                                      <FaceIcon value={face} className="h-5 w-5 shrink-0" />
                                      <span className="text-[13px] font-semibold text-[#2b2320]">{FACE_LABELS[face]}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
                                      <Check className="h-3 w-3" /> Verified
                                    </span>
                                  </div>

                                  {said && (
                                    <blockquote className="mt-2 whitespace-pre-line font-playfair text-[16px] leading-relaxed text-[#2b2320] sm:text-[17px]">
                                      {said}
                                    </blockquote>
                                  )}

                                  {imgs.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {imgs.map((src, idx) => (
                                        <button
                                          key={idx}
                                          onClick={() => setLightbox({ images: imgs, index: idx })}
                                          className="group/img relative h-16 w-16 overflow-hidden rounded-lg ring-1 ring-gray-200 transition-all hover:ring-[#e01a1b]/50"
                                        >
                                          <Image src={src} alt="" fill sizes="64px" className="object-cover transition-transform duration-300 group-hover/img:scale-110" />
                                        </button>
                                      ))}
                                    </div>
                                  )}

                                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[#a1948a]">
                                    <span className="font-semibold text-[#4a423c]">{review.user?.name || 'Customer'}</span>
                                    <span aria-hidden className="text-[#d8cabb]">&middot;</span>
                                    <span>{new Date(review.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                    {countryName && (
                                      <>
                                        <span aria-hidden className="text-[#d8cabb]">&middot;</span>
                                        <span>{flag ? `${flag} ` : ''}{countryName}</span>
                                      </>
                                    )}
                                  </div>
                                </div>

                                {/* RIGHT — Helpful */}
                                <div className="shrink-0 self-start">
                                  <button
                                    onClick={() => setHelpfulIds((prev) => { const n = new Set(prev); if (n.has(review.id)) n.delete(review.id); else n.add(review.id); return n; })}
                                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${helped ? 'border-[#e01a1b]/30 bg-[#fff1f1] text-[#e01a1b]' : 'border-[#e6dcd2] text-[#6b625b] hover:border-[#d6c8bb] hover:text-[#1a1a1a]'}`}
                                  >
                                    <ThumbsUp className={`h-3.5 w-3.5 ${helped ? 'fill-[#e01a1b]' : ''}`} /> <span className="hidden sm:inline">{helped ? 'Marked helpful' : 'Helpful'}</span>
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* View all — only when the feed is capped */}
                      {filteredReviews.length > 8 && (
                        <div className="mt-4 border-t border-[#eadfd4] pt-4 flex justify-center">
                          <button
                            onClick={() => setShowAllModal(true)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-[#e6dcd2] px-5 py-2 text-sm font-semibold text-[#5f5550] hover:border-[#e01a1b]/40 hover:text-[#e01a1b] hover:bg-[#fff1f1] transition-colors"
                          >
                            View all reviews <span className="text-gray-400">({filteredReviews.length})</span>
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                    </div>
                  </div>

                  {/* ── View-all modal: the compact rating summary + the full,
                      searchable, sortable review list ── */}
                  {showAllModal && createPortal(
                    <div className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-4">
                      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowAllModal(false)} />
                      <div className="relative flex h-[88vh] w-[92vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                        {/* header + compact ratings */}
                        <div className="flex items-start justify-between gap-3 border-b border-[#eadfd4] px-5 py-4 sm:px-6">
                          <div className="min-w-0 flex-1">
                            <h3 className="font-playfair text-lg font-semibold tracking-tight text-[#1a1a1a] sm:text-xl">Customer Reviews</h3>
                            <div className="mt-3">{renderRatings('modal')}</div>
                          </div>
                          <button onClick={() => setShowAllModal(false)} aria-label="Close" className="shrink-0 rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700">
                            <X className="h-5 w-5" />
                          </button>
                        </div>
                        {/* toolbar */}
                        <div className="flex flex-col gap-2.5 border-b border-[#eadfd4] px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                          <p className="text-[14px] font-semibold text-[#1a1a1a]">
                            <span className="tabular-nums">{filteredReviews.length}</span> Review{filteredReviews.length === 1 ? '' : 's'}
                          </p>
                          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                            <div className="relative sm:w-64">
                              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                              <input
                                value={reviewSearch}
                                onChange={(e) => setReviewSearch(e.target.value)}
                                placeholder="Search reviews..."
                                className="w-full rounded-full border border-[#eadfd4] bg-white py-2 pl-9 pr-3 text-sm text-gray-700 transition placeholder:text-gray-400 focus:border-[#e01a1b]/40 focus:outline-none focus:ring-2 focus:ring-[#e01a1b]/15"
                              />
                            </div>
                            <ReviewSortSelect
                              value={reviewSort}
                              options={REVIEW_SORTS}
                              onChange={(v) => { setReviewSort(v as typeof reviewSort); }}
                            />
                          </div>
                        </div>
                        {/* all reviews */}
                        <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6">
                          {filteredReviews.length === 0 ? (
                            <p className="py-10 text-center text-sm text-gray-400">No reviews match your filters.</p>
                          ) : (
                            <div className="divide-y divide-[#eadfd4]">
                              {filteredReviews.map((review) => renderReviewRow(review, false))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>,
                    document.body,
                  )}
                </>
              )}
            </div>
          )}

          {/* Review image lightbox */}
          {lightbox && (
            <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
              <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/80 hover:text-white p-2" aria-label="Close"><X className="w-6 h-6" /></button>
              {lightbox.images.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); setLightbox((l) => l ? { ...l, index: (l.index - 1 + l.images.length) % l.images.length } : l); }} className="absolute left-3 sm:left-6 text-white/80 hover:text-white p-2" aria-label="Previous"><ChevronLeft className="w-7 h-7" /></button>
              )}
              <div className="relative max-w-3xl w-full h-[70vh] sm:h-[80vh]" onClick={(e) => e.stopPropagation()}>
                <Image src={lightbox.images[lightbox.index]} alt="" fill sizes="90vw" className="object-contain" />
              </div>
              {lightbox.images.length > 1 && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); setLightbox((l) => l ? { ...l, index: (l.index + 1) % l.images.length } : l); }} className="absolute right-3 sm:right-6 text-white/80 hover:text-white p-2" aria-label="Next"><ChevronRight className="w-7 h-7" /></button>
                  <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-white/70 text-xs font-medium">{lightbox.index + 1} / {lightbox.images.length}</div>
                </>
              )}
            </div>
          )}

          {/* Manufacturer "Meet the Maker" modal */}
          {showMakerModal && hasManufacturerInfo(product.manufacturerInfo) && (() => {
            const m = product.manufacturerInfo!;
            const name = manufacturerDisplayName(m);
            return (
              <div
                className="m2c-mk-back fixed inset-0 z-[100] flex items-center justify-center bg-[#1a120c]/70 p-4 backdrop-blur-[4px]"
                onClick={() => setShowMakerModal(false)}
              >
                <style>{`
                  @keyframes m2cMkBack { from { opacity: 0 } to { opacity: 1 } }
                  @keyframes m2cMkCard {
                    from { opacity: 0; transform: translateY(28px) scale(0.94) }
                    to   { opacity: 1; transform: none }
                  }
                  /* The photograph settles out of a slow zoom rather than
                     appearing at rest -- the one bit of motion that is about
                     the subject rather than the box around it. */
                  @keyframes m2cMkZoom { from { transform: scale(1.14) } to { transform: scale(1) } }
                  @keyframes m2cMkRise {
                    from { opacity: 0; transform: translateY(12px) }
                    to   { opacity: 1; transform: none }
                  }
                  .m2c-mk-back { animation: m2cMkBack 200ms ease-out }
                  .m2c-mk-card { animation: m2cMkCard 400ms cubic-bezier(0.22, 1, 0.36, 1) }
                  /* Anchored to the top, or the zoom lifts the head out of
                     frame for the second the animation is running -- which is
                     the crop this frame was widened to avoid. */
                  .m2c-mk-zoom { transform-origin: 50% 0%; animation: m2cMkZoom 1400ms cubic-bezier(0.22, 1, 0.36, 1) both }
                  /* backwards, so each line is invisible during its delay
                     instead of flashing into place first. */
                  .m2c-mk-1 { animation: m2cMkRise 380ms ease-out 170ms backwards }
                  .m2c-mk-2 { animation: m2cMkRise 380ms ease-out 240ms backwards }
                  .m2c-mk-3 { animation: m2cMkRise 380ms ease-out 320ms backwards }
                  .m2c-mk-4 { animation: m2cMkRise 380ms ease-out 400ms backwards }
                  @media (prefers-reduced-motion: reduce) {
                    .m2c-mk-back, .m2c-mk-card, .m2c-mk-zoom,
                    .m2c-mk-1, .m2c-mk-2, .m2c-mk-3, .m2c-mk-4 { animation: none }
                  }
                `}</style>

                <div
                  className="m2c-mk-card relative w-full max-w-md overflow-hidden rounded-[1.75rem] bg-white shadow-[0_34px_90px_rgba(0,0,0,0.45)] ring-1 ring-black/10"
                  onClick={(ev) => ev.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Manufacturer profile"
                >
                  {/* The portrait, full width, with the name written on it. */}
                  <div className="relative h-72 overflow-hidden bg-[#2b2320] sm:h-80">
                    {m.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.photo} alt={name || 'Manufacturer'} className="m2c-mk-zoom h-full w-full object-cover object-top" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#e8262a_0%,#a31314_100%)] text-white/50">
                        <User className="h-20 w-20" strokeWidth={1.2} />
                      </div>
                    )}
                    <span aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(20,14,10,0.35)_0%,transparent_32%,rgba(20,14,10,0.5)_68%,rgba(20,14,10,0.92)_100%)]" />

                    <button
                      onClick={() => setShowMakerModal(false)}
                      className="absolute right-3.5 top-3.5 rounded-full bg-black/25 p-1.5 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/45 hover:text-white"
                      aria-label="Close"
                    >
                      <X className="h-4.5 w-4.5" />
                    </button>

                    <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                      <p className="m2c-mk-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/80">
                        <span aria-hidden className="h-px w-5 bg-[#e8262a]" />
                        The hands behind this product
                      </p>
                      {name && (
                        <h3 className="m2c-mk-2 mt-1.5 font-playfair text-[25px] font-semibold leading-tight tracking-tight text-white sm:text-[27px]">
                          {name}
                        </h3>
                      )}
                    </div>
                  </div>

                  <div className="px-5 pb-6 pt-5 sm:px-6">
                    {(m.role?.trim() || m.experience?.trim()) && (
                      <div className="m2c-mk-3 flex flex-wrap gap-2">
                        {m.role && m.role.trim() && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e01a1b]/[0.07] px-3.5 py-1.5 text-xs font-semibold text-[#e01a1b] ring-1 ring-[#e01a1b]/15">
                            <Award className="h-3.5 w-3.5" /> {m.role}
                          </span>
                        )}
                        {m.experience && m.experience.trim() && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f4efe8] px-3.5 py-1.5 text-xs font-semibold text-[#6b5240] ring-1 ring-[#e8ddd0]">
                            <Clock className="h-3.5 w-3.5" /> {m.experience}
                          </span>
                        )}
                      </div>
                    )}

                    {m.description && m.description.trim() && (
                      <div className="m2c-mk-4 mt-4 border-t border-[#f2e9df] pt-4">
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#b3a99f]">In their words</p>
                        <p className="max-h-[32vh] overflow-y-auto whitespace-pre-line text-[14.5px] leading-relaxed text-[#4a423c]">{m.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* You may also like — same-category products (hidden when none) */}
          {relatedProducts.length > 0 && (
            <div className="mt-6 sm:mt-8">
              <div className="flex items-end justify-between gap-4 mb-4 sm:mb-6">
                <div>
                  <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e01a1b] mb-1">
                    <span className="h-px w-6 bg-[#e01a1b]" /> More to explore
                  </span>
                  <h3 className="font-playfair text-xl sm:text-2xl font-semibold text-[#1a1a1a] tracking-tight">You may also like</h3>
                </div>
                <a
                  href={`/products?category=${encodeURIComponent(product.category || '')}`}
                  className="hidden sm:inline-flex items-center gap-1 text-sm font-semibold text-[#e01a1b] hover:text-[#c41617] whitespace-nowrap"
                >
                  View all
                  <ChevronDown className="w-4 h-4 -rotate-90" />
                </a>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {relatedProducts.map((p) => (
                  <ProductCard key={p.id} product={p} variant="showcase" />
                ))}
              </div>
            </div>
          )}

        </div >

        {/* Featured products — full-width section, same as the home page */}
        <FeaturedProducts />
      </div >
    </>
  );
};

export default ProductDetail;
