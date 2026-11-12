/**
 * Delhivery B2C (Surface/Express) API client.
 *
 * Single integration point for the live courier flow. Reads credentials from the
 * CourierIntegration settings singleton (token, environment, pickup name), so the
 * admin configures everything in Settings → Live Courier with nothing hard-coded.
 *
 * Covers: pincode serviceability, shipment creation (auto AWB), shipping label,
 * tracking, pickup request, cancel/RTO, and a live rate quote. All calls return
 * { ok, ... } and never throw for an API-level failure — callers decide whether a
 * failure should block the order action.
 *
 * Auth: every request carries `Authorization: Token <apiToken>`.
 * Base URLs: staging → https://staging-express.delhivery.com
 *            production → https://track.delhivery.com
 */
const { prisma } = require('../config/database');

const BASE_URLS = {
  staging: 'https://staging-express.delhivery.com',
  production: 'https://track.delhivery.com',
};

// ── Settings ──────────────────────────────────────────────────────────────────
async function getIntegration() {
  let s = await prisma.courierIntegration.findFirst();
  if (!s) s = await prisma.courierIntegration.create({ data: {} });
  return s;
}

// Is the live courier flow active for this order currency/region? Delhivery is
// India-only, so it never activates for USD/.com — those keep the manual method.
function isLiveForRegion(settings, currencyOrRegion) {
  if (!settings?.enabled || !settings?.connected) return false;
  const r = String(currencyOrRegion || '').toUpperCase();
  const isIN = r === 'IN' || r === 'INR';
  return isIN;
}

function baseUrl(settings) {
  return BASE_URLS[settings?.environment === 'production' ? 'production' : 'staging'];
}

function authHeaders(settings, extra = {}) {
  return {
    Authorization: `Token ${settings.apiToken || ''}`,
    Accept: 'application/json',
    ...extra,
  };
}

// Thin fetch wrapper with a timeout; returns { ok, status, data|text, error }.
async function call(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

// ── Pincode serviceability ────────────────────────────────────────────────────
// GET /c/api/pin-codes/json/?filter_codes=<pin>
async function checkServiceability(pin, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pin)}`;
  const r = await call(url, { headers: authHeaders(settings) });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  const codes = r.data?.delivery_codes || [];
  const entry = codes[0]?.postal_code;
  if (!entry) return { ok: true, serviceable: false, raw: r.data };
  return {
    ok: true,
    serviceable: true,
    prepaid: entry.pre_paid === 'Y',
    cod: entry.cod === 'Y',
    pickup: entry.pickup === 'Y',
    city: entry.district || entry.city,
    state: entry.state_code || entry.inc,
    raw: entry,
  };
}

// ── Create shipment (manifest) → auto AWB ─────────────────────────────────────
// POST /api/cmu/create.json   body: format=json&data=<json>
// Pass a normalised shipment object (see buildShipmentPayload in the controller).
async function createShipment(shipment, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken || !settings.pickupName) return { ok: false, error: 'not_configured' };

  const payload = {
    shipments: [shipment],
    pickup_location: { name: settings.pickupName },
  };
  const body = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
  const url = `${baseUrl(settings)}/api/cmu/create.json`;
  const r = await call(url, {
    method: 'POST',
    headers: authHeaders(settings, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body,
  });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };

  const pkg = r.data?.packages?.[0];
  const success = r.data?.success === true && pkg && (pkg.status === 'Success' || pkg.waybill);
  if (!success) {
    const remark = pkg?.remarks?.join?.('; ') || r.data?.rmk || 'shipment creation failed';
    return { ok: false, error: remark, raw: r.data };
  }
  return { ok: true, awb: pkg.waybill, refnum: pkg.refnum, raw: pkg };
}

// ── Shipping label (packing slip PDF) ─────────────────────────────────────────
// GET /api/p/packing_slip?wbns=<awb>&pdf=true
async function getLabel(awb, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true`;
  const r = await call(url, { headers: authHeaders(settings) });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  const pkg = r.data?.packages?.[0];
  return { ok: true, labelUrl: pkg?.pdf_download_link || null, raw: r.data };
}

// ── Tracking ──────────────────────────────────────────────────────────────────
// GET /api/v1/packages/json/?waybill=<awb>
async function track(awb, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`;
  const r = await call(url, { headers: authHeaders(settings) });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  const ship = r.data?.ShipmentData?.[0]?.Shipment;
  if (!ship) return { ok: true, found: false, raw: r.data };
  return {
    ok: true,
    found: true,
    status: ship.Status?.Status,           // e.g. 'In Transit', 'Delivered', 'RTO'
    statusType: ship.Status?.StatusType,   // 'UD' | 'DL' | 'RT' ...
    statusDateTime: ship.Status?.StatusDateTime,
    instructions: ship.Status?.Instructions,
    scans: ship.Scans || [],
    raw: ship,
  };
}

// ── Pickup request ────────────────────────────────────────────────────────────
// POST /fm/request/new/
async function schedulePickup({ pickupDate, pickupTime = '14:00:00', expectedCount = 1 }, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken || !settings.pickupName) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/fm/request/new/`;
  const body = JSON.stringify({
    pickup_location: settings.pickupName,
    pickup_date: pickupDate,         // 'YYYY-MM-DD'
    pickup_time: pickupTime,         // 'HH:MM:SS'
    expected_package_count: expectedCount,
  });
  const r = await call(url, {
    method: 'POST',
    headers: authHeaders(settings, { 'Content-Type': 'application/json' }),
    body,
  });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  return { ok: true, pickupId: r.data?.pickup_id, raw: r.data };
}

// ── Register pickup location (ClientWarehouse) ────────────────────────────────
// POST /api/backend/clientwarehouse/create/
// Registers a pickup/warehouse in the Delhivery account so shipments can reference
// it by `name`. The shipment's pickup_location.name must equal this `name` exactly.
async function registerPickupLocation({ name, phone, email, address, city, state, pincode, country = 'India' }, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/api/backend/clientwarehouse/create/`;
  const body = JSON.stringify({
    name,
    email: email || '',
    phone: String(phone || ''),
    address,
    city,
    country,
    pin: String(pincode || ''),
    registered_name: settings.clientName || name,
    return_address: address,
    return_pin: String(pincode || ''),
    return_city: city,
    return_state: state,
    return_country: country,
  });
  const r = await call(url, {
    method: 'POST',
    headers: authHeaders(settings, { 'Content-Type': 'application/json' }),
    body,
  });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  // Delhivery returns { success: true } on success, else an error/message.
  const success = r.data?.success === true || r.data?.success === 'true';
  if (!success) {
    const msg = r.data?.error || r.data?.rmk || r.data?.data || (typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
    return { ok: false, error: String(msg).slice(0, 300), raw: r.data };
  }
  return { ok: true, raw: r.data };
}

// ── Cancel / RTO ──────────────────────────────────────────────────────────────
// POST /api/p/edit   body: { waybill, cancellation: "true" }
async function cancelShipment(awb, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const url = `${baseUrl(settings)}/api/p/edit`;
  const body = JSON.stringify({ waybill: awb, cancellation: 'true' });
  const r = await call(url, {
    method: 'POST',
    headers: authHeaders(settings, { 'Content-Type': 'application/json' }),
    body,
  });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  const okFlag = r.data?.status === true || r.data?.status === 'true';
  return { ok: okFlag, error: okFlag ? undefined : (r.data?.rmk || 'cancel failed'), raw: r.data };
}

// ── Live rate quote (shipping charge estimate) ────────────────────────────────
// GET /api/kinko/v1/invoice/charges/.json?md=<mode>&ss=Delivered&d_pin=&o_pin=&cgm=<grams>&pt=<Pre-paid|COD>
async function rateQuote({ originPin, destPin, weightGrams, paymentType = 'Pre-paid', mode = 'S' }, settingsArg) {
  const settings = settingsArg || await getIntegration();
  if (!settings.apiToken) return { ok: false, error: 'not_configured' };
  const params = new URLSearchParams({
    md: mode,                 // 'S' surface | 'E' express
    ss: 'Delivered',
    d_pin: String(destPin || ''),
    o_pin: String(originPin || ''),
    cgm: String(Math.max(1, Math.round(weightGrams || 0))),
    pt: paymentType,          // 'Pre-paid' | 'COD'
  });
  const url = `${baseUrl(settings)}/api/kinko/v1/invoice/charges/.json?${params.toString()}`;
  const r = await call(url, { headers: authHeaders(settings) });
  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}`, raw: r.data };
  const entry = Array.isArray(r.data) ? r.data[0] : r.data;
  // Use the PRE-TAX freight (gross_amount): the platform adds shipping GST as its
  // own line, so taking total_amount (GST-inclusive) would double-charge tax.
  const amount = entry?.gross_amount ?? entry?.total_amount ?? entry?.charge_DL ?? null;
  if (amount == null) return { ok: false, error: 'no_rate', raw: r.data };
  return { ok: true, amount: Number(amount), raw: entry };
}

module.exports = {
  getIntegration,
  isLiveForRegion,
  checkServiceability,
  createShipment,
  getLabel,
  track,
  schedulePickup,
  cancelShipment,
  rateQuote,
  registerPickupLocation,
};
