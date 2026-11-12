import axios from '@/lib/axios';
import { getCurrency, getRegion } from '@/lib/currency';
import type { ActiveOffer } from '@/lib/offers';

export interface CartItem {
  id: string;
  productId: string;
  variantId?: string;
  quantity: number;
  price: number;
  /** Shipping mode chosen for this line — required when the product offers a choice. */
  transportType?: 'AIR' | 'SHIP' | null;
  /** Courier partner id (see lib/couriers) chosen for this line. */
  courier?: string | null;
  /** True when this line is a free gift from a "Buy A get B free" offer (price 0). */
  isFreeGift?: boolean;
  /** The offer that granted this free-gift line. */
  giftOfferId?: string | null;
  product?: {
    id: string;
    name: string;
    images: { url: string; isPrimary: boolean }[];
    basePrice: number;
    description?: string;
    gstPercentage?: number;
    /** Per-product shipping rules. Rates inside are in INR — convert for USD carts. */
    logisticsConfig?: any;
    inStock?: boolean;
    availableStock?: number;
    originalPrice?: number;
    adminFixedPrice?: number;
    priceINR?: number | null;
    priceUSD?: number | null;
    originalPriceINR?: number | null;
    originalPriceUSD?: number | null;
    category?: string;
    rating?: number;
    reviews?: number;
    material?: string;
    discount?: number;
    singleUnitColor?: string;
    singleUnitSize?: string;
    singleUnitColorHex?: string;
    /** Live automatic offer for this line, attached by the backend cart enrichment. */
    activeOffer?: ActiveOffer;
  };
  variant?: {
    variantName?: string;
    size: string;
    color: string;
    colorHex?: string;
    sku: string;
    stock: number;
    images?: string[];
  };
}

/** A free gift the customer must choose (offer's free set has multiple products/variants). */
export interface PendingGift {
  offerId: string;
  offerTitle: string;
  getQty: number;
  freeScope?: 'PRODUCT' | 'CATEGORY' | null;
  options: {
    productId: string;
    name: string;
    image: string | null;
    variants: { id: string; size?: string; color?: string; colorHex?: string; stock: number }[];
  }[];
}

export interface CartResponse {
  success: boolean;
  data?: {
    items: CartItem[];
    total: number;
    itemCount: number;
    /** Free gifts awaiting the customer's choice (chooser modal). */
    pendingGifts?: PendingGift[];
    /** Chooser data for every choosable gift offer (chosen or not) — powers "Change gift". */
    giftOptions?: PendingGift[];
  };
  message?: string;
  error?: string;
}

class CartService {
  // Notify header and other listeners of cart count changes
  private _notify(count: number) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count } }));
    }
  }

  // Add item to cart. Optionally carries the shipping choice (transport + courier)
  // made on the product page so the line lands in the cart ready to check out.
  async addToCart(
    productId: string,
    quantity: number = 1,
    variantId?: string,
    shipping?: { transportType?: 'AIR' | 'SHIP' | null; courier?: string | null }
  ): Promise<CartResponse> {
    try {
      const currency = getCurrency();
      const response = await axios.post('/cart/add', {
        productId,
        quantity,
        variantId,
        currency,
        ...(shipping?.transportType !== undefined ? { transportType: shipping.transportType } : {}),
        ...(shipping?.courier !== undefined ? { courier: shipping.courier } : {}),
      });
      const result: CartResponse = response.data;
      if (result.success && result.data) {
        this._notify(result.data.itemCount);
      }
      return result;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to add item to cart');
    }
  }

  /** Choose a free gift (for a "Buy A get B free" offer whose free set has options). */
  async addFreeGift(offerId: string, productId: string, variantId?: string): Promise<CartResponse> {
    try {
      const response = await axios.post('/cart/gift', { offerId, productId, variantId }, { params: { region: getRegion() } });
      const result: CartResponse = response.data;
      if (result.success && result.data) this._notify(result.data.itemCount);
      return result;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to add free gift');
    }
  }

  // Get cart items
  async getCart(): Promise<CartResponse> {
    try {
      // Region drives which offers apply and the currency they're priced in.
      const response = await axios.get('/cart', { params: { region: getRegion() } });
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to fetch cart');
    }
  }

  // Update cart item quantity
  async updateCartItem(itemId: string, quantity: number): Promise<CartResponse> {
    try {
      const response = await axios.put(`/cart/${itemId}`, { quantity });
      const result: CartResponse = response.data;
      if (result.success && result.data) {
        this._notify(result.data.itemCount);
      }
      return result;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update cart item');
    }
  }

  /** Set the shipping mode and courier for one cart line. */
  async setShipping(itemId: string, transportType: 'AIR' | 'SHIP', courier: string | null): Promise<CartResponse> {
    try {
      // Send the active storefront currency so the server validates the courier
      // against the region the shopper is actually in (and re-aligns a line that
      // was added in another region), not the currency frozen on the line.
      const response = await axios.put(`/cart/${itemId}`, { transportType, courier, currency: getCurrency() });
      return response.data;
    } catch (error: any) {
      throw new Error(error?.response?.data?.error || error.message || 'Failed to set shipping method');
    }
  }

  // Remove item from cart
  async removeFromCart(itemId: string): Promise<CartResponse> {
    try {
      const response = await axios.delete(`/cart/${itemId}`);
      const result: CartResponse = response.data;
      if (result.success && result.data) {
        this._notify(result.data.itemCount);
      }
      return result;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to remove item from cart');
    }
  }

  // Clear cart
  async clearCart(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await axios.delete('/cart/clear');
      this._notify(0);
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to clear cart');
    }
  }

  // Local storage methods for guest users
  getLocalCart(): CartItem[] {
    if (typeof window === 'undefined') return [];
    try {
      const cart = localStorage.getItem('guestCart');
      return cart ? JSON.parse(cart) : [];
    } catch {
      return [];
    }
  }

  saveLocalCart(items: CartItem[]): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('guestCart', JSON.stringify(items));
    } catch (error) {
    }
  }

  addToLocalCart(productId: string, quantity: number = 1, variantId?: string): void {
    const cart = this.getLocalCart();
    const existingItem = cart.find(item => item.productId === productId && item.variantId === variantId);

    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      cart.push({
        id: Date.now().toString() + Math.random().toString(36).substring(7),
        productId,
        variantId,
        quantity,
        price: 0 // Will be updated when fetching product details
      });
    }

    this.saveLocalCart(cart);
    this._notify(cart.length);
  }

  removeFromLocalCart(id: string): void {
    const cart = this.getLocalCart();
    const updatedCart = cart.filter(item => item.id !== id);
    this.saveLocalCart(updatedCart);
    this._notify(updatedCart.length);
  }

  updateLocalCartItem(id: string, quantity: number): void {
    const cart = this.getLocalCart();
    const existingItem = cart.find(item => item.id === id);

    if (existingItem) {
      existingItem.quantity = quantity;
      this.saveLocalCart(cart);
      this._notify(cart.length);
    }
  }

  clearLocalCart(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem('guestCart');
      this._notify(0);
    } catch (error) {
      console.error('Failed to clear local cart:', error);
    }
  }

  // Check free shipping eligibility
  async checkFreeShipping(userId: string, cartTotal: number): Promise<{ success: boolean; data?: any; message?: string }> {
    try {
      const response = await axios.post('/coupons/check-free-shipping', { userId, cartTotal, region: getRegion() });
      return response.data;
    } catch (error: any) {
      console.warn('Free shipping check failed:', error);
      return { success: false, message: error.message || 'Failed to check free shipping' };
    }
  }
}

export const cartService = new CartService();
export default cartService;
