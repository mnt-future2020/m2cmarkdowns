'use client';

import { useEffect } from 'react';
import { companyInfoService } from '@/services/companyInfoService';

/**
 * Keeps the browser-tab favicon in sync with the admin-uploaded favicon across
 * every route and portal (storefront, admin, vendor, checker).
 *
 * Why this exists on the client instead of only in `generateMetadata`:
 * the server renders the favicon per-route and caches it (ISR / data cache),
 * so different routes could show *different* stale favicons after an admin
 * re-upload — which is exactly what happened (storefront, admin and the API
 * were each on a different version). The server metadata now renders a stable
 * default; this component applies the *current* favicon on the client, so every
 * tab converges on the same, latest icon regardless of route caching.
 *
 * The favicon URL is unique per upload, so swapping the <link> href reliably
 * makes the browser refetch — no cache-busting needed.
 */
export default function FaviconManager() {
  useEffect(() => {
    let cancelled = false;
    companyInfoService
      .getPublicCompanyInfo()
      .then((info) => {
        if (cancelled) return;
        if (info?.favicon) applyFavicon(info.favicon);
      })
      .catch(() => {
        /* leave the bundled default favicon in place */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

function applyFavicon(href: string) {
  if (typeof document === 'undefined') return;

  // IMPORTANT: never remove the <link> nodes Next.js/React renders from the
  // route metadata. Detaching React-managed DOM makes React later call
  // removeChild on a now-null parent, which crashes client-side navigation
  // ("Cannot read properties of null (reading 'removeChild')"): the URL changes
  // but the page won't swap until a full refresh.
  //
  // Instead we own a single pair of icon links (tagged data-m2c-favicon) and
  // only ever touch those. A later icon link wins in the browser, so ours
  // overrides the SSR default without removing it.
  const upsert = (rel: string) => {
    let link = document.head.querySelector<HTMLLinkElement>(
      `link[data-m2c-favicon][rel="${rel}"]`,
    );
    if (!link) {
      link = document.createElement('link');
      link.rel = rel;
      link.setAttribute('data-m2c-favicon', '');
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  };
  upsert('icon');
  upsert('apple-touch-icon');
}
