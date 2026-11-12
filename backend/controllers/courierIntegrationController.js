const { prisma } = require('../config/database');
const delhivery = require('../utils/delhivery');

// Public-safe view — never leak the full API token to the client.
function publicView(s) {
  if (!s) return { provider: 'delhivery', enabled: false, connected: false };
  const t = s.apiToken || '';
  return {
    id: s.id,
    provider: s.provider,
    enabled: s.enabled,
    connected: s.connected,
    environment: s.environment,
    pickupName: s.pickupName || '',
    originPincode: s.originPincode || '',
    clientName: s.clientName || '',
    useLiveRates: s.useLiveRates,
    defaultWeightGrams: s.defaultWeightGrams,
    defaultLengthCm: s.defaultLengthCm,
    defaultWidthCm: s.defaultWidthCm,
    defaultHeightCm: s.defaultHeightCm,
    hasToken: !!t,
    tokenPreview: t ? `${t.slice(0, 4)}••••${t.slice(-2)}` : '',
    lastTestAt: s.lastTestAt,
    lastTestError: s.lastTestError,
    // Webhook: the admin registers this exact URL (secret included) in the Delhivery
    // panel. Shown in full because only admins see settings and they need to copy it.
    hasWebhookSecret: !!s.webhookSecret,
    webhookUrl: s.webhookSecret
      ? `${(process.env.BACKEND_PUBLIC_URL || process.env.APP_URL || '').replace(/\/+$/, '')}/api/courier-integration/webhook?secret=${encodeURIComponent(s.webhookSecret)}`
      : '',
    webhookPath: `/api/courier-integration/webhook?secret=${s.webhookSecret ? encodeURIComponent(s.webhookSecret) : '<secret>'}`,
  };
}

// GET /api/courier-integration/public — tiny unauthenticated flag the storefront
// uses to hide the manual courier picker for India when the live courier handles it.
const publicStatus = async (req, res) => {
  try {
    const s = await delhivery.getIntegration();
    const liveActiveIN = !!(s.enabled && s.connected); // Delhivery = India only
    res.json({ success: true, data: { provider: s.provider, liveActiveIN, useLiveRates: !!(liveActiveIN && s.useLiveRates) } });
  } catch (e) {
    // Fail open: if we can't read settings, behave as if live courier is off.
    res.json({ success: true, data: { provider: 'delhivery', liveActiveIN: false, useLiveRates: false } });
  }
};

// POST /api/courier-integration/cart-rate { pincode, paymentMethod }
// Authenticated customer endpoint: the live Delhivery shipping cost for THIS
// user's cart to a destination pincode. Weight is computed server-side (same as
// createOrder) so the checkout display, the payment amount, and the final order
// all use one identical figure. Returns { ok, liveRate, shippingInr } — liveRate
// false (or ok false) means the caller should keep its manual weight-based rate.
const getCartLiveRate = async (req, res) => {
  try {
    const userId = req.userId;
    const pincode = String(req.body?.pincode || '').trim();
    const paymentType = req.body?.paymentMethod === 'COD' ? 'COD' : 'Pre-paid';

    const settings = await delhivery.getIntegration();
    // Only applies to India + live rates on + a valid destination pincode.
    if (!settings.useLiveRates || !delhivery.isLiveForRegion(settings, 'INR') || !settings.originPincode || !/^\d{6}$/.test(pincode)) {
      return res.json({ success: true, data: { ok: true, liveRate: false } });
    }

    const cart = await prisma.cart.findFirst({ where: { userId }, include: { items: true } });
    if (!cart || cart.items.length === 0) return res.json({ success: true, data: { ok: true, liveRate: false } });

    const { calculateLogistics } = require('../utils/logistics');
    const products = await Promise.all(cart.items.map((it) =>
      prisma.product.findUnique({ where: { id: it.productId }, select: { logisticsConfig: true } })
    ));
    let weightKg = 0;
    for (let i = 0; i < cart.items.length; i++) {
      const cfg = products[i]?.logisticsConfig;
      if (!cfg) continue;
      const r = calculateLogistics(cfg, cart.items[i].quantity, cart.items[i].transportType || undefined, 'IN');
      weightKg += Number(r.totalWeightKg) || 0;
    }
    const weightGrams = Math.max(1, Math.round(weightKg * 1000)) || settings.defaultWeightGrams;

    const q = await delhivery.rateQuote({ originPin: settings.originPincode, destPin: pincode, weightGrams, paymentType }, settings);
    if (!q.ok || !(q.amount > 0)) return res.json({ success: true, data: { ok: true, liveRate: false } });
    res.json({ success: true, data: { ok: true, liveRate: true, shippingInr: Math.round(q.amount * 100) / 100, weightGrams } });
  } catch (e) {
    console.error('getCartLiveRate:', e?.message || e);
    // Fail safe: tell the caller to use its manual rate.
    res.json({ success: true, data: { ok: false, liveRate: false } });
  }
};

// GET /api/courier-integration/admin — settings for the admin Settings tab.
const getSettings = async (req, res) => {
  try {
    const s = await delhivery.getIntegration();
    res.json({ success: true, data: publicView(s) });
  } catch (e) {
    console.error('courier getSettings:', e);
    res.status(500).json({ success: false, error: 'Failed to load courier settings' });
  }
};

// PUT /api/courier-integration/admin — save credentials/flags.
// Turning `enabled` on is what disables the manual courier method for IN orders.
const updateSettings = async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await delhivery.getIntegration();
    const data = { updatedBy: req.userId || null };

    if (b.enabled !== undefined) data.enabled = !!b.enabled;
    if (b.useLiveRates !== undefined) data.useLiveRates = !!b.useLiveRates;
    if (b.environment !== undefined) data.environment = b.environment === 'production' ? 'production' : 'staging';
    if (b.pickupName !== undefined) data.pickupName = String(b.pickupName || '').trim() || null;
    if (b.originPincode !== undefined) data.originPincode = String(b.originPincode || '').trim() || null;
    if (b.clientName !== undefined) data.clientName = String(b.clientName || '').trim() || null;
    // Only overwrite the token when a non-masked value is sent (blank = keep).
    if (typeof b.apiToken === 'string' && b.apiToken.trim() && !b.apiToken.includes('••')) {
      data.apiToken = b.apiToken.trim();
      data.connected = false; // a new token must be re-tested before it's trusted
    }
    const num = (v, min, max, d) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return d;
      return Math.min(max, Math.max(min, n));
    };
    if (b.defaultWeightGrams !== undefined) data.defaultWeightGrams = num(b.defaultWeightGrams, 1, 100000, existing.defaultWeightGrams);
    if (b.defaultLengthCm !== undefined) data.defaultLengthCm = num(b.defaultLengthCm, 1, 500, existing.defaultLengthCm);
    if (b.defaultWidthCm !== undefined) data.defaultWidthCm = num(b.defaultWidthCm, 1, 500, existing.defaultWidthCm);
    if (b.defaultHeightCm !== undefined) data.defaultHeightCm = num(b.defaultHeightCm, 1, 500, existing.defaultHeightCm);

    // Can't enable the integration without a token + pickup location.
    if (data.enabled) {
      const token = data.apiToken || existing.apiToken;
      const pickup = data.pickupName !== undefined ? data.pickupName : existing.pickupName;
      if (!token || !pickup) {
        return res.status(400).json({ success: false, error: 'Add the API token and pickup location before enabling.' });
      }
    }

    const saved = await prisma.courierIntegration.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: publicView(saved), message: 'Courier settings saved' });
  } catch (e) {
    console.error('courier updateSettings:', e);
    res.status(500).json({ success: false, error: 'Failed to save courier settings' });
  }
};

// POST /api/courier-integration/admin/webhook-secret — generate (or rotate) the
// webhook shared secret. Returns the full webhook URL to register in Delhivery.
const generateWebhookSecret = async (req, res) => {
  try {
    const crypto = require('crypto');
    const secret = crypto.randomBytes(24).toString('hex');
    const existing = await delhivery.getIntegration();
    const saved = await prisma.courierIntegration.update({ where: { id: existing.id }, data: { webhookSecret: secret } });
    res.json({ success: true, message: 'Webhook secret generated', data: publicView(saved) });
  } catch (e) {
    console.error('generateWebhookSecret:', e);
    res.status(500).json({ success: false, error: 'Failed to generate webhook secret' });
  }
};

// POST /api/courier-integration/admin/test — validate the token by hitting a
// lightweight serviceability lookup; records connected + lastTest.
const testConnection = async (req, res) => {
  try {
    const existing = await delhivery.getIntegration();
    if (!existing.apiToken) return res.status(400).json({ success: false, error: 'Add the API token first.' });
    const pin = String(req.body?.pin || '110001'); // New Delhi GPO as a default probe
    const r = await delhivery.checkServiceability(pin, existing);
    const okConn = r.ok; // a 200 from the API means the token authenticated
    // Friendlier guidance for the common failure modes.
    let friendly = r.error || 'test failed';
    if (r.error === 'http_401') {
      friendly = existing.environment === 'staging'
        ? 'Unauthorized (401). A LIVE Delhivery token only works on Production — switch Environment to Production and re-test. (Staging needs a separate UAT token from Delhivery.)'
        : 'Unauthorized (401). The API token is invalid or was not copied in full. Re-generate it in one.delhivery.com → API Setup and paste the complete token.';
    } else if (r.error === 'timeout' || r.error === 'network error') {
      friendly = 'Could not reach Delhivery. Check your internet/firewall and try again.';
    }
    await prisma.courierIntegration.update({
      where: { id: existing.id },
      data: { connected: okConn, lastTestAt: new Date(), lastTestError: okConn ? null : friendly },
    });
    if (!okConn) return res.status(400).json({ success: false, error: friendly });
    res.json({ success: true, message: 'Connected to Delhivery', data: { serviceable: r.serviceable, pin } });
  } catch (e) {
    console.error('courier testConnection:', e);
    res.status(500).json({ success: false, error: 'Connection test failed' });
  }
};

// GET /api/courier-integration/serviceability?pin=XXXXXX — pincode check (admin).
const serviceability = async (req, res) => {
  try {
    const pin = String(req.query.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ success: false, error: 'Enter a valid 6-digit pincode' });
    const r = await delhivery.checkServiceability(pin);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('courier serviceability:', e);
    res.status(500).json({ success: false, error: 'Serviceability check failed' });
  }
};

// POST /api/courier-integration/admin/register-pickup
// Registers a pickup location (ClientWarehouse) with Delhivery and stores its name
// + pincode as the integration's pickupName/originPincode. The name sent here is
// what every shipment's pickup_location must match.
const registerPickup = async (req, res) => {
  try {
    const { name, phone, email, address, city, state, pincode } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ success: false, error: 'Pickup location name is required' });
    if (!String(phone || '').trim()) return res.status(400).json({ success: false, error: 'Phone is required' });
    if (!String(address || '').trim()) return res.status(400).json({ success: false, error: 'Address is required' });
    if (!String(city || '').trim() || !String(state || '').trim()) return res.status(400).json({ success: false, error: 'City and state are required' });
    if (!/^\d{6}$/.test(String(pincode || ''))) return res.status(400).json({ success: false, error: 'A valid 6-digit pincode is required' });

    const nm = String(name).trim();
    const r = await delhivery.registerPickupLocation({ name: nm, phone, email, address, city, state, pincode });
    if (!r.ok) {
      // A "already exists" is effectively success — the name is usable.
      if (/already\s*exist/i.test(r.error || '')) {
        const s = await delhivery.getIntegration();
        await prisma.courierIntegration.update({ where: { id: s.id }, data: { pickupName: nm, originPincode: String(pincode) } });
        return res.json({ success: true, message: `Pickup location "${nm}" is already registered and is now set.` });
      }
      return res.status(502).json({ success: false, error: `Delhivery: ${r.error}` });
    }
    const s = await delhivery.getIntegration();
    await prisma.courierIntegration.update({ where: { id: s.id }, data: { pickupName: nm, originPincode: String(pincode) } });
    res.json({ success: true, message: `Pickup location "${nm}" registered with Delhivery and set as your pickup.` });
  } catch (e) {
    console.error('registerPickup:', e);
    res.status(500).json({ success: false, error: 'Failed to register pickup location' });
  }
};

// GET /api/courier-integration/rate?pin=XXXXXX&weight=<grams>&cod=0|1
// Live shipping-rate quote for a destination pincode + weight. Falls back to
// `ok:false` (caller uses the static rate) on any failure.
const rateQuote = async (req, res) => {
  try {
    const settings = await delhivery.getIntegration();
    if (!settings.originPincode) return res.status(400).json({ success: false, error: 'Set the origin pincode in settings first.' });
    const destPin = String(req.query.pin || '').trim();
    if (!/^\d{6}$/.test(destPin)) return res.status(400).json({ success: false, error: 'Enter a valid 6-digit pincode' });
    const weightGrams = Math.max(1, Math.round(Number(req.query.weight) || settings.defaultWeightGrams));
    const paymentType = String(req.query.cod) === '1' ? 'COD' : 'Pre-paid';
    const r = await delhivery.rateQuote({ originPin: settings.originPincode, destPin, weightGrams, paymentType }, settings);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true, data: { amountInr: r.amount, weightGrams, destPin } });
  } catch (e) {
    console.error('courier rateQuote:', e);
    res.status(500).json({ success: false, error: 'Rate quote failed' });
  }
};

// Convert a stored line dimensions snapshot ({length,width,height,unit}) to whole
// centimetres, or null when incomplete.
function dimsToCm(d) {
  if (!d) return null;
  const f = String(d.unit).toUpperCase() === 'IN' ? 2.54 : 1;
  const L = Math.round(Number(d.length) * f);
  const W = Math.round(Number(d.width) * f);
  const H = Math.round(Number(d.height) * f);
  if (!(L > 0 && W > 0 && H > 0)) return null;
  return { L, W, H, vol: L * W * H };
}

// Build a Delhivery shipment payload from an order document. The consignee details
// and the parcel weight/dimensions are taken DYNAMICALLY from the order; the
// settings `default*` values are fallbacks used only when a product carries no
// weight/dimensions in its logistics snapshot.
function buildShipmentPayload(order, settings) {
  const addr = (order.shippingAddress && typeof order.shippingAddress === 'object') ? order.shippingAddress : {};
  const isCod = order.paymentMethod === 'COD';
  // Field names as stored on the order's shippingAddress: street / addressLine2 /
  // addressLine3 / landmark for the address, zipCode for the pincode, firstName +
  // lastName for the name. (Tolerate legacy aliases too.)
  const line = [addr.street, addr.addressLine1, addr.addressLine2, addr.addressLine3, addr.landmark]
    .filter(Boolean).join(', ');
  const pincode = String(addr.zipCode || addr.pincode || addr.zip || addr.postalCode || '').trim();
  const fullName = order.customerName || [addr.firstName, addr.lastName].filter(Boolean).join(' ') || addr.name || 'Customer';

  // Real weight: sum each line's snapshotted total weight (already unit×qty, in kg).
  const totalWeightGrams = (order.items || []).reduce((w, it) => {
    const kg = Number(it.logistics?.totalWeightKg);
    return w + (Number.isFinite(kg) ? kg * 1000 : 0);
  }, 0);
  const weight = Math.max(1, Math.round(totalWeightGrams || settings.defaultWeightGrams));

  // Real dimensions: a parcel ships as ONE box, so use the largest line's
  // dimensions (by volume) as representative; fall back to the configured box.
  const biggest = (order.items || [])
    .map((it) => dimsToCm(it.logistics?.dimensions))
    .filter(Boolean)
    .sort((a, b) => b.vol - a.vol)[0];
  const length = biggest?.L || settings.defaultLengthCm;
  const width = biggest?.W || settings.defaultWidthCm;
  const height = biggest?.H || settings.defaultHeightCm;

  const desc = (order.items || []).map((i) => i.productName || i.name).filter(Boolean).slice(0, 5).join(', ') || 'Order items';
  const qty = (order.items || []).reduce((n, it) => n + (it.quantity || 1), 0) || 1;

  return {
    name: fullName,
    add: line || addr.address || '',
    pin: pincode,
    city: addr.city || '',
    state: addr.state || '',
    country: 'India',
    phone: String(order.customerPhone || addr.phone || ''),
    order: order.orderId,
    payment_mode: isCod ? 'COD' : 'Prepaid',
    products_desc: desc,
    cod_amount: isCod ? (order.totalAmountINR != null ? order.totalAmountINR : order.totalAmount) : 0,
    total_amount: order.totalAmountINR != null ? order.totalAmountINR : order.totalAmount,
    quantity: qty,
    weight, // grams, from the order's products
    shipment_width: width,
    shipment_height: height,
    shipment_length: length,
    seller_name: settings.clientName || 'M2C',
  };
}

// POST /api/courier-integration/orders/:orderId/ship — create the Delhivery
// shipment for an order (auto AWB), store AWB + label on the order, and (best
// effort) fetch the label. The order must be at the APPROVED_BY_ADMIN_HUB stage.
const createOrderShipment = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    const settings = await delhivery.getIntegration();
    if (!delhivery.isLiveForRegion(settings, order.currency)) {
      return res.status(400).json({ success: false, error: 'Live courier is not active for this order.' });
    }
    if (order.trackingReference && order.shippingProvider === 'delhivery') {
      return res.status(409).json({ success: false, error: `A shipment (AWB ${order.trackingReference}) already exists.` });
    }

    const payload = buildShipmentPayload(order, settings);
    if (!payload.pin || !payload.phone || !payload.add) {
      return res.status(400).json({ success: false, error: 'Order address is incomplete (pincode/phone/address).' });
    }

    const created = await delhivery.createShipment(payload, settings);
    if (!created.ok) return res.status(502).json({ success: false, error: `Delhivery: ${created.error}` });

    const label = await delhivery.getLabel(created.awb, settings).catch(() => ({ ok: false }));
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        trackingReference: created.awb,
        shippingProvider: 'delhivery',
        shippingLabelUrl: label.ok ? label.labelUrl : null,
      },
    });
    res.json({ success: true, message: `Shipment created — AWB ${created.awb}`, data: { awb: created.awb, labelUrl: updated.shippingLabelUrl } });
  } catch (e) {
    console.error('createOrderShipment:', e);
    res.status(500).json({ success: false, error: 'Failed to create shipment' });
  }
};

// GET /api/courier-integration/orders/:orderId/label — (re)fetch the label URL.
const getOrderLabel = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
    if (!order?.trackingReference) return res.status(404).json({ success: false, error: 'No AWB for this order' });
    const r = await delhivery.getLabel(order.trackingReference);
    if (!r.ok) return res.status(502).json({ success: false, error: r.error });
    if (r.labelUrl && r.labelUrl !== order.shippingLabelUrl) {
      await prisma.order.update({ where: { id: order.id }, data: { shippingLabelUrl: r.labelUrl } });
    }
    res.json({ success: true, data: { labelUrl: r.labelUrl } });
  } catch (e) {
    console.error('getOrderLabel:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch label' });
  }
};

// GET /api/courier-integration/orders/:orderId/track — refresh tracking status AND
// apply it to the order lifecycle (sync-on-click), so the admin clicking Track
// advances the order exactly like the webhook would (Delivered/Cancelled/etc.).
const trackOrder = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
    if (!order?.trackingReference) return res.status(404).json({ success: false, error: 'No AWB for this order' });
    const r = await delhivery.track(order.trackingReference);
    if (!r.ok) return res.status(502).json({ success: false, error: r.error });
    if (r.found) {
      const { applyCourierStatusToOrder } = require('./adminOrderController');
      await applyCourierStatusToOrder({
        order,
        statusStr: r.status,
        statusType: r.statusType,
        actor: { id: req.userId || null, name: req.user?.name || 'Admin', type: 'admin' },
      }).catch((e) => console.warn('[trackOrder] sync failed:', e?.message || e));
    }
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('trackOrder:', e);
    res.status(500).json({ success: false, error: 'Failed to track shipment' });
  }
};

// POST /api/courier-integration/webhook?secret=<secret>
// Delhivery status push. Public (no auth) — authenticated by the shared secret in
// the query/body. Delhivery's payload nests the shipment under Shipment{...}; we
// parse defensively and apply the status to the order lifecycle (idempotent).
const webhook = async (req, res) => {
  try {
    const settings = await delhivery.getIntegration();
    const secret = settings.webhookSecret;
    const provided = req.query?.secret || req.body?.secret || req.headers['x-webhook-secret'];
    if (!secret || provided !== secret) {
      return res.status(401).json({ success: false, error: 'Invalid webhook secret' });
    }
    // Delhivery sends { Shipment: { AWB/Waybill, Status: { Status, StatusType } } }
    // (shapes vary a little between accounts) — read it defensively.
    const body = req.body || {};
    const ship = body.Shipment || body.shipment || body;
    const awb = String(ship.AWB || ship.Waybill || ship.waybill || body.waybill || '').trim();
    const statusObj = ship.Status || ship.status || {};
    const statusStr = statusObj.Status || statusObj.status || ship.ShipmentStatus || body.Status || '';
    const statusType = statusObj.StatusType || statusObj.statusType || '';
    if (!awb) return res.status(200).json({ success: true, ignored: 'no awb' });

    const order = await prisma.order.findFirst({ where: { trackingReference: awb, shippingProvider: 'delhivery' } });
    if (!order) return res.status(200).json({ success: true, ignored: 'no matching order' });

    const { applyCourierStatusToOrder } = require('./adminOrderController');
    const result = await applyCourierStatusToOrder({
      order, statusStr, statusType,
      actor: { name: 'Delhivery webhook', type: 'system' },
    });
    // Always 200 so Delhivery doesn't retry-storm on a benign no-op.
    res.status(200).json({ success: true, changed: !!result?.changed, target: result?.target || null });
  } catch (e) {
    console.error('courier webhook:', e?.message || e);
    res.status(200).json({ success: true, error: 'handled with error' });
  }
};

// POST /api/courier-integration/orders/:orderId/cancel — cancel the AWB (RTO).
const cancelOrderShipment = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
    if (!order?.trackingReference) return res.status(404).json({ success: false, error: 'No AWB for this order' });
    const r = await delhivery.cancelShipment(order.trackingReference);
    if (!r.ok) return res.status(502).json({ success: false, error: r.error });
    await prisma.order.update({
      where: { id: order.id },
      data: { lastCourierStatus: 'Cancelled', lastCourierStatusAt: new Date() },
    });
    res.json({ success: true, message: 'Shipment cancelled' });
  } catch (e) {
    console.error('cancelOrderShipment:', e);
    res.status(500).json({ success: false, error: 'Failed to cancel shipment' });
  }
};

module.exports = {
  publicStatus,
  getCartLiveRate,
  webhook,
  generateWebhookSecret,
  getSettings,
  updateSettings,
  testConnection,
  serviceability,
  rateQuote,
  registerPickup,
  createOrderShipment,
  getOrderLabel,
  trackOrder,
  cancelOrderShipment,
  buildShipmentPayload,
};
