'use client';

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Instagram, Facebook, Youtube, Mail, Phone } from "lucide-react";
import { categoryService, Category } from "@/services/categoryService";
import { companyInfoService, PublicCompanyInfo } from "@/services/companyInfoService";
import CompanyLogo from "@/components/Shared/CompanyLogo";
import { useSamePageTop } from "@/components/WebSite/Shared/useSamePageTop";

/**
 * The footer.
 *
 * Ground and top rule live on the wrapper — see Footer.tsx. Nothing in here
 * paints a background, so the linen runs unbroken from the red hairline at the
 * top through to the legal line at the bottom.
 *
 * Removed earlier, and still gone:
 *  · the "— OUR PROMISE —" headline block, which repeated the eyebrow and the
 *    layout of the section directly above it, and opened the footer with a
 *    42px hero headline;
 *  · its subtitle, which was the same sentence as the company column's
 *    description 150px below it;
 *  · the four trust badges, which were the third set on one page after
 *    PromoStrip's — and which carried "Pan-India shipping" on a store that
 *    runs NEXT_PUBLIC_SITE_REGION=US and prices in dollars;
 *  · the grid, dot, twin-radial and drifting-contour layers — four decorative
 *    passes behind the content;
 *  · the "Stay Updated" newsletter column. Beyond taking three of the twelve
 *    columns, its submit handler showed a "Subscribed" toast and then discarded
 *    the address — there is no subscribe endpoint in the backend. It had been
 *    collecting nothing while telling people otherwise.
 */

/**
 * Column heading — a lead rule and the label, which is exactly how the eyebrows
 * on Featured Products, Top Selling and The M2C Standard are built. Deep red
 * rather than brand red: #e01a1b on linen is ~3.9:1 and this is 11px type.
 */
const ColHeading = ({ children }: { children: React.ReactNode }) => (
  <h4 className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.24em] text-[#c41617]">
    <span aria-hidden className="h-px w-5 shrink-0 bg-gradient-to-r from-[#c41617] to-[#e9a3a3]" />
    {children}
  </h4>
);

/**
 * Footer nav link.
 *
 * 14.5px was fine print, which is why the eye skipped the words and only took
 * in the layout. 18px is navigation — stepped down to 16px on phones, where
 * the three link columns sit two-up and 18px would wrap "All Categories".
 *
 * Hover swaps the label. The word rides up out of the row and a red copy of it
 * rises into the same place from below, both moving together inside a clipped
 * box exactly one line tall. Nothing grows, slides sideways or underlines —
 * the row simply changes state, which is a cleaner read than a rule racing
 * across 236px of column.
 *
 * The second copy is aria-hidden: it is the same word twice in the DOM, and a
 * screen reader should hear it once.
 */
const ROW =
  "group flex w-full items-center gap-2.5 py-[7px] leading-none text-[#3f3a35] transition-colors duration-300";
const SWAP = "transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-full";

/**
 * The swap itself, shared by every row in the footer. It lived inside NavLink
 * at first, which meant the Let's Connect column — email, phone, socials — had
 * only a colour change while the two columns beside it swapped, and one column
 * behaving differently from its neighbours reads as a bug rather than a choice.
 *
 * The clip box is sized in em, not pixels, so it tracks the font size across
 * breakpoints; a fixed pixel height crops the descenders at 18px.
 */
const SwapLabel = ({ label, wrapper = "", line = "" }: { label: string; wrapper?: string; line?: string }) => (
  <span className={`relative block h-[1.4em] overflow-hidden ${wrapper}`}>
    <span className={`block leading-[1.4] ${SWAP} ${line}`}>{label}</span>
    <span aria-hidden className={`absolute inset-x-0 top-full block leading-[1.4] text-[#c41617] ${SWAP} ${line}`}>
      {label}
    </span>
  </span>
);

/**
 * Clicking one of these while already on that page used to do nothing at all —
 * see useSamePageTop for why, and for what it does instead.
 */
const NavLink = ({ href, label }: { href: string; label: string }) => {
  const samePageTop = useSamePageTop();
  return (
    <Link href={href} onClick={samePageTop(href)} className={`${ROW} text-[16px] sm:text-[17px] lg:text-[18px]`}>
      <SwapLabel label={label} wrapper="min-w-0 flex-1" />
    </Link>
  );
};

/** Contact row — the same swap, with the icon leading it. */
const ConnectRow = ({
  href,
  Icon,
  label,
  external = false,
  clip = false,
}: {
  href: string;
  Icon: typeof Instagram;
  label: string;
  external?: boolean;
  clip?: boolean;
}) => (
  <a
    href={href}
    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    className={`${ROW} text-[15.5px] sm:text-[16px]`}
  >
    <Icon className="h-4 w-4 shrink-0 text-[#a8968c] transition-colors duration-300 group-hover:text-[#c41617]" />
    {/* The email overruns a 236px column, so its two copies truncate together —
        applied to one only, the red copy would arrive a different length. */}
    <SwapLabel label={label} wrapper="min-w-0 flex-1" line={clip ? "truncate" : ""} />
  </a>
);

const MainFooterContent = () => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [companyInfo, setCompanyInfo] = useState<PublicCompanyInfo>({
    companyName: 'M2C Markdowns Pvt Ltd',
    companyLogo: null,
    secondaryLogo: null,
    favicon: null,
    companyEmail: null,
    companyPhone: null,
    companyWebsite: null,
    registeredAddress: null,
    city: null,
    state: null,
    country: null,
    zipCode: null,
    socialInstagram: null,
    socialFacebook: null,
    socialYoutube: null,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    categoryService.getAllCategories({ status: 'ACTIVE', showRootOnly: 'true' })
      .then((res) => { if (res.success && res.data) setCategories(res.data.slice(0, 6)); })
      .catch((e) => console.error("Failed to fetch categories for footer:", e));
    companyInfoService.getPublicCompanyInfo().then(setCompanyInfo).catch(() => {});
  }, []);

  /**
   * The trigger watches the grid, not the root.
   *
   * A single observer on the root at 10% fired after ~70px of a 700px footer,
   * i.e. the moment its top edge appeared — which is roughly right for the
   * columns and completely wrong for anything lower down. Whatever is being
   * animated has to be the thing observed.
   *
   * Not <Reveal>, for the same reason as the rest of the page: its 1.4s
   * fail-safe fires whether the element has been reached or not.
   */
  useEffect(() => {
    const root = rootRef.current;
    const grid = gridRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined' || !grid) {
      root.classList.add('is-woven');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          root.classList.add('is-woven');
          io.disconnect();
        }
      },
      // The last 5% of the viewport doesn't count, so nothing starts while
      // it is still clipping the bottom edge.
      { threshold: 0.12, rootMargin: '0px 0px -5% 0px' },
    );
    io.observe(grid);
    return () => io.disconnect();
  }, []);

  /**
   * One set of social links, not two. Instagram and Facebook were rendered
   * twice in this footer — as bare circles under the company blurb AND as
   * labelled rows in Let's Connect — the same two destinations, 400px apart.
   * YouTube moved in with them so no link was lost.
   *
   * They render under the company blurb, in the slot the About M2C pill held.
   * They spent a while at the foot of Let's Connect instead, under an email and
   * a phone number, which is about the last place anything in a footer gets
   * looked at.
   *
   * They are tiles rather than another set of text rows. Three more rows in the
   * same column made the socials indistinguishable from navigation, and the
   * footer is linen and red throughout — each platform's own colour arriving on
   * hover is the one moment of real colour in it, and it only appears when
   * someone reaches for it.
   *
   * `fill` is passed down as a custom property because the value is per-row
   * data, which a utility class cannot express.
   */
  const socials = [
    {
      url: companyInfo.socialInstagram,
      Icon: Instagram,
      label: "Instagram",
      fill: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285aeb 90%)',
    },
    { url: companyInfo.socialFacebook, Icon: Facebook, label: "Facebook", fill: '#1877f2' },
    { url: companyInfo.socialYoutube, Icon: Youtube, label: "YouTube", fill: '#ff0000' },
  ].filter((s) => s.url) as { url: string; Icon: typeof Instagram; label: string; fill: string }[];

  const navColumns: Array<{ heading: string; delay: number; links: Array<{ href: string; label: string }> }> = [
    {
      // Categories lead, because that is what someone scrolling to the foot of
      // a shop is usually looking for.
      heading: 'Shop',
      delay: 80,
      links: [
        { href: '/products', label: 'All Products' },
        { href: '/categories', label: 'All Categories' },
        ...categories.slice(0, 4).map((c) => ({ href: `/categories/${c.slug}`, label: c.name })),
      ],
    },
    {
      // The column this footer did not have. Every one of these pages already
      // existed and only Terms, Privacy and Returns were linked at all — from
      // the bottom bar, at 12px, under the copyright.
      heading: 'Help',
      delay: 140,
      links: [
        { href: '/order', label: 'Track Order' },
        { href: '/returns', label: 'Returns & FAQ' },
        { href: '/contact', label: 'Contact Us' },
        { href: '/about', label: 'About M2C' },
        { href: '/offers', label: 'Offers' },
      ],
    },
    {
      // Signed out these still work: /profile and /wishlist bounce to login,
      // which is the normal behaviour for an account link.
      heading: 'Account',
      delay: 200,
      links: [
        { href: '/profile', label: 'My Account' },
        { href: '/profile', label: 'My Orders' },
        { href: '/wishlist', label: 'Wishlist' },
        { href: '/cart', label: 'Cart' },
      ],
    },
  ];

  return (
    <div ref={rootRef} className="relative overflow-hidden text-[#3f3a35]">
      <style>{`
        .m2c-col { opacity: 0; transform: translateY(22px); }
        .is-woven .m2c-col {
          opacity: 1; transform: none;
          transition: opacity .6s ease, transform .7s cubic-bezier(0.22,1,0.36,1);
        }

        /* Each tile's own platform colour, washed in on hover. It lives on a
           pseudo-element so the fill can cross-fade under the icon rather than
           snapping, and so the resting border and the arriving colour are not
           fighting over the same property. */
        .m2c-social::before {
          content: '';
          position: absolute;
          inset: 0;
          background: var(--fill);
          opacity: 0;
          transition: opacity .35s ease;
        }
        .m2c-social:hover::before,
        .m2c-social:focus-visible::before { opacity: 1 }

        @media (prefers-reduced-motion: reduce) {
          .m2c-col, .is-woven .m2c-col { opacity: 1; transform: none; transition: none; }
          .m2c-social { transition: none }
          .m2c-social::before { transition: none }
        }
      `}</style>

      <div className="relative mx-auto max-w-7xl px-4 pt-14 sm:px-6 sm:pt-16 lg:px-8 lg:pt-20 xl:max-w-420">
        <div ref={gridRef} className="relative grid grid-cols-1 gap-x-8 gap-y-11 lg:grid-cols-12 lg:gap-x-10">
          {/* ── Our Company ─────────────────────────────────────────── */}
          <div className="m2c-col min-w-0 lg:col-span-3">
            <Link href="/" className="inline-block">
              <CompanyLogo
                className="h-12 w-auto object-contain sm:h-14"
                skeletonClassName="h-12 sm:h-14 w-40 bg-[#0f0b08]/[0.06]"
                fallbackWidth={220}
                fallbackHeight={56}
              />
            </Link>
            <p className="mt-5 max-w-[19rem] text-[14.5px] leading-[1.65] text-[#6b625b]">
              Home textiles bought direct from the workshops that weave them — towels, aprons, table linen and bath accessories in cotton that lasts.
            </p>
            {/* ── Follow us ─────────────────────────────────────────────
                This is where the "About M2C" pill was. The page it went to is
                still one tap away — Help lists About M2C, two columns to the
                right — so the destination is not lost, only the second copy of
                it, and the socials get the one spot in the footer the eye
                actually lands on after the logo and the sentence under it.

                They sat at the bottom of Let's Connect before, below an email
                and a phone number, which is the last place anything gets read
                in a footer. */}
            {socials.length > 0 && (
              <div className="mt-7">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8a807a]">Follow us</p>
                <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                  {socials.map(({ url, Icon, label, fill }) => (
                    <a
                      key={label}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${label} (opens in a new tab)`}
                      style={{ '--fill': fill } as React.CSSProperties}
                      title={label}
                      className="m2c-social group relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-[#e6dbcc] bg-white/70 transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-transparent hover:shadow-[0_12px_24px_-14px_rgba(74,50,38,0.55)]"
                    >
                      {/* The label was set beside the icon in a tile roughly
                          130x96. Two of those is a lot of furniture to say
                          "Instagram, Facebook" — everyone knows the glyphs, and
                          the name survives on the accessible name and the
                          tooltip. */}
                      <Icon
                        className="relative z-10 h-[18px] w-[18px] text-[#6b625b] transition-colors duration-300 group-hover:text-white"
                        strokeWidth={1.8}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Shop · Help · Account ───────────────────────────────────
              One sub-grid rather than three siblings of the outer twelve.
              Stacked one-per-row on a phone these three columns ran to about
              900px of scrolling on their own; two-up they are half that, and
              the outer grid still gets a single six-column block on desktop so
              the twelve add up as before. */}
          <div className="min-w-0 lg:col-span-6">
            <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-3 sm:gap-x-8">
              {navColumns.map((col) => (
                <div key={col.heading} className="m2c-col min-w-0" style={{ transitionDelay: `${col.delay}ms` }}>
                  <ColHeading>{col.heading}</ColHeading>
                  <div className="mt-4 flex flex-col -ml-0.5">
                    {col.links.map((l, i) => (
                      <NavLink key={`${l.href}-${i}`} href={l.href} label={l.label} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Let's Connect ───────────────────────────────────────── */}
          <div className="m2c-col min-w-0 lg:col-span-3" style={{ transitionDelay: '260ms' }}>
            <ColHeading>Let&apos;s Connect</ColHeading>

            {/* Capped rather than run to the full column. The email is the
                longest string here and it now fits without truncating. */}
            <div className="mt-5 flex max-w-[24rem] flex-col">
              {companyInfo.companyEmail && (
                <ConnectRow href={`mailto:${companyInfo.companyEmail}`} Icon={Mail} label={companyInfo.companyEmail} clip />
              )}
              {companyInfo.companyPhone && (
                <ConnectRow href={`tel:${companyInfo.companyPhone}`} Icon={Phone} label={companyInfo.companyPhone} />
              )}
            </div>

          </div>
        </div>

      </div>

      {/* The columns still need to stop before the legal line starts. The
          oversized company name that closed the footer here is gone at the
          client's request; the hairline above the legal bar is the only rule
          left between the columns and the copyright, which is enough. */}
      <div aria-hidden className="h-12 sm:h-14" />
    </div>
  );
};

export default MainFooterContent;
