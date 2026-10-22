"use client";

import { useState, useEffect } from "react";
import { User, Mail, Phone, MapPin, Building2, Shield, Save, FileText, CreditCard, Upload, Image as ImageIcon, DollarSign, Key, Eye, EyeOff, Percent, Warehouse, Globe, Camera, Truck, Gift } from "lucide-react";
import ImageCropModal from "@/components/UI/ImageCropModal";
import Dropdown from "@/components/UI/Dropdown";
import GSTSettingsTab from "./GSTSettingsTab";
import HubSettingsTab from "./HubSettingsTab";
import SEOSettingsTab from "./SEOSettingsTab";
import BannerSettingsTab from "./BannerSettingsTab";
import ExchangeRateTab from "./ExchangeRateTab";
import EmailTemplatesTab from "./EmailTemplatesTab";
import CreditPointsSettingsTab from "./CreditPointsSettingsTab";
import CourierManagement from "@/components/AdminDashboard/Couriers/CourierManagement";
import DeliveryZones from "@/components/AdminDashboard/Logistics/DeliveryZones";
import InvoiceSettings from "../Billing/Settings/InvoiceSettings";
import { Card, CardContent } from "../../UI/Card";
import { showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import { paymentSettingsService } from "@/services/paymentSettingsService";
import { adminProfileService } from "@/services/adminProfileService";
import { companyInfoService } from "@/services/companyInfoService";
import { hasPermission, getStoredAuth, storeAuth } from "@/lib/auth";
import { getCountries, getStates, normalizeCountryToIso } from "@/components/WebSite/CheckOut/CheckoutProcess/constants";

type UserRole = "super_admin" | "admin" | "employee";

interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  avatar: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

export default function Settings() {
  const canManageSettings = hasPermission("settings:edit");
  // Simulate getting current user role - replace with actual auth
  const [currentUser] = useState<UserProfile>({
    id: "1",
    name: "John Admin",
    email: "john.admin@company.com",
    phone: "+1 234-567-8900",
    role: "super_admin", // Change to "admin" or "employee" to test different views
    avatar: "",
    address: "123 Admin Street",
    city: "New York",
    state: "NY",
    zipCode: "10001",
  });

  const [activeTab, setActiveTab] = useState<"profile" | "company" | "payment" | "gst" | "hub" | "invoice" | "seo" | "banner" | "vendor-notif" | "exchange-rate" | "email-templates" | "couriers" | "delivery-zones" | "credit-points">("profile");

  // Profile form state
  const [profileData, setProfileData] = useState({
    title: "",
    firstName: "",
    middleName: "",
    lastName: "",
    email: currentUser.email,
    phone: currentUser.phone,
    address: currentUser.address,
    addressLine2: "",
    addressLine3: "",
    landmark: "",
    city: currentUser.city,
    state: currentUser.state,
    zipCode: currentUser.zipCode,
    country: "India",
  });

  // Composed display name (Title First Middle Last) for the header card etc.
  const displayName =
    [profileData.title, profileData.firstName, profileData.middleName, profileData.lastName]
      .map((p) => (p || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim() || currentUser.name;

  const TITLE_OPTIONS = ["", "Mr.", "Mrs.", "Ms.", "Dr."];

  // Profile photo (upload + crop). `profileImage` is the saved URL or a freshly
  // cropped base64 preview; the crop modal opens with the chosen file.
  const [profileImage, setProfileImage] = useState<string>("");
  // Falls back to the placeholder icon if the photo URL fails to load (CDN hiccup,
  // deleted asset) instead of showing a blank/broken image. Reset on every new URL.
  const [profileImgBroken, setProfileImgBroken] = useState(false);
  useEffect(() => { setProfileImgBroken(false); }, [profileImage]);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropFileName, setCropFileName] = useState("");

  // Company info state (only for super_admin and admin)
  const [companyInfo, setCompanyInfo] = useState({
    companyName: "M2C Markdowns Pvt Ltd",
    companyLogo: "",
    secondaryLogo: "",
    favicon: "",
    gstNumber: "29ABCDE1234F1Z5",
    panNumber: "ABCDE1234F",
    cinNumber: "U74999KA2020PTC123456",
    companyEmail: "info@m2c.com",
    companyPhone: "+91 80-1234-5678",
    companyWebsite: "https://www.m2c.com",
    registeredAddress: "123 Business Park, Tech City",
    addressLine2: "",
    addressLine3: "",
    landmark: "",
    city: "Bangalore",
    state: "Karnataka",
    country: "IN",
    zipCode: "560001",
    bankName: "HDFC Bank",
    bankAccountNumber: "1234567890",
    bankIfscCode: "HDFC0001234",
    bankBranch: "MG Road Branch",
    socialInstagram: "",
    socialFacebook: "",
    socialYoutube: "",
  });

  // Razorpay settings state (only for super_admin)
  const [razorpaySettings, setRazorpaySettings] = useState({
    enabled: false,
    keyId: "",
    keySecret: "",
    webhookSecret: "",
    xAccountNumber: ""
  });

  // PayU settings state (only for super_admin)
  const [payuSettings, setPayuSettings] = useState({
    enabled: false,
    merchantKey: "",
    merchantSalt: ""
  });

  // Loading state for payment settings
  const [loadingPaymentSettings, setLoadingPaymentSettings] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [loadingCompanyInfo, setLoadingCompanyInfo] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [uploadingSecondaryLogo, setUploadingSecondaryLogo] = useState(false);
  const [secondaryLogoPreview, setSecondaryLogoPreview] = useState<string | null>(null);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  const [faviconPreview, setFaviconPreview] = useState<string | null>(null);

  // Password visibility states
  const [showRazorpaySecret, setShowRazorpaySecret] = useState(false);
  const [showRazorpayWebhook, setShowRazorpayWebhook] = useState(false);
  const [showPayuSalt, setShowPayuSalt] = useState(false);

  // Track if secrets are masked (from backend)
  const isRazorpaySecretMasked = razorpaySettings.keySecret === '••••••••';
  const isRazorpayWebhookMasked = razorpaySettings.webhookSecret === '••••••••';
  const isPayuSaltMasked = payuSettings.merchantSalt === '••••••••';

  // Access control
  const canAccessAdminSettings = currentUser.role === "super_admin" || currentUser.role === "admin";
  const isReadOnly = currentUser.role === "employee" || !canManageSettings;

  // Fetch data on component mount
  useEffect(() => {
    const fetchData = async () => {
      // Fetch admin profile
      try {
        setLoadingProfile(true);
        const profileResponse = await adminProfileService.getProfile();
        if (profileResponse.success && profileResponse.data) {
          const d = profileResponse.data;
          // Legacy records only have `name` — split it as a best-effort fallback
          // so First/Last aren't blank until the admin re-saves the structured form.
          const nameParts = (d.name || "").trim().split(/\s+/).filter(Boolean);
          const fallbackFirst = nameParts[0] || "";
          const fallbackLast = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
          setProfileData({
            title: d.title || "",
            firstName: d.firstName || fallbackFirst,
            middleName: d.middleName || "",
            lastName: d.lastName || fallbackLast,
            email: d.email || "",
            phone: d.phoneNumber || "",
            address: d.address || "",
            addressLine2: d.addressLine2 || "",
            addressLine3: d.addressLine3 || "",
            landmark: d.landmark || "",
            city: d.city || "",
            state: d.state || "",
            zipCode: d.zipCode || "",
            country: d.country || "India",
          });
          setProfileImage(d.image || "");
        }
      } catch (error) {
        console.error('Failed to fetch profile:', error);
      } finally {
        setLoadingProfile(false);
      }

      // Fetch company info (for admins)
      if (canAccessAdminSettings) {
        try {
          setLoadingCompanyInfo(true);
          const companyResponse = await companyInfoService.getCompanyInfo();
          if (companyResponse.success && companyResponse.data) {
            setCompanyInfo({
              companyName: companyResponse.data.companyName || "",
              companyLogo: companyResponse.data.companyLogo || "",
              secondaryLogo: companyResponse.data.secondaryLogo || "",
              favicon: companyResponse.data.favicon || "",
              gstNumber: companyResponse.data.gstNumber || "",
              panNumber: companyResponse.data.panNumber || "",
              cinNumber: companyResponse.data.cinNumber || "",
              companyEmail: companyResponse.data.companyEmail || "",
              companyPhone: companyResponse.data.companyPhone || "",
              companyWebsite: companyResponse.data.companyWebsite || "",
              registeredAddress: companyResponse.data.registeredAddress || "",
              addressLine2: companyResponse.data.addressLine2 || "",
              addressLine3: companyResponse.data.addressLine3 || "",
              landmark: companyResponse.data.landmark || "",
              city: companyResponse.data.city || "",
              state: companyResponse.data.state || "",
              // Normalise legacy free-text country ("India") to an ISO code for the dropdown.
              country: normalizeCountryToIso(companyResponse.data.country) || "",
              zipCode: companyResponse.data.zipCode || "",
              bankName: companyResponse.data.bankName || "",
              bankAccountNumber: companyResponse.data.bankAccountNumber || "",
              bankIfscCode: companyResponse.data.bankIfscCode || "",
              bankBranch: companyResponse.data.bankBranch || "",
              socialInstagram: companyResponse.data.socialInstagram || "",
              socialFacebook: companyResponse.data.socialFacebook || "",
              socialYoutube: companyResponse.data.socialYoutube || "",
            });
          }
        } catch (error) {
          console.error('Failed to fetch company info:', error);
        } finally {
          setLoadingCompanyInfo(false);
        }
      }

      // Fetch payment settings (for super_admin)
      if (currentUser.role === "super_admin") {
        try {
          setLoadingPaymentSettings(true);
          const response = await paymentSettingsService.getPaymentSettings();

          if (response.success && response.data) {
            setRazorpaySettings({
              enabled: response.data.razorpayEnabled,
              keyId: response.data.razorpayKeyId || "",
              keySecret: response.data.razorpayKeySecret || "",
              webhookSecret: response.data.razorpayWebhookSecret || "",
              xAccountNumber: (response.data as any).razorpayxAccountNumber || ""
            });

            setPayuSettings({
              enabled: response.data.payuEnabled,
              merchantKey: response.data.payuMerchantKey || "",
              merchantSalt: response.data.payuMerchantSalt || ""
            });
          }
        } catch (error) {
          console.error('Failed to fetch payment settings:', error);
        } finally {
          setLoadingPaymentSettings(false);
        }
      }
    };

    fetchData();
  }, [currentUser.role, canAccessAdminSettings]);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoadingProfile(true);
      const response = await adminProfileService.updateProfile({
        title: profileData.title,
        firstName: profileData.firstName,
        middleName: profileData.middleName,
        lastName: profileData.lastName,
        phoneNumber: profileData.phone,
        address: profileData.address,
        addressLine2: profileData.addressLine2,
        addressLine3: profileData.addressLine3,
        landmark: profileData.landmark,
        city: profileData.city,
        state: profileData.state,
        zipCode: profileData.zipCode,
        country: profileData.country || "India",
        image: profileImage,
      });

      if (response.success) {
        // Reflect the persisted (Cloudinary) URL so we stop re-uploading base64.
        const savedImage = response.data?.image ?? profileImage;
        if (response.data?.image !== undefined) setProfileImage(response.data.image || "");
        // Sync the stored auth user + tell the header/sidebar to refresh their
        // avatar and name immediately (they read from stored auth).
        try {
          const auth = getStoredAuth();
          if (auth?.user) {
            const updatedUser = { ...auth.user, name: response.data?.name || displayName, image: savedImage || undefined };
            storeAuth(auth.token, updatedUser, true);
            window.dispatchEvent(new CustomEvent("admin-profile-updated", { detail: updatedUser }));
          }
        } catch { /* non-fatal — header refreshes on next load */ }
        showSuccessToast("Profile Updated", response.message || "Your profile has been updated successfully.");
      }
    } catch (error: any) {
      showErrorToast("Update Failed", error.message || "Failed to update profile. Please try again.");
    } finally {
      setLoadingProfile(false);
    }
  };

  // Profile photo: open the cropper with the selected file, then keep the
  // cropped base64 as a preview (uploaded to Cloudinary on Save).
  const handleProfilePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCropFileName(file.name);
    setCropSrc(URL.createObjectURL(file));
  };

  const handleProfilePhotoCropped = (croppedFile: File) => {
    const reader = new FileReader();
    reader.onload = () => setProfileImage(reader.result as string);
    reader.readAsDataURL(croppedFile);
    if (cropSrc?.startsWith("blob:")) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    setCropFileName("");
  };

  const handleCompanyInfoUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoadingCompanyInfo(true);

      // Determine which section is being updated based on the form
      const formId = (e.target as HTMLFormElement).id;

      let response;
      if (formId === 'basic-info-form') {
        response = await companyInfoService.updateBasicInfo({
          companyName: companyInfo.companyName,
          companyEmail: companyInfo.companyEmail,
          companyPhone: companyInfo.companyPhone,
          companyWebsite: companyInfo.companyWebsite,
          socialInstagram: companyInfo.socialInstagram,
          socialFacebook: companyInfo.socialFacebook,
          socialYoutube: companyInfo.socialYoutube,
        });
      } else if (formId === 'legal-info-form') {
        response = await companyInfoService.updateLegalInfo({
          gstNumber: companyInfo.gstNumber,
          panNumber: companyInfo.panNumber,
          cinNumber: companyInfo.cinNumber
        });
      } else if (formId === 'address-form') {
        response = await companyInfoService.updateAddress({
          registeredAddress: companyInfo.registeredAddress,
          addressLine2: companyInfo.addressLine2,
          addressLine3: companyInfo.addressLine3,
          landmark: companyInfo.landmark,
          city: companyInfo.city,
          state: companyInfo.state,
          country: companyInfo.country,
          zipCode: companyInfo.zipCode
        });
      } else if (formId === 'bank-details-form') {
        response = await companyInfoService.updateBankDetails({
          bankName: companyInfo.bankName,
          bankAccountNumber: companyInfo.bankAccountNumber,
          bankIfscCode: companyInfo.bankIfscCode,
          bankBranch: companyInfo.bankBranch
        });
      }

      if (response?.success) {
        showSuccessToast("Company Info Updated", response.message || "Company information has been updated successfully.");
      }
    } catch (error: any) {
      showErrorToast("Update Failed", error.message || "Failed to update company information. Please try again.");
    } finally {
      setLoadingCompanyInfo(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showErrorToast("Invalid File", "Please upload an image file");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showErrorToast("File Too Large", "Please upload an image smaller than 5MB");
      return;
    }

    // Convert to base64 for preview
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      setLogoPreview(base64String);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveLogo = async () => {
    if (!logoPreview) return;

    try {
      setUploadingLogo(true);
      const response = await companyInfoService.updateLogo(logoPreview);

      if (response.success) {
        setCompanyInfo(prev => ({
          ...prev,
          companyLogo: logoPreview
        }));
        setLogoPreview(null);
        showSuccessToast("Logo Saved", "Company logo has been saved successfully");
      }
    } catch (error: any) {
      showErrorToast("Save Failed", error.message || "Failed to save logo");
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleCancelLogo = () => {
    setLogoPreview(null);
    // Reset file input
    const fileInput = document.getElementById('logo-upload') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };

  // ── Secondary logo (shown in the header on non-brand pages) ──
  const handleSecondaryLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showErrorToast("Invalid File", "Please upload an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showErrorToast("File Too Large", "Please upload an image smaller than 5MB");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setSecondaryLogoPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveSecondaryLogo = async () => {
    if (!secondaryLogoPreview) return;

    try {
      setUploadingSecondaryLogo(true);
      const response = await companyInfoService.updateSecondaryLogo(secondaryLogoPreview);

      if (response.success) {
        setCompanyInfo(prev => ({
          ...prev,
          secondaryLogo: secondaryLogoPreview
        }));
        setSecondaryLogoPreview(null);
        showSuccessToast("Logo Saved", "Secondary logo has been saved successfully");
      }
    } catch (error: any) {
      showErrorToast("Save Failed", error.message || "Failed to save secondary logo");
    } finally {
      setUploadingSecondaryLogo(false);
    }
  };

  const handleCancelSecondaryLogo = () => {
    setSecondaryLogoPreview(null);
    const fileInput = document.getElementById('secondary-logo-upload') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };

  // ── Favicon (browser-tab icon — square image) ──
  const handleFaviconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Favicons are commonly PNG/ICO/SVG — accept any image type.
    if (!file.type.startsWith('image/')) {
      showErrorToast("Invalid File", "Please upload an image file (PNG, SVG or ICO)");
      return;
    }
    // Favicons should be tiny; cap at 1MB.
    if (file.size > 1 * 1024 * 1024) {
      showErrorToast("File Too Large", "Please upload a favicon smaller than 1MB");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setFaviconPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveFavicon = async () => {
    if (!faviconPreview) return;

    try {
      setUploadingFavicon(true);
      const response = await companyInfoService.updateFavicon(faviconPreview);

      if (response.success) {
        setCompanyInfo(prev => ({
          ...prev,
          favicon: response.data?.favicon || faviconPreview
        }));
        setFaviconPreview(null);
        showSuccessToast("Favicon Saved", "The browser-tab icon has been updated. It may take a refresh to appear.");
      }
    } catch (error: any) {
      showErrorToast("Save Failed", error.message || "Failed to save favicon");
    } finally {
      setUploadingFavicon(false);
    }
  };

  const handleCancelFavicon = () => {
    setFaviconPreview(null);
    const fileInput = document.getElementById('favicon-upload') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };

  const handleRazorpaySettingsUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoadingPaymentSettings(true);
      const response = await paymentSettingsService.updateRazorpaySettings({
        enabled: razorpaySettings.enabled,
        keyId: razorpaySettings.keyId,
        keySecret: razorpaySettings.keySecret,
        webhookSecret: razorpaySettings.webhookSecret,
        xAccountNumber: razorpaySettings.xAccountNumber
      });

      if (response.success) {
        showSuccessToast("Razorpay Settings Updated", response.message || "Payment gateway settings have been updated successfully.");

        // Update state with sanitized data from response
        if (response.data) {
          setRazorpaySettings(prev => ({
            ...prev,
            enabled: response.data.razorpayEnabled !== undefined ? response.data.razorpayEnabled : prev.enabled,
            keySecret: response.data.razorpayKeySecret || prev.keySecret,
            webhookSecret: response.data.razorpayWebhookSecret || prev.webhookSecret
          }));

          // If Razorpay was enabled, disable PayU
          if (response.data.payuEnabled !== undefined) {
            setPayuSettings(prev => ({
              ...prev,
              enabled: response.data.payuEnabled || false
            }));
          }
        }
      }
    } catch (error: any) {
      showErrorToast("Update Failed", error.message || "Failed to update Razorpay settings. Please try again.");
    } finally {
      setLoadingPaymentSettings(false);
    }
  };

  const handlePayUSettingsUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoadingPaymentSettings(true);
      const response = await paymentSettingsService.updatePayUSettings({
        enabled: payuSettings.enabled,
        merchantKey: payuSettings.merchantKey,
        merchantSalt: payuSettings.merchantSalt
      });

      if (response.success) {
        showSuccessToast("PayU Settings Updated", response.message || "PayU payment gateway settings have been updated successfully.");

        // Update state with sanitized data from response
        if (response.data) {
          setPayuSettings(prev => ({
            ...prev,
            enabled: response.data.payuEnabled !== undefined ? response.data.payuEnabled : prev.enabled,
            merchantSalt: response.data.payuMerchantSalt || prev.merchantSalt
          }));

          // If PayU was enabled, disable Razorpay
          if (response.data.razorpayEnabled !== undefined) {
            setRazorpaySettings(prev => ({
              ...prev,
              enabled: response.data.razorpayEnabled || false
            }));
          }
        }
      }
    } catch (error: any) {
      showErrorToast("Update Failed", error.message || "Failed to update PayU settings. Please try again.");
    } finally {
      setLoadingPaymentSettings(false);
    }
  };

  return (
    <div className="p-6">

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-600 mt-1">Manage your profile and system settings</p>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-slate-200">
        <div className="flex gap-4 overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-200 [&_button]:shrink-0 [&_button]:whitespace-nowrap">
          <button
            onClick={() => setActiveTab("profile")}
            className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "profile"
              ? "border-brand-500 text-brand-600"
              : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
          >
            <User className="h-4 w-4 inline mr-2" />
            Profile Settings
          </button>
          {canAccessAdminSettings && (
            <>
              <button
                onClick={() => setActiveTab("company")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "company"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Building2 className="h-4 w-4 inline mr-2" />
                Company Info
              </button>
              <button
                onClick={() => setActiveTab("payment")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "payment"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <DollarSign className="h-4 w-4 inline mr-2" />
                Payment Settings
              </button>
              <button
                onClick={() => setActiveTab("gst")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "gst"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Percent className="h-4 w-4 inline mr-2" />
                GST Settings
              </button>
              <button
                onClick={() => setActiveTab("hub")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "hub"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Warehouse className="h-4 w-4 inline mr-2" />
                Hub Management
              </button>
              <button
                onClick={() => setActiveTab("invoice")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "invoice"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <FileText className="h-4 w-4 inline mr-2" />
                Invoice Settings
              </button>
              <button
                onClick={() => setActiveTab("seo")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "seo"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Globe className="h-4 w-4 inline mr-2" />
                SEO Settings
              </button>
              <button
                onClick={() => setActiveTab("banner")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "banner"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <ImageIcon className="h-4 w-4 inline mr-2" />
                Banner
              </button>
              <button
                onClick={() => setActiveTab("vendor-notif")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "vendor-notif"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Mail className="h-4 w-4 inline mr-2" />
                Vendor Notifications
              </button>
              <button
                onClick={() => setActiveTab("exchange-rate")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "exchange-rate"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <DollarSign className="h-4 w-4 inline mr-2" />
                Exchange Rate
              </button>
              <button
                onClick={() => setActiveTab("email-templates")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "email-templates"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Mail className="h-4 w-4 inline mr-2" />
                Email Templates
              </button>
              <button
                onClick={() => setActiveTab("couriers")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "couriers"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Truck className="h-4 w-4 inline mr-2" />
                Courier Partners
              </button>
              <button
                onClick={() => setActiveTab("delivery-zones")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "delivery-zones"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <MapPin className="h-4 w-4 inline mr-2" />
                Delivery Zones
              </button>
              <button
                onClick={() => setActiveTab("credit-points")}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${activeTab === "credit-points"
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
              >
                <Gift className="h-4 w-4 inline mr-2" />
                Credit Points
              </button>
            </>
          )}
        </div>
      </div>

      {/* Profile Tab */}
      {activeTab === "profile" && (
        <div className="space-y-6">
          {/* Role Badge */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <label
                  className={`relative w-20 h-20 rounded-full shrink-0 group ${isReadOnly ? '' : 'cursor-pointer'}`}
                  title={isReadOnly ? undefined : 'Upload profile photo'}
                >
                  <div className="w-20 h-20 bg-slate-200 rounded-full flex items-center justify-center overflow-hidden border border-slate-200">
                    {profileImage && !profileImgBroken ? (
                      <img
                        src={profileImage}
                        alt="Profile"
                        onError={() => setProfileImgBroken(true)}
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      <User className="h-10 w-10 text-slate-400" />
                    )}
                  </div>
                  {!isReadOnly && (
                    <>
                      <span className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Camera className="h-6 w-6 text-white" />
                      </span>
                      <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-brand-500 border-2 border-white flex items-center justify-center shadow-sm">
                        <Camera className="h-3 w-3 text-white" />
                      </span>
                      <input type="file" accept="image/*" className="hidden" onChange={handleProfilePhotoSelect} />
                    </>
                  )}
                </label>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">{displayName}</h2>
                  <p className="text-slate-600">{profileData.email || currentUser.email}</p>
                  <div className="mt-2">
                    <span
                      className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${currentUser.role === "super_admin"
                        ? "bg-purple-50 text-purple-700 border border-purple-200"
                        : currentUser.role === "admin"
                          ? "bg-brand-50 text-brand-700 border border-brand-200"
                          : "bg-green-50 text-green-700 border border-green-200"
                        }`}
                    >
                      <Shield className="h-3 w-3 mr-1" />
                      {currentUser.role === "super_admin"
                        ? "Super Admin"
                        : currentUser.role === "admin"
                          ? "Admin"
                          : "Employee"}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Personal Information */}
          <Card>
            <CardContent className="p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Personal Information</h3>
              <form onSubmit={handleProfileUpdate}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Name row */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Title</label>
                    <Dropdown
                      id="title"
                      value={profileData.title}
                      options={TITLE_OPTIONS.filter(Boolean)}
                      placeholder="Select"
                      disabled={isReadOnly}
                      onChange={(v: string | string[]) => setProfileData({ ...profileData, title: (Array.isArray(v) ? v[0] : v) || "" })}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      First Name <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="text"
                        value={profileData.firstName}
                        onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                        disabled={isReadOnly}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Middle Name</label>
                    <input
                      type="text"
                      value={profileData.middleName}
                      onChange={(e) => setProfileData({ ...profileData, middleName: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Last Name</label>
                    <input
                      type="text"
                      value={profileData.lastName}
                      onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Email Address <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="email"
                        value={profileData.email}
                        onChange={(e) => setProfileData({ ...profileData, email: e.target.value })}
                        disabled={isReadOnly}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="tel"
                        value={profileData.phone}
                        onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                        disabled={isReadOnly}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  {/* Address rows */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Address Line 1</label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Street address, building"
                        value={profileData.address}
                        onChange={(e) => setProfileData({ ...profileData, address: e.target.value })}
                        disabled={isReadOnly}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Address Line 2</label>
                    <input
                      type="text"
                      placeholder="Apartment, suite (optional)"
                      value={profileData.addressLine2}
                      onChange={(e) => setProfileData({ ...profileData, addressLine2: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Address Line 3</label>
                    <input
                      type="text"
                      placeholder="Area, locality (optional)"
                      value={profileData.addressLine3}
                      onChange={(e) => setProfileData({ ...profileData, addressLine3: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Landmark</label>
                    <input
                      type="text"
                      placeholder="Nearby landmark (optional)"
                      value={profileData.landmark}
                      onChange={(e) => setProfileData({ ...profileData, landmark: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">City</label>
                    <input
                      type="text"
                      value={profileData.city}
                      onChange={(e) => setProfileData({ ...profileData, city: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">State</label>
                    <input
                      type="text"
                      value={profileData.state}
                      onChange={(e) => setProfileData({ ...profileData, state: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Pincode</label>
                    <input
                      type="text"
                      value={profileData.zipCode}
                      onChange={(e) => setProfileData({ ...profileData, zipCode: e.target.value })}
                      disabled={isReadOnly}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Country</label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="text"
                        value={profileData.country}
                        onChange={(e) => setProfileData({ ...profileData, country: e.target.value })}
                        disabled={isReadOnly}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>
                </div>

                {!isReadOnly && (
                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={loadingProfile}
                      className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="h-4 w-4" />
                      {loadingProfile ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {isReadOnly && (
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">
                <strong>Note:</strong> As an employee, you have read-only access to your profile. Contact your administrator to make changes.
              </p>
            </div>
          )}

          {/* Profile photo cropper */}
          <ImageCropModal
            src={cropSrc}
            fileName={cropFileName}
            title="Crop Profile Photo"
            cropShape="round"
            showGrid={false}
            onCancel={() => {
              if (cropSrc?.startsWith("blob:")) URL.revokeObjectURL(cropSrc);
              setCropSrc(null);
              setCropFileName("");
            }}
            onCropped={handleProfilePhotoCropped}
          />
        </div>
      )}

      {/* Company Info Tab */}
      {activeTab === "company" && canAccessAdminSettings && (
        <div className="space-y-6">
          {/* Company Logo */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-brand-100 rounded-lg">
                  <ImageIcon className="w-5 h-5 text-brand-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Primary Logo</h3>
              </div>
              <p className="text-xs text-slate-500 mb-4 -mt-2">Shown in the header on Home, Contact, About, Terms &amp; Conditions, Privacy Policy and Returns &amp; FAQ pages.</p>
              <div className="flex items-center gap-6">
                <div className="w-32 h-32 border-2 border-dashed border-slate-300 rounded-lg flex items-center justify-center bg-slate-50">
                  {logoPreview || companyInfo.companyLogo ? (
                    <img
                      src={logoPreview || companyInfo.companyLogo}
                      alt="Company Logo"
                      className="w-full h-full object-contain rounded-lg"
                    />
                  ) : (
                    <div className="text-center">
                      <ImageIcon className="h-12 w-12 text-slate-400 mx-auto mb-2" />
                      <p className="text-xs text-slate-500">No logo</p>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-3">Upload your company logo. Recommended size: 512x512px</p>
                  <input
                    type="file"
                    id="logo-upload"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    disabled={currentUser.role !== "super_admin" || uploadingLogo}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="logo-upload"
                      className={`flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer ${currentUser.role !== "super_admin" || uploadingLogo || logoPreview
                        ? "opacity-50 cursor-not-allowed pointer-events-none"
                        : ""
                        }`}
                    >
                      <Upload className="h-4 w-4" />
                      Choose Logo
                    </label>
                    {logoPreview && canManageSettings && (
                      <>
                        <button
                          onClick={handleSaveLogo}
                          disabled={uploadingLogo}
                          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save className="h-4 w-4" />
                          {uploadingLogo ? "Saving..." : "Save Logo"}
                        </button>
                        <button
                          onClick={handleCancelLogo}
                          disabled={uploadingLogo}
                          className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                  {logoPreview && (
                    <p className="text-xs text-brand-600 mt-2">Preview - Click "Save Logo" to upload</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Secondary Logo — shown in the header on all other pages */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-brand-100 rounded-lg">
                  <ImageIcon className="w-5 h-5 text-brand-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Secondary Logo</h3>
              </div>
              <p className="text-xs text-slate-500 mb-4 -mt-2">Shown in the header on all other pages (Products, Categories, Cart, Checkout, Profile, Orders&hellip;). If left empty, the primary logo is used everywhere.</p>
              <div className="flex items-center gap-6">
                <div className="w-32 h-32 border-2 border-dashed border-slate-300 rounded-lg flex items-center justify-center bg-slate-50">
                  {secondaryLogoPreview || companyInfo.secondaryLogo ? (
                    <img
                      src={secondaryLogoPreview || companyInfo.secondaryLogo}
                      alt="Secondary Logo"
                      className="w-full h-full object-contain rounded-lg"
                    />
                  ) : (
                    <div className="text-center">
                      <ImageIcon className="h-12 w-12 text-slate-400 mx-auto mb-2" />
                      <p className="text-xs text-slate-500">No logo</p>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-3">Upload the secondary logo. Recommended size: 512x512px</p>
                  <input
                    type="file"
                    id="secondary-logo-upload"
                    accept="image/*"
                    onChange={handleSecondaryLogoUpload}
                    disabled={currentUser.role !== "super_admin" || uploadingSecondaryLogo}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="secondary-logo-upload"
                      className={`flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer ${currentUser.role !== "super_admin" || uploadingSecondaryLogo || secondaryLogoPreview
                        ? "opacity-50 cursor-not-allowed pointer-events-none"
                        : ""
                        }`}
                    >
                      <Upload className="h-4 w-4" />
                      Choose Logo
                    </label>
                    {secondaryLogoPreview && canManageSettings && (
                      <>
                        <button
                          onClick={handleSaveSecondaryLogo}
                          disabled={uploadingSecondaryLogo}
                          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save className="h-4 w-4" />
                          {uploadingSecondaryLogo ? "Saving..." : "Save Logo"}
                        </button>
                        <button
                          onClick={handleCancelSecondaryLogo}
                          disabled={uploadingSecondaryLogo}
                          className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                  {secondaryLogoPreview && (
                    <p className="text-xs text-brand-600 mt-2">Preview - Click "Save Logo" to upload</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Favicon — browser-tab icon */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-brand-100 rounded-lg">
                  <ImageIcon className="w-5 h-5 text-brand-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Favicon</h3>
              </div>
              <p className="text-xs text-slate-500 mb-4 -mt-2">The small icon shown in the browser tab, bookmarks and history. Use a square image (PNG or SVG, 512x512px recommended). Changes may take a browser refresh to appear.</p>
              <div className="flex items-center gap-6">
                <div className="w-32 h-32 border-2 border-dashed border-slate-300 rounded-lg flex items-center justify-center bg-slate-50">
                  {faviconPreview || companyInfo.favicon ? (
                    <img
                      src={faviconPreview || companyInfo.favicon}
                      alt="Favicon"
                      className="w-16 h-16 object-contain rounded"
                    />
                  ) : (
                    <div className="text-center">
                      <ImageIcon className="h-12 w-12 text-slate-400 mx-auto mb-2" />
                      <p className="text-xs text-slate-500">No favicon</p>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-3">Upload the favicon. Recommended size: 512x512px (square)</p>
                  <input
                    type="file"
                    id="favicon-upload"
                    accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/*"
                    onChange={handleFaviconUpload}
                    disabled={currentUser.role !== "super_admin" || uploadingFavicon}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="favicon-upload"
                      className={`flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer ${currentUser.role !== "super_admin" || uploadingFavicon || faviconPreview
                        ? "opacity-50 cursor-not-allowed pointer-events-none"
                        : ""
                        }`}
                    >
                      <Upload className="h-4 w-4" />
                      Choose Favicon
                    </label>
                    {faviconPreview && canManageSettings && (
                      <>
                        <button
                          onClick={handleSaveFavicon}
                          disabled={uploadingFavicon}
                          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save className="h-4 w-4" />
                          {uploadingFavicon ? "Saving..." : "Save Favicon"}
                        </button>
                        <button
                          onClick={handleCancelFavicon}
                          disabled={uploadingFavicon}
                          className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                  {faviconPreview && (
                    <p className="text-xs text-brand-600 mt-2">Preview - Click "Save Favicon" to upload</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Basic Company Information */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-green-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Basic Information</h3>
              </div>
              <form id="basic-info-form" onSubmit={handleCompanyInfoUpdate}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Company Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={companyInfo.companyName}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, companyName: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Company Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="email"
                        value={companyInfo.companyEmail}
                        onChange={(e) => setCompanyInfo({ ...companyInfo, companyEmail: e.target.value })}
                        disabled={currentUser.role !== "super_admin"}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Company Phone</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <input
                        type="tel"
                        value={companyInfo.companyPhone}
                        onChange={(e) => setCompanyInfo({ ...companyInfo, companyPhone: e.target.value })}
                        disabled={currentUser.role !== "super_admin"}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-2">Company Website</label>
                    <input
                      type="url"
                      value={companyInfo.companyWebsite}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, companyWebsite: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="https://www.example.com"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  {/* Social Media Links */}
                  <div className="md:col-span-2 pt-2">
                    <p className="text-sm font-medium text-slate-700 mb-3">Social Media Links</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Instagram URL</label>
                    <input
                      type="url"
                      value={companyInfo.socialInstagram}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, socialInstagram: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="https://www.instagram.com/yourpage"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Facebook URL</label>
                    <input
                      type="url"
                      value={companyInfo.socialFacebook}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, socialFacebook: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="https://www.facebook.com/yourpage"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-2">YouTube URL</label>
                    <input
                      type="url"
                      value={companyInfo.socialYoutube}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, socialYoutube: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="https://www.youtube.com/@yourchannel"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>
                </div>

                {currentUser.role === "super_admin" && canManageSettings && (
                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={loadingCompanyInfo}
                      className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="h-4 w-4" />
                      {loadingCompanyInfo ? 'Saving...' : 'Save Basic Information'}
                    </button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Legal & Tax Information */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <FileText className="w-5 h-5 text-purple-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Legal & Tax Information</h3>
              </div>
              <form id="legal-info-form" onSubmit={handleCompanyInfoUpdate}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      GST Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={companyInfo.gstNumber}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, gstNumber: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="29ABCDE1234F1Z5"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Company PAN Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={companyInfo.panNumber}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, panNumber: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="ABCDE1234F"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">CIN Number</label>
                    <input
                      type="text"
                      value={companyInfo.cinNumber}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, cinNumber: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="U74999KA2020PTC123456"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                </div>

                {currentUser.role === "super_admin" && canManageSettings && (
                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={loadingCompanyInfo}
                      className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="h-4 w-4" />
                      {loadingCompanyInfo ? 'Saving...' : 'Save Legal Information'}
                    </button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Registered Address */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <MapPin className="w-5 h-5 text-orange-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Registered Address</h3>
              </div>
              <form id="address-form" onSubmit={handleCompanyInfoUpdate}>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  <div className="sm:col-span-2 md:col-span-3">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Address Line 1 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={companyInfo.registeredAddress}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, registeredAddress: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="Building / street"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Address Line 2</label>
                    <input
                      type="text"
                      value={companyInfo.addressLine2}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, addressLine2: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="Area / locality (optional)"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Address Line 3</label>
                    <input
                      type="text"
                      value={companyInfo.addressLine3}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, addressLine3: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="Optional"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Landmark</label>
                    <input
                      type="text"
                      value={companyInfo.landmark}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, landmark: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="Nearby landmark (optional)"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">City</label>
                    <input
                      type="text"
                      value={companyInfo.city}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, city: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  {/* Country first: choosing it repopulates the State dropdown below. */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Country</label>
                    <Dropdown
                      value={companyInfo.country}
                      onChange={(v) => setCompanyInfo({ ...companyInfo, country: v as string, state: "" })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="Select country"
                      options={getCountries().map((c) => ({ value: c.isoCode, label: `${c.flag} ${c.name}` }))}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">State</label>
                    <Dropdown
                      value={companyInfo.state}
                      onChange={(v) => setCompanyInfo({ ...companyInfo, state: v as string })}
                      disabled={currentUser.role !== "super_admin" || !companyInfo.country || getStates(companyInfo.country).length === 0}
                      placeholder={companyInfo.country ? "Select state" : "Select a country first"}
                      options={getStates(companyInfo.country).map((s) => ({ value: s.name, label: s.name }))}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">PIN Code</label>
                    <input
                      type="text"
                      value={companyInfo.zipCode}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, zipCode: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>
                </div>

                {currentUser.role === "super_admin" && canManageSettings && (
                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={loadingCompanyInfo}
                      className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="h-4 w-4" />
                      {loadingCompanyInfo ? 'Saving...' : 'Save Address'}
                    </button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Bank Details */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-indigo-100 rounded-lg">
                  <CreditCard className="w-5 h-5 text-indigo-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Bank Details</h3>
              </div>
              <form id="bank-details-form" onSubmit={handleCompanyInfoUpdate}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Bank Name</label>
                    <input
                      type="text"
                      value={companyInfo.bankName}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, bankName: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Account Number</label>
                    <input
                      type="text"
                      value={companyInfo.bankAccountNumber}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, bankAccountNumber: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">IFSC Code</label>
                    <input
                      type="text"
                      value={companyInfo.bankIfscCode}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, bankIfscCode: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      placeholder="HDFC0001234"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Branch</label>
                    <input
                      type="text"
                      value={companyInfo.bankBranch}
                      onChange={(e) => setCompanyInfo({ ...companyInfo, bankBranch: e.target.value })}
                      disabled={currentUser.role !== "super_admin"}
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100"
                    />
                  </div>
                </div>

                {currentUser.role === "super_admin" && canManageSettings && (
                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={loadingCompanyInfo}
                      className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Save className="h-4 w-4" />
                      {loadingCompanyInfo ? 'Saving...' : 'Save Bank Details'}
                    </button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {currentUser.role === "admin" && (
            <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg">
              <p className="text-sm text-brand-800">
                <strong>Note:</strong> Company information can only be edited by Super Admin. Contact your Super Admin to make changes.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Payment Settings Tab */}
      {activeTab === "payment" && canAccessAdminSettings && (
        <div className="space-y-6">
          {loadingPaymentSettings ? (
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-500 mx-auto mb-4"></div>
                    <p className="text-slate-600">Loading payment settings...</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Info Box */}
              <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg">
                <p className="text-sm text-brand-800">
                  <strong>Important:</strong> Only one payment gateway can be active at a time. When you enable one gateway, the other will be automatically disabled.
                </p>
              </div>

              {/* Razorpay Payment Gateway */}
              <Card>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-slate-100 rounded-lg">
                        <DollarSign className="w-5 h-5 text-slate-900" />
                      </div>
                      <div>
                        <h3 className="text-2xl font-bold text-slate-900">Razorpay Payment Gateway</h3>
                        <p className="text-sm text-slate-600 mt-1">Configure payment settings for customer transactions</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-600">Status:</span>
                      <span
                        className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium ${razorpaySettings.enabled
                          ? "bg-brand-500 text-white"
                          : "bg-slate-200 text-slate-700"
                          }`}
                      >
                        {razorpaySettings.enabled ? "● Active" : "● Inactive"}
                      </span>
                    </div>
                  </div>

                  <form onSubmit={handleRazorpaySettingsUpdate}>
                    {/* Enable/Disable Toggle */}
                    <div className="mb-6 p-4 border border-slate-200 rounded-lg bg-slate-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-slate-900">Enable Razorpay Payments</p>
                          <p className="text-sm text-slate-600">Allow customers to pay using Razorpay gateway</p>
                          {razorpaySettings.enabled && payuSettings.enabled && (
                            <p className="text-xs text-amber-600 mt-1">⚠ Enabling this will disable PayU</p>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          checked={razorpaySettings.enabled}
                          onChange={(e) => setRazorpaySettings({ ...razorpaySettings, enabled: e.target.checked })}
                          disabled={currentUser.role !== "super_admin"}
                          className="h-5 w-5 text-slate-900 border-slate-300 rounded focus:ring-brand-500/40 disabled:opacity-50"
                        />
                      </div>
                    </div>

                    {/* Warning when enabling */}
                    {razorpaySettings.enabled && payuSettings.enabled && (
                      <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-sm text-amber-800">
                          <strong>Note:</strong> Only one payment gateway can be active at a time. Saving these settings will automatically disable PayU.
                        </p>
                      </div>
                    )}

                    {/* API Credentials */}
                    <div className="space-y-4 mb-6">
                      <h4 className="font-semibold text-slate-900 flex items-center gap-2">
                        <Key className="h-4 w-4" />
                        API Credentials
                      </h4>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            Key ID <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={razorpaySettings.keyId}
                            onChange={(e) => setRazorpaySettings({ ...razorpaySettings, keyId: e.target.value })}
                            disabled={currentUser.role !== "super_admin"}
                            placeholder="rzp_test_1234567890"
                            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            Key Secret <span className="text-red-500">*</span>
                          </label>
                          <div className="relative">
                            <input
                              type={!isRazorpaySecretMasked && showRazorpaySecret ? "text" : "password"}
                              value={razorpaySettings.keySecret}
                              onChange={(e) => {
                                setRazorpaySettings({ ...razorpaySettings, keySecret: e.target.value });
                                // Reset visibility when user starts typing on a masked field
                                if (isRazorpaySecretMasked) {
                                  setShowRazorpaySecret(false);
                                }
                              }}
                              disabled={currentUser.role !== "super_admin"}
                              placeholder="Enter key secret"
                              className={`w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm ${!isRazorpaySecretMasked && razorpaySettings.keySecret ? 'pr-10' : ''}`}
                            />
                            {!isRazorpaySecretMasked && razorpaySettings.keySecret && (
                              <button
                                type="button"
                                onClick={() => setShowRazorpaySecret(!showRazorpaySecret)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                                title={showRazorpaySecret ? "Hide secret" : "Show secret"}
                              >
                                {showRazorpaySecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                          {isRazorpaySecretMasked && (
                            <p className="text-xs text-slate-500 mt-1">Secret is hidden. Enter a new value to update.</p>
                          )}
                        </div>

                        <div className="md:col-span-2">
                          <label className="block text-sm font-medium text-slate-700 mb-2">Webhook Secret</label>
                          <div className="relative">
                            <input
                              type={!isRazorpayWebhookMasked && showRazorpayWebhook ? "text" : "password"}
                              value={razorpaySettings.webhookSecret}
                              onChange={(e) => {
                                setRazorpaySettings({ ...razorpaySettings, webhookSecret: e.target.value });
                                // Reset visibility when user starts typing on a masked field
                                if (isRazorpayWebhookMasked) {
                                  setShowRazorpayWebhook(false);
                                }
                              }}
                              disabled={currentUser.role !== "super_admin"}
                              placeholder="Enter webhook secret"
                              className={`w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm ${!isRazorpayWebhookMasked && razorpaySettings.webhookSecret ? 'pr-10' : ''}`}
                            />
                            {!isRazorpayWebhookMasked && razorpaySettings.webhookSecret && (
                              <button
                                type="button"
                                onClick={() => setShowRazorpayWebhook(!showRazorpayWebhook)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                                title={showRazorpayWebhook ? "Hide secret" : "Show secret"}
                              >
                                {showRazorpayWebhook ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                          {isRazorpayWebhookMasked && (
                            <p className="text-xs text-slate-500 mt-1">Secret is hidden. Enter a new value to update.</p>
                          )}
                        </div>

                        <div className="md:col-span-2">
                          <label className="block text-sm font-medium text-slate-700 mb-2">RazorpayX Account Number <span className="font-normal text-slate-400">(for automated wallet payouts)</span></label>
                          <input
                            type="text"
                            value={razorpaySettings.xAccountNumber}
                            onChange={(e) => setRazorpaySettings({ ...razorpaySettings, xAccountNumber: e.target.value })}
                            disabled={currentUser.role !== "super_admin"}
                            placeholder="e.g. 2323230000000000"
                            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm"
                          />
                          <p className="text-xs text-slate-500 mt-1">Your RazorpayX source account number (Dashboard → Account Details). Leave blank to pay out wallet withdrawals manually.</p>
                        </div>
                      </div>
                    </div>

                    {currentUser.role === "super_admin" && canManageSettings && (
                      <div className="mt-6 flex items-center gap-3">
                        <button
                          type="submit"
                          disabled={loadingPaymentSettings}
                          className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save className="h-4 w-4" />
                          {loadingPaymentSettings ? 'Saving...' : 'Save Payment Settings'}
                        </button>
                        <a
                          href="https://dashboard.razorpay.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-brand-600 hover:text-brand-800 underline"
                        >
                          Open Razorpay Dashboard →
                        </a>
                      </div>
                    )}
                  </form>
                </CardContent>
              </Card>

              {/* PayU Payment Gateway */}
              <Card>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-slate-100 rounded-lg">
                        <DollarSign className="w-5 h-5 text-slate-900" />
                      </div>
                      <div>
                        <h3 className="text-2xl font-bold text-slate-900">PayU Payment Gateway</h3>
                        <p className="text-sm text-slate-600 mt-1">Configure PayU for Indian market payments</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-600">Status:</span>
                      <span
                        className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium ${payuSettings.enabled
                          ? "bg-brand-500 text-white"
                          : "bg-slate-200 text-slate-700"
                          }`}
                      >
                        {payuSettings.enabled ? "● Active" : "● Inactive"}
                      </span>
                    </div>
                  </div>

                  <form onSubmit={handlePayUSettingsUpdate}>
                    {/* Enable/Disable Toggle */}
                    <div className="mb-6 p-4 border border-slate-200 rounded-lg bg-slate-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-slate-900">Enable PayU Payments</p>
                          <p className="text-sm text-slate-600">Allow customers to pay using PayU gateway</p>
                          {payuSettings.enabled && razorpaySettings.enabled && (
                            <p className="text-xs text-amber-600 mt-1">⚠ Enabling this will disable Razorpay</p>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          checked={payuSettings.enabled}
                          onChange={(e) => setPayuSettings({ ...payuSettings, enabled: e.target.checked })}
                          disabled={currentUser.role !== "super_admin"}
                          className="h-5 w-5 text-slate-900 border-slate-300 rounded focus:ring-brand-500/40 disabled:opacity-50"
                        />
                      </div>
                    </div>

                    {/* Warning when enabling */}
                    {payuSettings.enabled && razorpaySettings.enabled && (
                      <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-sm text-amber-800">
                          <strong>Note:</strong> Only one payment gateway can be active at a time. Saving these settings will automatically disable Razorpay.
                        </p>
                      </div>
                    )}

                    {/* API Credentials */}
                    <div className="space-y-4 mb-6">
                      <h4 className="font-semibold text-slate-900 flex items-center gap-2">
                        <Key className="h-4 w-4" />
                        API Credentials
                      </h4>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            Merchant Key <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={payuSettings.merchantKey}
                            onChange={(e) => setPayuSettings({ ...payuSettings, merchantKey: e.target.value })}
                            disabled={currentUser.role !== "super_admin"}
                            placeholder="gtKFFx"
                            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            Merchant Salt <span className="text-red-500">*</span>
                          </label>
                          <div className="relative">
                            <input
                              type={!isPayuSaltMasked && showPayuSalt ? "text" : "password"}
                              value={payuSettings.merchantSalt}
                              onChange={(e) => {
                                setPayuSettings({ ...payuSettings, merchantSalt: e.target.value });
                                // Reset visibility when user starts typing on a masked field
                                if (isPayuSaltMasked) {
                                  setShowPayuSalt(false);
                                }
                              }}
                              disabled={currentUser.role !== "super_admin"}
                              placeholder="Enter merchant salt"
                              className={`w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100 font-mono text-sm ${!isPayuSaltMasked && payuSettings.merchantSalt ? 'pr-10' : ''}`}
                            />
                            {!isPayuSaltMasked && payuSettings.merchantSalt && (
                              <button
                                type="button"
                                onClick={() => setShowPayuSalt(!showPayuSalt)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                                title={showPayuSalt ? "Hide salt" : "Show salt"}
                              >
                                {showPayuSalt ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                          {isPayuSaltMasked && (
                            <p className="text-xs text-slate-500 mt-1">Salt is hidden. Enter a new value to update.</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {currentUser.role === "super_admin" && canManageSettings && (
                      <div className="mt-6 flex items-center gap-3">
                        <button
                          type="submit"
                          disabled={loadingPaymentSettings}
                          className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save className="h-4 w-4" />
                          {loadingPaymentSettings ? 'Saving...' : 'Save PayU Settings'}
                        </button>
                        <a
                          href="https://dashboard.payu.in"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-brand-600 hover:text-brand-800 underline"
                        >
                          Open PayU Dashboard →
                        </a>
                      </div>
                    )}
                  </form>
                </CardContent>
              </Card>

              {currentUser.role === "admin" && (
                <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg">
                  <p className="text-sm text-brand-800">
                    <strong>Note:</strong> Payment gateway settings can only be modified by Super Admin. Contact your Super Admin to make changes.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* GST Settings Tab */}
      {activeTab === "gst" && canAccessAdminSettings && (
        <GSTSettingsTab />
      )}

      {/* Hub Management Tab */}
      {activeTab === "hub" && canAccessAdminSettings && (
        <HubSettingsTab />
      )}

      {/* Invoice Settings Tab */}
      {activeTab === "invoice" && canAccessAdminSettings && (
        <InvoiceSettings />
      )}

      {/* SEO Settings Tab */}
      {activeTab === "seo" && canAccessAdminSettings && (
        <SEOSettingsTab />
      )}

      {/* Banner Settings Tab */}
      {activeTab === "banner" && canAccessAdminSettings && (
        <BannerSettingsTab />
      )}

      {/* Vendor Notification Settings Tab */}
      {activeTab === "vendor-notif" && canAccessAdminSettings && (
        <VendorNotificationTab />
      )}

      {/* Exchange Rate Tab */}
      {activeTab === "exchange-rate" && canAccessAdminSettings && (
        <ExchangeRateTab />
      )}

      {activeTab === "email-templates" && canAccessAdminSettings && (
        <EmailTemplatesTab isReadOnly={isReadOnly} />
      )}

      {activeTab === "couriers" && canAccessAdminSettings && (
        <CourierManagement />
      )}

      {/* Delivery Zones Tab */}
      {activeTab === "delivery-zones" && canAccessAdminSettings && (
        <DeliveryZones />
      )}

      {/* Credit Points Settings Tab */}
      {activeTab === "credit-points" && canAccessAdminSettings && (
        <CreditPointsSettingsTab />
      )}
    </div>
  );
}

// Vendor Notification Email Settings Component
function VendorNotificationTab() {
  const [emails, setEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await companyInfoService.getVendorNotificationSettings();
        if (res.success && res.data) {
          setEmails(res.data.emails || []);
        }
      } catch {
        // Settings may not exist yet
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const addEmail = () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address');
      return;
    }
    if (emails.includes(trimmed)) {
      setError('This email is already added');
      return;
    }
    setEmails(prev => [...prev, trimmed]);
    setNewEmail('');
    setError('');
  };

  const removeEmail = (email: string) => {
    setEmails(prev => prev.filter(e => e !== email));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await companyInfoService.updateVendorNotificationSettings(emails);
      showSuccessToast('Saved', 'Vendor notification emails updated successfully');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      showErrorToast('Error', message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-slate-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <Mail className="h-5 w-5 text-slate-700" />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Vendor Registration Mail Notification</h3>
              <p className="text-sm text-slate-500">When a new vendor registers, notification emails will be sent only to the email addresses listed below.</p>
            </div>
          </div>

          {/* Add Email */}
          <div className="flex gap-3 mb-4">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => { setNewEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && addEmail()}
              className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              placeholder="Enter email address"
            />
            <button
              onClick={addEmail}
              className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 font-medium text-sm"
            >
              Add Email
            </button>
          </div>
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

          {/* Email List */}
          {emails.length === 0 ? (
            <div className="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-300">
              <Mail className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No notification emails configured.</p>
              <p className="text-xs text-slate-400">Add email addresses above to receive vendor registration notifications.</p>
            </div>
          ) : (
            <div className="space-y-2 mb-4">
              {emails.map((email, index) => (
                <div key={index} className="flex items-center justify-between px-4 py-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex items-center gap-3">
                    <Mail className="h-4 w-4 text-slate-400" />
                    <span className="text-sm font-medium text-slate-800">{email}</span>
                  </div>
                  <button
                    onClick={() => removeEmail(email)}
                    className="text-red-500 hover:text-red-700 text-sm font-medium"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <p className="text-xs text-slate-500">{emails.length} email(s) will be notified on new vendor registration</p>
            </div>
          )}

          {/* Save */}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium text-sm disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
