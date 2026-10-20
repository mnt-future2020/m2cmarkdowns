const crypto = require('crypto');
const { prisma } = require('../config/database');
const { generateInvoiceNo } = require('../utils/invoiceGenerator');
const { ACTIVE_ITEMS_FILTER } = require('../utils/activeItemsFilter');

// Prune items belonging to a CANCELLED/RETURNED shipment (reship scenario) — but
// ONLY for live orders. A fully cancelled/returned ORDER has all its shipments
// cancelled, so the shipment-status filter would wrongly empty it; there the
// customer must still see everything they ordered. Include shipment.status on the
// items query for this to work, then run each fetched order through here.
const CANCELLED_OR_RETURNED = ['CANCELLED', 'RETURNED'];
function pruneReshippedItems(order) {
    if (!order || !Array.isArray(order.items)) return order;
    if (!CANCELLED_OR_RETURNED.includes(order.status)) {
        order.items = order.items.filter(
            (it) => !it.shipmentId || !CANCELLED_OR_RETURNED.includes(it.shipment?.status),
        );
    }
    // Drop the helper relation we only pulled for the check above.
    order.items = order.items.map(({ shipment, ...rest }) => rest);
    return order;
}
const ITEMS_WITH_SHIPMENT_STATUS = { include: { shipment: { select: { status: true } } } };

// Attach each order item's live product return-eligibility flag (`returnable`).
// OrderItems are frozen snapshots and don't carry it, so the storefront can't tell
// whether a return is allowed without this. In-memory only — never persisted.
// Defaults to true when the product is missing (e.g. deleted) to match the schema.
async function attachItemReturnable(orders) {
    const list = Array.isArray(orders) ? orders : [orders];
    const ids = [...new Set(list.flatMap((o) => (o?.items || []).map((it) => it.productId).filter(Boolean)))];
    if (ids.length === 0) return;
    const products = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, returnable: true },
    });
    const byId = new Map(products.map((p) => [p.id, p.returnable !== false]));
    for (const o of list) {
        for (const it of (o?.items || [])) {
            it.returnable = it.productId && byId.has(it.productId) ? byId.get(it.productId) : true;
        }
    }
}
const { notifications } = require('../utils/notificationService');
const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
const { withRetry } = require('../utils/dbRetry');
const { resolveUsdRate, toINR, resolveUnitPrice } = require('../utils/orderCurrency');
const { evaluateCoupon } = require('../utils/couponPricing');
const { calculateLogistics, convertShippingToOrderCurrency, qualifiesForFreeShipping } = require('../utils/logistics');
const { resolveDeliveryZone, getShippingGstPct } = require('../utils/deliveryZone');
const { isVisibleInRegion, normalizeRegion } = require('../utils/regionVisibility');
const { isIntrastate, splitLineTax } = require('../utils/gst');
const { isCourierAvailable } = require('../utils/couriers');
const { applyBestOffer, qualifyingThresholdIds, qualifyingCrossBogo, offerAppliesToFreeSet } = require('../utils/offers');

/** Round a money value to 2 decimals, avoiding float artefacts (e.g. 115.19999). */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Create new order
const createOrder = async (req, res) => {
    try {
        const userId = req.userId; // user ID from auth middleware
        const {
            shippingAddress,
            paymentMethod,
            paymentId, // from payment gateway (e.g., Stripe, Razorpay)
            // Razorpay signature payload. When present, signature verification
            // happens inline here so the client can replace its prior two-step
            // (verify → createOrder) flow with a single round trip.
            razorpayOrderId = null,
            razorpaySignature = null,
            shippingCost = 0,
            tax = 0,
            discount = 0,
            couponCode = null,
            currency = 'INR',
        } = req.body;

        // 1. Validate Input
        if (!shippingAddress || !paymentMethod) {
            return res.status(400).json({
                success: false,
                error: 'Shipping address and payment method are required'
            });
        }

        // 2. Parallel pre-flight: cart, user, bag type, and payment settings
        // (when Razorpay verification is required). These reads are independent
        // of each other, so running them concurrently removes ~3 sequential
        // round trips from the critical path on Vercel.
        //
        // generateInvoiceNo is intentionally NOT included here — it mutates the
        // invoice-sequence counter, so we only call it after all validation
        // passes (otherwise a rejected request would burn an invoice number).
        // Any non-COD order MUST carry a verifiable payment. This used to be
        // opt-in (`razorpayOrderId && razorpaySignature && paymentId`), which meant
        // POSTing an order with no payment fields skipped verification entirely and
        // still got written `paymentStatus: 'PAID'` below.
        // COD and a fully-wallet-covered order carry no gateway payment, so they
        // skip Razorpay verification. A partial-wallet order still pays the rest
        // via Razorpay (paymentMethod stays 'razorpay').
        const isPrepaid = paymentMethod !== 'COD' && paymentMethod !== 'WALLET';
        const needsRazorpayVerification = isPrepaid;
        if (isPrepaid && !(razorpayOrderId && razorpaySignature && paymentId)) {
            return res.status(400).json({
                success: false,
                error: 'Payment verification failed - missing payment details'
            });
        }

        const [cart, user, paymentSettings, existingOrderForPayment] = await Promise.all([
            prisma.cart.findFirst({ where: { userId }, include: { items: true } }),
            prisma.user.findUnique({ where: { id: userId } }),
            needsRazorpayVerification
                // keyId is needed as well: the amount reconciliation below fetches the
                // Razorpay order to confirm the customer actually paid this cart's total.
                ? prisma.paymentSettings.findFirst({ select: { razorpayKeyId: true, razorpayKeySecret: true } })
                : Promise.resolve(null),
            // Idempotency guard: a gateway payment id can only ever produce one
            // order. If the client retries after a network failure (response
            // lost but the first attempt committed), return the existing order
            // instead of charging stock/settlements twice.
            paymentId
                ? prisma.order.findFirst({
                    where: { paymentId, customerId: userId },
                    include: { items: ACTIVE_ITEMS_FILTER },
                })
                : Promise.resolve(null),
        ]);

        if (existingOrderForPayment) {
            return res.status(200).json({
                success: true,
                message: 'Order already placed for this payment',
                data: existingOrderForPayment,
                duplicate: true,
            });
        }

        // Verify Razorpay signature inline (server-side check is mandatory —
        // we never trust a payment id that has not been HMAC-verified).
        if (needsRazorpayVerification) {
            if (!paymentSettings || !paymentSettings.razorpayKeySecret) {
                return res.status(500).json({
                    success: false,
                    error: 'Payment verification failed - configuration error'
                });
            }
            const expectedSignature = crypto
                .createHmac('sha256', paymentSettings.razorpayKeySecret)
                .update(`${razorpayOrderId}|${paymentId}`)
                .digest('hex');
            if (expectedSignature !== razorpaySignature) {
                return res.status(400).json({
                    success: false,
                    error: 'Payment verification failed - invalid signature'
                });
            }
        }

        if (!cart || cart.items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Cart is empty'
            });
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // 3. Validate Stock and Calculate Totals
        // Resolve the FX rate up front: every money field written below needs an INR
        // twin, and those must all share one rate for the order to be internally
        // consistent. Snapshotting also stops admin rate edits rewriting this order.
        const orderExchangeRate = currency === 'USD' ? await resolveUsdRate(prisma) : null;
        // Customer GST/tax is charged ONLY on the `.in` storefront (currency INR).
        // On `.com` and every other region tax is 0 and no tax line is shown. This
        // gates the customer rate only — vendor settlement GST (below) is a separate
        // payout tied to the vendor's GSTIN, not the storefront, and is unaffected.
        const taxApplies = normalizeRegion(currency) === 'IN';

        // GST place-of-supply split: SUPPLIER = the Admin/Company registered State,
        // PLACE OF SUPPLY = the customer's shipping State. Same state -> intrastate
        // (CGST+SGST); different -> interstate (IGST). Vendor/warehouse/hub location
        // is deliberately NOT used. Only relevant when tax applies (`.in`).
        let intrastate = false;
        if (taxApplies) {
            const company = await prisma.companyInfo.findFirst({ select: { state: true, country: true } });
            intrastate = isIntrastate(
                company?.state, shippingAddress?.state,
                company?.country, shippingAddress?.country,
            );
        }

        let subtotal = 0;
        // Customer GST accumulated per line below. The client also sends a `tax`,
        // but it is advisory only — this server-side figure is what gets stored.
        let computedTax = 0;
        // Shipping accumulated per line from each product's logisticsConfig, in INR
        // (the per-kg rates are entered in rupees). Converted to the order currency
        // once the goods subtotal is known.
        let computedShippingInr = 0;
        const orderItemsData = [];
        const stockUpdates = [];
        const vendorTotals = {}; // Tracks vendor amounts using their base prices


        // Fetch all products in parallel — sequential awaits add latency that
        // pushes the downstream transaction past its 5s default on cold starts.
        // Invoice-no generation runs alongside the product fetches because it
        // is independent of cart contents (saves one more round trip).
        const orderNow = new Date();
        const [productsForItems, invoiceNo, activeOffers] = await Promise.all([
            Promise.all(
                cart.items.map((item) =>
                    prisma.product.findUnique({
                        where: { id: item.productId },
                        include: {
                            vendor: true,
                            variants: item.variantId ? { where: { id: item.variantId } } : false,
                            images: { where: { isPrimary: true }, take: 1 }
                        }
                    })
                )
            ),
            generateInvoiceNo(prisma),
            // Live offers, loaded once for the whole cart. Empty (the common case)
            // means the pricing below is byte-identical to the pre-offer behaviour.
            prisma.offer.findMany({
                where: { isActive: true, startsAt: { lte: orderNow }, endsAt: { gte: orderNow } },
            }),
        ]);

        // Customer targeting: a targeted offer applies ONLY for the customers it
        // names. Drop the rest so this buyer can never receive someone else's
        // private offer; untargeted offers (the norm) stay in for everyone.
        const scopedOffers = activeOffers.filter(
            (o) => !(Array.isArray(o.targetCustomerIds) && o.targetCustomerIds.length > 0)
                || o.targetCustomerIds.includes(userId)
        );

        // THRESHOLD offers ("spend ₹X, get Y% off") fire on the whole-cart value, which
        // isn't known until the lines are priced. A lightweight pre-pass sums the INR
        // selling price of every buyable line so we know which threshold offers qualify
        // before the real pricing loop runs. Empty offers → empty set → no effect.
        let preSubtotalINR = 0;
        for (let i = 0; i < cart.items.length; i++) {
            const p = productsForItems[i];
            if (!p) continue;
            const v = cart.items[i].variantId && p.variants?.length > 0 ? p.variants[0] : null;
            preSubtotalINR += resolveUnitPrice(v || p, 'INR', null) * cart.items[i].quantity;
        }
        const thresholdEligibleIds = qualifyingThresholdIds(scopedOffers, preSubtotalINR, currency, orderNow);

        // Cross-product BOGO ("buy A get B free") is delivered as free-gift lines that the
        // cart auto-added/chose (isFreeGift, price 0). Re-validate them here: the buy
        // condition must still hold and the gifted product must belong to the offer's free
        // set — otherwise the cart changed since the gift was granted and we reject so the
        // customer can review rather than get a free item they no longer qualify for.
        const giftBuyLines = [];
        for (let i = 0; i < cart.items.length; i++) {
            const p = productsForItems[i];
            if (!p || cart.items[i].isFreeGift) continue;
            giftBuyLines.push({ product: p, quantity: cart.items[i].quantity, isFreeGift: false });
        }
        const qualifyingGiftOfferIds = new Set(
            qualifyingCrossBogo(scopedOffers, giftBuyLines, currency, orderNow).map((q) => q.offer.id)
        );

        for (let i = 0; i < cart.items.length; i++) {
            const item = cart.items[i];
            const product = productsForItems[i];

            if (!product) {
                return res.status(404).json({
                    success: false,
                    error: `Product not found for item ID: ${item.id}`
                });
            }

            if (!product.inStock) {
                return res.status(400).json({
                    success: false,
                    error: `Product is out of stock: ${product.name}`
                });
            }

            const variant = item.variantId && product.variants?.length > 0 ? product.variants[0] : null;

            // Check stock
            const checkStock = variant ? variant.stock : product.totalStock;
            if (product.trackInventory && checkStock < item.quantity) {
                return res.status(400).json({
                    success: false,
                    error: `Insufficient stock for product: ${product.name}`
                });
            }

            // Region gate — the last line of defence. A cart built on .in can't be
            // checked out on .com (and vice-versa): the item may have been added
            // before a visibility change, or the region switched mid-session. Uses
            // the order currency (INR=.in, USD=.com).
            const skuVisibility = variant ? variant.priceVisibility : product.priceVisibility;
            if (!isVisibleInRegion(skuVisibility, currency)) {
                return res.status(400).json({
                    success: false,
                    error: `"${product.name}" is not available in your region. Please remove it to continue.`
                });
            }

            // A free-gift line ("Buy A get B free"): validate it still qualifies, then
            // price it at 0. If the buy condition or free set no longer holds, the cart
            // changed since the gift was granted — reject so nothing free slips through.
            const isGift = !!item.isFreeGift;
            if (isGift) {
                const giftOffer = scopedOffers.find((o) => o.id === item.giftOfferId);
                const valid = giftOffer
                    && qualifyingGiftOfferIds.has(item.giftOfferId)
                    && offerAppliesToFreeSet(giftOffer, product);
                if (!valid) {
                    return res.status(400).json({
                        success: false,
                        error: `Your free gift "${product.name}" is no longer valid because your cart changed. Please review your cart and try again.`,
                    });
                }
            }

            // Price the line in the order's currency. Shared with the storefront's
            // getRegionalPrice() chain — see resolveUnitPrice() for why a USD order
            // must convert from INR rather than fall through to an INR field.
            const sellingUnitPrice = isGift ? 0 : resolveUnitPrice(variant || product, currency, orderExchangeRate);

            // Apply the best automatic Offer to the SELLING price only. This never
            // touches vendorPrice below, so the vendor settlement is unchanged — M2C's
            // margin absorbs the discount. With no live offers, applyBestOffer returns
            // the price untouched and offer=null, so this is a no-op for every existing
            // order. Offer eligibility (category/product, region, min-qty) is resolved
            // server-side here; the storefront badge is only advisory. Gift lines skip
            // this entirely — they are already ₹0.
            const offerResult = isGift
                ? { unitPrice: 0 }
                : applyBestOffer({
                    product,
                    sellingUnitPrice,
                    quantity: item.quantity,
                    currency,
                    rate: orderExchangeRate,
                    offers: scopedOffers,
                    now: orderNow,
                    thresholdEligibleIds,
                });
            const unitPrice = offerResult.unitPrice;

            // Round per line as well: the invoice prints each item's totalPrice,
            // so the printed item lines must sum to the printed subtotal.
            const itemTotal = round2(unitPrice * item.quantity);
            subtotal += itemTotal;

            // Customer GST, recomputed from the product's own rate against the SAME
            // base the customer is charged (itemTotal). Never trust the client's
            // figure: this lands on a document titled "TAX INVOICE" and feeds every
            // revenue report, so a posted `tax: 0` would understate a legal filing.
            // Rounded per line so the printed lines reconcile with the printed total.
            // A product saved without a GST rate is charged 0% — and the same null
            // also zeroes the VENDOR's tax below, which is a payout shortfall, not
            // just a reporting gap. Log it so the catalogue gap is visible and can be
            // backfilled; hard-failing here would reject legitimate existing rows at
            // the checkout step, which is the worst possible place to surface it.
            if (product.gstPercentage == null) {
                console.warn(
                    `[createOrder] Product ${product.id} (${product.name}) has no gstPercentage — ` +
                    `charging 0% GST to the customer and paying 0 tax to the vendor.`
                );
            }
            // The customer GST is NOT charged here. A coupon reduces the taxable
            // value (see the post-coupon block below), so tax has to wait until the
            // coupon is known — otherwise GST would be charged on the pre-coupon
            // amount, over-charging the customer. Only the per-line RATE is frozen
            // now (stored on the order item), so the invoice can reproduce the split.
            const customerGstRate = taxApplies ? (product.gstPercentage || 0) : 0;

            // Shipping for this line, from the product's own logistics config.
            // Same calculator the storefront uses (utils/logistics.js is a port of
            // lib/logistics.ts) so the quoted figure and the charged figure agree.
            //
            // AIR and SHIP have different per-kg rates and delivery windows, so when a
            // product offers both the customer must have picked one in the cart — we
            // will not silently choose on their behalf and bill them for it.
            const allowedTransports = Array.isArray(product.logisticsConfig?.transportTypes)
                ? product.logisticsConfig.transportTypes
                : [];
            if (allowedTransports.length > 1 && !item.transportType) {
                return res.status(400).json({
                    success: false,
                    error: `Please choose a shipping method for "${product.name}" before placing the order.`,
                });
            }
            if (item.transportType && !allowedTransports.includes(item.transportType)) {
                return res.status(400).json({
                    success: false,
                    error: `The selected shipping method is not available for "${product.name}".`,
                });
            }
            // Resolved mode: the explicit choice, else the only option, else none.
            const lineTransport = item.transportType || allowedTransports[0] || null;

            // Courier partner: required whenever the product ships (has a transport),
            // and must be one the catalog offers for this order's region + mode. The
            // region comes from the order currency (INR=.in, USD=.com). Frozen onto the
            // line so fulfilment/admin dispatches with the carrier the customer chose.
            let lineCourier = null;
            if (allowedTransports.length > 0) {
                if (!item.courier) {
                    return res.status(400).json({
                        success: false,
                        error: `Please choose a courier partner for "${product.name}" before placing the order.`,
                    });
                }
                if (!(await isCourierAvailable(item.courier, currency, lineTransport))) {
                    return res.status(400).json({
                        success: false,
                        error: `The selected courier is not available for "${product.name}".`,
                    });
                }
                lineCourier = item.courier;
            }

            // Region drives the SHIP lane's cost (SURFACE domestic vs SEA international).
            // The order currency is the source of truth: INR = .in, USD = .com.
            const lineRegion = currency === 'INR' ? 'IN' : 'US';
            const lineLogistics = calculateLogistics(
                product.logisticsConfig, item.quantity, lineTransport || undefined, lineRegion
            );
            computedShippingInr += lineLogistics.totalShippingCost;

            // Full logistics snapshot — everything the customer selected/was quoted for
            // this line, so the admin order view shows the complete shipping picture.
            const lineDims = product.logisticsConfig?.dimensions || null;
            let cbmPerUnit = null, cbmTotal = null;
            if (lineDims && lineDims.length && lineDims.width && lineDims.height) {
                const toM = (v) => (String(lineDims.unit).toUpperCase() === 'IN' ? Number(v) * 0.0254 : Number(v) / 100);
                cbmPerUnit = Math.round(toM(lineDims.length) * toM(lineDims.width) * toM(lineDims.height) * 1e4) / 1e4;
                cbmTotal = Math.round(cbmPerUnit * item.quantity * 1e4) / 1e4;
            }
            let lineDeliveryDays = null;
            if (lineTransport === 'AIR') {
                lineDeliveryDays = product.logisticsConfig?.airDeliveryDays ?? null;
            } else if (lineTransport === 'SHIP') {
                lineDeliveryDays = lineRegion === 'IN'
                    ? (product.logisticsConfig?.surfaceDeliveryDays ?? product.logisticsConfig?.shipDeliveryDays ?? null)
                    : (product.logisticsConfig?.shipDeliveryDays ?? null);
            }
            const lineLogisticsSnapshot = (lineTransport || lineCourier) ? {
                transportType: lineTransport,
                courier: lineCourier,
                totalWeightKg: lineLogistics.totalWeightKg ?? null,
                shippingCostInr: lineLogistics.totalShippingCost ?? null,
                deliveryDays: lineDeliveryDays,
                dimensions: lineDims,
                cbmPerUnit,
                cbmTotal,
            } : null;

            // Calculate Vendor Settlement using vendor's base price.
            //
            // M2C buys from the vendor and resells, so the vendor makes a taxable
            // supply TO M2C and must be paid GST on their own goods value. The GST
            // rate is fixed by the product's HSN code, so it is the same rate the
            // customer pays — only the base differs (vendor's basePrice, not the
            // admin selling price). Unregistered vendors (no GSTIN) charge no tax.
            const vendorPrice = product.basePrice || 0;
            const vendorItemTotal = vendorPrice * item.quantity;
            const vendorGstRate = product.vendor?.gstNumber ? (product.gstPercentage || 0) : 0;
            const vendorItemTax = vendorItemTotal * vendorGstRate / 100;

            if (product.vendorId) {
                if (!vendorTotals[product.vendorId]) {
                    vendorTotals[product.vendorId] = {
                        baseAmount: 0,
                        taxAmount: 0,
                        // Collects every rate seen for this vendor — a settlement spanning
                        // products on different HSN rates cannot report a single rate.
                        rates: new Set(),
                        vendorName: product.vendor.companyName || product.vendor.ownerName || 'Unknown Vendor'
                    };
                }
                vendorTotals[product.vendorId].baseAmount += vendorItemTotal;
                vendorTotals[product.vendorId].taxAmount += vendorItemTax;
                vendorTotals[product.vendorId].rates.add(vendorGstRate);
            }

            // Prepare Order Item Data
            orderItemsData.push({
                productId: product.id,
                productName: product.name,
                productImage: variant?.images?.[0] || product.images[0]?.url || '',
                quantity: item.quantity,
                unitPrice: unitPrice,
                totalPrice: itemTotal,
                totalPriceINR: toINR(itemTotal, currency, orderExchangeRate),
                // Freeze the GST rate charged on this line so the invoice shows the
                // real per-item rate, not a blended average across mixed-rate carts.
                gstPercentage: customerGstRate,
                transportType: lineTransport,
                courier: lineCourier,
                logistics: lineLogisticsSnapshot || undefined,
                // Offer snapshot (customer-side only). Unset when no offer applied, so
                // legacy/no-offer lines are written exactly as before.
                originalUnitPrice: offerResult.offer ? offerResult.originalUnitPrice : undefined,
                appliedOffer: offerResult.offer || undefined,
                // Freeze the vendor payout for this line so the settlement statement can
                // itemise it later. Vendor money is always INR — vendorPrice is basePrice,
                // never converted. Mirrors the vendorTotals accumulation above.
                vendorUnitPrice: round2(vendorPrice),
                vendorLineBase: round2(vendorItemTotal),
                vendorLineTax: round2(vendorItemTax),
                vendorGstRate: vendorGstRate,
                vendorId: product.vendorId,
                vendorName: product.vendor.companyName || product.vendor.ownerName,
                sku: variant ? variant.sku : product.baseSku,
                variantId: variant ? variant.id : undefined,
                size: variant ? variant.size : product.singleUnitSize || undefined,
                color: variant ? variant.color : product.singleUnitColor || undefined
            });

            // Prepare stock update list
            if (product.trackInventory) {
                // Check if stock became insufficient in the meantime?
                // For high concurrency, we should check inside transaction or use optimistic locking.
                // For now, we collect the ID to decrement later in transaction.
                stockUpdates.push({
                    id: product.id,
                    variantId: variant ? variant.id : null,
                    quantity: item.quantity,
                    inventoryItemId: product.inventoryItemId,
                    currentTotalStock: product.totalStock
                });
            }
        }

        // 5. Create Order
        // Generate unique Order ID (invoiceNo was already generated in parallel
        // pre-flight, so no extra round trip here).
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const orderDisplayId = `ORD-${new Date().getFullYear()}-${timestamp}${random}`;

        /*
          Money must be rounded to 2dp BEFORE it is summed, not after.

          These values are stored and then printed line-by-line on the invoice,
          which formats each to 2dp. Summing the raw floats and rounding only
          for display made the invoice fail to add up: a 4 × $4.19 order with
          12% GST and a 10% coupon stored tax=2.0112, discount=1.676 and
          total=17.0952 — printed as "16.76 + 2.01 − 1.68" but a Grand Total of
          "17.10" (the lines sum to 17.09). On a tax document the components
          must reconcile exactly against the total.

          Rounding each component first makes the stored total identical to the
          sum of the printed lines. It also collapses float artefacts such as
          discount = 1.6760000000000002.
        */
        const roundedSubtotal = round2(subtotal);
        // ── Discount: re-derived server-side from the coupon row ─────────────
        // The client reads `discount` out of localStorage, so it is attacker-
        // controlled. Re-run the same validator the /coupons/apply endpoint uses,
        // against the server's own subtotal. No coupon code => no discount, whatever
        // the client claimed. An invalid/expired coupon fails the order rather than
        // silently charging full price after the customer already paid the
        // discounted amount — the payment reconciliation above would reject it anyway.
        let roundedDiscount = 0;
        let validatedCouponCode = null;
        let couponGrantsFreeShipping = false;
        if (couponCode) {
            const evaluated = await evaluateCoupon({
                code: couponCode,
                cartTotal: roundedSubtotal,
                userId,
                currency,
            });
            if (!evaluated.ok) {
                return res.status(400).json({
                    success: false,
                    error: `Coupon could not be applied: ${evaluated.message}`,
                });
            }
            roundedDiscount = round2(evaluated.discountAmount);
            validatedCouponCode = evaluated.code;
            couponGrantsFreeShipping = Boolean(evaluated.freeShipping);
        }
        // ── GST on the POST-coupon net (correct treatment) ──────────────────
        // Under GST, a discount recorded on the invoice and given at the time of
        // supply is excluded from the taxable value — so the coupon must reduce the
        // base BEFORE tax, not after. Allocate the coupon across the taxable lines
        // in proportion to each line's value, tax each line's net at its own frozen
        // rate, and sum. Proportional allocation keeps mixed-rate carts correct, and
        // the invoice re-derives the identical split from (subtotal, discount, each
        // line's totalPrice + gstPercentage), so the printed lines reconcile exactly.
        // Product-level discounts and automatic offers are already baked into each
        // line's price, so they are taxed net too. The VENDOR settlement tax above is
        // deliberately left on the vendor's own base — M2C's margin absorbs the coupon.
        // Accumulate the tax, splitting each line into CGST/SGST (intrastate) or
        // IGST (interstate) per its own product rate — products may differ.
        let cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
        for (const oi of orderItemsData) {
            const gross = oi.totalPrice;
            const couponShare = roundedSubtotal > 0 ? (gross / roundedSubtotal) * roundedDiscount : 0;
            const netTaxable = Math.max(0, gross - couponShare);
            const lineTax = round2(netTaxable * (oi.gstPercentage || 0) / 100);
            computedTax += lineTax;
            const split = splitLineTax(lineTax, intrastate);
            cgstTotal += split.cgst;
            sgstTotal += split.sgst;
            igstTotal += split.igst;
        }
        // Server-computed GST wins over the client's figure. The client value is
        // only compared, so a genuine mismatch (stale cart price, tampering) is
        // visible in the logs instead of silently becoming the invoiced tax.
        const roundedTax = round2(computedTax);
        const cgstAmount = round2(cgstTotal);
        const sgstAmount = round2(sgstTotal);
        const igstAmount = round2(igstTotal);
        const taxType = roundedTax > 0 ? (intrastate ? 'INTRASTATE' : 'INTERSTATE') : null;
        const clientTax = round2(Number(tax) || 0);
        if (Math.abs(clientTax - roundedTax) > 0.01) {
            console.warn(
                `[createOrder] Client tax ${clientTax} != server tax ${roundedTax} ` +
                `(user ${userId}, ${currency}). Storing the server figure.`
            );
        }
        const clientDiscount = round2(Number(discount) || 0);
        if (Math.abs(clientDiscount - roundedDiscount) > 0.01) {
            console.warn(
                `[createOrder] Client discount ${clientDiscount} != server discount ${roundedDiscount} ` +
                `(user ${userId}, coupon ${couponCode || 'none'}). Storing the server figure.`
            );
        }
        // ── Shipping: re-derived server-side ────────────────────────────────
        // Computed from each product's own logisticsConfig (see utils/logistics.js,
        // a port of the storefront's lib/logistics.ts) rather than trusting the
        // client's number. The per-kg rates are in rupees, so convert into the
        // order's currency using this order's rate snapshot — otherwise a ₹50
        // shipping charge would be billed as $50 on a .com order.
        const freeShipping = await qualifiesForFreeShipping({
            prisma,
            userId,
            cartTotalInr: currency === 'USD'
                ? toINR(roundedSubtotal, currency, orderExchangeRate)
                : roundedSubtotal,
            couponGrantsFreeShipping,
            region: currency, // 'INR'|'USD' — normalized inside isVisibleInRegion
        });
        // ── Delivery zone: destination availability + flat fee + shipping GST ──
        // Block the order when the destination isn't covered by any active zone,
        // then add the zone's flat fee on top of the weight-based rate and apply
        // the global shipping GST. All dynamic — nothing hardcoded.
        const deliveryZone = await resolveDeliveryZone({
            country: shippingAddress?.country,
            state: shippingAddress?.state,
            city: shippingAddress?.city,
        });
        if (!deliveryZone) {
            return res.status(400).json({
                success: false,
                error: 'Delivery is not available to this location. Please choose a different delivery address.',
            });
        }
        const shippingGstPct = await getShippingGstPct();
        const zoneFeeInr = freeShipping ? 0 : (Number(deliveryZone.flatFee) || 0);
        // Shipping base (INR) = weight-based rate + zone flat fee (0 when free).
        const shippingBaseInr = freeShipping ? 0 : round2(computedShippingInr + zoneFeeInr);
        const shippingTaxInr = round2(shippingBaseInr * shippingGstPct / 100);

        const roundedShipping = Math.max(0, convertShippingToOrderCurrency(shippingBaseInr, currency, orderExchangeRate));
        const roundedShippingTax = Math.max(0, convertShippingToOrderCurrency(shippingTaxInr, currency, orderExchangeRate));
        const deliveryFlatFeeOrderCcy = Math.max(0, convertShippingToOrderCurrency(zoneFeeInr, currency, orderExchangeRate));

        const clientShipping = round2(Number(shippingCost) || 0);
        if (Math.abs(clientShipping - roundedShipping) > 0.01) {
            console.warn(
                `[createOrder] Client shipping ${clientShipping} != server shipping ${roundedShipping} ` +
                `(user ${userId}, ${currency}, freeShipping=${freeShipping}). Storing the server figure.`
            );
        }

        // Clamp at zero. A discount larger than the goods value must never produce a
        // negative order that would read as money owed to the customer. Shipping tax
        // is added on top of the (product) tax and shipping.
        const totalAmount = Math.max(0, round2(
            roundedSubtotal + roundedShipping + roundedShippingTax + roundedTax - roundedDiscount
        ));

        // ── Wallet redemption (store credit) ─────────────────────────────────
        // Store credit is a TENDER applied AFTER the invoice total is final — it
        // never touches subtotal/discount/tax. Wallet balance is INR; convert to
        // the order currency to cap it, and remember the INR amount to debit.
        let walletApplied = 0;      // order currency
        let walletAppliedINR = 0;   // actually debited from the wallet
        const requestedWallet = Math.max(0, Number(req.body?.walletApplied) || 0);
        if (requestedWallet > 0 || paymentMethod === 'WALLET') {
            const wallet = await prisma.wallet.findUnique({ where: { customerId: userId } });
            const balanceINR = wallet?.balance || 0;
            const balanceOrderCcy = currency === 'USD'
                ? round2(orderExchangeRate ? balanceINR / orderExchangeRate : 0)
                : balanceINR;
            const maxRedeem = round2(Math.min(balanceOrderCcy, totalAmount));
            const want = paymentMethod === 'WALLET' ? totalAmount : requestedWallet;
            walletApplied = round2(Math.max(0, Math.min(want, maxRedeem)));
            walletAppliedINR = currency === 'USD' ? round2(walletApplied * orderExchangeRate) : walletApplied;
            if (walletAppliedINR > balanceINR) walletAppliedINR = round2(balanceINR);
        }
        // ── Credit points redemption ─────────────────────────────────────────
        // Points are an INR-denominated tender applied AFTER wallet (and after the
        // invoice total is final). Capped by: admin max-redeem % of the order, the
        // customer's points balance, the min-points-to-redeem floor, and whatever
        // value remains after the wallet credit. Value = points × redeemValuePerPointInr.
        let pointsRedeemed = 0;          // whole points spent
        let pointsRedeemedValue = 0;     // order currency
        let pointsRedeemedValueINR = 0;  // INR twin (what the ledger records)
        const requestedPoints = Math.max(0, Math.floor(Number(req.body?.pointsRedeemed) || 0));
        if (requestedPoints > 0) {
            const creditPoints = require('../utils/creditPoints');
            const cpSettings = await creditPoints.getSettings();
            if (cpSettings.enabled && creditPoints.isActiveForRegion(cpSettings, currency)) {
                const perPointInr = Number(cpSettings.redeemValuePerPointInr) || 0;
                const balancePts = await creditPoints.getBalance(userId);
                const totalAmountINRCalc = currency === 'USD' ? round2(totalAmount * orderExchangeRate) : totalAmount;
                const walletedINR = walletAppliedINR || 0;
                if (perPointInr > 0 && balancePts > 0) {
                    // INR headroom: min(max-redeem % of order, amount left after wallet).
                    const maxByPercentINR = round2(totalAmountINRCalc * (Number(cpSettings.maxRedeemPercent) || 0) / 100);
                    const remainingINR = Math.max(0, round2(totalAmountINRCalc - walletedINR));
                    const headroomINR = Math.min(maxByPercentINR, remainingINR);
                    const maxPointsByValue = Math.floor(headroomINR / perPointInr);
                    let pts = Math.min(requestedPoints, balancePts, maxPointsByValue);
                    // Enforce the min-to-redeem floor: below it, redeem nothing.
                    if (pts < (Number(cpSettings.minPointsToRedeem) || 0)) pts = 0;
                    if (pts > 0) {
                        pointsRedeemed = pts;
                        pointsRedeemedValueINR = round2(pts * perPointInr);
                        pointsRedeemedValue = currency === 'USD'
                            ? round2(orderExchangeRate ? pointsRedeemedValueINR / orderExchangeRate : 0)
                            : pointsRedeemedValueINR;
                    }
                }
            }
        }

        // Net still payable via gateway after wallet + points.
        const netPayable = Math.max(0, round2(totalAmount - walletApplied - pointsRedeemedValue));

        // A pure-wallet order must be fully covered by the balance.
        if (paymentMethod === 'WALLET' && netPayable > 0.009) {
            return res.status(400).json({
                success: false,
                error: 'Your wallet balance does not cover the full amount. Please choose another payment method.'
            });
        }

        // ── Payment amount reconciliation ────────────────────────────────────
        // The HMAC signature proves the payment exists and is ours — it does NOT
        // prove it was for THIS cart. Without this check, a valid signature from an
        // earlier ₹10 order verifies fine against a ₹10,000 basket. This is the only
        // point in the request where the server knows both the captured amount and
        // its own computed total, so the comparison belongs here.
        if (needsRazorpayVerification) {
            try {
                const Razorpay = require('razorpay');
                const rzp = new Razorpay({
                    key_id: paymentSettings.razorpayKeyId,
                    key_secret: paymentSettings.razorpayKeySecret,
                });
                const rzpOrder = await rzp.orders.fetch(razorpayOrderId);

                // Step 1 — did the customer actually pay the full amount the Razorpay
                // order was raised for? Both figures come from Razorpay in paise, so
                // this is exact and currency-independent.
                const orderPaise = Number(rzpOrder?.amount || 0);
                const paidPaise = Number(rzpOrder?.amount_paid || 0);
                if (!paidPaise) {
                    return res.status(400).json({
                        success: false,
                        error: 'Payment verification failed - payment not captured'
                    });
                }
                if (paidPaise < orderPaise) {
                    console.error(
                        `[createOrder] Underpayment: paid ${paidPaise} of ${orderPaise} paise ` +
                        `(user ${userId}, rzpOrder ${razorpayOrderId}).`
                    );
                    return res.status(400).json({
                        success: false,
                        error: 'Payment verification failed - payment incomplete'
                    });
                }

                // Step 2 — was that payment raised for THIS cart? paymentController
                // stamps the quote onto the Razorpay order's notes at creation time,
                // so compare in the ORDER'S OWN CURRENCY against that snapshot.
                //
                // Deliberately NOT re-converting with the live FX rate: the customer
                // may sit on the payment page for minutes, and an admin editing the
                // exchange rate in that window would otherwise make a perfectly good
                // payment fail reconciliation (money taken, no order created). The
                // quote is immutable once the Razorpay order exists, so comparing
                // like-for-like removes FX from this check entirely.
                const quotedAmount = Number(rzpOrder?.notes?.quotedAmount);
                const quotedCurrency = String(rzpOrder?.notes?.quotedCurrency || '').toUpperCase();

                let expected = null;
                let paid = null;
                let unit = currency;
                // Compare against the NET payable (total minus any wallet credit),
                // since that is what the Razorpay order was raised for.
                if (Number.isFinite(quotedAmount) && quotedCurrency === currency) {
                    expected = netPayable;
                    paid = quotedAmount;
                } else {
                    // Fallback for orders raised before the quote was stamped: compare
                    // in INR using this order's own rate snapshot.
                    unit = 'INR';
                    expected = currency === 'USD'
                        ? toINR(netPayable, currency, orderExchangeRate)
                        : netPayable;
                    paid = round2(paidPaise / 100);
                }

                // Tolerance covers cent-level rounding only — same units on both
                // sides, so anything larger is a genuine mismatch.
                const tolerance = Math.max(0.02, round2(Number(expected) * 0.005));
                if (expected != null && paid < expected - tolerance) {
                    console.error(
                        `[createOrder] Payment amount mismatch: paid ${paid} vs expected ${expected} ${unit} ` +
                        `(user ${userId}, rzpOrder ${razorpayOrderId}).`
                    );
                    return res.status(400).json({
                        success: false,
                        error: 'Payment verification failed - amount does not match your order'
                    });
                }
                if (expected != null && paid > expected + tolerance) {
                    // Overpayment is not a security risk, but it means the quote and
                    // the recomputed total drifted — worth seeing in the logs.
                    console.warn(
                        `[createOrder] Customer overpaid: ${paid} vs ${expected} ${unit} ` +
                        `(user ${userId}, rzpOrder ${razorpayOrderId}).`
                    );
                }
            } catch (rzpErr) {
                // A verification that cannot complete must not silently pass: this is
                // the guard standing between a signature and a real captured payment.
                console.error('[createOrder] Razorpay reconciliation failed:', rzpErr.message);
                return res.status(400).json({
                    success: false,
                    error: 'Payment verification failed - could not confirm payment'
                });
            }
        }

        // Group vendor totals for Settlements (Now calculated in the main cart loop)

        const datePeriod = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

        // Track low stock alerts (populated inside transaction, sent after)
        const lowStockAlerts = [];

        // Collected during the transaction but written AFTER it commits.
        // These are pure audit log entries; persisting them outside the
        // transaction keeps the critical-path write count smaller without
        // affecting order correctness.
        const stockHistoryRecords = [];

        // Use transaction to ensure data integrity
        const result = await prisma.$transaction(async (tx) => {
            // Create Order
            const newOrder = await tx.order.create({
                data: {
                    orderId: orderDisplayId,
                    invoiceNo,                    // ← from InvoiceSettings
                    customerId: userId,
                    customerName: user.name,
                    customerEmail: user.email,
                    customerPhone: shippingAddress.phone || user.phoneNumber || "",
                    shippingAddress,
                    // Persist the rounded components so what's stored is exactly
                    // what the invoice prints, and subtotal + tax − discount
                    // reconciles against totalAmount.
                    subtotal: roundedSubtotal,
                    shippingCost: roundedShipping,
                    // Delivery zone + shipping tax (destination-based).
                    deliveryZoneId: deliveryZone.id,
                    deliveryZoneName: deliveryZone.name,
                    deliveryFlatFee: deliveryFlatFeeOrderCcy,
                    shippingTax: roundedShippingTax,
                    shippingTaxINR: shippingTaxInr,
                    tax: roundedTax,
                    // GST split (display) — total stays `tax`. Intrastate =>
                    // cgst+sgst, interstate => igst. All 0 / null when no GST.
                    cgstAmount,
                    sgstAmount,
                    igstAmount,
                    taxType,
                    discount: roundedDiscount,
                    totalAmount,
                    couponCode: validatedCouponCode,
                    currency,
                    exchangeRate: orderExchangeRate,
                    // INR twins — every cross-order aggregate sums these, not the originals.
                    totalAmountINR: round2(toINR(totalAmount, currency, orderExchangeRate)),
                    taxINR: round2(toINR(roundedTax, currency, orderExchangeRate)),
                    shippingCostINR: round2(toINR(roundedShipping, currency, orderExchangeRate)),
                    discountINR: round2(toINR(roundedDiscount, currency, orderExchangeRate)),
                    // Wallet tender (order currency) + INR twin + what the gateway was charged.
                    walletApplied,
                    walletAppliedINR: round2(walletAppliedINR),
                    // Credit-points tender (order currency) + INR twin + points spent.
                    pointsRedeemed,
                    pointsRedeemedValue: round2(pointsRedeemedValue),
                    pointsRedeemedValueINR: round2(pointsRedeemedValueINR),
                    amountPaid: netPayable,
                    paymentStatus: paymentMethod === 'COD' ? 'PENDING' : 'PAID',
                    paymentMethod,
                    paymentId,
                    status: 'ORDER_CREATED',
                    items: {
                        create: orderItemsData
                    }
                },
                include: {
                    items: true
                }
            });

            // Re-validate stock inside transaction to prevent concurrent overselling.
            // The outer check (pre-transaction) is a fast-path guard; this is the
            // authoritative check under transactional isolation. Reads run in
            // parallel — each round trip would otherwise stack serially.
            const freshStockChecks = await Promise.all(
                stockUpdates.map((update) =>
                    update.variantId
                        ? tx.productVariant.findUnique({ where: { id: update.variantId }, select: { stock: true } })
                        : tx.product.findUnique({ where: { id: update.id }, select: { totalStock: true } })
                )
            );
            for (let i = 0; i < stockUpdates.length; i++) {
                const update = stockUpdates[i];
                const fresh = freshStockChecks[i];
                const available = update.variantId ? fresh?.stock : fresh?.totalStock;
                if (!fresh || available < update.quantity) {
                    throw Object.assign(
                        new Error(`Insufficient stock for one of the products. Please refresh and try again.`),
                        { statusCode: 409 }
                    );
                }
            }

            // Increment coupon usedCount if a coupon was applied
            if (validatedCouponCode) {
                await tx.coupon.updateMany({
                    where: { code: validatedCouponCode },
                    data: { usedCount: { increment: 1 } },
                });
            }

            // Debit the wallet inside the transaction — a rollback (e.g. stock
            // shortage below) also reverses the debit. debitWallet re-reads the
            // balance and throws if it's insufficient, so it can't over-spend.
            if (walletAppliedINR > 0) {
                const { debitWallet } = require('../utils/wallet');
                await debitWallet({
                    customerId: userId,
                    amount: walletAppliedINR,
                    source: 'ORDER_REDEMPTION',
                    description: `Applied to order ${orderDisplayId}`,
                    refs: { orderId: newOrder.id, orderCode: orderDisplayId },
                    actor: { id: userId, name: user.name, type: 'customer' },
                }, tx);
            }

            // Debit credit points inside the transaction (mirrors the wallet debit) —
            // a rollback also reverses the points spend. redeemPoints re-reads the
            // balance and throws POINTS_INSUFFICIENT if it can't cover the spend.
            if (pointsRedeemed > 0) {
                const creditPoints = require('../utils/creditPoints');
                await creditPoints.redeemPoints({
                    customerId: userId,
                    points: pointsRedeemed,
                    source: 'ORDER_REDEMPTION',
                    valueInr: pointsRedeemedValueINR,
                    description: `Redeemed on order ${orderDisplayId}`,
                    refs: { orderId: newOrder.id, orderCode: orderDisplayId },
                    actor: { id: userId, name: user.name, type: 'customer' },
                }, tx);
            }

            // Update Stock
            // Aggregate total quantity per product for totalStock/inventory updates
            const productTotalDeductions = {};
            for (const update of stockUpdates) {
                if (!productTotalDeductions[update.id]) {
                    productTotalDeductions[update.id] = {
                        totalQuantity: 0,
                        inventoryItemId: update.inventoryItemId,
                        currentTotalStock: update.currentTotalStock
                    };
                }
                productTotalDeductions[update.id].totalQuantity += update.quantity;
            }

            // Decrement stock sequentially. MongoDB transactions only allow one
            // operation per session at a time and Prisma serializes parallel
            // writes onto the same tx client anyway, so Promise.all would add
            // risk without any actual parallelism.
            for (const update of stockUpdates) {
                if (update.variantId) {
                    await tx.productVariant.update({
                        where: { id: update.variantId },
                        data: { stock: { decrement: update.quantity } }
                    });
                } else if (update.inventoryItemId) {
                    await tx.inventory.update({
                        where: { id: update.inventoryItemId },
                        data: { baseStock: { decrement: update.quantity } }
                    });
                }
            }

            // Recalculate product totalStock and inventory currentStock from
            // source-of-truth values. Reads inside each iteration run in
            // parallel (safe — read-only, distinct documents). The outer loop
            // and writes stay sequential because MongoDB transactions only
            // allow one operation per session at a time.
            for (const [productId, agg] of Object.entries(productTotalDeductions)) {
                const [freshProduct, freshInventory] = await Promise.all([
                    tx.product.findUnique({
                        where: { id: productId },
                        include: { variants: true },
                    }),
                    agg.inventoryItemId
                        ? tx.inventory.findUnique({ where: { id: agg.inventoryItemId } })
                        : Promise.resolve(null),
                ]);

                const variantSum = freshProduct?.variants
                    ? freshProduct.variants.reduce((sum, v) => sum + v.stock, 0)
                    : 0;

                let newTotalStock;

                if (agg.inventoryItemId && freshInventory) {
                    newTotalStock = freshInventory.baseStock + variantSum;
                    await tx.inventory.update({
                        where: { id: agg.inventoryItemId },
                        data: { currentStock: newTotalStock },
                    });
                    // Audit log entry — persisted in a single createMany after the
                    // transaction commits to keep the critical path shorter.
                    stockHistoryRecords.push({
                        inventoryId: agg.inventoryItemId,
                        previousStock: newTotalStock + agg.totalQuantity,
                        newStock: newTotalStock,
                        changeAmount: -agg.totalQuantity,
                        reason: `Order placed: ${orderDisplayId}`,
                        changedBy: userId,
                        changedByType: 'system',
                        changedByName: user.name,
                    });
                } else {
                    newTotalStock = Math.max(0, agg.currentTotalStock - agg.totalQuantity);
                }

                await tx.product.update({
                    where: { id: productId },
                    data: { totalStock: newTotalStock, inStock: newTotalStock > 0 },
                });

                // Low-stock notification metadata. Use the already-fetched product
                // name instead of issuing a second findUnique.
                if (newTotalStock <= 10 || newTotalStock === 0) {
                    lowStockAlerts.push({
                        productId,
                        productName: freshProduct?.name || 'Unknown Product',
                        newStock: newTotalStock,
                        threshold: freshProduct?.lowStockThreshold || 10,
                    });
                }
            }

            // Create Vendor Settlements
            const settlementRecords = [];
            const vendorKeys = Object.keys(vendorTotals);
            for (let i = 0; i < vendorKeys.length; i++) {
                const vid = vendorKeys[i];
                const vData = vendorTotals[vid];
                const seqStr = String(i + 1).padStart(3, '0');
                const setNum = `SET-${new Date().getFullYear()}-${timestamp}-${seqStr}`;

                // Round money to paise once, at the record boundary — accumulating
                // rounded per-item tax would drift on multi-line settlements.
                const baseAmount = round2(vData.baseAmount);
                const taxAmount = round2(vData.taxAmount);
                // Only report a rate when the whole settlement shares one.
                const uniformRate = vData.rates.size === 1 ? [...vData.rates][0] : null;

                settlementRecords.push({
                    settlementNumber: setNum,
                    vendorId: vid,
                    vendorName: vData.vendorName,
                    orderId: newOrder.id,
                    billingNumber: invoiceNo || orderDisplayId,
                    period: datePeriod,
                    baseAmount,
                    taxAmount,
                    gstPercentage: uniformRate,
                    // Gross payable — what actually leaves M2C's bank.
                    amount: round2(baseAmount + taxAmount),
                    status: 'Pending',
                    dueDate: null,
                    // Settlements are system-generated by the order flow (no human
                    // "maker"), so they are auto-approved — the maker-checker gate
                    // would only add friction with no segregation-of-duties benefit.
                    // Payout control stays with settlement:mark_paid + the delivered/
                    // bank-details checks.
                    approvalStatus: 'APPROVED',
                });
            }

            if (settlementRecords.length > 0) {
                await tx.settlement.createMany({
                    data: settlementRecords
                });
            }

            // Create VendorShipments — one per vendor in this order.
            // Each shipment tracks its own status, shipping, hub, and review.
            const vendorItemGroups = {};
            for (const item of newOrder.items) {
                if (!vendorItemGroups[item.vendorId]) {
                    vendorItemGroups[item.vendorId] = {
                        vendorName: item.vendorName,
                        itemIds: [],
                    };
                }
                vendorItemGroups[item.vendorId].itemIds.push(item.id);
            }

            // Create per-vendor shipments sequentially — MongoDB transactions
            // serialize writes on the same session, so parallelism here would
            // add risk without speed-up.
            let shipmentIdx = 0;
            for (const [vid, group] of Object.entries(vendorItemGroups)) {
                shipmentIdx++;
                const shipmentDisplayId = `${orderDisplayId}-V${shipmentIdx}`;
                const shipment = await tx.vendorShipment.create({
                    data: {
                        shipmentId: shipmentDisplayId,
                        orderId: newOrder.id,
                        vendorId: vid,
                        vendorName: group.vendorName,
                        status: 'ORDER_CREATED',
                        // Vendor has 6 hours to accept before the overdue sweep alerts
                        // admin + vendor.
                        acceptanceDeadline: new Date(Date.now() + 6 * 60 * 60 * 1000),
                    },
                });
                await tx.orderItem.updateMany({
                    where: { id: { in: group.itemIds } },
                    data: { shipmentId: shipment.id },
                });
            }

            // Clear Cart
            await tx.cartItem.deleteMany({
                where: { cartId: cart.id }
            });

            return newOrder;
        }, {
            // Order creation runs many sequential writes (order, stock revalidation,
            // variant + inventory updates, stockChangeHistory, settlements, vendor
            // shipments, cart cleanup). The 5s Prisma default is not enough on
            // Vercel serverless cold starts and was silently failing post-payment.
            maxWait: 10000,
            timeout: 30000,
        });

        // Persist audit log entries collected during the transaction. Fire-and-
        // forget — the order is already committed, so a log-write failure must
        // not block (or fail) the response to the customer.
        if (stockHistoryRecords.length > 0) {
            withRetry(() => prisma.stockChangeHistory.createMany({ data: stockHistoryRecords }))
                .catch((err) => console.error('stockChangeHistory backfill failed after retries:', err));
        }

        // Send low stock / out of stock alerts (outside transaction)
        const { createNotification, createNotificationForRole: notifyStockAlert } = require('./notificationController');
        for (const alert of lowStockAlerts) {
            if (alert.newStock === 0) {
                notifyStockAlert({
                    role: 'ADMIN', type: 'OUT_OF_STOCK',
                    title: 'Out of Stock',
                    message: `"${alert.productName}" is now out of stock!`,
                    data: { productId: alert.productId }
                }).catch(() => {});
            } else if (alert.newStock <= alert.threshold) {
                notifyStockAlert({
                    role: 'ADMIN', type: 'LOW_STOCK_ALERT',
                    title: 'Low Stock Alert',
                    message: `"${alert.productName}" has only ${alert.newStock} units left.`,
                    data: { productId: alert.productId }
                }).catch(() => {});
            }
        }

        // Notify vendors about new order (fire-and-forget)
        const vendorIds = [...new Set(result.items.map((i) => i.vendorId).filter(Boolean))];
        for (const vid of vendorIds) {
            const vendorItems = result.items.filter((i) => i.vendorId === vid);
            const vendorTotal = vendorItems.reduce((s, i) => s + i.totalPrice, 0);
            notifications.orderReceived(vid, result.orderId, vendorItems.length, vendorTotal).catch(() => {});
            createNotification({
                userId: vid, role: 'VENDOR', type: 'ORDER_RECEIVED',
                title: 'New Order Received',
                message: `Order #${result.orderId} — ${vendorItems.length} item(s), ₹${vendorTotal.toLocaleString('en-IN')}`,
                data: { orderId: result.id }
            }).catch(() => {});
        }

        // Notify admins — new order placed
        notifyStockAlert({
            role: 'ADMIN', type: 'NEW_ORDER',
            title: 'New Order Placed',
            message: `Order #${result.orderId} — ₹${result.totalAmount?.toLocaleString('en-IN')} from ${result.customerName || 'Customer'}`,
            data: { orderId: result.id }
        }).catch(() => {});

        // Notify customer — order confirmed
        if (result.customerId) {
            notifications.orderConfirmed(result.customerId, result.orderId).catch(() => {});
            createNotification({
                userId: result.customerId, role: 'USER', type: 'ORDER_CONFIRMED',
                title: 'Order Confirmed',
                message: `Your order #${result.orderId} has been placed successfully.`,
                data: { orderId: result.id }
            }).catch(() => {});
        }

        // Email the customer their order confirmation with the tax-invoice PDF attached.
        // Fire-and-forget — a mail failure must never fail the order. Re-fetch the order
        // fresh (with items) + company/invoice-logo settings so the PDF has everything.
        (async () => {
            try {
                const { sendOrderConfirmationEmail } = require('../utils/email/orderEmailSender');
                const [fullOrder, company, invSettings] = await Promise.all([
                    prisma.order.findUnique({ where: { id: result.id }, include: { items: true } }),
                    prisma.companyInfo.findFirst({ select: { companyName: true, gstNumber: true, registeredAddress: true, companyLogo: true } }),
                    prisma.invoiceSettings.findFirst({ select: { invoiceLogo: true } }),
                ]);
                if (fullOrder?.customerEmail) {
                    await sendOrderConfirmationEmail(fullOrder, {
                        companyName: company?.companyName,
                        gstNumber: company?.gstNumber,
                        address: company?.registeredAddress,
                        companyLogo: invSettings?.invoiceLogo || company?.companyLogo,
                    });
                }
            } catch (e) {
                console.warn('[order] confirmation email skipped:', e.message);
            }
        })();

        // Fire-and-forget: email vendors whose stock dropped to its low-stock
        // alert level because of this order (deduped per low-stock episode).
        const affectedInventoryIds = [...new Set(stockUpdates.map(u => u.inventoryItemId).filter(Boolean))];
        for (const invId of affectedInventoryIds) {
            checkAndAlertLowStock(invId).catch(() => {});
        }

        res.status(201).json({
            success: true,
            message: 'Order placed successfully',
            data: result
        });

    } catch (error) {
        if (error.statusCode === 409) {
            return res.status(409).json({ success: false, error: error.message });
        }
        console.error('Create order error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create order',
            // Surface the underlying message so payment-completed-but-order-failed
            // incidents can be diagnosed without server log access.
            detail: error?.message || undefined,
            code: error?.code || undefined,
        });
    }
};

// Get user orders
const getUserOrders = async (req, res) => {
    try {
        const userId = req.userId;

        const orders = await prisma.order.findMany({
            where: { customerId: userId },
            include: {
                items: ITEMS_WITH_SHIPMENT_STATUS,
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
        orders.forEach(pruneReshippedItems);
        await attachItemReturnable(orders);

        res.json({
            success: true,
            data: orders
        });
    } catch (error) {
        console.error('Get user orders error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch orders'
        });
    }
};

// Get single order by ID (supports both MongoDB id and human-readable orderId)
const getOrderById = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.userId;

        // Try to find by MongoDB id first, then by human-readable orderId
        let order = null;

        // Check if id looks like a MongoDB ObjectId (24 hex characters)
        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        if (isObjectId) {
            order = await prisma.order.findUnique({
                where: { id },
                include: {
                    items: ITEMS_WITH_SHIPMENT_STATUS,
                    statusHistory: true,
                    hub: { select: { name: true, city: true, state: true } },
                    shipments: { select: { hub: { select: { name: true, city: true, state: true } } } }
                }
            });
        }

        // If not found by id, try finding by orderId (human-readable)
        if (!order) {
            order = await prisma.order.findUnique({
                where: { orderId: id },
                include: {
                    items: ITEMS_WITH_SHIPMENT_STATUS,
                    statusHistory: true,
                    hub: { select: { name: true, city: true, state: true } },
                    shipments: { select: { hub: { select: { name: true, city: true, state: true } } } }
                }
            });
        }

        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }

        // Keep reship-hiding for live orders; show all items for a cancelled/returned order.
        pruneReshippedItems(order);

        // Ensure user owns the order
        if (order.customerId !== userId) {
            return res.status(403).json({
                success: false,
                error: 'Unauthorized access to order'
            });
        }

        await attachItemReturnable(order);

        // Timeline places (city/state only):
        //   processing → the vendor's warehouse/factory (where the goods are stored)
        //   shipped    → the admin hub the order was routed through
        //   received   → the customer's shipping address (already on the order)
        const primaryVendorId = order.vendorId
            || order.items?.find((i) => i.vendorId)?.vendorId
            || null;
        let vendorLocation = null;
        if (primaryVendorId) {
            const v = await prisma.vendor.findUnique({
                where: { id: primaryVendorId },
                select: {
                    warehouseCity: true, warehouseState: true,
                    factoryCity: true, factoryState: true,
                    businessCity: true, businessState: true,
                },
            }).catch(() => null);
            if (v) {
                const city = v.warehouseCity || v.factoryCity || v.businessCity || null;
                const state = v.warehouseState || v.factoryState || v.businessState || null;
                if (city || state) vendorLocation = { city, state };
            }
        }
        // The admin hub handling the final hub→customer leg is assigned per
        // VendorShipment; fall back to the order-level hub if one is set there.
        const shipmentHub = order.shipments
            ?.map((s) => s.hub)
            .find((h) => h && (h.city || h.state)) || null;
        const hubSrc = (order.hub && (order.hub.city || order.hub.state)) ? order.hub : shipmentHub;
        const hubLocation = hubSrc ? { city: hubSrc.city, state: hubSrc.state } : null;

        res.json({
            success: true,
            data: { ...order, vendorLocation, hubLocation }
        });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch order'
        });
    }
};

// Statuses from which a customer may still cancel — anything before the parcel
// leaves the hub for them. Once SHIPPED_TO_CUSTOMER they must use Return instead.
const CUSTOMER_CANCELLABLE = new Set([
    'ORDER_CREATED',
    'VENDOR_PROCESSING',
    'PACKED_BY_VENDOR',
    'IN_TRANSIT_TO_ADMIN_HUB',
    'RECEIVED_AT_ADMIN_HUB',
    'APPROVED_BY_ADMIN_HUB',
]);

// How many days after delivery a customer may raise a return.
const RETURN_WINDOW_DAYS = 7;

// Customer: cancel own order (pre-dispatch). Cancels the vendor settlement and
// issues an automatic refund for prepaid orders.
const cancelMyOrder = async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;
        const reason = (req.body?.reason || '').toString().trim().slice(0, 300) || null;

        const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
        if (order.customerId !== userId) return res.status(403).json({ success: false, error: 'Not your order' });
        if (!CUSTOMER_CANCELLABLE.has(order.status)) {
            return res.status(409).json({
                success: false,
                error: 'This order can no longer be cancelled. If it has shipped, please request a return once it is delivered.',
            });
        }

        const { restoreStockForOrder } = require('../utils/restoreStock');
        let stockHistoryRecords = [];
        await prisma.$transaction(async (tx) => {
            // Stop the vendor payout for a cancelled order.
            await tx.settlement.updateMany({
                where: { orderId: order.id, status: { in: ['Pending', 'Processing'] } },
                data: { status: 'Cancelled' },
            });
            // Put the reserved stock back on sale — the items never shipped.
            stockHistoryRecords = await restoreStockForOrder(tx, order, {
                reason: `Order cancelled: ${order.orderId}`,
                changedBy: userId,
                changedByType: 'customer',
                changedByName: 'Customer',
            });
            await tx.order.update({
                where: { id: order.id },
                data: {
                    status: 'CANCELLED',
                    cancelReason: reason,
                    statusHistory: {
                        create: {
                            status: 'CANCELLED',
                            updatedBy: userId,
                            updatedByType: 'customer',
                            comment: `Cancelled by customer${reason ? `: ${reason}` : ''}`,
                        },
                    },
                },
            });
            // Cancel every non-terminal vendor shipment too, so per-vendor views
            // (Vendor to Hub) reflect the cancellation and stop offering "Proceed".
            const liveShipments = await tx.vendorShipment.findMany({
                where: { orderId: order.id, status: { notIn: ['CANCELLED', 'RETURNED'] } },
                select: { id: true },
            });
            for (const s of liveShipments) {
                await tx.vendorShipment.update({
                    where: { id: s.id },
                    data: {
                        status: 'CANCELLED',
                        statusHistory: {
                            create: {
                                status: 'CANCELLED',
                                updatedBy: userId,
                                updatedByType: 'customer',
                                comment: `Order cancelled by customer${reason ? `: ${reason}` : ''}`,
                            },
                        },
                    },
                });
            }
        });

        // Persist restock audit rows (best-effort — never block the cancel).
        if (stockHistoryRecords.length > 0) {
            prisma.stockChangeHistory.createMany({ data: stockHistoryRecords }).catch(() => {});
        }

        // Refund policy: ALWAYS to the M2C Wallet as instant store credit — never
        // back to the gateway. The captured amount stays with M2C; the customer
        // withdraws from the wallet separately if they want cash. Only paid,
        // non-COD orders have anything to refund.
        const wasPaid = order.paymentStatus === 'PAID' && order.paymentMethod !== 'COD';
        let updated;
        if (wasPaid) {
            // The gross total includes the points-funded portion as a tender. Since
            // redeemed points are given back AS POINTS (reverseOrderPoints below),
            // exclude their value from the wallet refund to avoid refunding twice.
            const grossInr = order.totalAmountINR != null ? order.totalAmountINR : order.totalAmount;
            const creditInr = round2(Math.max(0, grossInr - (order.pointsRedeemedValueINR || 0)));
            const refundAmt = round2(Math.max(0, order.totalAmount - (order.pointsRedeemedValue || 0)));
            try {
                const { creditWallet } = require('../utils/wallet');
                if (creditInr > 0) {
                    await creditWallet({
                        customerId: userId, amount: creditInr, source: 'REFUND',
                        description: `Cancellation refund for ${order.orderId}`,
                        refs: { orderId: order.id, orderCode: order.orderId },
                        actor: { id: userId, name: 'Customer', type: 'customer' },
                    });
                }
            } catch (e) { console.warn('[cancel] wallet credit failed:', e?.message); }
            updated = await prisma.order.update({
                where: { id: order.id },
                data: { refundStatus: 'WALLET', refundAmount: refundAmt },
            });
        } else {
            updated = order;
        }

        // Reverse credit points: refund any redeemed, claw back any earned.
        if (!order.pointsReversedAt && ((order.pointsRedeemed || 0) > 0 || (order.pointsEarned || 0) > 0)) {
            try {
                const creditPoints = require('../utils/creditPoints');
                await creditPoints.reverseOrderPoints({
                    customerId: order.customerId,
                    orderId: order.id,
                    orderCode: order.orderId,
                    redeemedPoints: order.pointsRedeemed || 0,
                    earnedPoints: order.pointsEarned || 0,
                    actor: { id: userId, name: 'Customer', type: 'customer' },
                });
                await prisma.order.update({ where: { id: order.id }, data: { pointsReversedAt: new Date() } }).catch(() => {});
            } catch (e) { console.warn('[cancel] points reversal failed:', e?.message); }
        }

        // Notify vendors so they stop processing.
        try {
            const { createNotification } = require('./notificationController');
            const vendorIds = [...new Set(order.items.map((i) => i.vendorId).filter(Boolean))];
            for (const vid of vendorIds) {
                createNotification({
                    userId: vid, role: 'VENDOR', type: 'ORDER_CANCELLED',
                    title: 'Order Cancelled', message: `Order #${order.orderId} was cancelled by the customer.`,
                    data: { orderId: order.id },
                }).catch(() => {});
            }
        } catch { /* notifications are best-effort */ }

        const refundMsg = wasPaid
            ? 'Order cancelled. Your refund has been added to your M2C Wallet.'
            : 'Order cancelled.';
        res.json({ success: true, data: updated, message: refundMsg });
    } catch (error) {
        console.error('Cancel my order error:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel order' });
    }
};

// Customer: request a return on a delivered order. Does NOT change the order
// status — it raises a request the admin approves (→ RETURNED + refund).
const requestReturn = async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;
        const reason = (req.body?.reason || '').toString().trim().slice(0, 500);
        if (!reason) return res.status(400).json({ success: false, error: 'Please provide a reason for the return' });

        const order = await prisma.order.findUnique({ where: { id } });
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
        if (order.customerId !== userId) return res.status(403).json({ success: false, error: 'Not your order' });
        if (order.status !== 'DELIVERED') {
            return res.status(409).json({ success: false, error: 'Returns are only available for delivered orders' });
        }
        const existing = order.returnRequest && typeof order.returnRequest === 'object' ? order.returnRequest : null;
        if (existing && existing.status === 'Requested') {
            return res.status(409).json({ success: false, error: 'A return request is already pending for this order' });
        }
        if (existing && existing.status === 'Approved') {
            return res.status(409).json({ success: false, error: 'This order has already been approved for return' });
        }

        // Enforce the return window (from the delivered status-history entry, else createdAt).
        const deliveredAt = order.actualDelivery || order.updatedAt || order.createdAt;
        const windowEnd = new Date(deliveredAt);
        windowEnd.setDate(windowEnd.getDate() + RETURN_WINDOW_DAYS);
        if (new Date() > windowEnd) {
            return res.status(409).json({ success: false, error: `The ${RETURN_WINDOW_DAYS}-day return window has closed for this order` });
        }

        const updated = await prisma.order.update({
            where: { id: order.id },
            data: { returnRequest: { reason, status: 'Requested', requestedAt: new Date().toISOString() } },
        });

        // Notify admins to review.
        try {
            const { createNotificationForRole } = require('./notificationController');
            createNotificationForRole?.({
                role: 'ADMIN', type: 'RETURN_REQUESTED',
                title: 'Return Requested', message: `Return requested for order #${order.orderId}.`,
                data: { orderId: order.id },
            }).catch?.(() => {});
        } catch { /* best-effort */ }

        res.json({ success: true, data: updated, message: 'Return request submitted. We will review it shortly.' });
    } catch (error) {
        console.error('Request return error:', error);
        res.status(500).json({ success: false, error: 'Failed to submit return request' });
    }
};

// Pre-payment fulfilment check. Runs the same cart validations that createOrder
// enforces (stock, shipping method, courier availability) BEFORE the customer is
// sent to the payment gateway — so we never capture a payment for an order that
// createOrder would then reject (which stranded the customer: charged, no order,
// bounced back to checkout). Returns { success:true } when the cart can be placed,
// or the first blocking problem as a 400 with a user-facing message.
const validateCheckout = async (req, res) => {
    try {
        const userId = req.userId;
        const currency = req.body?.currency === 'USD' ? 'USD' : 'INR';

        const cart = await prisma.cart.findFirst({ where: { userId }, include: { items: true } });
        if (!cart || cart.items.length === 0) {
            return res.status(400).json({ success: false, error: 'Your cart is empty.' });
        }

        const products = await Promise.all(cart.items.map((item) =>
            prisma.product.findUnique({
                where: { id: item.productId },
                include: { variants: item.variantId ? { where: { id: item.variantId } } : false },
            })
        ));

        for (let i = 0; i < cart.items.length; i++) {
            const item = cart.items[i];
            const product = products[i];

            if (!product) {
                return res.status(400).json({ success: false, error: 'A product in your cart is no longer available. Please review your cart.' });
            }
            if (!product.inStock) {
                return res.status(400).json({ success: false, error: `"${product.name}" is out of stock. Please remove it to continue.` });
            }
            const variant = item.variantId && product.variants?.length > 0 ? product.variants[0] : null;
            const checkStock = variant ? variant.stock : product.totalStock;
            if (product.trackInventory && checkStock < item.quantity) {
                return res.status(400).json({ success: false, error: `Insufficient stock for "${product.name}".` });
            }

            // Shipping method + courier — the checks that produced "courier not
            // available" only AFTER payment. Mirror them here, pre-payment.
            const allowedTransports = Array.isArray(product.logisticsConfig?.transportTypes)
                ? product.logisticsConfig.transportTypes
                : [];
            if (allowedTransports.length > 1 && !item.transportType) {
                return res.status(400).json({ success: false, error: `Please choose a shipping method for "${product.name}" before placing the order.` });
            }
            if (item.transportType && !allowedTransports.includes(item.transportType)) {
                return res.status(400).json({ success: false, error: `The selected shipping method is not available for "${product.name}".` });
            }
            const lineTransport = item.transportType || allowedTransports[0] || null;
            if (allowedTransports.length > 0) {
                if (!item.courier) {
                    return res.status(400).json({ success: false, error: `Please choose a courier partner for "${product.name}" before placing the order.` });
                }
                if (!(await isCourierAvailable(item.courier, currency, lineTransport))) {
                    return res.status(400).json({ success: false, error: `The selected courier is not available for "${product.name}". Please go back to your cart and choose a different courier.` });
                }
            }
        }

        // Re-validate the coupon BEFORE payment (same check createOrder runs after),
        // so a coupon that was rejected/expired/limit-reached between cart and
        // checkout fails here instead of capturing payment then rejecting the order.
        const couponCode = req.body?.couponCode;
        if (couponCode) {
            const cartSubtotal = round2(cart.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0));
            const evaluated = await evaluateCoupon({ code: couponCode, cartTotal: cartSubtotal, userId, currency });
            if (!evaluated.ok) {
                return res.status(400).json({ success: false, error: `Coupon could not be applied: ${evaluated.message}` });
            }
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Validate checkout error:', error);
        return res.status(500).json({ success: false, error: 'Could not validate your cart. Please try again.' });
    }
};

// Customer "Buy Again": add every still-available item from a past order back
// into the caller's cart. Missing / out-of-region / out-of-stock items are
// skipped and reported; quantities are capped at current available stock and
// prices are refreshed to the live storefront price (never the old order price).
const reorderToCart = async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;
        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        const order = await prisma.order.findUnique({
            where: isObjectId ? { id } : { orderId: id },
            include: { items: true },
        });

        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        if (order.customerId !== userId) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        if (!Array.isArray(order.items) || order.items.length === 0) {
            return res.status(400).json({ success: false, error: 'This order has no items to reorder' });
        }

        // Cart line currency follows the caller's current storefront region, falling
        // back to the currency the order was originally charged in.
        const currency = (req.body?.currency || req.query?.currency || order.currency || 'INR') === 'USD' ? 'USD' : 'INR';

        // Get or create the caller's cart once, then upsert each item into it.
        let cart = await prisma.cart.findFirst({ where: { userId } });
        if (!cart) cart = await prisma.cart.create({ data: { userId } });

        const added = [];
        const skipped = [];

        for (const item of order.items) {
            const desiredQty = Math.max(1, item.quantity || 1);
            const product = await prisma.product.findUnique({
                where: { id: item.productId },
                select: {
                    id: true, name: true, inStock: true, totalStock: true,
                    basePrice: true, adminFixedPrice: true, priceINR: true, priceUSD: true, priceVisibility: true,
                    variants: item.variantId ? {
                        where: { id: item.variantId },
                        select: { id: true, price: true, adminFixedPrice: true, priceINR: true, priceUSD: true, stock: true, priceVisibility: true },
                    } : false,
                },
            });

            const label = item.productName || product?.name || 'Item';

            if (!product) {
                skipped.push({ name: label, reason: 'No longer available' });
                continue;
            }
            const variant = item.variantId ? (product.variants && product.variants[0]) : null;
            if (item.variantId && !variant) {
                skipped.push({ name: label, reason: 'Selected variant no longer available' });
                continue;
            }

            // Region gate — the SKU must be visible in the caller's storefront.
            const skuVisibility = variant ? variant.priceVisibility : product.priceVisibility;
            if (!isVisibleInRegion(skuVisibility, currency)) {
                skipped.push({ name: label, reason: 'Not available in your region' });
                continue;
            }

            const availableStock = variant ? variant.stock : product.totalStock;
            if (!product.inStock || !availableStock || availableStock < 1) {
                skipped.push({ name: label, reason: 'Out of stock' });
                continue;
            }

            // Cap the re-added quantity at what is currently in stock.
            const qty = Math.min(desiredQty, availableStock);

            // Resolve the CURRENT price in the caller's currency (never the stale order price).
            let price;
            if (variant) {
                price = currency === 'USD'
                    ? (variant.priceUSD || variant.adminFixedPrice || variant.price)
                    : (variant.priceINR || variant.adminFixedPrice || variant.price);
            } else {
                price = currency === 'USD'
                    ? (product.priceUSD || product.adminFixedPrice || product.basePrice)
                    : (product.priceINR || product.adminFixedPrice || product.basePrice);
            }

            const existing = await prisma.cartItem.findFirst({
                where: { cartId: cart.id, productId: product.id, variantId: item.variantId || null },
            });

            if (existing) {
                // Merge with any existing cart line, never exceeding available stock.
                const mergedQty = Math.min(existing.quantity + qty, availableStock);
                await prisma.cartItem.update({
                    where: { id: existing.id },
                    data: { quantity: mergedQty, price, currency },
                });
            } else {
                await prisma.cartItem.create({
                    data: { cartId: cart.id, productId: product.id, variantId: item.variantId || null, quantity: qty, price, currency },
                });
            }

            added.push({ name: label, quantity: qty, capped: qty < desiredQty });
        }

        const updatedCart = await prisma.cart.findUnique({
            where: { id: cart.id },
            include: { items: true },
        });

        return res.json({
            success: true,
            message: added.length
                ? `${added.length} item${added.length > 1 ? 's' : ''} added to your cart`
                : 'No items could be added to your cart',
            data: {
                added,
                skipped,
                addedCount: added.length,
                skippedCount: skipped.length,
                itemCount: updatedCart?.items?.length || 0,
            },
        });
    } catch (error) {
        console.error('Reorder to cart error:', error);
        return res.status(500).json({ success: false, error: 'Failed to add items to cart' });
    }
};

module.exports = {
    createOrder,
    validateCheckout,
    getUserOrders,
    getOrderById,
    cancelMyOrder,
    requestReturn,
    reorderToCart,
};
