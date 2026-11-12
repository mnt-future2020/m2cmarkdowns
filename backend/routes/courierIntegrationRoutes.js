const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/courierIntegrationController');
const { authenticateToken, requireAdminRole, requirePermission } = require('../middleware/auth');

// Public (no auth) — storefront flag to hide the manual courier picker for India.
router.get('/public', publicStatus);
// Customer (auth, no admin role) — live Delhivery shipping rate for their cart.
router.post('/cart-rate', authenticateToken, getCartLiveRate);
// Delhivery status webhook — public, authenticated by the ?secret in the URL.
router.post('/webhook', webhook);

router.use(authenticateToken, requireAdminRole);

// Settings (part of the Settings module).
router.get('/admin', requirePermission('settings:view'), getSettings);
router.put('/admin', requirePermission('settings:edit'), updateSettings);
router.post('/admin/test', requirePermission('settings:edit'), testConnection);
router.post('/admin/register-pickup', requirePermission('settings:edit'), registerPickup);
router.post('/admin/webhook-secret', requirePermission('settings:edit'), generateWebhookSecret);

// Pincode serviceability lookup (handy from Settings + order dispatch).
router.get('/serviceability', serviceability);
// Live shipping-rate quote for a destination pincode + weight.
router.get('/rate', rateQuote);

// Per-order shipment operations — gated by the hub→customer dispatch permission.
router.post('/orders/:orderId/ship', requirePermission('hub_to_customer:update_status'), createOrderShipment);
router.get('/orders/:orderId/label', requirePermission('hub_to_customer:view'), getOrderLabel);
router.get('/orders/:orderId/track', requirePermission('hub_to_customer:view'), trackOrder);
router.post('/orders/:orderId/cancel', requirePermission('hub_to_customer:update_status'), cancelOrderShipment);

module.exports = router;
