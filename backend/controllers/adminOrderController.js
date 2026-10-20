const { prisma } = require('../config/database');
const { isCourierAvailable, courierName } = require('../utils/couriers');
const { recomputeAndPersistOrderStatus } = require('../utils/computeOrderStatus');
const { ACTIVE_ITEMS_FILTER } = require('../utils/activeItemsFilter');
const { withWriteRetry } = require('../utils/dbRetry');
const { creditWallet } = require('../utils/wallet');
const creditPoints = require('../utils/creditPoints');

const SETTLEMENT_DUE_DAYS = 30;

/**
 * Reverse an order's credit-points movements on cancel/return: refund points the
 * customer redeemed and claw back any unspent points they earned. Idempotent via
 * order.pointsReversedAt. Never throws.
 */
async function reverseOrderPoints(order, actor = {}) {
    if (!order || !order.customerId) return;
    if (order.pointsReversedAt) return; // already reversed
    const redeemedPoints = order.pointsRedeemed || 0;
    const earnedPoints = order.pointsEarned || 0;
    if (redeemedPoints <= 0 && earnedPoints <= 0) return;
    try {
        await creditPoints.reverseOrderPoints({
            customerId: order.customerId,
            orderId: order.id,
            orderCode: order.orderId,
            redeemedPoints,
            earnedPoints,
            actor: { id: actor?.id, name: actor?.name || actor?.email || 'Admin', type: 'admin' },
        });
        await prisma.order.update({
            where: { id: order.id },
            data: { pointsReversedAt: new Date() },
        }).catch(() => {});
    } catch (e) {
        console.warn('[reverseOrderPoints] failed:', e?.message || e);
    }
}

/**
 * Refund an order to the customer's M2C Wallet as instant store credit — the only
 * refund path (no gateway refunds; the captured amount stays with M2C, and the
 * customer withdraws from the wallet separately). No-op for COD/unpaid orders.
 * Sets order.refundStatus = 'WALLET'. Never throws.
 */
async function refundOrderToWallet(order, actor = {}) {
    const wasPaid = order.paymentStatus === 'PAID' && order.paymentMethod !== 'COD';
    if (!wasPaid) return;
    // The gross total includes the points-funded portion. Redeemed points are
    // given back AS POINTS by reverseOrderPoints (called alongside every use of
    // this helper), so exclude their value here to avoid refunding twice.
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const grossInr = order.totalAmountINR != null ? order.totalAmountINR : order.totalAmount;
    const creditInr = round2(Math.max(0, grossInr - (order.pointsRedeemedValueINR || 0)));
    const refundAmt = round2(Math.max(0, order.totalAmount - (order.pointsRedeemedValue || 0)));
    try {
        if (creditInr > 0) {
            await creditWallet({
                customerId: order.customerId,
                amount: creditInr,
                source: 'REFUND',
                description: `Refund for order ${order.orderId}`,
                refs: { orderId: order.id, orderCode: order.orderId },
                actor: { id: actor?.id, name: actor?.name || actor?.email || 'Admin', type: 'admin' },
            });
        }
    } catch (e) {
        console.warn('[refundOrderToWallet] wallet credit failed:', e?.message || e);
    }
    await prisma.order.update({
        where: { id: order.id },
        data: { refundStatus: 'WALLET', refundAmount: refundAmt },
    }).catch(() => {});
}

// Allowed OrderStatus values (mirrors the Prisma enum).
const ALLOWED_ORDER_STATUSES = new Set([
    'ORDER_CREATED',
    'ACCEPTED_BY_VENDOR',
    'VENDOR_PROCESSING',
    'PACKED_BY_VENDOR',
    'IN_TRANSIT_TO_ADMIN_HUB',
    'RECEIVED_AT_ADMIN_HUB',
    'APPROVED_BY_ADMIN_HUB',
    'REJECTED_BY_ADMIN_HUB',
    'SHIPPED_TO_CUSTOMER',
    'DELIVERED',
    'CANCELLED',
    'RETURNED',
]);

// Terminal statuses — cannot be changed once entered.
const TERMINAL_STATUSES = new Set(['CANCELLED', 'RETURNED']);

// Legal forward transitions for shipment-level status updates.
const SHIPMENT_TRANSITIONS = {
    ORDER_CREATED:           ['ACCEPTED_BY_VENDOR', 'CANCELLED'],
    ACCEPTED_BY_VENDOR:      ['VENDOR_PROCESSING', 'CANCELLED'],
    VENDOR_PROCESSING:       ['PACKED_BY_VENDOR', 'CANCELLED'],
    PACKED_BY_VENDOR:        ['IN_TRANSIT_TO_ADMIN_HUB', 'CANCELLED'],
    IN_TRANSIT_TO_ADMIN_HUB: ['RECEIVED_AT_ADMIN_HUB', 'CANCELLED'],
    RECEIVED_AT_ADMIN_HUB:   ['APPROVED_BY_ADMIN_HUB', 'REJECTED_BY_ADMIN_HUB', 'CANCELLED'],
    APPROVED_BY_ADMIN_HUB:   ['CANCELLED'],
    REJECTED_BY_ADMIN_HUB:   ['CANCELLED'],
    SHIPPED_TO_CUSTOMER:     [],
    DELIVERED:               [],
    CANCELLED:               [],
    RETURNED:                [],
};

// Legal forward transitions for order-level status (hub-to-customer phase).
const ORDER_TRANSITIONS = {
    ORDER_CREATED:           ['ACCEPTED_BY_VENDOR', 'VENDOR_PROCESSING', 'CANCELLED'],
    ACCEPTED_BY_VENDOR:      ['VENDOR_PROCESSING', 'CANCELLED'],
    VENDOR_PROCESSING:       ['PACKED_BY_VENDOR', 'CANCELLED'],
    PACKED_BY_VENDOR:        ['IN_TRANSIT_TO_ADMIN_HUB', 'CANCELLED'],
    IN_TRANSIT_TO_ADMIN_HUB: ['RECEIVED_AT_ADMIN_HUB', 'CANCELLED'],
    RECEIVED_AT_ADMIN_HUB:   ['APPROVED_BY_ADMIN_HUB', 'REJECTED_BY_ADMIN_HUB', 'CANCELLED'],
    APPROVED_BY_ADMIN_HUB:   ['SHIPPED_TO_CUSTOMER', 'CANCELLED'],
    REJECTED_BY_ADMIN_HUB:   ['CANCELLED'],
    SHIPPED_TO_CUSTOMER:     ['DELIVERED', 'RETURNED'],
    DELIVERED:               ['RETURNED'],
    CANCELLED:               [],
    RETURNED:                [],
};

// ============================================
// SHIPMENT-LEVEL ENDPOINTS (Vendor-to-Hub flow)
// ============================================

// Admin: Get all shipments
const getAllShipmentsAdmin = async (req, res) => {
    try {
        const shipments = await prisma.vendorShipment.findMany({
            include: {
                items: true,
                order: {
                    select: {
                        id: true,
                        orderId: true,
                        customerName: true,
                        totalAmount: true,
                        currency: true,
                        exchangeRate: true,
                        paymentStatus: true,
                        createdAt: true,
                        orderDate: true,
                    },
                },
                hub: true,
                statusHistory: { orderBy: { timestamp: 'desc' } },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, data: shipments });
    } catch (error) {
        console.error('Get all shipments error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch shipments' });
    }
};

// Admin: Get single shipment by ID
const getShipmentByIdAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        let shipment;
        if (isObjectId) {
            shipment = await prisma.vendorShipment.findUnique({
                where: { id },
                include: {
                    items: true,
                    order: {
                        select: {
                            id: true,
                            orderId: true,
                            status: true,
                            customerName: true,
                            customerEmail: true,
                            customerPhone: true,
                            totalAmount: true,
                            subtotal: true,
                            shippingCost: true,
                            tax: true,
                            discount: true,
                            currency: true,
                            exchangeRate: true,
                            paymentStatus: true,
                            paymentMethod: true,
                            paymentId: true,
                            shippingAddress: true,
                            createdAt: true,
                            orderDate: true,
                            invoiceNo: true,
                        },
                    },
                    hub: true,
                    statusHistory: { orderBy: { timestamp: 'desc' } },
                    adminReviews: { take: 1 },
                },
            });
        }

        if (!shipment) {
            shipment = await prisma.vendorShipment.findUnique({
                where: { shipmentId: id },
                include: {
                    items: true,
                    order: {
                        select: {
                            id: true,
                            orderId: true,
                            status: true,
                            customerName: true,
                            customerEmail: true,
                            customerPhone: true,
                            totalAmount: true,
                            subtotal: true,
                            shippingCost: true,
                            tax: true,
                            discount: true,
                            currency: true,
                            exchangeRate: true,
                            paymentStatus: true,
                            paymentMethod: true,
                            paymentId: true,
                            shippingAddress: true,
                            createdAt: true,
                            orderDate: true,
                            invoiceNo: true,
                        },
                    },
                    hub: true,
                    statusHistory: { orderBy: { timestamp: 'desc' } },
                    adminReviews: { take: 1 },
                },
            });
        }

        if (!shipment) {
            return res.status(404).json({ success: false, error: 'Shipment not found' });
        }

        // Flatten adminReviews[0] → adminReview
        const { adminReviews, ...rest } = shipment;
        res.json({ success: true, data: { ...rest, adminReview: adminReviews?.[0] || null } });
    } catch (error) {
        console.error('Get admin shipment error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch shipment details' });
    }
};

// Admin: Update shipment status (assign hub, mark received, etc.)
const updateShipmentStatusAdmin = async (req, res) => {
    try {
        const adminId = req.userId || req.adminId;
        const { id } = req.params;
        const { status, assignedHubId } = req.body;

        // Validate status
        if (status !== undefined && status !== null && status !== '') {
            if (typeof status !== 'string' || !ALLOWED_ORDER_STATUSES.has(status)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid status value. Must be one of: ${[...ALLOWED_ORDER_STATUSES].join(', ')}`,
                });
            }
        }

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        let shipment;
        if (isObjectId) {
            shipment = await prisma.vendorShipment.findUnique({
                where: { id },
                include: { items: true },
            });
        }
        if (!shipment) {
            shipment = await prisma.vendorShipment.findUnique({
                where: { shipmentId: id },
                include: { items: true },
            });
        }

        if (!shipment) {
            return res.status(404).json({ success: false, error: 'Shipment not found' });
        }

        // Transition guard
        if (status && status !== shipment.status) {
            if (TERMINAL_STATUSES.has(shipment.status)) {
                return res.status(409).json({
                    success: false,
                    error: `Shipment is ${shipment.status}; no further status changes are allowed.`,
                });
            }
            const allowedNext = SHIPMENT_TRANSITIONS[shipment.status] || [];
            if (!allowedNext.includes(status)) {
                return res.status(409).json({
                    success: false,
                    error: `Illegal status transition: ${shipment.status} → ${status}. Allowed next: ${allowedNext.length ? allowedNext.join(', ') : '(none)'}.`,
                });
            }
        }

        // The vendor must accept the order before a hub can be assigned.
        if (assignedHubId && shipment.status === 'ORDER_CREATED') {
            return res.status(409).json({
                success: false,
                error: 'The vendor has not accepted this order yet. A hub can be assigned only after the vendor accepts.',
            });
        }
        // Hub assignment only allowed early in the flow (post-acceptance).
        if (assignedHubId && !['ACCEPTED_BY_VENDOR', 'VENDOR_PROCESSING'].includes(shipment.status)) {
            return res.status(409).json({
                success: false,
                error: `Hub can only be assigned while the shipment is in ACCEPTED_BY_VENDOR or VENDOR_PROCESSING (current: ${shipment.status}).`,
            });
        }

        // Idempotency: a duplicate request asking for the status the shipment is
        // already in (with no hub change) is a no-op — return success instead of
        // re-writing history or tripping the optimistic-lock conflict.
        if ((!status || status === shipment.status) && !assignedHubId) {
            const current = await prisma.vendorShipment.findUnique({
                where: { id: shipment.id },
                include: {
                    items: true,
                    order: { select: { id: true, orderId: true, customerName: true, totalAmount: true } },
                    hub: true,
                    statusHistory: { orderBy: { timestamp: 'desc' } },
                },
            });
            return res.json({ success: true, data: current });
        }

        // Assigning a hub advances the shipment into VENDOR_PROCESSING (the vendor
        // has already accepted), unless an explicit status was supplied.
        const nextStatus = status || (assignedHubId ? 'VENDOR_PROCESSING' : shipment.status);
        const updatedShipment = await withWriteRetry(() => prisma.$transaction(async (tx) => {
            // Optimistic locking
            const fresh = await tx.vendorShipment.findUnique({
                where: { id: shipment.id },
                select: { status: true },
            });
            if (!fresh || fresh.status !== shipment.status) {
                throw new Error('CONFLICT');
            }

            const updated = await tx.vendorShipment.update({
                where: { id: shipment.id },
                data: {
                    status: nextStatus,
                    assignedHubId: assignedHubId ?? shipment.assignedHubId,
                    statusHistory: {
                        create: {
                            status: nextStatus,
                            updatedBy: adminId,
                            updatedByType: 'admin',
                            comment: assignedHubId
                                ? `Admin assigned hub and updated status to ${nextStatus}`
                                : `Admin updated status to ${nextStatus}`,
                        },
                    },
                },
                include: {
                    items: true,
                    order: {
                        select: { id: true, orderId: true, customerName: true, totalAmount: true },
                    },
                    hub: true,
                    statusHistory: { orderBy: { timestamp: 'desc' } },
                },
            });

            // Recompute parent Order status
            await recomputeAndPersistOrderStatus(tx, shipment.orderId);

            // Settlement due date: triggered by shipment approval/rejection/cancellation
            if (status === 'APPROVED_BY_ADMIN_HUB') {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + SETTLEMENT_DUE_DAYS);
                const dueDateResult = await tx.settlement.updateMany({
                    where: {
                        orderId: shipment.orderId,
                        vendorId: shipment.vendorId,
                        status: 'Pending',
                        dueDate: null,
                    },
                    data: { dueDate },
                });
                if (dueDateResult.count === 0) {
                    console.warn(`[Settlement] No pending settlements found for orderId=${shipment.orderId}, vendorId=${shipment.vendorId} — dueDate not set`);
                }
            } else if (status === 'REJECTED_BY_ADMIN_HUB') {
                await tx.settlement.updateMany({
                    where: {
                        orderId: shipment.orderId,
                        vendorId: shipment.vendorId,
                        status: 'Pending',
                    },
                    data: { status: 'Failed' },
                });
            } else if (status === 'CANCELLED') {
                await tx.settlement.updateMany({
                    where: {
                        orderId: shipment.orderId,
                        vendorId: shipment.vendorId,
                        status: { in: ['Pending', 'Processing'] },
                    },
                    data: { status: 'Cancelled' },
                });
            }

            return updated;
        }));

        // Notify vendor about shipment status change
        if (status || assignedHubId) {
            const { createNotification: createShipmentNotif } = require('./notificationController');
            const vendorId = shipment.vendorId || shipment.items?.[0]?.vendorId;
            const orderId = updatedShipment.order?.orderId || '';

            const shipmentMessages = {
                'VENDOR_PROCESSING': assignedHubId
                    ? { title: 'Hub Assigned — Start Processing', message: `Order #${orderId} has been assigned to a hub. Please start processing.` }
                    : { title: 'Order Processing', message: `Order #${orderId} is now being processed.` },
                'IN_TRANSIT_TO_ADMIN_HUB': { title: 'Order In Transit', message: `Order #${orderId} is in transit to admin hub.` },
                'RECEIVED_AT_ADMIN_HUB': { title: 'Order Received at Hub', message: `Order #${orderId} has been received at admin hub.` },
                'APPROVED_BY_ADMIN_HUB': { title: 'Shipment Approved', message: `Your shipment for order #${orderId} has been approved by the hub.` },
                'SHIPPED_TO_CUSTOMER': { title: 'Order Shipped', message: `Order #${orderId} has been shipped to the customer.` },
                'DELIVERED': { title: 'Order Delivered', message: `Order #${orderId} has been delivered to the customer.` },
                'CANCELLED': { title: 'Order Cancelled', message: `Order #${orderId} has been cancelled.` },
                'RETURNED': { title: 'Order Returned', message: `Order #${orderId} has been returned.` },
            };

            const nextSt = status || (assignedHubId ? 'VENDOR_PROCESSING' : null);
            const msg = nextSt ? shipmentMessages[nextSt] : null;
            if (msg && vendorId) {
                createShipmentNotif({
                    userId: vendorId, role: 'VENDOR', type: `ORDER_${nextSt}`,
                    title: msg.title, message: msg.message,
                    data: { orderId: shipment.orderId, shipmentId: shipment.id }
                }).catch(() => {});
            }

            // Email the vendor when the admin ASSIGNS the order to a hub (the moment they
            // must start delivering to the admin hub). Fire-and-forget, never blocks.
            if (assignedHubId && vendorId) {
                (async () => {
                    try {
                        const { sendVendorOrderAssignedEmail } = require('../utils/email/vendorEmailSender');
                        const vendor = await prisma.vendor.findUnique({
                            where: { id: vendorId },
                            select: { email: true, businessEmail: true, companyName: true, ownerName: true },
                        });
                        const to = vendor?.businessEmail || vendor?.email;
                        if (!to) return;
                        const hub = updatedShipment.hub;
                        const hubAddress = hub
                            ? [hub.address, [hub.city, hub.state].filter(Boolean).join(', '), hub.zipCode].filter(Boolean).join(', ')
                            : '';
                        await sendVendorOrderAssignedEmail({
                            to,
                            companyName: vendor.companyName,
                            ownerName: vendor.ownerName,
                            orderId: updatedShipment.order?.orderId || shipment.orderId,
                            itemCount: updatedShipment.items?.length ?? shipment.items?.length,
                            hubName: hub?.name,
                            hubAddress,
                        });
                    } catch (e) {
                        console.warn('[order] vendor assignment email skipped:', e.message);
                    }
                })();
            }
        }

        res.json({ success: true, data: updatedShipment });
    } catch (error) {
        if (error.message === 'CONFLICT') {
            return res.status(409).json({
                success: false,
                error: 'Shipment status was modified by another admin. Please refresh and try again.',
            });
        }
        console.error('Update admin shipment status error:', error);
        res.status(500).json({ success: false, error: 'Failed to update shipment status' });
    }
};

// ============================================
// ORDER-LEVEL ENDPOINTS (Hub-to-Customer flow + listing)
// ============================================

// Admin: Get all orders
const getAllOrdersAdmin = async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            include: {
                items: ACTIVE_ITEMS_FILTER,
                statusHistory: {
                    orderBy: { timestamp: 'desc' },
                },
                hub: true,
                shipments: {
                    include: {
                        items: true,
                        hub: true,
                        adminReviews: { take: 1 },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, data: orders });
    } catch (error) {
        console.error('Get all orders error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    }
};

// Admin: Get single order by ID
const getAdminOrderById = async (req, res) => {
    try {
        const { id } = req.params;

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        const whereClause = isObjectId ? { id } : { orderId: id };

        const order = await prisma.order.findUnique({
            where: whereClause,
            include: {
                items: ACTIVE_ITEMS_FILTER,
                statusHistory: {
                    orderBy: { timestamp: 'desc' },
                },
                hub: true,
                shipments: {
                    include: {
                        items: true,
                        hub: true,
                        statusHistory: { orderBy: { timestamp: 'desc' } },
                        adminReviews: { take: 1 },
                    },
                },
            },
        });

        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        res.json({ success: true, data: order });
    } catch (error) {
        console.error('Get admin order error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch order details' });
    }
};

// Admin: Update order status (hub-to-customer phase)
const { notifications } = require('../utils/notificationService');

// Maps order status to notification helper — must match OrderStatus enum exactly
const STATUS_NOTIFICATION_MAP = {
  'ORDER_CREATED': 'orderConfirmed',
  'VENDOR_PROCESSING': 'orderProcessing',
  'PACKED_BY_VENDOR': null,
  'IN_TRANSIT_TO_ADMIN_HUB': null,
  'RECEIVED_AT_ADMIN_HUB': null,
  'APPROVED_BY_ADMIN_HUB': null,
  'SHIPPED_TO_CUSTOMER': 'orderShipped',
  'DELIVERED': 'orderDelivered',
  'CANCELLED': 'orderCancelled',
  'RETURNED': 'orderRefunded',
};


const updateAdminOrderStatus = async (req, res) => {
    try {
        const adminId = req.userId || req.adminId;
        const { id } = req.params;
        const { status, courier, trackingReference, cancelReason, restock } = req.body;
        const courierId = courier != null ? String(courier).trim() : '';
        const trackingId = trackingReference != null ? String(trackingReference).trim() : '';
        const cancelReasonText = cancelReason != null ? String(cancelReason).trim() : '';
        // Cancellation no longer auto-restocks. Stock returns to inventory ONLY when
        // the admin explicitly approves it (restock === true); otherwise the units
        // are written off with the cancellation reason on record.
        const shouldRestock = restock === true;

        if (status !== undefined && status !== null && status !== '') {
            if (typeof status !== 'string' || !ALLOWED_ORDER_STATUSES.has(status)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid status value. Must be one of: ${[...ALLOWED_ORDER_STATUSES].join(', ')}`,
                });
            }
        }

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        const whereClause = isObjectId ? { id } : { orderId: id };

        const order = await prisma.order.findUnique({
            where: whereClause,
            include: {
                items: true,
                shipments: { select: { id: true, status: true } },
            },
        });

        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        // Transition guard
        if (status && status !== order.status) {
            if (TERMINAL_STATUSES.has(order.status)) {
                return res.status(409).json({
                    success: false,
                    error: `Order is ${order.status}; no further status changes are allowed.`,
                });
            }
            const allowedNext = ORDER_TRANSITIONS[order.status] || [];
            if (!allowedNext.includes(status)) {
                return res.status(409).json({
                    success: false,
                    error: `Illegal status transition: ${order.status} → ${status}. Allowed next: ${allowedNext.length ? allowedNext.join(', ') : '(none)'}.`,
                });
            }
        }

        const nextStatus = status || order.status;

        // Shipping to the customer requires the courier partner + tracking ID the
        // admin entered in the dispatch modal, so the customer can be notified with it.
        if (status === 'SHIPPED_TO_CUSTOMER') {
            if (!courierId || !trackingId) {
                return res.status(400).json({
                    success: false,
                    error: 'Courier partner and tracking ID are required to ship the order to the customer.',
                });
            }
            if (!(await isCourierAvailable(courierId, order.currency, null))) {
                return res.status(400).json({
                    success: false,
                    error: 'The selected courier partner is not available.',
                });
            }
        }

        // Did the admin dispatch with a courier different from the one the customer
        // chose at checkout? (Per-line courier is snapshotted on each OrderItem.)
        // If so, the customer gets an apology email + in-app notification below.
        const customerCouriers = [...new Set((order.items || []).map((i) => i.courier).filter(Boolean))];
        const courierChanged = status === 'SHIPPED_TO_CUSTOMER'
            && customerCouriers.length > 0
            && !customerCouriers.includes(courierId);
        const originalCourierId = customerCouriers[0] || null;

        const updatedOrder = await prisma.$transaction(async (tx) => {
            // Optimistic locking — re-read inside transaction
            const fresh = await tx.order.findUnique({
                where: { id: order.id },
                select: { status: true },
            });
            if (!fresh || fresh.status !== order.status) {
                throw new Error('CONFLICT');
            }

            // SHIPPED_TO_CUSTOMER requires all non-terminal shipments to be APPROVED.
            // Re-read shipments inside the transaction to prevent race conditions.
            if (nextStatus === 'SHIPPED_TO_CUSTOMER') {
                const freshShipments = await tx.vendorShipment.findMany({
                    where: { orderId: order.id },
                    select: { status: true },
                });
                if (freshShipments.length > 0) {
                    const pending = freshShipments.filter(
                        s => s.status !== 'APPROVED_BY_ADMIN_HUB'
                            && s.status !== 'CANCELLED'
                            && s.status !== 'RETURNED'
                    );
                    if (pending.length > 0) {
                        throw Object.assign(
                            new Error('Cannot ship to customer until all vendor shipments are approved (or cancelled/returned).'),
                            { statusCode: 409 }
                        );
                    }
                }
            }

            // Cancel all pending settlements when order is cancelled
            if (nextStatus === 'CANCELLED') {
                await tx.settlement.updateMany({
                    where: {
                        orderId: order.id,
                        status: { in: ['Pending', 'Processing'] },
                    },
                    data: { status: 'Cancelled' },
                });
                // Return the reserved stock to inventory ONLY when the admin approved
                // it. When they didn't, the units stay written off (not restocked) —
                // the cancellation reason is the record of why.
                if (shouldRestock) {
                    try {
                        const { restoreStockForOrder } = require('../utils/restoreStock');
                        const rows = await restoreStockForOrder(tx, order, {
                            reason: `Order cancelled by admin (stock restored): ${order.orderId}`,
                            changedBy: adminId,
                            changedByType: 'admin',
                            changedByName: req.user?.name || 'Admin',
                        });
                        if (rows.length) await tx.stockChangeHistory.createMany({ data: rows });
                    } catch (e) {
                        console.warn('[admin cancel] stock restore failed:', e?.message || e);
                    }
                }
                // Cancel every non-terminal vendor shipment too, so the per-vendor
                // Vendor-to-Hub view reflects the cancellation and stops offering
                // "Assign Hub / Proceed" on an order that's already cancelled.
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
                                    updatedBy: adminId,
                                    updatedByType: 'admin',
                                    comment: `Order cancelled by admin${cancelReasonText ? ` — ${cancelReasonText}` : ''}`,
                                },
                            },
                        },
                    });
                }
            }

            // Safety net: backfill dueDate on any Pending settlements that still
            // have dueDate === null. The primary trigger lives in
            // updateShipmentStatusAdmin (APPROVED_BY_ADMIN_HUB), but if it was
            // missed (old code, race, crash) we catch it here before the order
            // progresses past the point of no return.
            if (nextStatus === 'SHIPPED_TO_CUSTOMER' || nextStatus === 'DELIVERED') {
                const nullDueDateSettlements = await tx.settlement.findMany({
                    where: {
                        orderId: order.id,
                        status: 'Pending',
                        dueDate: null,
                    },
                    select: { id: true, vendorId: true },
                });

                if (nullDueDateSettlements.length > 0) {
                    console.warn(`[Settlement] Backfilling dueDate for ${nullDueDateSettlements.length} settlement(s) on order ${order.id} → ${nextStatus}`);
                    const approvedShipments = await tx.vendorShipment.findMany({
                        where: {
                            orderId: order.id,
                            status: { in: ['APPROVED_BY_ADMIN_HUB', 'DELIVERED'] },
                        },
                        select: { vendorId: true, updatedAt: true },
                    });

                    const vendorApprovalDate = {};
                    for (const s of approvedShipments) {
                        if (!vendorApprovalDate[s.vendorId] || s.updatedAt > vendorApprovalDate[s.vendorId]) {
                            vendorApprovalDate[s.vendorId] = s.updatedAt;
                        }
                    }

                    for (const settlement of nullDueDateSettlements) {
                        const baseDate = vendorApprovalDate[settlement.vendorId] || new Date();
                        const dueDate = new Date(baseDate);
                        dueDate.setDate(dueDate.getDate() + SETTLEMENT_DUE_DAYS);
                        await tx.settlement.update({
                            where: { id: settlement.id },
                            data: { dueDate },
                        });
                    }
                }
            }

            return tx.order.update({
                where: { id: order.id },
                data: {
                    status: nextStatus,
                    // Freeze the dispatch courier + tracking ID onto the order when it
                    // ships to the customer (shown to the customer + on the order pages).
                    ...(status === 'SHIPPED_TO_CUSTOMER' ? { courier: courierId, trackingReference: trackingId } : {}),
                    // Record the admin's cancellation reason so it shows on both the
                    // admin cancellation panel and the customer's order page.
                    ...(nextStatus === 'CANCELLED' && cancelReasonText ? { cancelReason: cancelReasonText } : {}),
                    statusHistory: {
                        create: {
                            status: nextStatus,
                            updatedBy: adminId,
                            updatedByType: 'admin',
                            comment: status === 'SHIPPED_TO_CUSTOMER'
                                ? `Admin shipped to customer via ${courierName(courierId) || courierId} · Tracking ${trackingId}`
                                : nextStatus === 'CANCELLED'
                                    ? `Admin cancelled the order${cancelReasonText ? ` — ${cancelReasonText}` : ''} · Stock ${shouldRestock ? 'restored to inventory' : 'not restocked'}`
                                    : `Admin updated status to ${nextStatus}`,
                        },
                    },
                },
                include: {
                    items: true,
                    statusHistory: { orderBy: { timestamp: 'desc' } },
                    hub: true,
                    shipments: {
                        include: {
                            items: true,
                            hub: true,
                            adminReviews: { take: 1 },
                        },
                    },
                },
            });
        });

        // Earn credit points when the order reaches DELIVERED (refund-safe timing).
        // Idempotent: skip if already earned. Eligible INR excludes the points-funded
        // portion so redeemed points can't be farmed back into new points.
        if (nextStatus === 'DELIVERED' && !order.pointsEarned) {
            try {
                const settings = await creditPoints.getSettings();
                if (settings.enabled
                    && settings.earnOn === 'DELIVERED'
                    && creditPoints.isActiveForRegion(settings, order.currency)) {
                    const totalInr = order.totalAmountINR != null ? order.totalAmountINR : order.totalAmount;
                    const pointsValueInr = order.pointsRedeemedValueINR || 0;
                    const eligibleInr = Math.max(0, (totalInr || 0) - pointsValueInr);
                    const pts = creditPoints.computeEarnedPoints(eligibleInr, settings);
                    if (pts > 0) {
                        const expiresAt = settings.expiryDays > 0
                            ? new Date(Date.now() + settings.expiryDays * 86400000)
                            : null;
                        await creditPoints.earnPoints({
                            customerId: order.customerId,
                            points: pts,
                            source: 'ORDER_EARN',
                            valueInr: pts * (settings.redeemValuePerPointInr || 0),
                            description: `Points earned on order ${order.orderId}`,
                            refs: { orderId: order.id, orderCode: order.orderId },
                            actor: { id: req.user?.id, name: req.user?.name || 'System', type: 'system' },
                            expiresAt,
                        });
                        await prisma.order.update({
                            where: { id: order.id },
                            data: { pointsEarned: pts, pointsEarnedAt: new Date() },
                        }).catch(() => {});
                    }
                }
            } catch (e) {
                console.warn('[creditPoints earn] failed:', e?.message || e);
            }
        }

        // Approving a return (→ RETURNED): stop any vendor payout, mark the return
        // request approved, and issue the customer's refund automatically.
        if (status === 'RETURNED') {
            try {
                await prisma.settlement.updateMany({
                    where: { orderId: order.id, status: { in: ['Pending', 'Processing'] } },
                    data: { status: 'Cancelled' },
                });
                await refundOrderToWallet(order, req.user);
                await reverseOrderPoints(order, req.user);
                const prevReturn = order.returnRequest && typeof order.returnRequest === 'object' ? order.returnRequest : {};
                await prisma.order.update({
                    where: { id: order.id },
                    data: {
                        returnRequest: { ...prevReturn, status: 'Approved', decidedAt: new Date().toISOString() },
                    },
                });
            } catch (e) {
                console.error('Return refund error:', e?.message || e);
            }
        }

        // Admin cancelling the order (→ CANCELLED): refund to the customer's wallet
        // automatically, exactly like a customer-initiated cancel. Settlements were
        // already cancelled inside the transaction above.
        if (status === 'CANCELLED' && !order.refundStatus) {
            try {
                await refundOrderToWallet(order, req.user);
            } catch (e) {
                console.error('Cancel refund error:', e?.message || e);
            }
        }
        // Reverse credit-points on cancel (independent of wallet refund so it also
        // covers COD/unpaid orders that redeemed points).
        if (status === 'CANCELLED') {
            await reverseOrderPoints(order, req.user);
        }

        // Send push notification to customer (fire-and-forget)
        if (status && order.customerId) {
            const notifHelper = STATUS_NOTIFICATION_MAP[status];
            if (notifHelper && notifications[notifHelper]) {
                notifications[notifHelper](order.customerId, order.orderId).catch(() => {});
            }
        }

        // Courier changed at dispatch → apologise to the customer by email, with the
        // reason and the tracking ID for live tracking.
        if (courierChanged && order.customerEmail) {
            const { sendCourierChangedEmail } = require('../utils/email/orderEmailSender');
            sendCourierChangedEmail(order, {
                oldCourier: courierName(originalCourierId) || originalCourierId,
                newCourier: courierName(courierId) || courierId,
                trackingId,
            }).catch(() => {});
        }

        // In-app notifications for vendor on key order status changes
        if (status) {
            const { createNotification: createOrderNotif } = require('./notificationController');
            const vendorIds = [...new Set(order.items.map(i => i.vendorId).filter(Boolean))];
            const vendorStatusMessages = {
                'VENDOR_PROCESSING': { title: 'Hub Assigned — Start Processing', message: `Order #${order.orderId} has been assigned to a hub. Please start processing.` },
                'IN_TRANSIT_TO_ADMIN_HUB': { title: 'Order In Transit', message: `Order #${order.orderId} is in transit to admin hub.` },
                'RECEIVED_AT_ADMIN_HUB': { title: 'Order Received at Hub', message: `Order #${order.orderId} has been received at admin hub.` },
                'SHIPPED_TO_CUSTOMER': { title: 'Order Shipped to Customer', message: `Order #${order.orderId} has been shipped to the customer.` },
                'DELIVERED': { title: 'Order Delivered', message: `Order #${order.orderId} has been delivered to the customer.` },
                'CANCELLED': { title: 'Order Cancelled', message: `Order #${order.orderId} has been cancelled.` },
                'RETURNED': { title: 'Order Returned', message: `Order #${order.orderId} has been returned by the customer.` },
            };
            const vendorMsg = vendorStatusMessages[status];
            if (vendorMsg) {
                for (const vid of vendorIds) {
                    createOrderNotif({
                        userId: vid, role: 'VENDOR', type: `ORDER_${status}`,
                        title: vendorMsg.title, message: vendorMsg.message,
                        data: { orderId: order.id }
                    }).catch(() => {});
                }
            }

            // In-app notifications for customer on key order status changes
            if (order.customerId) {
                const customerStatusMessages = {
                    'SHIPPED_TO_CUSTOMER': courierChanged
                        ? { title: 'Delivery Update — Courier Changed', message: `We're sorry — ${courierName(originalCourierId) || 'your selected courier'} wasn't available, so your order #${order.orderId} now ships via ${courierName(courierId) || 'our courier partner'}. Live-track it with Tracking ID: ${trackingId}` }
                        : { title: 'Order Shipped!', message: `Your order #${order.orderId} is on its way via ${courierName(courierId) || 'our courier partner'}. Tracking ID: ${trackingId}` },
                    'DELIVERED': { title: 'Order Delivered', message: `Your order #${order.orderId} has been delivered. Enjoy your purchase!` },
                    'CANCELLED': { title: 'Order Cancelled', message: `Your order #${order.orderId} has been cancelled.` },
                    'RETURNED': { title: 'Refund Processed', message: `Your order #${order.orderId} has been returned and a refund will be processed.` },
                };
                const customerMsg = customerStatusMessages[status];
                if (customerMsg) {
                    createOrderNotif({
                        userId: order.customerId, role: 'USER', type: `ORDER_${status}`,
                        title: customerMsg.title, message: customerMsg.message,
                        data: { orderId: order.id }
                    }).catch(() => {});
                }
            }
        }

        res.json({ success: true, data: updatedOrder });
    } catch (error) {
        if (error.message === 'CONFLICT') {
            return res.status(409).json({
                success: false,
                error: 'Order status was modified by another admin. Please refresh and try again.',
            });
        }
        if (error.statusCode === 409) {
            return res.status(409).json({ success: false, error: error.message });
        }
        console.error('Update admin order status error:', error);
        res.status(500).json({ success: false, error: 'Failed to update order status' });
    }
};

// Admin: approve or reject a customer's return request.
//   approve → order becomes RETURNED, settlement cancelled, refund issued.
//   reject  → the request is closed; order stays DELIVERED, no refund.
const decideReturn = async (req, res) => {
    try {
        const adminId = req.userId || req.adminId;
        const { id } = req.params;
        const decision = (req.body?.decision || '').toString().toLowerCase();
        const note = (req.body?.note || '').toString().trim().slice(0, 300) || null;

        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ success: false, error: "decision must be 'approve' or 'reject'" });
        }

        const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
        const rr = order.returnRequest && typeof order.returnRequest === 'object' ? order.returnRequest : null;
        if (!rr || rr.status !== 'Requested') {
            return res.status(409).json({ success: false, error: 'There is no pending return request for this order' });
        }

        const { createNotification } = require('./notificationController');

        if (decision === 'reject') {
            const updated = await prisma.order.update({
                where: { id: order.id },
                data: { returnRequest: { ...rr, status: 'Rejected', decidedAt: new Date().toISOString(), note } },
            });
            if (order.customerId) {
                createNotification({
                    userId: order.customerId, role: 'USER', type: 'RETURN_REJECTED',
                    title: 'Return Declined', message: `Your return request for order #${order.orderId} was not approved${note ? `: ${note}` : '.'}`,
                    data: { orderId: order.id },
                }).catch(() => {});
            }
            return res.json({ success: true, data: updated, message: 'Return request rejected' });
        }

        // Approve → RETURNED + settlement clawback + refund.
        await prisma.$transaction(async (tx) => {
            await tx.settlement.updateMany({
                where: { orderId: order.id, status: { in: ['Pending', 'Processing'] } },
                data: { status: 'Cancelled' },
            });
            await tx.order.update({
                where: { id: order.id },
                data: {
                    status: 'RETURNED',
                    statusHistory: {
                        create: {
                            status: 'RETURNED', updatedBy: adminId, updatedByType: 'admin',
                            comment: `Return approved by admin${note ? `: ${note}` : ''}`,
                        },
                    },
                },
            });
        });

        await refundOrderToWallet(order, req.user);
        await reverseOrderPoints(order, req.user);
        const updated = await prisma.order.update({
            where: { id: order.id },
            data: {
                returnRequest: { ...rr, status: 'Approved', decidedAt: new Date().toISOString(), note },
            },
        });

        if (order.customerId) {
            createNotification({
                userId: order.customerId, role: 'USER', type: 'RETURN_APPROVED',
                title: 'Return Approved', message: `Your return for order #${order.orderId} was approved. Your refund has been added to your M2C Wallet.`,
                data: { orderId: order.id },
            }).catch(() => {});
        }

        res.json({ success: true, data: updated, message: 'Return approved and refund added to wallet' });
    } catch (error) {
        console.error('Decide return error:', error);
        res.status(500).json({ success: false, error: 'Failed to process return decision' });
    }
};

// Dedicated admin cancel entry point. Forces status=CANCELLED and delegates to
// updateAdminOrderStatus (which enforces the transition guard, cancels
// settlements and issues the refund). Exists as its own route so it can accept
// either the vendor-to-hub or hub-to-customer "update_status" permission —
// admins cancel a whole order from whichever stage/page they're on — without
// widening the shared status endpoint's ship/deliver transitions.
const cancelAdminOrder = async (req, res) => {
    const cancelReason = req.body?.cancelReason;
    // Whether to return the units to inventory. Defaults to false — a cancellation
    // does not restock unless the admin explicitly approves it.
    const restock = req.body?.restock === true;
    req.body = { status: 'CANCELLED', cancelReason, restock };
    return updateAdminOrderStatus(req, res);
};

module.exports = {
    getAllShipmentsAdmin,
    getShipmentByIdAdmin,
    updateShipmentStatusAdmin,
    getAllOrdersAdmin,
    getAdminOrderById,
    updateAdminOrderStatus,
    cancelAdminOrder,
    decideReturn,
};
