/**
 * Server-side shipping calculation.
 *
 * A faithful port of frontend/src/lib/logistics.ts. The two MUST stay in step:
 * the client renders the figure in the order summary and the server is what
 * actually charges it, so any divergence is a payment/invoice mismatch. If you
 * change one, change the other.
 *
 * CURRENCY: `airCostPerKg` / `shipCostPerKg` are entered by the vendor in RUPEES
 * (the product form labels them "₹"). This module therefore always returns INR.
 * Callers pricing a USD order must convert — see convertShippingToOrderCurrency.
 */

/** Normalise a weight in the config's unit of measure to kilograms. */
function toKg(weight, uom) {
    const w = Number(weight) || 0;
    if (uom === 'GRAM') return w / 1000;
    if (uom === 'TON') return w * 1000;
    return w;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Shipping cost for one cart line, in INR.
 *
 * `logisticsConfig` is an untyped Json column, so every field is treated as
 * possibly-missing: seed data in this repo uses a different shape entirely
 * ({ mode, weightKg, ... }) and would otherwise produce NaN. A config we cannot
 * read yields 0 rather than a wrong number.
 *
 * @param {object|null} config   Product.logisticsConfig
 * @param {number} quantity
 * @param {string} [overrideTransport]  'AIR' | 'SHIP'
 * @returns {{ totalShippingCost: number, totalWeightKg: number,
 *             selectedTransport: string|null, exceedsMaxWeight: boolean }}
 */
function calculateLogistics(config, quantity, overrideTransport, region) {
    const empty = {
        totalShippingCost: 0,
        totalWeightKg: 0,
        selectedTransport: null,
        exceedsMaxWeight: false,
    };
    if (!config || typeof config !== 'object') return empty;

    const transportTypes = Array.isArray(config.transportTypes) ? config.transportTypes : [];
    const weightRanges = Array.isArray(config.weightRanges) ? config.weightRanges : [];

    const unitWeightKg = toKg(config.unitWeight, config.weightUom);
    const totalWeightKg = unitWeightKg * (Number(quantity) || 0);
    const maxWeightKg = toKg(config.maxWeight, config.weightUom);
    const exceedsMaxWeight = maxWeightKg > 0 && totalWeightKg > maxWeightKg;

    // Weight-band recommendation, region-aware. A range's transport can be:
    //   AIR     → both markets, resolves to AIR
    //   SEA     → international (.com) only, resolves to SHIP
    //   SURFACE → domestic India (.in) only, resolves to SHIP
    //   SHIP    → legacy (pre sea/surface split), applies to both, resolves to SHIP
    // Ranges that don't apply to this market are skipped, so each market can carry
    // its own Air↔Ship crossover weights.
    const isDomesticMkt = String(region || '').toUpperCase() === 'IN';
    const rangeModeForRegion = (t) => {
        const v = String(t || '').toUpperCase();
        if (v === 'AIR') return 'AIR';
        if (v === 'SURFACE') return isDomesticMkt ? 'SHIP' : null;
        if (v === 'SEA') return isDomesticMkt ? null : 'SHIP';
        if (v === 'SHIP') return 'SHIP';
        return null;
    };
    // No fallback: a mode is recommended ONLY when the order weight actually falls
    // inside a configured range for this market. If nothing matches, there is no
    // recommendation and the shopper chooses the shipping method themselves.
    let recommendedTransport = null;
    for (const range of weightRanges) {
        const mode = rangeModeForRegion(range.recommendedTransport);
        if (mode == null) continue; // range not for this market
        if (totalWeightKg >= Number(range.minWeight) && totalWeightKg <= Number(range.maxWeight)) {
            recommendedTransport = mode;
            break;
        }
    }
    // A single configured transport is the only option — use it (not a fallback).
    if (transportTypes.length === 1) recommendedTransport = transportTypes[0];

    const selectedTransport = overrideTransport && transportTypes.includes(overrideTransport)
        ? overrideTransport
        : recommendedTransport;

    // The SHIP lane is SEA (international) or SURFACE (domestic India) depending on the
    // market. Domestic uses surfaceCostPerKg, falling back to shipCostPerKg for legacy
    // products that predate the split. AIR is a single shared lane.
    const isDomestic = String(region || '').toUpperCase() === 'IN';
    const shipCostPerKg = isDomestic
        ? (config.surfaceCostPerKg != null ? config.surfaceCostPerKg : config.shipCostPerKg)
        : config.shipCostPerKg;
    // No mode selected (weight outside every configured range, no override) → no
    // quote. Only AIR or SHIP produce a cost.
    const shippingCostPerKg = selectedTransport === 'AIR'
        ? (Number(config.airCostPerKg) || 0)
        : selectedTransport === 'SHIP'
            ? (Number(shipCostPerKg) || 0)
            : 0;

    const totalShippingCost = round2(totalWeightKg * shippingCostPerKg);

    return {
        totalShippingCost: Number.isFinite(totalShippingCost) ? totalShippingCost : 0,
        totalWeightKg,
        selectedTransport,
        exceedsMaxWeight,
    };
}

/**
 * Convert an INR shipping figure into the order's currency.
 * Uses the order's own rate snapshot so it lines up with every other money field
 * on that order (see utils/orderCurrency.js).
 */
function convertShippingToOrderCurrency(inrAmount, currency, rate) {
    if (currency !== 'USD') return round2(inrAmount);
    if (!rate || rate <= 0) return round2(inrAmount);
    return round2(inrAmount / rate);
}

/**
 * Does this order qualify for free shipping?
 *
 * Mirrors couponController.applyFreeShippingOffer, which the cart calls to show
 * the banner — re-derived here so the charge does not depend on a client flag.
 *
 * @param {object} args
 * @param {object} args.prisma
 * @param {string} args.userId
 * @param {number} args.cartTotalInr  Goods subtotal in INR.
 * @param {boolean} [args.couponGrantsFreeShipping] From the validated coupon.
 */
async function qualifiesForFreeShipping({ prisma, userId, cartTotalInr, couponGrantsFreeShipping, region }) {
    if (couponGrantsFreeShipping) return true;

    const { isVisibleInRegion } = require('./regionVisibility');

    const offers = await prisma.freeShippingOffer.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
    });
    if (offers.length === 0) return false;

    // orderNumbers is "which of this customer's orders are free" — the order being
    // placed right now is their (count + 1)th.
    const orderCount = await prisma.order.count({ where: { customerId: userId } });
    const nextOrderNumber = orderCount + 1;

    for (const offer of offers) {
        // Region gate — an offer only applies on the storefront it targets.
        if (!isVisibleInRegion(offer.region, region)) continue;
        if (offer.minOrderValue > 0 && cartTotalInr < offer.minOrderValue) continue;
        if (offer.orderNumbers?.length > 0 && !offer.orderNumbers.includes(nextOrderNumber)) continue;
        return true;
    }
    return false;
}

module.exports = { toKg, calculateLogistics, convertShippingToOrderCurrency, qualifiesForFreeShipping };
