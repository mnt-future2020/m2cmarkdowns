// ─── Courier Partners ───────────────────────────────────────────────────────
// Couriers are admin-managed (DB-backed) — see courierService + the admin Couriers
// module. This file keeps the transport-mode helpers, plus a runtime registry so
// courierName()/courierById() can resolve ids synchronously anywhere (cart, orders)
// after courierService has fetched the list. STATIC_COURIERS is a fallback used for
// the very first render and for legacy slug ids stored on old orders.

export type CourierRegion = 'IN' | 'US' | 'BOTH';
export type TransportMode = 'AIR' | 'SHIP';

export interface Courier {
  id: string;
  name: string;
  /** Short badge text used as the courier "icon". */
  code: string;
  /** Brand-ish colour for the badge background (fallback when no logo). */
  color: string;
  /** Optional uploaded logo image URL — shown instead of the code/colour badge. */
  logo?: string | null;
  region: CourierRegion;
  modes: TransportMode[];
  isActive?: boolean;
  sortOrder?: number;
  /** Public tracking-website URL. May contain a `{tracking}` placeholder. */
  trackingUrl?: string | null;
}

// Fallback catalogue (matches the seed) — used before the DB list loads and to resolve
// legacy slug ids ('dhl', 'blue-dart', …) saved on pre-existing orders.
export const STATIC_COURIERS: Courier[] = [
  { id: 'blue-dart', name: 'Blue Dart',  code: 'BD',  color: '#0B4DA2', region: 'IN', modes: ['AIR'] },
  { id: 'delhivery', name: 'Delhivery',  code: 'DL',  color: '#C8102E', region: 'IN', modes: ['AIR', 'SHIP'] },
  { id: 'dtdc',      name: 'DTDC',        code: 'DT',  color: '#E4032E', region: 'IN', modes: ['AIR', 'SHIP'] },
  { id: 'gati',      name: 'Gati',        code: 'GT',  color: '#1D4E8F', region: 'IN', modes: ['SHIP'] },
  { id: 'dhl',       name: 'DHL Express', code: 'DHL', color: '#D40511', region: 'US', modes: ['AIR'] },
  { id: 'fedex',     name: 'FedEx',       code: 'FX',  color: '#4D148C', region: 'US', modes: ['AIR'] },
  { id: 'ups',       name: 'UPS',         code: 'UPS', color: '#4E2A1E', region: 'US', modes: ['AIR'] },
  { id: 'maersk',    name: 'Maersk',      code: 'MK',  color: '#0091DA', region: 'US', modes: ['SHIP'] },
  { id: 'dhl-ocean', name: 'DHL Ocean',   code: 'DHL', color: '#D40511', region: 'US', modes: ['SHIP'] },
];

// Runtime registry, keyed by id, populated by courierService.getActiveCouriers().
let RUNTIME: Record<string, Courier> = {};
export function registerCouriers(list: Courier[]) {
  const map: Record<string, Courier> = { ...RUNTIME };
  for (const c of list) map[c.id] = c;
  RUNTIME = map;
}

function normalizeRegion(value?: string | null): CourierRegion | null {
  if (!value) return null;
  const v = String(value).toUpperCase();
  if (v === 'IN' || v === 'INR' || v === 'IN_ONLY') return 'IN';
  if (v === 'US' || v === 'USD' || v === 'COM_ONLY') return 'US';
  return null;
}

// Accepts a region ('IN'/'US'), currency ('INR'/'USD') OR a product priceVisibility
// ('IN_ONLY'/'COM_ONLY'/'BOTH'). 'BOTH' resolves to 'BOTH' (a product sold on both
// storefronts), everything else maps to IN / US / null.
function toScope(value?: string | null): CourierRegion | 'BOTH' | null {
  if (value && String(value).toUpperCase() === 'BOTH') return 'BOTH';
  return normalizeRegion(value);
}

/**
 * Region-aware transport-mode label. The two stored modes are AIR and SHIP, but their
 * meaning differs by market:
 *   - International (.com): AIR = Air Freight, SHIP = Sea Freight (ocean).
 *   - Domestic India (.in): AIR = Air (domestic express), SHIP = Surface / Road — there
 *     is no sea freight within India, goods move by road/rail.
 * For a BOTH product (admin, before a storefront is chosen) SHIP reads "Sea / Surface".
 */
export function transportModeLabel(mode: TransportMode, region?: string | null): string {
  const r = toScope(region);
  if (mode === 'AIR') return r === 'IN' ? 'Air' : 'Air Freight';
  if (r === 'IN') return 'Surface / Road';
  if (r === 'BOTH') return 'Sea / Surface';
  return 'Sea Freight';
}

/** True when SHIP means domestic surface/road (India) — callers pick a truck icon. */
export function isSurfaceRegion(region?: string | null): boolean {
  return toScope(region) === 'IN';
}

/** All known couriers (runtime registry if loaded, else the static fallback). */
function allCouriers(): Courier[] {
  const runtime = Object.values(RUNTIME);
  return runtime.length > 0 ? runtime : STATIC_COURIERS;
}

/**
 * Couriers available for a region + transport mode, from the loaded registry (falls back
 * to the static list). Prefer courierService.getActiveCouriers() in components that can
 * fetch; this sync helper is for convenience/fallback.
 */
export function getCouriers(region?: string | null, mode?: TransportMode | null): Courier[] {
  const r = normalizeRegion(region);
  // A courier tagged 'BOTH' serves the domestic (.in) and international (.com) stores alike.
  return allCouriers().filter((c) => (!r || c.region === r || c.region === 'BOTH') && (!mode || c.modes.includes(mode)));
}

/** Look up a courier by id — runtime registry first, then the static fallback. */
export function courierById(id?: string | null): Courier | undefined {
  if (!id) return undefined;
  return RUNTIME[id] || STATIC_COURIERS.find((c) => c.id === id);
}

/** Human-readable name for an id; falls back to the id itself. */
export function courierName(id?: string | null): string {
  return courierById(id)?.name || id || '';
}

/**
 * Resolve a courier's public tracking-website URL for a given tracking id.
 * If the stored URL has a `{tracking}` placeholder it's substituted; otherwise
 * the URL is returned as-is (the courier's tracking page). Returns null when the
 * courier has no tracking URL configured.
 */
export function courierTrackingUrl(id?: string | null, trackingId?: string | null): string | null {
  const raw = courierById(id)?.trackingUrl;
  if (!raw || !raw.trim()) return null;
  const tid = (trackingId || '').trim();
  let url = raw.trim();
  // Substitute the tracking id where the admin placed the {tracking} token.
  if (url.includes('{tracking}')) url = url.replace(/\{tracking\}/g, encodeURIComponent(tid));
  // Ensure it's an absolute external URL — a bare "www.example.com" would otherwise
  // be treated as a same-site relative path (localhost:3000/www.example.com → 404).
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

// ── Live-courier providers (fulfilled via a carrier API, e.g. Delhivery) ──────
// An order shipped by a live courier carries `shippingProvider` instead of a
// manual Courier id. These map the provider to its display name + public tracking
// page (the AWB lives in the order's trackingReference).
const LIVE_PROVIDER_NAME: Record<string, string> = { delhivery: 'Delhivery' };
const LIVE_PROVIDER_TRACK: Record<string, (awb: string) => string> = {
  delhivery: (awb) => `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`,
};

/** Display name for an order's courier — the live provider (Delhivery) or the manual courier. */
export function courierDisplayName(opts: { shippingProvider?: string | null; courier?: string | null }): string {
  const prov = (opts.shippingProvider || '').toLowerCase();
  if (prov && LIVE_PROVIDER_NAME[prov]) return LIVE_PROVIDER_NAME[prov];
  return courierName(opts.courier) || '';
}

/** Public tracking-page URL for an order — the live provider's page, else the manual courier's. */
export function orderTrackingUrl(opts: { shippingProvider?: string | null; courier?: string | null; trackingReference?: string | null }): string | null {
  const prov = (opts.shippingProvider || '').toLowerCase();
  const awb = (opts.trackingReference || '').trim();
  if (prov && LIVE_PROVIDER_TRACK[prov] && awb) return LIVE_PROVIDER_TRACK[prov](awb);
  return courierTrackingUrl(opts.courier, opts.trackingReference);
}
