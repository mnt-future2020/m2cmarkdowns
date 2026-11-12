const { prisma } = require('../config/database');
const { resolveDeliveryZone, getShippingGstPct, combineShipping, findOverlap } = require('../utils/deliveryZone');

const toNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── Admin CRUD ───────────────────────────────────────────────────────────────

exports.listZones = async (req, res) => {
    try {
        const zones = await prisma.deliveryZone.findMany({ orderBy: [{ countryName: 'asc' }, { name: 'asc' }] });
        const shippingGstPercentage = await getShippingGstPct();
        res.json({ success: true, data: zones, shippingGstPercentage });
    } catch (e) {
        console.error('listZones error:', e);
        res.status(500).json({ success: false, message: 'Failed to load delivery zones' });
    }
};

function sanitizeZoneBody(b) {
    const states = Array.isArray(b.states)
        ? b.states.map((s) => ({ iso: String(s.iso || '').trim(), name: String(s.name || '').trim() })).filter((s) => s.iso || s.name)
        : [];
    const cities = Array.isArray(b.cities) ? b.cities.map((c) => String(c || '').trim()).filter(Boolean) : [];
    return {
        name: String(b.name || '').trim(),
        countryIso: String(b.countryIso || '').trim().toUpperCase(),
        countryName: String(b.countryName || '').trim(),
        allStates: !!b.allStates,
        states: b.allStates ? [] : states,
        allCities: !!b.allCities,
        cities: (b.allStates || b.allCities) ? [] : cities,
        flatFee: Math.max(0, toNum(b.flatFee, 0)),
        isActive: b.isActive === undefined ? true : !!b.isActive,
    };
}

exports.createZone = async (req, res) => {
    try {
        const data = sanitizeZoneBody(req.body);
        if (!data.name || !data.countryIso || !data.countryName) {
            return res.status(400).json({ success: false, message: 'Zone name and country are required.' });
        }
        if (!data.allStates && data.states.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one state, or choose all states.' });
        }
        const existing = await prisma.deliveryZone.findMany();
        const overlap = findOverlap(data, existing);
        if (overlap) return res.status(409).json({ success: false, message: `This location is already covered — ${overlap}.` });
        const zone = await prisma.deliveryZone.create({ data });
        res.status(201).json({ success: true, data: zone });
    } catch (e) {
        console.error('createZone error:', e);
        res.status(500).json({ success: false, message: 'Failed to create delivery zone' });
    }
};

exports.updateZone = async (req, res) => {
    try {
        const { id } = req.params;
        const data = sanitizeZoneBody(req.body);
        if (!data.name || !data.countryIso || !data.countryName) {
            return res.status(400).json({ success: false, message: 'Zone name and country are required.' });
        }
        if (!data.allStates && data.states.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one state, or choose all states.' });
        }
        const existing = (await prisma.deliveryZone.findMany()).filter((z) => z.id !== id);
        const overlap = findOverlap(data, existing);
        if (overlap) return res.status(409).json({ success: false, message: `This location is already covered — ${overlap}.` });
        const zone = await prisma.deliveryZone.update({ where: { id }, data });
        res.json({ success: true, data: zone });
    } catch (e) {
        console.error('updateZone error:', e);
        res.status(500).json({ success: false, message: 'Failed to update delivery zone' });
    }
};

exports.deleteZone = async (req, res) => {
    try {
        await prisma.deliveryZone.delete({ where: { id: req.params.id } });
        res.json({ success: true, message: 'Delivery zone deleted' });
    } catch (e) {
        console.error('deleteZone error:', e);
        res.status(500).json({ success: false, message: 'Failed to delete delivery zone' });
    }
};

// Set the single global shipping GST % (stored on InvoiceSettings).
exports.updateShippingGst = async (req, res) => {
    try {
        const pct = Math.max(0, toNum(req.body.shippingGstPercentage, 0));
        let s = await prisma.invoiceSettings.findFirst();
        if (!s) {
            const now = new Date();
            s = await prisma.invoiceSettings.create({
                data: { financialYearStart: now, financialYearEnd: now, shippingGstPercentage: pct },
            });
        } else {
            s = await prisma.invoiceSettings.update({ where: { id: s.id }, data: { shippingGstPercentage: pct } });
        }
        res.json({ success: true, shippingGstPercentage: s.shippingGstPercentage || 0 });
    } catch (e) {
        console.error('updateShippingGst error:', e);
        res.status(500).json({ success: false, message: 'Failed to update shipping GST' });
    }
};

// ── Public quote (checkout order summary) ────────────────────────────────────
// Returns serviceability + the INR shipping breakdown for an address. Display
// only — order creation recomputes everything authoritatively.
exports.quoteDelivery = async (req, res) => {
    try {
        const { country, state, city, pincode, currency, weightShippingInr = 0, freeShipping = false } = req.body || {};

        // When the live courier (Delhivery) is active for India, IT decides the
        // delivery area + price — delivery zones are bypassed for India. Shipping GST
        // still applies (tax requirement); there's no zone flat fee in this mode.
        const delhivery = require('../utils/delhivery');
        const integ = await delhivery.getIntegration();
        const isIndia = String(country || '').trim().toLowerCase() === 'india' || String(currency || '').toUpperCase() === 'INR';
        if (isIndia && delhivery.isLiveForRegion(integ, 'INR')) {
            const pin = String(pincode || '').trim();
            let serviceable = true; // fail open on a transient API error (Delhivery serves most of India)
            if (/^\d{6}$/.test(pin)) {
                const s = await delhivery.checkServiceability(pin, integ).catch(() => null);
                if (s && s.ok) serviceable = !!s.serviceable;
            }
            if (!serviceable) return res.json({ success: true, serviceable: false });
            const shippingGstPct = await getShippingGstPct();
            const b = combineShipping({ weightShippingInr: toNum(weightShippingInr), zoneFlatFee: 0, shippingGstPct, freeShipping: !!freeShipping });
            return res.json({ success: true, serviceable: true, zone: { name: 'Delhivery (live courier)', flatFee: 0 }, shippingGstPct, ...b });
        }

        const zone = await resolveDeliveryZone({ country, state, city });
        if (!zone) {
            return res.json({ success: true, serviceable: false });
        }
        const shippingGstPct = await getShippingGstPct();
        const b = combineShipping({ weightShippingInr: toNum(weightShippingInr), zoneFlatFee: zone.flatFee, shippingGstPct, freeShipping: !!freeShipping });
        res.json({
            success: true,
            serviceable: true,
            zone: { id: zone.id, name: zone.name, flatFee: zone.flatFee },
            shippingGstPct,
            ...b,
        });
    } catch (e) {
        console.error('quoteDelivery error:', e);
        res.status(500).json({ success: false, message: 'Failed to quote delivery' });
    }
};
