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
  // Drop any existing icon links (the SSR default + prior ones) so the browser
  // picks up the fresh one rather than keeping the old match.
  document
    .querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    .forEach((el) => el.remove());

  const add = (rel: string) => {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    document.head.appendChild(link);
  };
  add('icon');
  add('apple-touch-icon');
}
