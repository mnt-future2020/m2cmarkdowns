'use client';

/**
 * Shared logo component for every surface that displays the company brand —
 * Header, Footer, login pages, vendor/checker headers, etc.
 *
 * What it does
 *   - Fetches the admin-uploaded company logo from the public company-info
 *     endpoint exactly once per page session (module-level promise cache —
 *     so a Header + Footer mounted together don't both hit the API).
 *   - While the fetch is in flight, renders a neutral pulsing skeleton in
 *     the same layout box the final logo will occupy. No flash of the
 *     static fallback logo before the dynamic one resolves, which used to
 *     confuse users who'd briefly see the bundled M2C placeholder and
 *     then watch it swap to whatever the admin had uploaded.
 *   - When the fetch resolves with a logo URL → renders an <img> with the
 *     dynamic URL.
 *   - When the fetch resolves WITHOUT a URL (or errors out) → renders the
 *     bundled fallback as a Next.js <Image> with width/height/sizes/priority
 *     wired through.
 *
 * Why a module-level cache and not React Query / Context
 *   This is a single string fetched on first paint and cached for the
 *   entire session. There is no invalidation story and no per-component
 *   variation. A 30-line module cache is the right size for the problem,
 *   and avoids pulling in a heavier client-state dependency.
 */

import { useEffect, useState } from 'react';
import { companyInfoService } from '@/services/companyInfoService';

// Both admin-uploaded logos are fetched together and cached for the session.
//   primary   → companyLogo   (home / contact / about / terms / privacy / returns)
//   secondary → secondaryLogo (header on all other pages)
// A `null` field means the admin hasn't uploaded that logo; the secondary
// variant then falls back to the primary, and finally to the bundled asset.
interface LogoPair { companyLogo: string | null; secondaryLogo: string | null; companyName: string | null; }
// `undefined` = not yet fetched (consumers should render the skeleton)
let cachedLogos: LogoPair | undefined = undefined;
let inflightFetch: Promise<LogoPair> | null = null;

function loadCompanyLogos(): Promise<LogoPair> {
  if (cachedLogos !== undefined) return Promise.resolve(cachedLogos);
  if (inflightFetch) return inflightFetch;
  inflightFetch = companyInfoService
    .getPublicCompanyInfo()
    .then(info => {
      cachedLogos = { companyLogo: info.companyLogo ?? null, secondaryLogo: info.secondaryLogo ?? null, companyName: info.companyName ?? null };
      return cachedLogos;
    })
    .catch(() => {
      cachedLogos = { companyLogo: null, secondaryLogo: null, companyName: null };
      return cachedLogos;
    })
    .finally(() => {
      inflightFetch = null;
    });
  return inflightFetch;
}

interface CompanyLogoProps {
  /** Tailwind/CSS classes applied to the rendered <img> and the fallback <Image>. */
  className?: string;
  /**
   * Classes applied to the loading-state skeleton div. MUST include sizing
   * (height + aspect-ratio or width) so the skeleton occupies the same box
   * the final logo will, avoiding layout shift when the fetch resolves.
   * Falls back to `className` if not provided.
   */
  skeletonClassName?: string;
  /** Intrinsic width for the bundled fallback Image (no effect on dynamic img). */
  fallbackWidth?: number;
  /** Intrinsic height for the bundled fallback Image. */
  fallbackHeight?: number;
  /** Next.js `sizes` hint for the bundled fallback. */
  fallbackSizes?: string;
  /** Mark the fallback Image as LCP-priority (header / hero). */
  priority?: boolean;
  /** Alt text for both the dynamic <img> and the static fallback. */
  alt?: string;
  /**
   * Which admin-uploaded logo to show. `'primary'` (default) uses the main
   * company logo. `'secondary'` uses the secondary logo, falling back to the
   * primary when no secondary has been uploaded.
   */
  variant?: 'primary' | 'secondary';
}

export default function CompanyLogo({
  className,
  skeletonClassName,
  fallbackWidth = 200,
  fallbackHeight = 100,
  fallbackSizes,
  priority,
  alt = 'Company Logo',
  variant = 'primary',
}: CompanyLogoProps) {
  const [logos, setLogos] = useState<LogoPair | undefined>(cachedLogos);

  useEffect(() => {
    if (cachedLogos !== undefined) {
      setLogos(cachedLogos);
      return;
    }
    let cancelled = false;
    loadCompanyLogos().then(pair => {
      if (!cancelled) setLogos(pair);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the URL for the requested variant (secondary falls back to primary).
  const logoUrl = logos === undefined
    ? undefined
    : variant === 'secondary'
      ? (logos.secondaryLogo || logos.companyLogo)
      : logos.companyLogo;

  // Still loading — render skeleton in the layout box the logo will fill.
  // The skeleton bg color is NOT hardcoded here: surfaces sit on widely
  // different backgrounds (white nav, black login pages, dark footer) and a
  // single hardcoded bg would look broken on at least one of them. Each
  // consumer is expected to include an appropriate `bg-*` class in
  // `skeletonClassName` — e.g. `bg-gray-100` on light surfaces, `bg-white/10`
  // on dark surfaces.
  if (logoUrl === undefined) {
    return (
      <div
        aria-hidden="true"
        className={`${skeletonClassName ?? className ?? ''} animate-pulse rounded`}
      />
    );
  }

  // Admin uploaded a logo — render it directly. We use a raw <img> here
  // (rather than next/image) because the URL is dynamic and arrives after
  // hydration; next/image's optimization pipeline doesn't gain us anything
  // for a single tiny logo and the Cloudinary CDN is already optimal.
  if (logoUrl) {
    return <img src={logoUrl} alt={alt} className={className} />;
  }

  // No admin-uploaded logo — render the company name as a text wordmark.
  // There is no bundled logo file to fall back to (logos are DB-driven, set in
  // Settings → Company Info), so a text wordmark avoids a broken image while
  // still showing the brand. In practice a logo is almost always uploaded.
  return (
    <span
      className={`${className ?? ''} inline-flex items-center font-semibold whitespace-nowrap`}
      role="img"
      aria-label={alt}
    >
      {logos?.companyName || 'M2C Markdowns'}
    </span>
  );
}
