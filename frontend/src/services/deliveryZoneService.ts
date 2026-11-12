import axios from '@/lib/axios';

export interface ZoneState { iso: string; name: string }

export interface DeliveryZone {
  id: string;
  name: string;
  countryIso: string;
  countryName: string;
  allStates: boolean;
  states: ZoneState[];
  allCities: boolean;
  cities: string[];
  flatFee: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type ZonePayload = Omit<DeliveryZone, 'id' | 'createdAt' | 'updatedAt'>;

export interface DeliveryQuote {
  success: boolean;
  serviceable: boolean;
  zone?: { id: string; name: string; flatFee: number };
  shippingGstPct?: number;
  weightInr?: number;
  flatFeeInr?: number;
  shippingBaseInr?: number;
  shippingTaxInr?: number;
}

class DeliveryZoneService {
  async getZones(): Promise<{ success: boolean; data: DeliveryZone[]; shippingGstPercentage: number }> {
    const res = await axios.get('/delivery-zones');
    return res.data;
  }
  async createZone(payload: ZonePayload): Promise<{ success: boolean; data: DeliveryZone }> {
    const res = await axios.post('/delivery-zones', payload);
    return res.data;
  }
  async updateZone(id: string, payload: ZonePayload): Promise<{ success: boolean; data: DeliveryZone }> {
    const res = await axios.put(`/delivery-zones/${id}`, payload);
    return res.data;
  }
  async deleteZone(id: string): Promise<{ success: boolean }> {
    const res = await axios.delete(`/delivery-zones/${id}`);
    return res.data;
  }
  async updateShippingGst(shippingGstPercentage: number): Promise<{ success: boolean; shippingGstPercentage: number }> {
    const res = await axios.put('/delivery-zones/shipping-gst', { shippingGstPercentage });
    return res.data;
  }
  // Checkout: serviceability + shipping breakdown (INR). Returns not-serviceable on any error.
  async quote(body: { country?: string; state?: string; city?: string; pincode?: string; currency?: string; weightShippingInr?: number; freeShipping?: boolean }): Promise<DeliveryQuote> {
    try {
      const res = await axios.post('/delivery-zones/quote', body);
      return res.data;
    } catch {
      return { success: false, serviceable: false };
    }
  }
}

export const deliveryZoneService = new DeliveryZoneService();
export default deliveryZoneService;
