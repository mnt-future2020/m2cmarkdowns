import axios from '@/lib/axios';

export interface CourierIntegrationSettings {
  id?: string;
  provider: string;            // 'delhivery'
  enabled: boolean;
  connected: boolean;
  environment: 'staging' | 'production';
  pickupName: string;
  originPincode: string;
  clientName: string;
  useLiveRates: boolean;
  defaultWeightGrams: number;
  defaultLengthCm: number;
  defaultWidthCm: number;
  defaultHeightCm: number;
  hasToken: boolean;
  tokenPreview: string;
  lastTestAt?: string | null;
  lastTestError?: string | null;
  hasWebhookSecret?: boolean;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  prepaid?: boolean;
  cod?: boolean;
  pickup?: boolean;
  city?: string;
  state?: string;
}

class CourierIntegrationService {
  // Public (no auth) — storefront flag: is the live courier handling India orders?
  // `useLiveRates` adds whether Delhivery live rates price India shipping.
  async getPublicStatus(): Promise<{ success: boolean; data: { provider: string; liveActiveIN: boolean; useLiveRates: boolean } }> {
    const res = await axios.get('/courier-integration/public');
    return res.data;
  }
  // Customer (auth) — live Delhivery shipping cost for the signed-in user's cart to
  // a destination pincode. liveRate=false means use the manual weight-based rate.
  async getCartLiveRate(pincode: string, paymentMethod?: string): Promise<{ success: boolean; data: { ok: boolean; liveRate: boolean; shippingInr?: number; weightGrams?: number } }> {
    const res = await axios.post('/courier-integration/cart-rate', { pincode, paymentMethod });
    return res.data;
  }
  async getSettings(): Promise<{ success: boolean; data: CourierIntegrationSettings }> {
    const res = await axios.get('/courier-integration/admin');
    return res.data;
  }
  async updateSettings(body: Partial<CourierIntegrationSettings> & { apiToken?: string }) {
    const res = await axios.put('/courier-integration/admin', body);
    return res.data as { success: boolean; message: string; data: CourierIntegrationSettings };
  }
  async testConnection(pin?: string) {
    const res = await axios.post('/courier-integration/admin/test', pin ? { pin } : {});
    return res.data as { success: boolean; message: string; data?: { serviceable: boolean; pin: string } };
  }
  // Register a pickup location (ClientWarehouse) with Delhivery and set it as the
  // integration's pickup. The `name` becomes the pickupName used on every shipment.
  async registerPickup(body: { name: string; phone: string; email?: string; address: string; city: string; state: string; pincode: string }) {
    const res = await axios.post('/courier-integration/admin/register-pickup', body);
    return res.data as { success: boolean; message: string };
  }
  // Generate/rotate the webhook secret; returns updated settings incl. webhookUrl.
  async generateWebhookSecret() {
    const res = await axios.post('/courier-integration/admin/webhook-secret');
    return res.data as { success: boolean; message: string; data: CourierIntegrationSettings };
  }
  async checkServiceability(pin: string): Promise<{ success: boolean; data: ServiceabilityResult }> {
    const res = await axios.get('/courier-integration/serviceability', { params: { pin } });
    return res.data;
  }

  // ── Per-order shipment operations ──
  async createShipment(orderId: string) {
    const res = await axios.post(`/courier-integration/orders/${orderId}/ship`);
    return res.data as { success: boolean; message: string; data: { awb: string; labelUrl: string | null } };
  }
  async getLabel(orderId: string) {
    const res = await axios.get(`/courier-integration/orders/${orderId}/label`);
    return res.data as { success: boolean; data: { labelUrl: string | null } };
  }
  async track(orderId: string) {
    const res = await axios.get(`/courier-integration/orders/${orderId}/track`);
    return res.data as { success: boolean; data: any };
  }
  async cancelShipment(orderId: string) {
    const res = await axios.post(`/courier-integration/orders/${orderId}/cancel`);
    return res.data as { success: boolean; message: string };
  }
}

export const courierIntegrationService = new CourierIntegrationService();
export default courierIntegrationService;
