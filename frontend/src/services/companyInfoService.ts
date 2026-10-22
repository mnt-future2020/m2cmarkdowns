import axios from '@/lib/axios';

export interface CompanyInfo {
  id: string;
  companyName: string;
  companyLogo?: string;
  secondaryLogo?: string;
  companyEmail?: string;
  companyPhone?: string;
  companyWebsite?: string;
  gstNumber?: string;
  panNumber?: string;
  cinNumber?: string;
  businessRegistrationNumber?: string;
  taxId?: string;
  registeredAddress?: string;
  addressLine2?: string;
  addressLine3?: string;
  landmark?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankIfscCode?: string;
  bankBranch?: string;
  socialInstagram?: string;
  socialFacebook?: string;
  socialYoutube?: string;
  updatedAt: string;
}

export interface UpdateBasicInfoData {
  companyName: string;
  companyEmail?: string;
  companyPhone?: string;
  companyWebsite?: string;
  socialInstagram?: string;
  socialFacebook?: string;
  socialYoutube?: string;
}

export interface UpdateLegalInfoData {
  gstNumber?: string;
  panNumber?: string;
  cinNumber?: string;
  businessRegistrationNumber?: string;
  taxId?: string;
}

export interface UpdateAddressData {
  registeredAddress?: string;
  addressLine2?: string;
  addressLine3?: string;
  landmark?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
}

export interface UpdateBankDetailsData {
  bankName?: string;
  bankAccountNumber?: string;
  bankIfscCode?: string;
  bankBranch?: string;
}

export interface PublicCompanyInfo {
  companyName: string;
  companyLogo: string | null;
  secondaryLogo: string | null;
  favicon: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  companyWebsite: string | null;
  registeredAddress: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zipCode: string | null;
  socialInstagram: string | null;
  socialFacebook: string | null;
  socialYoutube: string | null;
}

const LOGO_CACHE_KEY = 'companyInfo_public';
const DEFAULT_INFO: PublicCompanyInfo = {
  companyName: 'M2C Markdowns Pvt Ltd',
  companyLogo: null,
  secondaryLogo: null,
  favicon: null,
  companyEmail: null,
  companyPhone: null,
  companyWebsite: null,
  registeredAddress: null,
  city: null,
  state: null,
  country: null,
  zipCode: null,
  socialInstagram: null,
  socialFacebook: null,
  socialYoutube: null,
};

export const companyInfoService = {
  // Get cached company info instantly (no API call — for initial render)
  getCachedCompanyInfo: (): PublicCompanyInfo => {
    try {
      const cached = localStorage.getItem(LOGO_CACHE_KEY);
      if (cached) return { ...DEFAULT_INFO, ...JSON.parse(cached) };
    } catch { /* ignore */ }
    return DEFAULT_INFO;
  },

  // Get public company info with localStorage caching (no auth required)
  getPublicCompanyInfo: async (): Promise<PublicCompanyInfo> => {
    try {
      const response = await axios.get('/company-info/public');
      const data = { ...DEFAULT_INFO, ...(response.data?.data || {}) };
      try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
      return data;
    } catch {
      return companyInfoService.getCachedCompanyInfo();
    }
  },

  // Get company info
  getCompanyInfo: async () => {
    try {
      const response = await axios.get('/company-info');
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to fetch company info');
    }
  },

  // Update basic information
  updateBasicInfo: async (data: UpdateBasicInfoData) => {
    try {
      const response = await axios.put('/company-info/basic', data);
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update basic information');
    }
  },

  // Update legal information
  updateLegalInfo: async (data: UpdateLegalInfoData) => {
    try {
      const response = await axios.put('/company-info/legal', data);
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update legal information');
    }
  },

  // Update address
  updateAddress: async (data: UpdateAddressData) => {
    try {
      const response = await axios.put('/company-info/address', data);
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update address');
    }
  },

  // Update bank details
  updateBankDetails: async (data: UpdateBankDetailsData) => {
    try {
      const response = await axios.put('/company-info/bank', data);
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update bank details');
    }
  },

  // Update company logo (primary — brand pages)
  updateLogo: async (companyLogo: string) => {
    try {
      const response = await axios.put('/company-info/logo', { companyLogo });
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update company logo');
    }
  },

  // Update secondary logo (shown in the header on non-brand pages)
  updateSecondaryLogo: async (secondaryLogo: string) => {
    try {
      const response = await axios.put('/company-info/logo', { secondaryLogo });
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update secondary logo');
    }
  },

  // Update favicon (browser-tab icon — square image)
  updateFavicon: async (favicon: string) => {
    try {
      const response = await axios.put('/company-info/logo', { favicon });
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update favicon');
    }
  },

  // Get vendor notification email settings
  getVendorNotificationSettings: async () => {
    try {
      const response = await axios.get('/company-info/vendor-notifications');
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to fetch vendor notification settings');
    }
  },

  // Update vendor notification email settings
  updateVendorNotificationSettings: async (emails: string[]) => {
    try {
      const response = await axios.put('/company-info/vendor-notifications', { emails });
      return response.data;
    } catch (error: any) {
      throw new Error(error.message || 'Failed to update vendor notification settings');
    }
  }
};
