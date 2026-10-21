'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import ProductCard from '@/components/WebSite/ProductCard/ProductCard';
import { CTA_PILL, CTA_PILL_ICON } from '@/components/WebSite/Shared/ctaPill';
import { publicProductService, PublicProduct } from '@/services/publicProductService';

/**
 * Featured Products.
 *
 * Three things were wrong with the previous version and all three are fixed
 * here, without touching any service call.
 *
 *  1. Dead space. Cards were a fixed width (xl:w-64 = 256px) inside a
 *     max-w-420 (1680px) container, so 4 cards + 3 gaps came to 1120px and
 *     left ~496px of empty row — roughly a third of the section. They are now
 *     grid columns, so they stretch to whatever width is available.
 *
 *  2. Layout snap on load. The old skeleton used `grid xl:grid-cols-4`, which
 *     DOES stretch, so cards were ~380px while loading and snapped to 256px
 *     the moment the fetch resolved. The skeleton below now mirrors the loaded
 *     grid exactly — same columns, same gaps, same image ratio.
 *
 *  3. No entrance. The section used <Reveal>, which carries a 1.4s fail-safe
 *     that fires on a timer regardless of scroll position — so by the time you
 *     scrolled here it had already revealed and nothing animated.
 *
 * The entrance: each card starts under a panel of cloth with a rolled edge at
 * its top. The roll travels top-to-bottom and the cloth follows it off the
 * card, uncovering the product — a bolt of fabric unrolled onto a table.
 * Cards stagger so it reads left-to-right as a wave, the same language as the
 * hero's weave transition.
 *
 * The header is deliberately quieter than Top Selling / Best Sellers below it:
 * eyebrow, a hairline running the width of the row, and a text link whose rule
 * draws itself on hover — instead of a third identical red pill button. The
 * dot-grid SectionBackdrop was dropped here for the same reason; it was one of
 * the main things making all three product sections look like one section
 * printed three times.
 */

/** How many products the row asks for, and shows. */
const FEATURED_COUNT = 6;

/** How long one card takes to unroll. */
const UNROLL_MS = 950;

/** Gap between consecutive cards starting, giving a left-to-right wave. */
const UNROLL_STAGGER_MS = 170;

/**
 * When to fire.
 *
 * The first version used threshold 0.15 with a -8% bottom margin, which
 * triggered the moment the top sliver of the grid appeared — so the animation
 * ran out while the reader was still scrolling toward it and they arrived at
 * the finished state every time. Requiring 40% of the grid inside a viewport
 * shortened by 15% means it starts when the cards are properly on screen and
 * being looked at.
 */
const REVEAL_THRESHOLD = 0.4;
const REVEAL_MARGIN = '0px 0px -15% 0px';

/**
 * The linen ground. NoticeBoard above ends on white and BrandPromo below is
 * white throughout, so a warm panel between them reads as a deliberate surface
 * rather than a colour drift — and it is what lets the white cards read as
 * objects sitting on something instead of dissolving into the page.
 */
const GROUND =
  'border-y border-[#ece0d2] bg-linear-to-b from-[#faf6f0] via-[#f4ebe0] to-[#f8f2ea]';

/**
 * Back to the site's full 1680px for the six-across row.
 *
 * At 1440px, six columns would leave each card near 210px — narrower than the
 * 256px that made the names look lost in the first place. Full width with a
 * tighter 20px gutter puts them at about 252px, and the showcase card's larger
 * name and quieter price carry at that size where the old one did not.
 */
const SHELL = 'max-w-420';

export default function FeaturedProducts() {
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const fetchFeaturedProducts = async () => {
      setIsLoading(true);
      try {
        const response = await publicProductService.getFeaturedProducts(FEATURED_COUNT);
        if (response.success && response.data) {
          // Only ever the real, admin-flagged featured products — the row shows
          // however many exist (up to FEATURED_COUNT) and nothing when none do.
          setProducts(response.data.items);
        }
      } catch (error) {
        console.error('Error fetching featured products:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchFeaturedProducts();
  }, []);

  // Arrive at the section and the cloth draws back off the products.
  //
  // Watches the grid rather than the <section>: the section starts at the
  // header, so a section-level observer fires while the cards are still below
  // the fold and the animation plays where nobody can see it.
  //
  // The class is added imperatively so firing costs no re-render, and the
  // observer disconnects immediately — it plays once and stays played.
  //
  // Re-runs once products arrive, because the grid does not exist during the
  // loading state.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    // Without IntersectionObserver the cloth would never retract and the
    // products would stay covered, so reveal immediately instead.
    if (typeof IntersectionObserver === 'undefined') {
      grid.classList.add('is-unrolled');
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            grid.classList.add('is-unrolled');
            io.disconnect();
          }
        }
      },
      { threshold: REVEAL_THRESHOLD, rootMargin: REVEAL_MARGIN }
    );

    io.observe(grid);
    return () => io.disconnect();
  }, [products.length]);

  if (isLoading) {
    // Mirrors the loaded section exactly — same container, same masthead
    // shape, same grid columns and gaps, same 5/4 image ratio as ProductCard.
    // Anything that differs here shows up as a jump when the fetch resolves.
    return (
      <section className={`${GROUND} pt-3 pb-8 font-sans sm:pt-4 sm:pb-10 lg:pt-5 lg:pb-14`}>
        <div className={`mx-auto ${SHELL} px-3 sm:px-4 md:px-6 lg:px-8`}>
          <div className="mb-3 lg:mb-4">
            <div className="flex items-center justify-center gap-4 lg:justify-start">
              <div className="h-3 w-28 animate-pulse rounded bg-[#e6dacc]" />
              <div className="hidden h-px flex-1 bg-[#ece0d2] lg:block" />
              <div className="hidden h-3 w-36 animate-pulse rounded bg-[#e6dacc] lg:block" />
            </div>
            <div className="mx-auto mt-3 h-9 w-56 animate-pulse rounded bg-[#e6dacc] md:h-11 md:w-80 lg:mx-0" />
            <div className="mx-auto mt-2.5 h-4 w-full max-w-md animate-pulse rounded bg-[#eee4d8] lg:mx-0" />
          </div>

          <div className="grid grid-cols-2 gap-4 pt-5 sm:gap-5 md:grid-cols-3 md:gap-6 xl:grid-cols-6 xl:gap-5">
            {Array.from({ length: FEATURED_COUNT }).map((_, i) => (
              <div
                key={i}
                className="overflow-hidden rounded-[16px] bg-white ring-1 ring-[#e3d7c9] shadow-[0_10px_26px_-18px_rgba(74,50,38,0.45)]"
              >
                <div className="aspect-[5/4] w-full animate-pulse bg-[#efe6db]" />
                <div className="space-y-3 p-3.5 sm:p-4">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-[#e6dacc]" />
                  <div className="h-6 w-1/2 animate-pulse rounded bg-[#e6dacc]" />
                  <div className="h-10 w-full animate-pulse rounded-lg bg-[#f0e8de]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (products.length === 0) {
    return null; // Don't show section if no products
  }

  return (
    <section className={`relative overflow-hidden pt-3 pb-8 font-sans sm:pt-4 sm:pb-10 lg:pt-5 lg:pb-14 ${GROUND}`}>
      <style>{`
        /* ── The unroll ────────────────────────────────────────────────────
           Two tracks sharing one duration, one easing and one per-card delay
           (--d): the cloth slides down off the card, and the overlay fades out
           at the very end so nothing lingers over a revealed product.

           Both animate transform or opacity only — never height or top — so
           they run on the compositor instead of forcing layout every frame. */
        @keyframes m2cUnrollCloth {
          from { transform: translateY(0) }
          to   { transform: translateY(100%) }
        }
        @keyframes m2cUnrollFade {
          0%, 88% { opacity: 1 }
          100%    { opacity: 0 }
        }

        .m2c-clip {
          position: absolute;
          inset: 0;
          overflow: hidden;
          border-radius: 16px;   /* matches the showcase card's rounded-[16px] */
          pointer-events: none;  /* the card stays hoverable underneath */
          /* Above ProductCard's discount badge, wishlist heart and rating pill,
             which all sit at z-10. At z-5 they floated on top of the cloth, so
             the card read as uncovered however good the cloth looked. */
          z-index: 20;
        }

        /* Unbleached cotton: an 18px basket weave over a warm greige gradient.
           18px blocks rather than 1px lines on purpose — a tight line period
           resamples into a coloured haze on HiDPI screens.

           Pitched several steps deeper than the linen ground behind it. At the
           ground's own tone the covered cards would be near-invisible against
           the section before the animation runs. */
        .m2c-cloth {
          position: absolute;
          inset: 0;
          background-color: #dccdb9;
          background-image:
            repeating-linear-gradient(90deg, rgba(122,15,16,.06) 0 9px, transparent 9px 18px),
            repeating-linear-gradient(0deg,  rgba(122,15,16,.06) 0 9px, transparent 9px 18px),
            linear-gradient(180deg, #e6d8c6 0%, #c7b19a 100%);
        }

        /* The rolled end of the bolt. Slightly wider than the card so it reads
           as a cylinder lying across it rather than a bar tucked inside. */
        .m2c-roll {
          position: absolute;
          top: 0;
          left: -3%;
          right: -3%;
          height: 12px;
          border-radius: 999px;
          background: linear-gradient(180deg, #f2e8db 0%, #c2ab92 52%, #98805f 100%);
          box-shadow: 0 9px 20px -6px rgba(74,50,38,.6);
        }

        /* One shared curve. fill-mode 'both' holds the covered state through
           the stagger delay, so card 4 stays under cloth for its full wait
           instead of flashing visible before its turn. */
        .m2c-bolt.is-unrolled .m2c-clip,
        .m2c-bolt.is-unrolled .m2c-cloth {
          animation-duration: ${UNROLL_MS}ms;
          animation-delay: var(--d, 0ms);
          animation-timing-function: cubic-bezier(0.65, 0.02, 0.32, 1);
          animation-fill-mode: both;
        }
        .m2c-bolt.is-unrolled .m2c-clip  { animation-name: m2cUnrollFade }
        .m2c-bolt.is-unrolled .m2c-cloth { animation-name: m2cUnrollCloth }

        /* Reduced motion gets the products outright — the cloth never appears,
           so the preference stops the motion without hiding the stock. */
        @media (prefers-reduced-motion: reduce) {
          .m2c-clip { display: none }
        }
      `}</style>

      <div className={`relative mx-auto ${SHELL} px-3 sm:px-4 md:px-6 lg:px-8`}>
        {/* ── Masthead ─────────────────────────────────────────────────────
            Eyebrow, a hairline filling the row, and a text link on the right.
            No red pill: Top Selling and Best Sellers below both carry one in
            the same corner, and three of them is what made the page read as
            one section repeated. */}
        <div className="mb-3 lg:mb-4">
          <div className="flex items-center justify-center gap-4 lg:justify-start">
            {/* #c41617 rather than the usual #e01a1b: on this linen ground the
                brand red measures 4.15:1, and this is 11px bold text. The
                deeper red reads the same and measures 5.2:1. */}
            <span className="inline-flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#c41617] sm:text-xs">
              <span aria-hidden className="h-px w-6 bg-[#c41617]" />
              Handpicked
            </span>

            <span
              aria-hidden
              className="hidden h-px flex-1 lg:block"
              style={{ background: 'linear-gradient(90deg, #dcc9b4 0%, rgba(220,201,180,0) 100%)' }}
            />

            {/* Brand red, the same as Top Selling and Best Sellers.
                This was oxblood for a while, from when all three sections were
                the same layout with the same red pill in the same corner and
                colour was the only lever left to tell them apart. That is no
                longer true — this one is a linen panel with a six-across grid
                and a cloth reveal, Top Selling is a white section with a side
                masthead and a rail — so the difference had stopped doing a job
                and had become the thing it was meant to prevent: the same
                action looking like three different ones. */}
            <Link
              href="/products?collection=featured"
              className="group hidden shrink-0 items-center gap-2 rounded-full bg-[#e01a1b] px-6 py-2.5 text-[12.5px] font-semibold uppercase tracking-[0.12em] text-white shadow-[0_10px_24px_-12px_rgba(224,26,27,0.75)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#c41617] hover:shadow-[0_16px_30px_-12px_rgba(224,26,27,0.6)] lg:inline-flex"
            >
              View all products
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </Link>
          </div>

          <h2 className="mt-3 text-center font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl md:text-4xl lg:text-left xl:text-[2.75rem]">
            Featured Products
          </h2>
          {/* text-gray-500 measured 4.10:1 against the linen — under the 4.5:1
              body-text threshold. #5f5550 is the same warm neutral at 6.1:1. */}
          <p className="mx-auto mt-2 max-w-full text-center text-sm leading-relaxed text-[#5f5550] md:mt-3 md:text-base lg:mx-0 lg:max-w-2xl lg:text-left lg:text-lg xl:max-w-3xl">
            Handpicked selection of our finest traditional textiles, crafted by master artisans
          </p>
        </div>

        {/* ── Grid ─────────────────────────────────────────────────────────
            Columns, not fixed widths — this is what closes the ~496px gap.
            2 up to lg, then 4 across; 4 products divide evenly either way so
            there is never an orphan on the last row. */}
        <div
          ref={gridRef}
          className="m2c-bolt grid grid-cols-2 gap-4 pt-5 sm:gap-5 md:grid-cols-3 md:gap-6 xl:grid-cols-6 xl:gap-5"
        >
          {products.map((product, index) => (
            <div
              key={product.id}
              className="relative"
              style={{ '--d': `${index * UNROLL_STAGGER_MS}ms` } as React.CSSProperties}
            >
              <ProductCard product={product} variant="showcase" />

              <span aria-hidden className="m2c-clip">
                <span className="m2c-cloth">
                  <span className="m2c-roll" />
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* Mobile View All — stays a solid button. The quiet text link above is
            a desktop hover affordance; on touch this needs to be a real target. */}
        <div className="mt-6 flex justify-center sm:mt-8 lg:hidden">
          <Link
            href="/products?collection=featured"
            className={CTA_PILL}
          >
            View All Products
            <ArrowRight className={CTA_PILL_ICON} />
          </Link>
        </div>
      </div>
    </section>
  );
}
