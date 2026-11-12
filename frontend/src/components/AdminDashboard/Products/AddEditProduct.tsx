'use client'

import { useState, useEffect, useRef } from 'react'
import { convertINRtoUSD, getRegion } from '@/lib/currency'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/UI/Button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/UI/Card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/UI/Table'
import Dropdown from '@/components/UI/Dropdown'
import { ArrowLeft, Save, X, Upload, Package, Image as ImageIcon, ChevronLeft, ChevronRight, Pencil, AlertCircle } from 'lucide-react'
import courierIntegrationService from '@/services/courierIntegrationService'
import VariantImageModal from './VariantImageModal'
import CareInstructionModal, { CARE_INSTRUCTIONS, CareIcon, CATEGORY_COLORS, CATEGORY_BORDER } from '@/components/VendorDashboard/Products/CareInstructionModal'
import Link from 'next/link'
import { showSuccessToast, showErrorToast, showWarningToast } from '@/lib/toast-utils'
import { centerNotice } from '@/components/UI/CenterNotice'
import { gstSettingsService, type GSTSetting } from '@/services/gstSettingsService'
import { parseDimensions, combineDimensions } from '@/lib/dimensions'
import { transportModeLabel } from '@/lib/couriers'
import { courierService, type Courier } from '@/services/courierService'
import CourierBadge from '@/components/Shared/CourierBadge'
import ImageCropModal from '@/components/UI/ImageCropModal'
import { TitleSelect } from '@/components/VendorHub/FormUI'

// 1 → A, 26 → Z, 27 → AA … (mirrors the backend variant-suffix logic).
const variantAlphaSuffix = (n: number): string => {
  let s = ''
  let x = n
  while (x > 0) {
    const rem = (x - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    x = Math.floor((x - 1) / 26)
  }
  return s || 'A'
}

interface InventoryItem {
  id: string
  name: string
  sku: string
  category: string
  subcategory?: string
  description?: string
  currentStock: number
  hasProductCreated: boolean
  productId?: string
}

// Helper function to get color name from hex value
// Type a color name (e.g. "red", "blue") → auto-fill the swatch hex, same as
// the vendor product form.
const getColorHex = (name: string): string | null => {
  const nameMap: { [key: string]: string } = {
    black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', red: '#ff0000', green: '#008000', lime: '#00ff00',
    blue: '#0000ff', navy: '#000080', yellow: '#ffff00', magenta: '#ff00ff',
    cyan: '#00ffff', maroon: '#800000', olive: '#808000', purple: '#800080',
    teal: '#008080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a',
    beige: '#f5f5dc',
  }
  return nameMap[name.trim().toLowerCase()] || null
}

const getColorName = (hex: string): string => {
  const colorMap: { [key: string]: string } = {
    '#000000': 'Black',
    '#ffffff': 'White',
    '#808080': 'Gray',
    '#c0c0c0': 'Silver',
    '#ff0000': 'Red',
    '#00ff00': 'Green',
    '#0000ff': 'Blue',
    '#ffff00': 'Yellow',
    '#ff00ff': 'Magenta',
    '#00ffff': 'Cyan',
    '#800000': 'Maroon',
    '#008000': 'Dark Green',
    '#000080': 'Navy',
    '#808000': 'Olive',
    '#800080': 'Purple',
    '#008080': 'Teal',
    '#ffa500': 'Orange',
    '#ffc0cb': 'Pink',
    '#a52a2a': 'Brown',
    '#f5f5dc': 'Beige'
  }

  return colorMap[hex.toLowerCase()] || `Custom (${hex})`
}
const categorySubcategories: Record<string, string[]> = {
  'Bed Sheets': ['Cotton Sheets', 'Linen Sheets', 'Silk Sheets', 'Microfiber Sheets'],
  'Towels': ['Bath Towels', 'Hand Towels', 'Beach Towels', 'Kitchen Towels'],
  'Curtains': ['Blackout Curtains', 'Sheer Curtains', 'Thermal Curtains', 'Decorative Curtains'],
  'Pillows': ['Bed Pillows', 'Decorative Pillows', 'Travel Pillows', 'Memory Foam Pillows'],
  'Blankets': ['Wool Blankets', 'Cotton Blankets', 'Fleece Blankets', 'Electric Blankets']
}

const fabricTypes = [
  'Cotton', 'Linen', 'Silk', 'Polyester', 'Microfiber', 'Bamboo', 'Modal', 'Tencel', 'Wool', 'Cashmere'
]

const standardColors = ['White', 'Black', 'Gray', 'Navy', 'Beige', 'Brown', 'Red', 'Blue', 'Green', 'Yellow', 'Pink', 'Purple']

interface ProductVariant {
  id: string
  variantName?: string
  size: string
  color: string
  colorHex?: string // New field for color picker hex value
  sku: string
  price: number
  originalPrice?: number
  discount?: number
  adminFixedPrice?: number | null
  priceINR?: number | null
  priceUSD?: number | null
  originalPriceINR?: number | null
  originalPriceUSD?: number | null
  priceVisibility?: 'IN_ONLY' | 'COM_ONLY' | 'BOTH'
  stock: number
  lowStockThreshold?: number
  images: string[]
}

interface ProductImage {
  id: string
  url: string
  alt: string
  isPrimary: boolean
  imageType: 'cover' | 'gallery' // New field to distinguish image types
}

interface FabricSpecification {
  type: string
  composition: string
  weight: string
  // Fabric weight (g) + dimensions (cm) used to auto-calculate GSM — mirrors
  // the vendor product form.
  weightValue: string
  weightUnit: string
  length: string
  breadth: string
  gsm: string
  weave: string
  finish: string
  careInstructions: string[]
}

interface PricingTier {
  minQuantity: number
  maxQuantity?: number
  price: number
  discount?: number
}

interface ProductFormData {
  // Inventory Connection (NEW FLOW)
  inventoryItemId?: string // Link to inventory item
  isFromInventory: boolean // Whether this product is created from inventory

  // Vendor Information (NEW)
  vendorId?: string // Link to vendor
  vendorName?: string // Vendor name for display

  name: string
  description: string
  category: string
  subCategory: string

  // Pricing Information
  basePrice: number
  originalPrice?: number
  discount?: number // Discount percentage (e.g., 25 for 25% off)
  gstPercentage?: number // GST Percentage for the product
  hsnCode?: string // HSN / SAC code for GST classification
  returnable?: boolean // Whether customers can return this product (within 7 days of delivery)
  packagingType?: 'PACKED' | 'UNPACKED' | '' // How the product ships
  packingType?: 'BALE' | 'CARTON' | '' // Pack style when PACKED
  unpackedType?: 'STITCHED' | 'UNSTITCHED' | 'OTHER' | '' // Unpacked style
  unpackedNote?: string // Remark for the unpacked selection
  adminFixedPrice?: number | null
  priceINR?: number | null
  priceUSD?: number | null
  originalPriceINR?: number | null
  originalPriceUSD?: number | null
  priceVisibility?: 'IN_ONLY' | 'COM_ONLY' | 'BOTH'

  // Basic Product Info - Size & Color
  singleUnitSize?: string
  singleUnitColor?: string
  singleUnitColorHex?: string

  // Product Rating & Reviews (for display/reference)
  rating?: number
  reviews?: number

  // Fabric & Specifications
  fabricType: string
  material: string // Main material description (e.g., "100% Organic Cotton")
  fabricSpecifications: FabricSpecification

  // Who made the item (distinct from the selling vendor). Photo is a base64 data URL
  // while editing; the backend resolves it to a Cloudinary URL on save.
  manufacturerInfo: {
    photo: string
    title: string
    fullName: string
    role: string
    experience: string
    description: string
  }

  // Variants Management
  variants: ProductVariant[]
  hasVariants: boolean

  // Base Product Info (when no variants)
  baseSku: string

  // Images
  images: ProductImage[]

  // Stock Management
  totalStock: number
  lowStockThreshold: number
  trackInventory: boolean

  // Dispatch & Shipping
  dispatchTimeline: {
    processingDays: number
    shippingDays: number
    totalDays: number
  }

  // Additional Info
  uom: string
  tags: string[]
  dimensions?: string
  dimensionUnit: string
  weight?: string
  inStock: boolean
  status: 'ACTIVE' | 'INACTIVE' | 'OUT_OF_STOCK'

  // Logistics Configuration
  logisticsConfig?: {
    unitWeight: number
    weightUom: string
    maxWeight: number
    dimensions: { length: number; width: number; height: number; unit: string } | null
    transportTypes: string[]
    weightRanges: Array<{ minWeight: number; maxWeight: number; recommendedTransport: string }>
    airDeliveryDays: number
    // SHIP lane splits by market: ship* = SEA (international, .com); surface* = SURFACE
    // (domestic India, .in). Which fields the admin fills is driven by priceVisibility.
    shipDeliveryDays: number
    surfaceDeliveryDays?: number
    airCostPerKg: number
    shipCostPerKg: number
    surfaceCostPerKg?: number
    // Ids of the admin-managed couriers this product ships with (see Courier module).
    // The storefront shows these, filtered by the shopper's region + transport mode.
    courierIds?: string[]
    notes: string
  }
}

interface AddEditProductProps {
  productId?: string
  isEdit?: boolean
  inventoryId?: string // Pre-select an inventory item when coming from inventory page
  onProductNameLoad?: (name: string) => void
}

export default function AddEditProduct({ productId, isEdit = false, inventoryId, onProductNameLoad }: AddEditProductProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(isEdit)

  // State for dynamic data
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; email: string }>>([])
  const [categories, setCategories] = useState<string[]>([])
  const [vendorSubcategories, setVendorSubcategories] = useState<Record<string, string[]>>({}) // Store subcategories by category
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [isLoadingVendors, setIsLoadingVendors] = useState(true)
  const [isLoadingCategories, setIsLoadingCategories] = useState(true)
  const [isLoadingInventory, setIsLoadingInventory] = useState(false)

  // GST State
  const [gstRates, setGstRates] = useState<GSTSetting[]>([])
  const [isLoadingGst, setIsLoadingGst] = useState(false)
  // True when "Others" is chosen to enter a custom tax rate.
  const [gstOthers, setGstOthers] = useState(false)

  // Admin-managed couriers, for the logistics multi-select.
  const [couriers, setCouriers] = useState<Courier[]>([])
  useEffect(() => {
    courierService.getActiveCouriers().then(setCouriers).catch(() => setCouriers([]))
  }, [])

  // Live courier (Delhivery) status — drives the domestic (.in) per-kg rate note.
  const [liveRatesActive, setLiveRatesActive] = useState(false)
  useEffect(() => {
    courierIntegrationService
      .getSettings()
      .then((res) => setLiveRatesActive(!!(res?.data?.enabled && res?.data?.connected && res?.data?.useLiveRates)))
      .catch(() => setLiveRatesActive(false))
  }, [])

  const [formData, setFormData] = useState<ProductFormData>({
    // Inventory Connection (NEW)
    inventoryItemId: inventoryId || '',
    isFromInventory: !!inventoryId,

    // Vendor Information (NEW)
    vendorId: '',
    vendorName: '',

    name: '',
    description: '',
    category: '',
    subCategory: '',

    // Pricing Information
    basePrice: 0,
    originalPrice: undefined,
    discount: undefined,
    gstPercentage: undefined,
    hsnCode: '',
    returnable: true,
    packagingType: '',
    packingType: '',
    unpackedType: '',
    unpackedNote: '',
    adminFixedPrice: null,
    priceINR: null,
    priceUSD: null,
    originalPriceINR: null,
    originalPriceUSD: null,
    priceVisibility: 'BOTH',

    // Basic Product Info - Size & Color
    singleUnitSize: '',
    singleUnitColor: '',
    singleUnitColorHex: '#000000',

    // Product Rating & Reviews
    rating: undefined,
    reviews: undefined,

    // Fabric & Specifications
    fabricType: '',
    material: '',
    fabricSpecifications: {
      type: '',
      composition: '',
      weight: '',
      weightValue: '',
      weightUnit: 'GSM',
      length: '',
      breadth: '',
      gsm: '',
      weave: '',
      finish: '',
      careInstructions: []
    },

    // Manufacturer (who made the item)
    manufacturerInfo: {
      photo: '',
      title: '',
      fullName: '',
      role: '',
      experience: '',
      description: '',
    },

    // Variants Management
    variants: [],
    hasVariants: false,

    // Base Product Info
    baseSku: '',

    // Images
    images: [],

    // Stock Management
    totalStock: 0,
    lowStockThreshold: 5,
    trackInventory: true,

    // Dispatch & Shipping
    dispatchTimeline: {
      processingDays: 0,
      shippingDays: 0,
      totalDays: 0
    },

    // Additional Info
    uom: 'pcs',
    tags: [],
    dimensions: '',
    dimensionUnit: 'cm',
    weight: '',
    inStock: true,
    status: 'ACTIVE',

    // Logistics Configuration
    logisticsConfig: {
      unitWeight: 0,
      weightUom: 'KG',
      maxWeight: 0,
      dimensions: null as { length: number; width: number; height: number; unit: string } | null,
      transportTypes: ['AIR', 'SHIP'] as string[],
      weightRanges: [
        { minWeight: 0, maxWeight: 50, recommendedTransport: 'AIR' },
        { minWeight: 50, maxWeight: 5000, recommendedTransport: 'SHIP' }
      ] as Array<{ minWeight: number; maxWeight: number; recommendedTransport: string }>,
      airDeliveryDays: 7,
      shipDeliveryDays: 30,
      surfaceDeliveryDays: 7,
      airCostPerKg: 0,
      shipCostPerKg: 0,
      surfaceCostPerKg: 0,
      courierIds: [],
      notes: ''
    }
  })

  const [selectedTag, setSelectedTag] = useState('')
  const [careModalOpen, setCareModalOpen] = useState(false)
  const handleAddCareInstructions = (instructions: string[]) => {
    setFormData(prev => ({
      ...prev,
      fabricSpecifications: { ...prev.fabricSpecifications, careInstructions: instructions },
    }))
  }
  const [activeTab, setActiveTab] = useState('basic')

  // ── Manufacturer photo crop ────────────────────────────────────────────────
  const [mfrCropState, setMfrCropState] = useState<{ src: string; name: string } | null>(null)
  const setManufacturerField = (field: keyof ProductFormData['manufacturerInfo'], value: string) => {
    setFormData(prev => ({ ...prev, manufacturerInfo: { ...prev.manufacturerInfo, [field]: value } }))
  }
  const openMfrPhotoCropper = (file: File) => {
    if (!file.type.startsWith('image/')) {
      showErrorToast('Invalid file', 'Please choose an image file (PNG, JPG or WebP).')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      showErrorToast('Image too large', 'Please choose an image under 5 MB.')
      return
    }
    setMfrCropState({ src: URL.createObjectURL(file), name: file.name })
  }
  const closeMfrCropper = () => {
    setMfrCropState(prev => { if (prev) URL.revokeObjectURL(prev.src); return null })
  }
  const onMfrPhotoCropped = (file: File) => {
    const reader = new FileReader()
    reader.onloadend = () => setManufacturerField('photo', reader.result as string)
    reader.readAsDataURL(file)
    closeMfrCropper()
  }
  const productTabs = [
    { id: 'basic', label: 'Basic Info' },
    { id: 'fabric', label: 'Fabric & Specs' },
    { id: 'manufacturer', label: 'Manufacturer' },
    { id: 'variants', label: 'Variants' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'shipping', label: 'Shipping' },
    { id: 'logistics', label: 'Logistics' },
  ]
  const activeTabIndex = productTabs.findIndex((t) => t.id === activeTab)
  const goToPrevTab = () => {
    if (activeTabIndex > 0) setActiveTab(productTabs[activeTabIndex - 1].id)
  }
  const goToNextTab = () => {
    if (activeTabIndex < productTabs.length - 1) setActiveTab(productTabs[activeTabIndex + 1].id)
  }

  // Debug: Log category and subcategory changes
  useEffect(() => {
    console.log('=== FORM DATA CATEGORY/SUBCATEGORY CHANGED ===')
    console.log('Category:', formData.category)
    console.log('SubCategory:', formData.subCategory)
  }, [formData.category, formData.subCategory])

  // Auto-calculate GSM from fabric weight (g) and dimensions (cm):
  //   GSM = (Weight × 10000) ÷ (Length × Width)  — mirrors the vendor form.
  useEffect(() => {
    const w = parseFloat(formData.fabricSpecifications.weightValue)
    const l = parseFloat(formData.fabricSpecifications.length)
    const b = parseFloat(formData.fabricSpecifications.breadth)
    const gsm = w > 0 && l > 0 && b > 0 ? String(Math.round((w * 10000) / (l * b))) : ''
    if (gsm !== formData.fabricSpecifications.gsm) {
      setFormData(prev => ({
        ...prev,
        fabricSpecifications: { ...prev.fabricSpecifications, gsm, weightUnit: 'GSM' },
      }))
    }
  }, [formData.fabricSpecifications.weightValue, formData.fabricSpecifications.length, formData.fabricSpecifications.breadth, formData.fabricSpecifications.gsm])

  // Debug: Log when categories are loaded
  useEffect(() => {
    console.log('=== CATEGORIES STATE CHANGED ===')
    console.log('Categories:', categories)
    console.log('Categories length:', categories.length)
    console.log('Subcategories map:', vendorSubcategories)
  }, [categories, vendorSubcategories])

  // Load vendors on mount (categories loaded per vendor)
  useEffect(() => {
    const loadVendors = async () => {
      try {
        // Load vendors
        setIsLoadingVendors(true)
        const { default: VendorService } = await import('@/services/vendorService')
        const vendorsResponse = await VendorService.getAllVendors({ status: 'APPROVED' })

        if (vendorsResponse.vendors) {
          setVendors(vendorsResponse.vendors.map(v => ({
            id: v.id,
            name: v.companyName,
            email: v.businessEmail
          })))
        }
      } catch (error) {
        console.error('Error loading vendors:', error)
        showErrorToast('Load Failed', 'Unable to load vendors')
      } finally {
        setIsLoadingVendors(false)
      }
    }

    loadVendors()
    loadVendors()

    // Load GST Rates
    const loadGstRates = async () => {
      setIsLoadingGst(true)
      try {
        const response = await gstSettingsService.getSettings()
        if (response.success) {
          setGstRates(response.data)
        }
      } catch (error) {
        console.error('Error fetching GST settings:', error)
      } finally {
        setIsLoadingGst(false)
      }
    }
    loadGstRates()
  }, [])

  // Predefined tag options
  const tagOptions = [
    { value: 'Featured', label: 'Featured' },
    { value: 'Top Selling', label: 'Top Selling' },
    { value: 'Best Seller', label: 'Best Seller' }
  ]
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<any>(null)
  // Auto-save functionality (optional)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  useEffect(() => {
    setHasUnsavedChanges(true)
  }, [formData])

  // Warn user about unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  const [newVariant, setNewVariant] = useState<Partial<ProductVariant>>({
    variantName: '',
    size: '',
    color: '',
    colorHex: '#000000',
    sku: '',
    price: 0,
    stock: 0,
    images: [] // New field for variant images
  })

  // State for variant image editing (image modal)
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null)

  // Inline row-edit: load a variant back into the "Add New Variant" form so
  // ALL its fields can be edited; saving updates that row instead of adding.
  const [editVariantId, setEditVariantId] = useState<string | null>(null)
  const addVariantSectionRef = useRef<HTMLDivElement>(null)

  const handleEditVariantRow = (variant: ProductVariant) => {
    setNewVariant({
      variantName: variant.variantName || '',
      size: variant.size || '',
      color: variant.color || '',
      colorHex: variant.colorHex || '#000000',
      sku: variant.sku || '',
      price: variant.price || 0,
      originalPrice: variant.originalPrice,
      discount: variant.discount,
      stock: variant.stock || 0,
      lowStockThreshold: variant.lowStockThreshold,
      images: variant.images || [],
    })
    setEditVariantId(variant.id || null)
    // Scroll the add/edit form into view.
    setTimeout(() => addVariantSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  const cancelEditVariant = () => {
    setEditVariantId(null)
    setNewVariant({ variantName: '', size: '', color: '', colorHex: '#000000', sku: '', price: 0, stock: 0, lowStockThreshold: undefined, images: [] })
  }

  const handleVariantImagesUpdate = (variantId: string, newImages: string[]) => {
    updateVariant(variantId, 'images', newImages)
  }

  const getEditingVariant = () => {
    return formData.variants.find(v => v.id === editingVariantId)
  }

  // Load product data for editing
  useEffect(() => {
    if (isEdit && productId) {
      setIsLoadingData(true)

      // Fetch actual product data from API
      const loadProductData = async () => {
        try {
          const { adminProductService } = await import('@/services/adminProductService')
          const response = await adminProductService.getProduct(productId)

          if (response.success && response.data) {
            const product = response.data

            // Call callback to inform parent component about product name
            if (onProductNameLoad && product.name) {
              onProductNameLoad(product.name)
            }

            // Map API response to form data
            setFormData({
              inventoryItemId: product.inventory?.id || '',
              isFromInventory: !!product.inventory,

              // Vendor Information
              vendorId: product.vendorId,
              vendorName: product.vendor?.companyName || '',

              name: product.name,
              description: product.description,
              category: product.category,
              subCategory: product.subCategory || '',

              // Pricing Information
              basePrice: product.basePrice,
              originalPrice: product.originalPrice,
              discount: product.discount,
              gstPercentage: product.gstPercentage,
              hsnCode: product.hsnCode || '',
              returnable: product.returnable !== false,
              packagingType: (product.packagingType as 'PACKED' | 'UNPACKED' | undefined) || '',
              packingType: (product.packingType as 'BALE' | 'CARTON' | undefined) || '',
              unpackedType: ((product as any).unpackedType as 'STITCHED' | 'UNSTITCHED' | 'OTHER' | undefined) || '',
              unpackedNote: ((product as any).unpackedNote as string | undefined) || '',
              adminFixedPrice: product.adminFixedPrice || null,
              priceINR: product.priceINR || null,
              priceUSD: product.priceUSD || null,
              originalPriceINR: product.originalPriceINR || null,
              originalPriceUSD: product.originalPriceUSD || null,
              priceVisibility: product.priceVisibility || 'BOTH',

              // Basic Product Info - Size & Color
              singleUnitSize: product.singleUnitSize || '',
              singleUnitColor: product.singleUnitColor || '',
              singleUnitColorHex: product.singleUnitColorHex || '#000000',

              // Product Rating & Reviews
              rating: undefined,
              reviews: undefined,

              fabricType: product.fabricType || '',
              material: product.material || '',
              fabricSpecifications: (() => {
                const fs = (product.fabricSpecifications as any) || {}
                return {
                  type: fs.type || '',
                  composition: fs.composition || '',
                  weight: fs.weight || '',
                  weightValue: fs.weightValue || fs.weight || '',
                  weightUnit: fs.weightUnit || 'GSM',
                  length: fs.length || '',
                  breadth: fs.breadth || '',
                  gsm: fs.gsm || '',
                  weave: fs.weave || '',
                  finish: fs.finish || '',
                  careInstructions: Array.isArray(fs.careInstructions) ? fs.careInstructions : [],
                }
              })(),

              manufacturerInfo: (() => {
                const mi = (product as any).manufacturerInfo || {}
                return {
                  photo: mi.photo || '',
                  title: mi.title || '',
                  fullName: mi.fullName || '',
                  role: mi.role || '',
                  experience: mi.experience || '',
                  description: mi.description || '',
                }
              })(),

              variants: product.variants?.map(v => ({
                id: v.id,
                variantName: v.variantName,
                size: v.size,
                color: v.color,
                colorHex: v.colorHex || '#000000',
                sku: v.sku,
                price: v.price,
                lowStockThreshold: v.lowStockThreshold ?? undefined,
                originalPrice: v.originalPrice,
                discount: v.discount,
                adminFixedPrice: v.adminFixedPrice || null,
                priceINR: v.priceINR || null,
                priceUSD: v.priceUSD || null,
                originalPriceINR: v.originalPriceINR || null,
                originalPriceUSD: v.originalPriceUSD || null,
                priceVisibility: v.priceVisibility || 'BOTH',
                stock: v.stock,
                images: v.images || []
              })) || [],
              hasVariants: product.hasVariants,

              baseSku: product.baseSku,

              // Map actual product images
              images: product.images?.map(img => ({
                id: img.id,
                url: img.url,
                alt: img.alt || product.name,
                isPrimary: img.isPrimary,
                imageType: img.imageType as 'cover' | 'gallery'
              })) || [],

              // For variant products, use base stock from inventory (not aggregate totalStock)
              totalStock: product.hasVariants && product.inventory?.baseStock !== undefined
                ? product.inventory.baseStock
                : product.totalStock,
              lowStockThreshold: product.lowStockThreshold,
              trackInventory: product.trackInventory,

              dispatchTimeline: product.dispatchTimeline || {
                processingDays: 0,
                shippingDays: 0,
                totalDays: 0
              },

              uom: product.uom || 'pcs',
              tags: product.tags || [],
              dimensions: parseDimensions(product.dimensions).value,
              dimensionUnit: parseDimensions(product.dimensions).unit,
              weight: product.weight,
              inStock: product.inStock,
              status: product.status || 'ACTIVE',
              logisticsConfig: (product.logisticsConfig as ProductFormData['logisticsConfig']) || {
                unitWeight: 0,
                weightUom: 'KG',
                maxWeight: 0,
                dimensions: null,
                transportTypes: ['AIR', 'SHIP'],
                weightRanges: [
                  { minWeight: 0, maxWeight: 50, recommendedTransport: 'AIR' },
                  { minWeight: 50, maxWeight: 5000, recommendedTransport: 'SHIP' }
                ],
                airDeliveryDays: 7,
                shipDeliveryDays: 30,
                surfaceDeliveryDays: 7,
                airCostPerKg: 0,
                shipCostPerKg: 0,
                surfaceCostPerKg: 0,
                courierIds: [],
                notes: ''
              }
            })

            // Set selected inventory item if exists
            if (product.inventory) {
              setSelectedInventoryItem({
                id: product.inventory.id,
                name: product.inventory.name,
                sku: product.inventory.sku,
                currentStock: product.inventory.currentStock,
                category: product.inventory.category
              })
            }

            // Load inventory items for the vendor when editing
            if (product.vendorId) {
              setIsLoadingInventory(true)
              try {
                const { default: inventoryService } = await import('@/services/inventoryService')
                const items = await inventoryService.adminGetInventoryByVendor(product.vendorId, false)
                setInventoryItems(items)
              } catch (error) {
                console.error('Error loading inventory items:', error)
                setInventoryItems([])
              } finally {
                setIsLoadingInventory(false)
              }

              // Load vendor-specific categories when editing
              setIsLoadingCategories(true)
              try {
                // Use axios instance instead of fetch for proper authentication
                const axiosInstance = (await import('@/lib/axios')).default
                const response = await axiosInstance.get(`/inventory/admin/vendor/${product.vendorId}/categories`)

                const vendorCategories = response.data.data.categories || []
                const vendorSubcats = response.data.data.subcategories || []

                // Set categories as names
                const categoryNames = vendorCategories.map((c: any) => c.name)
                if (product.category && !categoryNames.includes(product.category)) {
                  categoryNames.push(product.category)
                }
                setCategories(categoryNames)

                // Build subcategories map by category name
                const subcatsMap: Record<string, string[]> = {}
                vendorCategories.forEach((cat: any) => {
                  const catSubcats = vendorSubcats
                    .filter((sub: any) => sub.parentId === cat.id)
                    .map((sub: any) => sub.name)

                  // Ensure product's existing subcategory is in the map for its category
                  if (product.category === cat.name && product.subCategory && !catSubcats.includes(product.subCategory)) {
                    catSubcats.push(product.subCategory)
                  }

                  if (catSubcats.length > 0) {
                    subcatsMap[cat.name] = catSubcats
                  }
                })

                // If product category wasn't found in vendor categories, we still need its subcategory in the map
                if (product.category && product.subCategory && !subcatsMap[product.category]) {
                  subcatsMap[product.category] = [product.subCategory]
                }

                setVendorSubcategories(subcatsMap)
              } catch (error) {
                console.error('Error loading vendor categories:', error)
                setCategories([])
                setVendorSubcategories({})
              } finally {
                setIsLoadingCategories(false)
              }
            }
          }
        } catch (error: any) {
          console.error('Error loading product data:', error)
          showErrorToast('Failed to Load Product', error.message || 'Unable to load product data. Please try again.')
        } finally {
          setIsLoadingData(false)
        }
      }

      loadProductData()
    }
  }, [isEdit, productId])

  // Inventory Selection Functions
  const handleInventorySelect = (inventoryItem: InventoryItem) => {
    console.log('=== INVENTORY ITEM SELECTED ===')
    console.log('Inventory item:', inventoryItem)
    console.log('Available categories:', categories)
    console.log('Categories length:', categories.length)
    console.log('Available subcategories map:', vendorSubcategories)
    console.log('Inventory category:', inventoryItem.category)
    console.log('Inventory subcategory:', inventoryItem.subcategory)
    console.log('Is loading categories?', isLoadingCategories)

    // Warn if categories aren't loaded yet (shouldn't happen with disabled dropdown)
    if (categories.length === 0) {
      console.warn('⚠️ WARNING: Categories array is empty! This should not happen.')
      showWarningToast('Please Wait', 'Categories are still loading. Please try again in a moment.')
      return
    }

    // Field might be subcategory or subCategory in different contexts, handle both
    const invCategory = inventoryItem.category
    const invSubcategory = inventoryItem.subcategory || (inventoryItem as any).subCategory

    // Find the matching category with case-insensitive comparison and handle common plural/singular cases
    let matchedCategory = categories.find(
      cat => {
        const c1 = cat.toLowerCase()
        const c2 = invCategory.toLowerCase()
        return c1 === c2 || c1 === c2 + 's' || c2 === c1 + 's'
      }
    )

    console.log('Initially matched category:', matchedCategory)

    // If no match found, we'll use the inventory category but add it to our list so the dropdown shows it
    if (!matchedCategory && invCategory) {
      console.log('No matched category found, adding to list:', invCategory)
      setCategories(prev => [...new Set([...prev, invCategory])])
      matchedCategory = invCategory
    }

    // Find matching subcategory with case-insensitive comparison
    const categorySubcats = matchedCategory ? (vendorSubcategories[matchedCategory] || categorySubcategories[matchedCategory] || []) : []
    let matchedSubcategory = invSubcategory
      ? categorySubcats.find(sub => {
        const s1 = sub.toLowerCase()
        const s2 = invSubcategory.toLowerCase()
        return s1 === s2 || s1 === s2 + 's' || s2 === s1 + 's'
      })
      : ''

    console.log('Available subcategories for matching:', categorySubcats)
    console.log('Matched subcategory (case-corrected):', matchedSubcategory)

    // Ensure the inventory subcategory is in our local categories map so it shows in the dropdown
    if (!matchedSubcategory && invSubcategory && matchedCategory) {
      console.log('Subcategory mismatch, adding inventory subcategory to map:', invSubcategory)
      setVendorSubcategories(prev => ({
        ...prev,
        [matchedCategory!]: [...new Set([...(prev[matchedCategory!] || []), invSubcategory])]
      }))
      matchedSubcategory = invSubcategory
    }

    setSelectedInventoryItem(inventoryItem)
    setFormData(prev => {
      const newData = {
        ...prev,
        inventoryItemId: inventoryItem.id,
        isFromInventory: true,
        description: inventoryItem.description || '',
        category: matchedCategory || invCategory || '',
        subCategory: matchedSubcategory || invSubcategory || '',
        baseSku: inventoryItem.sku,
        totalStock: inventoryItem.currentStock
      }

      console.log('Final choice - Category:', newData.category, 'SubCategory:', newData.subCategory)
      return newData
    })
  }

  const clearInventorySelection = () => {
    setSelectedInventoryItem(null)
    setFormData(prev => ({
      ...prev,
      inventoryItemId: '',
      isFromInventory: false,
      name: '',
      description: '',
      category: '',
      subCategory: '', // Also clear subcategory
      baseSku: '',
      totalStock: 0
    }))
  }

  // Vendor Selection Functions
  const handleVendorSelect = async (vendorId: string) => {
    const vendor = vendors.find(v => v.id === vendorId)
    if (vendor) {
      setFormData(prev => ({
        ...prev,
        vendorId: vendor.id,
        vendorName: vendor.name,
        category: '', // Reset category when vendor changes
        subCategory: '' // Reset subcategory when vendor changes
      }))

      // Load vendor-specific categories FIRST (before inventory items)
      setIsLoadingCategories(true)
      try {
        console.log('=== FETCHING VENDOR CATEGORIES ===')
        console.log('Vendor ID:', vendorId)

        // Use axios instance instead of fetch for proper authentication
        const { default: axiosInstance } = await import('@/lib/axios')
        const response = await axiosInstance.get(`/inventory/admin/vendor/${vendorId}/categories`)

        console.log('Response data:', response.data)

        const vendorCategories = response.data.data.categories || []
        const vendorSubcats = response.data.data.subcategories || []

        console.log('=== LOADED VENDOR CATEGORIES ===')
        console.log('Categories:', vendorCategories)
        console.log('Subcategories:', vendorSubcats)

        // Set categories as names
        const categoryNames = vendorCategories.map((c: any) => c.name)
        setCategories(categoryNames)

        // Build subcategories map by category name
        const subcatsMap: Record<string, string[]> = {}
        vendorCategories.forEach((cat: any) => {
          // Find subcategories that belong to this category
          const catSubcats = vendorSubcats
            .filter((sub: any) => sub.parentId === cat.id)
            .map((sub: any) => sub.name)

          if (catSubcats.length > 0) {
            subcatsMap[cat.name] = catSubcats
          }
        })

        setVendorSubcategories(subcatsMap)
        console.log('Loaded vendor categories:', categoryNames)
        console.log('Loaded vendor subcategories map:', subcatsMap)
      } catch (error: any) {
        console.error('Error loading vendor categories:', error)
        console.error('Error response:', error.response?.data)
        showErrorToast('Load Failed', 'Unable to load categories for this vendor')
        setCategories([])
        setVendorSubcategories({})
      } finally {
        setIsLoadingCategories(false)
      }

      // Load inventory items for the selected vendor AFTER categories are loaded
      setIsLoadingInventory(true)
      try {
        const { default: inventoryService } = await import('@/services/inventoryService')
        const items = await inventoryService.adminGetInventoryByVendor(vendorId, false)
        console.log('=== LOADED INVENTORY ITEMS ===')
        console.log('Items:', items)
        setInventoryItems(items)
      } catch (error) {
        console.error('Error loading inventory items:', error)
        showErrorToast('Load Failed', 'Unable to load inventory items for this vendor')
        setInventoryItems([])
      } finally {
        setIsLoadingInventory(false)
      }
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target

    // Handle dispatchTimeline with auto-calculation FIRST (before generic dot notation)
    if (name.startsWith('dispatchTimeline.')) {
      const field = name.replace('dispatchTimeline.', '')
      const numValue = parseInt(value) || 0
      setFormData(prev => ({
        ...prev,
        dispatchTimeline: {
          ...prev.dispatchTimeline,
          [field]: numValue,
          totalDays: field === 'processingDays'
            ? numValue + prev.dispatchTimeline.shippingDays
            : field === 'shippingDays'
              ? prev.dispatchTimeline.processingDays + numValue
              : prev.dispatchTimeline.totalDays
        }
      }))
    } else if (name.includes('.')) {
      // Handle other nested object updates (e.g., fabricSpecifications.type)
      const [parent, child] = name.split('.')
      setFormData(prev => ({
        ...prev,
        [parent]: {
          ...prev[parent as keyof ProductFormData] as any,
          [child]: value
        }
      }))
    } else {
      setFormData(prev => {
        const updated = {
          ...prev,
          [name]: type === 'number' ? parseFloat(value) || 0 :
            type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
        }

        return updated
      })
    }
  }

  const addVariant = () => {
    // SKU is auto-generated server-side; size is optional. Color is required.
    if (!newVariant.color) return

    // Edit mode: update the existing row in place.
    if (editVariantId) {
      setFormData(prev => ({
        ...prev,
        variants: prev.variants.map(v => v.id === editVariantId ? {
          ...v,
          variantName: (newVariant.variantName || '').trim(),
          color: newVariant.color!,
          colorHex: newVariant.colorHex || '#000000',
          price: newVariant.price || 0,
          originalPrice: newVariant.originalPrice || undefined,
          discount: newVariant.discount || undefined,
          stock: newVariant.stock || 0,
          lowStockThreshold: newVariant.lowStockThreshold,
          images: newVariant.images || [],
        } : v)
      }))
      setEditVariantId(null)
      setNewVariant({ variantName: '', size: '', color: '', colorHex: '#000000', sku: '', price: 0, stock: 0, lowStockThreshold: undefined, images: [] })
      return
    }

    const variant: ProductVariant = {
      id: Date.now().toString(),
      variantName: (newVariant.variantName || '').trim(),
      size: newVariant.size || '',
      color: newVariant.color!,
      colorHex: newVariant.colorHex || '#000000',
      sku: '', // assigned by the backend on save
      price: newVariant.price || 0,
      originalPrice: newVariant.originalPrice || undefined,
      discount: newVariant.discount || undefined,
      stock: newVariant.stock || 0,
      lowStockThreshold: newVariant.lowStockThreshold,
      images: newVariant.images || []
    }

    setFormData(prev => ({
      ...prev,
      variants: [...prev.variants, variant]
    }))

    setNewVariant({ variantName: '', size: '', color: '', colorHex: '#000000', sku: '', price: 0, stock: 0, lowStockThreshold: undefined, images: [] })
  }

  const removeVariant = (variantId: string) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.filter(v => v.id !== variantId)
    }))
  }

  const updateVariant = (variantId: string, field: keyof ProductVariant, value: any) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.map(v => {
        if (v.id === variantId) {
          // If updating colorHex, also update color name
          if (field === 'colorHex') {
            return {
              ...v,
              [field]: value,
              color: getColorName(value)
            }
          }
          return { ...v, [field]: value }
        }
        return v
      })
    }))
  }

  const handleVariantImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    if (file.size > 5 * 1024 * 1024) { // 5MB limit
      centerNotice.error('File Too Large', `${file.name} exceeds the 5MB limit.`)
      e.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      if (event.target?.result) {
        setNewVariant(prev => ({
          ...prev,
          images: [event.target?.result as string] // Overwrite with new single image
        }))
        centerNotice.success('Image Uploaded', 'Variant image added.')
      } else {
        centerNotice.error('Upload Failed', `Could not read ${file.name}.`)
      }
      e.target.value = ''
    }
    reader.onerror = () => {
      centerNotice.error('Upload Failed', `Failed to read ${file.name}.`)
      e.target.value = ''
    }
    reader.readAsDataURL(file)
  }

  const addTag = () => {
    if (selectedTag && !formData.tags.includes(selectedTag)) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, selectedTag]
      }))
      setSelectedTag('')
    }
  }

  // Image handling functions
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, imageType: 'cover' | 'gallery' = 'gallery') => {
    const files = e.target.files
    if (!files) return

    // Check file size limits FIRST - before any other processing
    const oversizedFiles = Array.from(files).filter(file => file.size > 10 * 1024 * 1024) // 10MB limit
    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map(f => f.name).join(', ')
      centerNotice.error('File Too Large', `The following file(s) exceed the 10MB limit: ${fileNames}`)
      e.target.value = '' // Reset input immediately
      return
    }

    // Check limits before processing
    if (imageType === 'cover') {
      const existingCoverImages = formData.images.filter(img => img.imageType === 'cover')
      if (existingCoverImages.length >= 1) {
        centerNotice.error('Cover Image Limit', 'Only one cover image is allowed. Please remove the existing cover image first.')
        e.target.value = '' // Reset input
        return
      }
      if (files.length > 1) {
        centerNotice.error('Single Image Only', 'Please select only one image for the cover image.')
        e.target.value = '' // Reset input
        return
      }
    }

    if (imageType === 'gallery') {
      const existingGalleryImages = formData.images.filter(img => img.imageType === 'gallery')
      const remainingSlots = 3 - existingGalleryImages.length

      if (remainingSlots <= 0) {
        centerNotice.error('Gallery Limit Reached', 'Maximum 3 gallery images allowed. Please remove some images first.')
        e.target.value = '' // Reset input
        return
      }

      if (files.length > remainingSlots) {
        centerNotice.error('Too Many Images', `You can only add ${remainingSlots} more gallery image${remainingSlots > 1 ? 's' : ''}.`)
        e.target.value = '' // Reset input
        return
      }
    }

    // Process files (all validations passed)
    const validFiles = Array.from(files)
    validFiles.forEach((file) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        const newImage: ProductImage = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          url: event.target?.result as string,
          alt: file.name,
          isPrimary: imageType === 'cover',
          imageType: imageType
        }

        setFormData(prev => ({
          ...prev,
          images: [...prev.images, newImage]
        }))
        centerNotice.success('Image Uploaded', `${file.name} added successfully.`)
      }
      reader.readAsDataURL(file)
    })

    // Reset input
    e.target.value = ''
  }

  const setCoverImage = (imageId: string) => {
    setFormData(prev => ({
      ...prev,
      images: prev.images.map(img => ({
        ...img,
        isPrimary: img.id === imageId,
        imageType: img.id === imageId ? 'cover' : img.imageType
      }))
    }))
  }

  const setImageType = (imageId: string, imageType: 'cover' | 'gallery') => {
    // Check limits before changing type
    if (imageType === 'cover') {
      const existingCoverImages = formData.images.filter(img => img.imageType === 'cover' && img.id !== imageId)
      if (existingCoverImages.length >= 1) {
        centerNotice.error('Cover Image Limit', 'Only one cover image is allowed. Please remove the existing cover image first.')
        return
      }
    }

    if (imageType === 'gallery') {
      const existingGalleryImages = formData.images.filter(img => img.imageType === 'gallery' && img.id !== imageId)
      if (existingGalleryImages.length >= 3) {
        centerNotice.error('Gallery Limit Reached', 'Maximum 3 gallery images allowed.')
        return
      }
    }

    setFormData(prev => ({
      ...prev,
      images: prev.images.map(img => {
        if (img.id === imageId) {
          return {
            ...img,
            imageType: imageType,
            isPrimary: imageType === 'cover' ? true : false
          }
        }
        // If setting another image as cover, remove cover status from others
        if (imageType === 'cover' && img.imageType === 'cover') {
          return {
            ...img,
            imageType: 'gallery',
            isPrimary: false
          }
        }
        return img
      })
    }))
  }

  const removeImage = (imageId: string) => {
    setFormData(prev => {
      const updatedImages = prev.images.filter(img => img.id !== imageId)
      // If we removed the cover image, make the first gallery image the cover if available
      if (updatedImages.length > 0 && !updatedImages.some(img => img.imageType === 'cover')) {
        const firstGalleryImage = updatedImages.find(img => img.imageType === 'gallery')
        if (firstGalleryImage) {
          firstGalleryImage.imageType = 'cover'
          firstGalleryImage.isPrimary = true
        }
      }
      return {
        ...prev,
        images: updatedImages
      }
    })
  }

  const removeTag = (tag: string) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter(t => t !== tag)
    }))
  }

  const handleSaveDraft = async () => {
    setIsLoading(true)
    try {
      // Save as draft
      console.log('Saving draft:', formData)
      showSuccessToast('Draft Saved', 'Your product draft has been saved.')
      setHasUnsavedChanges(false)
    } catch (error) {
      showErrorToast('Save Failed', 'Unable to save draft.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Basic validation
    if (!formData.name.trim()) {
      showErrorToast('Validation Error', 'Product name is required.')
      return
    }

    if (!formData.category) {
      showErrorToast('Validation Error', 'Please select a category.')
      return
    }

    if (!formData.vendorId) {
      showErrorToast('Validation Error', 'Please select a vendor.')
      return
    }

    if (!isEdit && !formData.inventoryItemId) {
      showErrorToast('Validation Error', 'Please select an inventory item.')
      return
    }

    // Pricing validation
    if (formData.basePrice <= 0) {
      showErrorToast('Validation Error', 'Please enter a valid base price.')
      return
    }

    if (formData.hasVariants && formData.variants.length === 0) {
      showErrorToast('Validation Error', 'Please add at least one variant or disable variants.')
      return
    }

    setIsLoading(true)

    try {
      const { adminProductService } = await import('@/services/adminProductService')

      // Fold the dimension unit into the dimensions string (e.g. "230x250 cm")
      // and drop the helper-only field before sending.
      const submitData: any = {
        ...formData,
        dimensions: combineDimensions(formData.dimensions, formData.dimensionUnit),
      }
      delete submitData.dimensionUnit

      if (isEdit && productId) {
        // Update existing product
        const response = await adminProductService.updateProduct(productId, submitData)

        if (response.success) {
          showSuccessToast('Product Updated', 'Product has been updated successfully.')
          setHasUnsavedChanges(false)
          router.push('/admin/dashboard/products')
        }
      } else {
        // Create new product
        const response = await adminProductService.createProduct(submitData)

        if (response.success) {
          showSuccessToast('Product Created', 'Product has been created successfully.')
          setHasUnsavedChanges(false)
          router.push('/admin/dashboard/products')
        }
      }
    } catch (error: any) {
      console.error('Error saving product:', error)
      showErrorToast('Save Failed', error.message || 'Unable to save product. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  // Show loading state while fetching data
  if (isLoadingData) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href="/admin/dashboard/products">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Products
              </Button>
            </Link>
            <h1 className="text-2xl font-bold text-slate-900">Loading...</h1>
          </div>
        </div>
        <Card>
          <CardContent className="p-8">
            <div className="flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700"></div>
              <span className="ml-3 text-slate-600">Loading product data...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Sticky header + tabs — stays pinned while the content scrolls (matches
          the vendor product form). Horizontal negative margins bleed the
          background to the layout edges; no negative TOP margin so it never
          overlaps the page breadcrumb above it. */}
      <div className="sticky top-0 z-20 bg-slate-50 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-3 pb-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center space-x-4">
            <button
              type="button"
              onClick={() => router.back()}
              aria-label="Go back"
              className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors shrink-0"
            >
              <ArrowLeft className="h-4 w-4 text-slate-600" />
            </button>
            <h1 className="text-2xl font-bold text-slate-900">
              {isEdit ? 'Edit Product' : 'Add New Product'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/admin/dashboard/products" className="shrink-0">
              <Button
                type="button"
                variant="outline"
                className="border-slate-200 text-slate-700 hover:bg-slate-100 hover:border-slate-300 hover:text-slate-900 transition-colors"
              >
                Cancel
              </Button>
            </Link>
            {!isEdit && (
              <Button
                type="button"
                variant="outline"
                onClick={handleSaveDraft}
                disabled={isLoading}
                className="border-brand-200 text-brand-600 hover:bg-brand-50 hover:border-brand-300 hover:text-brand-700 transition-colors"
              >
                Save as Draft
              </Button>
            )}
            <Button
              type="submit"
              form="admin-product-form"
              disabled={isLoading}
              className="bg-brand-500 text-white hover:bg-brand-600 hover:shadow-md hover:shadow-brand-500/30 active:bg-brand-700 transition-all shadow-sm shadow-brand-500/20"
            >
              <Save className="h-4 w-4 mr-2" />
              {isLoading ? 'Saving...' : (isEdit ? 'Update Product' : 'Create Product')}
            </Button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mt-4 border-b border-slate-200">
          <nav className="-mb-px flex gap-1 overflow-x-auto">
            {productTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 rounded-t-md ${activeTab === tab.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                  }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Form */}
      <form id="admin-product-form" onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:items-start">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">

            {/* Basic Information Tab */}
            {activeTab === 'basic' && (
              <Card>
                <CardHeader>
                  <CardTitle>Basic Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">

                  {/* Vendor Selection */}
                  <div>
                    <Dropdown
                      label="Vendor *"
                      value={formData.vendorId || ''}
                      options={vendors.map(vendor => ({
                        value: vendor.id,
                        label: `${vendor.name} (${vendor.email})`
                      }))}
                      placeholder={isLoadingVendors ? "Loading vendors..." : "Select Vendor"}
                      onChange={(value) => handleVendorSelect(value as string)}
                      disabled={isLoadingVendors || isEdit}
                    />
                    {formData.vendorName && (
                      <p className="text-xs text-slate-500 mt-1">Selected: {formData.vendorName}</p>
                    )}
                    {isEdit && (
                      <p className="text-xs text-blue-600 mt-1">ℹ️ Vendor cannot be changed when editing</p>
                    )}
                  </div>

                  {/* Inventory Selection */}
                  <div className="border border-brand-200 rounded-xl p-4 bg-brand-50">
                    <h4 className="font-semibold text-slate-900 mb-1.5">Select Inventory Item</h4>
                    <p className="text-sm text-slate-600 mb-4">
                      Choose an inventory item to create a detailed product with variants
                    </p>

                    {!formData.vendorId ? (
                      <p className="text-sm text-slate-600 italic">
                        Please select a vendor first to view their inventory items
                      </p>
                    ) : isLoadingCategories ? (
                      <div className="flex items-center justify-center py-4">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500"></div>
                        <span className="ml-3 text-sm text-slate-500">Loading categories...</span>
                      </div>
                    ) : !selectedInventoryItem ? (
                      <div className="space-y-3">
                        {isLoadingInventory ? (
                          <div className="flex items-center justify-center py-4">
                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500"></div>
                            <span className="ml-3 text-sm text-slate-500">Loading inventory items...</span>
                          </div>
                        ) : inventoryItems.length === 0 ? (
                          <p className="text-sm text-slate-600 italic py-2">
                            No available inventory items for this vendor
                          </p>
                        ) : (
                          <>
                            <Dropdown
                              label="Available Inventory Items"
                              value=""
                              options={inventoryItems
                                .filter(item => !item.hasProductCreated)
                                .map(item => ({
                                  value: item.id,
                                  label: `${item.name} (${item.sku}) - Stock: ${item.currentStock}`
                                }))}
                              placeholder={isLoadingCategories ? "Loading categories first..." : "Select an inventory item"}
                              onChange={(value) => {
                                const item = inventoryItems.find(i => i.id === value)
                                if (item) handleInventorySelect(item)
                              }}
                              disabled={isLoadingCategories}
                            />
                            {isLoadingCategories ? (
                              <p className="text-xs text-slate-500">
                                Please wait for categories to load before selecting an inventory item
                              </p>
                            ) : (
                              <p className="text-xs text-slate-500">
                                Only inventory items without existing products are shown
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="bg-white border border-brand-200 rounded-lg p-4">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <h5 className="font-medium text-slate-900">{selectedInventoryItem.name}</h5>
                            <p className="text-sm text-slate-600">SKU: {selectedInventoryItem.sku}</p>
                            <p className="text-sm text-slate-600">Category: {selectedInventoryItem.category}</p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={clearInventorySelection}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Change
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <span className="text-slate-600">Current Stock:</span>
                            <span className="font-medium ml-2">{selectedInventoryItem.currentStock}</span>
                          </div>
                        </div>
                        <Link href={`/admin/dashboard/inventory/edit/${selectedInventoryItem.id}`}>
                          <Button variant="outline" size="sm" className="mt-3 hover:bg-brand-500 hover:text-white hover:border-brand-500 transition-colors">
                            Edit Inventory Item
                          </Button>
                        </Link>
                      </div>
                    )}
                  </div>

                  {/* Inventory Item Name (when from inventory) */}
                  {formData.isFromInventory && selectedInventoryItem && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Inventory Item Name
                      </label>
                      <input
                        type="text"
                        value={selectedInventoryItem.name}
                        disabled
                        className="w-full px-3 py-2 border border-slate-300 rounded-md bg-slate-100 text-slate-600"
                        placeholder="Inventory item name"
                      />
                      <p className="text-xs text-slate-500 mt-1">Reference from inventory item</p>
                    </div>
                  )}

                  {/* Product Name */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Product Name *
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleInputChange}
                      required
                      disabled={!formData.vendorId || (!isEdit && !formData.inventoryItemId)}
                      className={`w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent ${(!formData.vendorId || (!isEdit && !formData.inventoryItemId)) ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : ''}`}
                      placeholder={!formData.vendorId ? "Please select a vendor first" : (!isEdit && !formData.inventoryItemId) ? "Please select an inventory item first" : formData.isFromInventory ? "Enter a unique product name" : "Enter product name"}
                    />
                    {!formData.vendorId && (
                      <p className="text-xs text-red-500 mt-1">Select a vendor before entering the product name</p>
                    )}
                    {formData.vendorId && !isEdit && !formData.inventoryItemId && (
                      <p className="text-xs text-red-500 mt-1">Select an inventory item before entering the product name</p>
                    )}
                    {formData.vendorId && formData.isFromInventory && (
                      <p className="text-xs text-slate-500 mt-1">Create a unique product name (can be different from inventory item name)</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Description *
                    </label>
                    <textarea
                      name="description"
                      value={formData.description}
                      onChange={handleInputChange}
                      required
                      rows={4}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                      placeholder="Enhance the product description with detailed information"
                    />
                    {formData.isFromInventory && (
                      <p className="text-xs text-slate-500 mt-1">You can enhance the basic description from inventory</p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Dropdown
                        label="Category *"
                        value={formData.category}
                        options={categories}
                        placeholder={
                          !formData.vendorId
                            ? "Select vendor first"
                            : isLoadingCategories
                              ? "Loading categories..."
                              : categories.length === 0
                                ? "No categories available"
                                : "Select Category"
                        }
                        onChange={(value) => setFormData(prev => ({ ...prev, category: value as string, subCategory: '' }))}
                        disabled={!formData.vendorId || isLoadingCategories || formData.isFromInventory}
                      />
                      {!formData.vendorId && (
                        <p className="text-xs text-slate-500 mt-1 italic">Please select a vendor first</p>
                      )}
                      {formData.isFromInventory && formData.vendorId && (
                        <p className="text-xs text-slate-500 mt-1">From inventory item</p>
                      )}
                    </div>
                    <div>
                      <Dropdown
                        label="Sub-Category *"
                        value={formData.subCategory}
                        options={formData.category ? (vendorSubcategories[formData.category] || categorySubcategories[formData.category] || []) : []}
                        placeholder="Select Sub-Category"
                        onChange={(value) => setFormData(prev => ({ ...prev, subCategory: value as string }))}
                        disabled={!formData.category}
                      />
                    </div>
                  </div>



                  {/* Selling Unit, Base SKU, Base Color — 3 per row */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Selling Unit (UOM)
                      </label>
                      <Dropdown
                        label=""
                        value={formData.uom}
                        options={[
                          { value: 'pcs', label: 'Pieces (pcs)' },
                          { value: 'meters', label: 'Meters' },
                          { value: 'kg', label: 'Kilograms (kg)' },
                          { value: 'yards', label: 'Yards' },
                          { value: 'sets', label: 'Sets' },
                          { value: 'rolls', label: 'Rolls' },
                          { value: 'pairs', label: 'Pairs' },
                          { value: 'dozen', label: 'Dozen' },
                        ]}
                        placeholder="Select UOM"
                        onChange={(value) => setFormData(prev => ({ ...prev, uom: value as string }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">How this product is sold to customers</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Base SKU
                      </label>
                      <input
                        type="text"
                        name="baseSku"
                        value={formData.baseSku}
                        readOnly
                        className="w-full px-3 py-2 border border-slate-200 rounded-md bg-slate-100 text-slate-600 cursor-not-allowed"
                        placeholder={isEdit ? '' : 'Auto-generated on save'}
                      />
                      <p className="text-xs text-slate-500 mt-1">Auto-generated &amp; permanent — not editable.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        HSN Code
                      </label>
                      <input
                        type="text"
                        value={formData.hsnCode ?? ''}
                        onChange={(e) => setFormData(prev => ({ ...prev, hsnCode: e.target.value }))}
                        placeholder="e.g., 6302"
                        maxLength={8}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                      />
                      <p className="text-xs text-slate-500 mt-1">HSN code for GST classification</p>
                    </div>
                    {/* Returns are a .in-only feature — hide this control on .com. */}
                    {getRegion() === 'IN' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Return Applicable
                      </label>
                      <Dropdown
                        label=""
                        value={formData.returnable === false ? 'no' : 'yes'}
                        options={[
                          { value: 'yes', label: 'Yes — returns allowed' },
                          { value: 'no', label: 'No — no returns' },
                        ]}
                        placeholder="Select"
                        onChange={(value) => setFormData(prev => ({ ...prev, returnable: value === 'yes' }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        When Yes, customers can raise a return within 7 days of delivery. When No, the return option is hidden for this product.
                      </p>
                    </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Packaging
                      </label>
                      <Dropdown
                        label=""
                        value={formData.packagingType || ''}
                        options={[
                          { value: '', label: 'Select packaging…' },
                          { value: 'PACKED', label: 'Packed' },
                          { value: 'UNPACKED', label: 'Unpacked' },
                        ]}
                        placeholder="Select packaging…"
                        onChange={(value) => setFormData(prev => ({
                          ...prev,
                          packagingType: value as 'PACKED' | 'UNPACKED' | '',
                          // Clear the pack style when not packed.
                          packingType: value === 'PACKED' ? prev.packingType : '',
                          // Clear the unpacked fields when not unpacked.
                          unpackedType: value === 'UNPACKED' ? prev.unpackedType : '',
                          unpackedNote: value === 'UNPACKED' ? prev.unpackedNote : '',
                        }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">Is this product shipped packed or unpacked?</p>
                    </div>
                    {formData.packagingType === 'PACKED' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Pack Style
                      </label>
                      <Dropdown
                        label=""
                        value={formData.packingType || ''}
                        options={[
                          { value: '', label: 'Select pack style…' },
                          { value: 'BALE', label: 'Bale pack' },
                          { value: 'CARTON', label: 'Carton box' },
                        ]}
                        placeholder="Select pack style…"
                        onChange={(value) => setFormData(prev => ({ ...prev, packingType: value as 'BALE' | 'CARTON' | '' }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">How is the packed product bundled?</p>
                    </div>
                    )}
                    {formData.packagingType === 'UNPACKED' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Unpacked Type
                      </label>
                      <Dropdown
                        label=""
                        value={formData.unpackedType || ''}
                        options={[
                          { value: '', label: 'Select type…' },
                          { value: 'STITCHED', label: 'Stitched' },
                          { value: 'UNSTITCHED', label: 'Unstitched' },
                          { value: 'OTHER', label: 'Other' },
                        ]}
                        placeholder="Select type…"
                        onChange={(value) => setFormData(prev => ({ ...prev, unpackedType: value as 'STITCHED' | 'UNSTITCHED' | 'OTHER' | '' }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">Is the unpacked product stitched, unstitched or other?</p>
                      <div className="mt-3">
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Note / Remarks
                        </label>
                        <textarea
                          name="unpackedNote"
                          value={formData.unpackedNote || ''}
                          onChange={handleInputChange}
                          rows={2}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                          placeholder="Add any remarks about the unpacked product…"
                        />
                      </div>
                    </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Base Color
                      </label>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={formData.singleUnitColorHex || '#000000'}
                            onChange={(e) => {
                              const hex = e.target.value
                              setFormData(prev => ({
                                ...prev,
                                singleUnitColorHex: hex,
                                singleUnitColor: getColorName(hex)
                              }))
                            }}
                            className="w-10 h-10 border border-slate-300 rounded-md cursor-pointer"
                            title="Pick a color"
                          />
                          <input
                            type="text"
                            value={formData.singleUnitColor || ''}
                            onChange={(e) => {
                              const name = e.target.value
                              const hex = getColorHex(name)
                              setFormData(prev => ({ ...prev, singleUnitColor: name, ...(hex ? { singleUnitColorHex: hex } : {}) }))
                            }}
                            placeholder="Color name"
                            className="flex-1 px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                          />
                        </div>
                        <p className="text-xs text-slate-500">Primary color for this product</p>
                      </div>
                    </div>
                  </div>

                  {/* Tags */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Tags
                    </label>
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <Dropdown
                            value={selectedTag}
                            options={tagOptions}
                            onChange={(value) => setSelectedTag(value as string)}
                            placeholder="Select a tag"
                          />
                        </div>
                        {/* Span wrapper carries the tooltip so it still shows when
                            the (disabled) button suppresses hover events. */}
                        <span title={!selectedTag ? 'Please select a tag first' : undefined} className="inline-flex">
                          <Button
                            type="button"
                            onClick={addTag}
                            disabled={!selectedTag}
                            className="bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
                          >
                            Add
                          </Button>
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {formData.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center px-3 py-1.5 bg-blue-50 text-slate-500 border border-blue-200 rounded-full text-sm font-medium"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(tag)}
                              className="ml-2 text-blue-600 hover:text-blue-800"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                      {formData.tags.length === 0 && (
                        <p className="text-xs text-slate-500">No tags added yet. Select from the dropdown above.</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Fabric & Specifications Tab */}
            {activeTab === 'fabric' && (
              <Card>
                <CardHeader>
                  <CardTitle>Fabric Type & Specifications</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Row 1: Fabric Type | Material Description | Composition */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                      <Dropdown
                        label="Fabric Type *"
                        value={formData.fabricType}
                        options={fabricTypes}
                        placeholder="Select Fabric Type"
                        onChange={(value) => setFormData(prev => ({ ...prev, fabricType: value as string }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Material Description
                      </label>
                      <input
                        type="text"
                        name="material"
                        value={formData.material}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        placeholder="e.g., 100% Organic Cotton"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Composition
                      </label>
                      <input
                        type="text"
                        name="fabricSpecifications.composition"
                        value={formData.fabricSpecifications.composition}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        placeholder="e.g., 100% Cotton"
                      />
                    </div>
                  </div>

                  {/* Row 2: Weight | Length | Width | GSM */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Weight (g)
                      </label>
                      <input
                        type="number"
                        name="fabricSpecifications.weightValue"
                        value={formData.fabricSpecifications.weightValue || ''}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        placeholder="e.g., 200 (grams)"
                        min="0"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Length (cm)
                      </label>
                      <input
                        type="number"
                        name="fabricSpecifications.length"
                        value={formData.fabricSpecifications.length || ''}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        placeholder="e.g., 100"
                        min="0"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Width (cm)
                      </label>
                      <input
                        type="number"
                        name="fabricSpecifications.breadth"
                        value={formData.fabricSpecifications.breadth || ''}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        placeholder="e.g., 100"
                        min="0"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        GSM <span className="text-xs font-normal text-slate-400">(auto-calculated)</span>
                      </label>
                      <input
                        type="text"
                        readOnly
                        aria-readonly="true"
                        value={formData.fabricSpecifications.gsm || ''}
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-semibold text-slate-700 bg-slate-100 cursor-not-allowed"
                        placeholder="—"
                        title="GSM = (Weight in g × 10000) ÷ (Length in cm × Width in cm)"
                      />
                      <p className="mt-1 text-xs text-slate-400">GSM = (Weight × 10000) ÷ (Length × Width)</p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Type of Weave
                    </label>
                    <input
                      type="text"
                      name="fabricSpecifications.weave"
                      value={formData.fabricSpecifications.weave}
                      onChange={handleInputChange}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                      placeholder="e.g., Percale, Sateen, Twill"
                    />
                  </div>

                  {/* Care Instructions — icon-based modal, same as the vendor form */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Care Instructions *
                    </label>
                    <button
                      type="button"
                      onClick={() => setCareModalOpen(true)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-left text-slate-500 hover:border-brand-400 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
                    >
                      {formData.fabricSpecifications.careInstructions.length > 0
                        ? `${formData.fabricSpecifications.careInstructions.length} instruction(s) selected — click to edit`
                        : 'Click to select care instructions…'}
                    </button>
                    {formData.fabricSpecifications.careInstructions.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {formData.fabricSpecifications.careInstructions.map((instruction, idx) => {
                          const match = CARE_INSTRUCTIONS.find((c) => c.label === instruction)
                          if (!match) {
                            return (
                              <span key={idx} className="inline-flex items-center text-xs px-2.5 py-1.5 bg-slate-50 text-slate-700 rounded-lg border border-slate-200">
                                {instruction}
                              </span>
                            )
                          }
                          const iconColor = CATEGORY_COLORS[match.category] || 'text-slate-500'
                          const chipStyle = CATEGORY_BORDER[match.category] || 'border-slate-200 bg-slate-50 text-slate-700'
                          return (
                            <span key={idx} className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${chipStyle}`}>
                              <span className={iconColor}>
                                <CareIcon paths={match.paths} className="w-4 h-4" />
                              </span>
                              {match.label}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Manufacturer Tab — who actually MADE this item */}
            {activeTab === 'manufacturer' && (
              <Card>
                <CardHeader>
                  <CardTitle>Manufacturer Information</CardTitle>
                  <p className="text-sm text-slate-500 mt-1">
                    Who made this item? This is shown to the QC inspector and on every product and inspection page. All fields are optional.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Photo */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Profile Photo</label>
                    <div className="flex items-center gap-4">
                      <div className="w-24 h-24 rounded-full border-2 border-dashed border-slate-300 overflow-hidden flex items-center justify-center bg-slate-50 shrink-0">
                        {formData.manufacturerInfo.photo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={formData.manufacturerInfo.photo} alt="Manufacturer" className="w-full h-full object-cover" />
                        ) : (
                          <ImageIcon className="w-8 h-8 text-slate-300" />
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        <input
                          id="admin-mfr-photo-input"
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) openMfrPhotoCropper(f); e.target.value = '' }}
                        />
                        <label
                          htmlFor="admin-mfr-photo-input"
                          className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                        >
                          <Upload className="w-4 h-4" />
                          {formData.manufacturerInfo.photo ? 'Change Photo' : 'Upload Photo'}
                        </label>
                        {formData.manufacturerInfo.photo && (
                          <button
                            type="button"
                            onClick={() => setManufacturerField('photo', '')}
                            className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700"
                          >
                            <X className="w-3.5 h-3.5" /> Remove
                          </button>
                        )}
                        <span className="text-xs text-slate-400">PNG, JPG or WebP, up to 5 MB. Square works best.</span>
                      </div>
                    </div>
                  </div>

                  {/* Title + Full Name */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1.5">Title</label>
                      <TitleSelect
                        value={formData.manufacturerInfo.title}
                        onChange={(v) => setManufacturerField('title', v)}
                        id="admin-mfr-title"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold text-slate-700 mb-1.5">Full Name</label>
                      <input
                        type="text"
                        value={formData.manufacturerInfo.fullName}
                        onChange={(e) => setManufacturerField('fullName', e.target.value)}
                        className="w-full px-4 py-2.5 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
                        placeholder="e.g. Ravi Kumar"
                      />
                    </div>
                  </div>

                  {/* Role + Experience */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1.5">Role</label>
                      <input
                        type="text"
                        value={formData.manufacturerInfo.role}
                        onChange={(e) => setManufacturerField('role', e.target.value)}
                        className="w-full px-4 py-2.5 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
                        placeholder="e.g. Master Weaver, Production Head"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1.5">Experience</label>
                      <input
                        type="text"
                        value={formData.manufacturerInfo.experience}
                        onChange={(e) => setManufacturerField('experience', e.target.value)}
                        className="w-full px-4 py-2.5 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
                        placeholder="e.g. 12 years"
                      />
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5">Short Description</label>
                    <textarea
                      value={formData.manufacturerInfo.description}
                      onChange={(e) => setManufacturerField('description', e.target.value)}
                      rows={4}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors resize-y"
                      placeholder="A short note about the maker — their craft, specialisation, workshop…"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Variants Tab */}
            {activeTab === 'variants' && (
              <Card>
                <CardHeader>
                  <CardTitle>Size & Color Variants</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      name="hasVariants"
                      checked={formData.hasVariants}
                      onChange={handleInputChange}
                      className="rounded border-slate-300 text-slate-900 focus:ring-brand-500/40"
                    />
                    <label className="text-sm font-medium text-slate-900">
                      This product has variants (different sizes/colors)
                    </label>
                  </div>

                  {formData.hasVariants && (
                    <>
                      {/* Add / Edit Variant */}
                      <div ref={addVariantSectionRef} className={`border-2 border-dashed rounded-xl p-6 bg-gradient-to-br from-slate-50 to-white transition-colors ${editVariantId ? 'border-brand-400 ring-2 ring-brand-500/20' : 'border-slate-300 hover:border-slate-400'}`}>
                        <div className="flex items-center gap-3 mb-6">
                          <div className="p-2 bg-brand-500 rounded-lg">
                            <Package className="h-5 w-5 text-white" />
                          </div>
                          <div>
                            <h4 className="font-semibold text-slate-900">{editVariantId ? 'Edit Variant' : 'Add New Variant'}</h4>
                            <p className="text-sm text-slate-600">{editVariantId ? 'Update this variant’s details and save your changes' : 'Create a new product variant with specific attributes'}</p>
                          </div>
                        </div>

                        {/* Variant Details - Two Row Layout */}
                        <div className="space-y-6">
                          {/* First Row: Variant Name, Color, SKU */}
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Variant Name</label>
                              <input
                                type="text"
                                value={newVariant.variantName || ''}
                                onChange={(e) => setNewVariant(prev => ({ ...prev, variantName: e.target.value }))}
                                placeholder="e.g., Premium Red"
                                className="w-full h-11 px-3.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-sm bg-white"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Color *</label>
                              <div className="flex items-center gap-3 h-11 px-3 border border-slate-300 rounded-lg bg-white">
                                <input
                                  type="color"
                                  value={newVariant.colorHex || '#000000'}
                                  onChange={(e) => {
                                    const hex = e.target.value
                                    setNewVariant(prev => ({
                                      ...prev,
                                      colorHex: hex,
                                      color: getColorName(hex)
                                    }))
                                  }}
                                  className="w-10 h-10 border border-slate-300 rounded-md cursor-pointer"
                                  title="Pick a color"
                                />
                                <input
                                  type="text"
                                  value={newVariant.color || ''}
                                  onChange={(e) => {
                                    const name = e.target.value
                                    const hex = getColorHex(name)
                                    setNewVariant(prev => ({ ...prev, color: name, ...(hex ? { colorHex: hex } : {}) }))
                                  }}
                                  placeholder="Color name"
                                  className="flex-1 px-0 py-0 border-0 focus:outline-none focus:ring-0 text-sm bg-transparent"
                                />
                              </div>
                            </div>

                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">SKU</label>
                              <input
                                type="text"
                                readOnly
                                value={formData.baseSku ? `${formData.baseSku}-${variantAlphaSuffix(formData.variants.length + 1)}` : ''}
                                placeholder="Auto-generated on save"
                                className="w-full h-11 px-3.5 border border-slate-200 rounded-lg text-sm bg-slate-100 text-slate-600 cursor-not-allowed"
                              />
                              <p className="text-xs text-slate-500">Auto-generated from the product SKU — not editable.</p>
                            </div>
                          </div>

                          {/* Second Row: Pricing & Inventory & Image */}
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Price *</label>
                              <div className="relative">
                                <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-slate-500 text-sm font-medium">₹</span>
                                <input
                                  type="number"
                                  value={newVariant.price || ''}
                                  onChange={(e) => setNewVariant(prev => ({ ...prev, price: parseFloat(e.target.value) || 0 }))}
                                  placeholder="0.00"
                                  step="0.01"
                                  className="w-full pl-8 pr-3.5 h-11 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-sm bg-white"
                                />
                              </div>
                            </div>

                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Stock Quantity *</label>
                              <input
                                type="number"
                                value={newVariant.stock || ''}
                                onChange={(e) => setNewVariant(prev => ({ ...prev, stock: parseInt(e.target.value) || 0 }))}
                                placeholder="0"
                                min="0"
                                className="w-full h-11 px-3.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-sm bg-white"
                              />
                            </div>

                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Low Stock Alert</label>
                              <input
                                type="number"
                                value={newVariant.lowStockThreshold ?? ''}
                                onChange={(e) => setNewVariant(prev => ({ ...prev, lowStockThreshold: e.target.value === '' ? undefined : parseInt(e.target.value) }))}
                                placeholder="Default"
                                min="5"
                                className="w-full h-11 px-3.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 text-sm bg-white"
                              />
                            </div>

                            <div className="space-y-2">
                              <label className="block text-sm font-semibold text-slate-700">Variant Image</label>
                              <div className="flex items-center gap-3">
                                <div className="relative w-12 h-12 bg-slate-100 rounded-lg border border-slate-300 overflow-hidden flex-shrink-0">
                                  {newVariant.images && newVariant.images.length > 0 ? (
                                    <img
                                      src={newVariant.images[0]}
                                      alt="Variant"
                                      className="w-full h-full object-cover"
                                    />
                                  ) : (
                                    <div className="flex items-center justify-center h-full text-slate-400">
                                      <Upload className="w-5 h-5" />
                                    </div>
                                  )}
                                </div>
                                <div className="flex-1">
                                  <input
                                    type="file"
                                    id="variant-image-upload"
                                    accept="image/*"
                                    onChange={handleVariantImageUpload}
                                    className="hidden"
                                  />
                                  <label
                                    htmlFor="variant-image-upload"
                                    className="inline-block px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                                  >
                                    {newVariant.images && newVariant.images.length > 0 ? 'Change Image' : 'Choose Image'}
                                  </label>
                                  {newVariant.images && newVariant.images.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => setNewVariant(prev => ({ ...prev, images: [] }))}
                                      className="ml-2 text-xs text-red-600 hover:text-red-800"
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Action Button */}
                          <div className="flex justify-end gap-2 pt-4 border-t border-slate-200">
                            {editVariantId && (
                              <Button
                                type="button"
                                onClick={cancelEditVariant}
                                className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-6 py-2.5 font-medium"
                              >
                                Cancel
                              </Button>
                            )}
                            <Button
                              type="button"
                              onClick={addVariant}
                              disabled={!newVariant.color || !newVariant.price}
                              className="bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-400 disabled:cursor-not-allowed px-6 py-2.5 font-medium"
                            >
                              <Package className="h-4 w-4 mr-2" />
                              {editVariantId ? 'Update Variant' : 'Add Variant'}
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Existing Variants */}
                      {formData.variants.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="font-semibold text-slate-900">Current Variants ({formData.variants.length})</h4>
                            <div className="text-xs text-slate-600">
                              Total Stock: <span className="font-semibold text-slate-900">{formData.variants.reduce((sum, v) => sum + v.stock, 0)}</span>
                            </div>
                          </div>

                          {/* Variants Table */}
                          <div className="overflow-x-auto border border-slate-300 rounded-lg">
                            <Table className="table-fixed w-full min-w-[720px] [&_th]:px-3 [&_th]:h-11 [&_td]:px-3 [&_td]:py-2">
                              <TableHeader className="!bg-brand-500/[0.06] !border-0 [&_tr]:border-b [&_tr]:border-brand-100/50 [&_th]:!text-brand-500/60 [&_th]:font-bold [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:h-11">
                                <TableRow>
                                  <TableHead className="w-16">Image</TableHead>
                                  <TableHead>Name</TableHead>
                                  <TableHead className="w-44">Color</TableHead>
                                  <TableHead className="w-36">SKU</TableHead>
                                  <TableHead className="w-32">Price</TableHead>
                                  <TableHead className="w-28">Stock</TableHead>
                                  <TableHead className="text-center w-20">Action</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {formData.variants.map((variant, idx) => (
                                  <TableRow key={variant.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50 hover:bg-slate-100'}>
                                    <TableCell>
                                      <button
                                        type="button"
                                        onClick={() => setEditingVariantId(variant.id || null)}
                                        className="w-10 h-10 bg-slate-100 rounded border border-slate-200 overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all relative group"
                                        title="Manage images"
                                      >
                                        {variant.images && variant.images.length > 0 ? (
                                          <img src={variant.images[0]} alt={variant.sku} className="w-full h-full object-cover" />
                                        ) : (
                                          <div className="flex items-center justify-center h-full text-slate-300">
                                            <Package className="w-4 h-4" />
                                          </div>
                                        )}

                                        {/* Overlay indicator */}
                                        <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                          <ImageIcon className="w-4 h-4 text-white drop-shadow-sm" />
                                        </div>
                                      </button>
                                    </TableCell>
                                    <TableCell>
                                      <input
                                        type="text"
                                        value={variant.variantName || ''}
                                        onChange={(e) => updateVariant(variant.id, 'variantName', e.target.value)}
                                        placeholder="—"
                                        className="w-full min-w-[100px] px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/40 bg-white"
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="color"
                                          value={variant.colorHex || '#CCCCCC'}
                                          onChange={(e) => updateVariant(variant.id, 'colorHex', e.target.value)}
                                          className="w-6 h-6 rounded border border-slate-300 cursor-pointer"
                                          title="Click to change color"
                                        />
                                        <div className="flex flex-col">
                                          <input
                                            type="text"
                                            value={variant.color}
                                            onChange={(e) => {
                                              const name = e.target.value
                                              const hex = getColorHex(name)
                                              updateVariant(variant.id, 'color', name)
                                              if (hex) updateVariant(variant.id, 'colorHex', hex)
                                            }}
                                            className="w-full min-w-[90px] text-slate-900 text-sm font-medium bg-transparent border-none p-0 focus:outline-none focus:ring-1 focus:ring-brand-500/40 rounded px-1"
                                            placeholder="Color name"
                                          />
                                          <span className="text-slate-500 text-xs">{variant.colorHex || '#CCCCCC'}</span>
                                        </div>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <input
                                        type="text"
                                        readOnly
                                        value={variant.sku || (formData.baseSku ? `${formData.baseSku}-${variantAlphaSuffix(idx + 1)}` : '')}
                                        className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-xs font-mono bg-slate-100 text-slate-600 cursor-not-allowed"
                                        placeholder="Auto-generated on save"
                                        title="Auto-generated — not editable"
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <div className="relative">
                                        <span className="absolute left-2 top-1/2 transform -translate-y-1/2 text-slate-500 text-xs">₹</span>
                                        <input
                                          type="number"
                                          value={variant.price || ''}
                                          onChange={(e) => updateVariant(variant.id, 'price', parseFloat(e.target.value) || 0)}
                                          className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded-md text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-brand-500/40 bg-white"
                                          step="0.01"
                                          min="0"
                                        />
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <input
                                        type="number"
                                        value={variant.stock || ''}
                                        onChange={(e) => updateVariant(variant.id, 'stock', parseInt(e.target.value) || 0)}
                                        className={`w-20 px-2 py-1.5 border rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-brand-500/40 bg-white ${variant.stock > 20 ? 'border-green-300 text-green-800' :
                                          variant.stock > 5 ? 'border-yellow-300 text-yellow-800' :
                                            'border-red-300 text-red-800'
                                          }`}
                                        min="0"
                                      />
                                    </TableCell>
                                    <TableCell className="text-center">
                                      <div className="inline-flex items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => handleEditVariantRow(variant)}
                                          className="text-slate-600 hover:text-brand-600 p-1 inline-block"
                                          title="Edit variant"
                                        >
                                          <Pencil className="h-4 w-4" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => removeVariant(variant.id)}
                                          className="text-slate-600 hover:text-red-600 p-1 inline-block"
                                          title="Remove variant"
                                        >
                                          <X className="h-4 w-4" />
                                        </button>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>

                          {/* Variant Summary */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                            <div className="bg-slate-50 border border-slate-300 rounded-lg p-4">
                              <p className="text-xs text-slate-600 mb-1">Total Variants</p>
                              <p className="text-2xl font-bold text-slate-900">{formData.variants.length}</p>
                            </div>
                            <div className="bg-slate-50 border border-slate-300 rounded-lg p-4">
                              <p className="text-xs text-slate-600 mb-1">Total Stock</p>
                              <p className="text-2xl font-bold text-slate-900">{formData.variants.reduce((sum, v) => sum + v.stock, 0)}</p>
                            </div>
                            <div className="bg-slate-50 border border-slate-300 rounded-lg p-4">
                              <p className="text-xs text-slate-600 mb-1">Price Range</p>
                              <p className="text-2xl font-bold text-slate-900">
                                ₹{Math.min(...formData.variants.map(v => v.price)).toFixed(2)} - ₹{Math.max(...formData.variants.map(v => v.price)).toFixed(2)}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {formData.variants.length === 0 && (
                        <div className="text-center py-8 bg-slate-50 rounded-lg border border-slate-300">
                          <p className="text-slate-600 mb-2">No variants added yet</p>
                          <p className="text-sm text-slate-500">Add your first variant above to get started</p>
                        </div>
                      )}
                    </>
                  )}

                  {/* Base / Single Unit Pricing Section */}
                  <div className="border-2 border-slate-300 rounded-lg p-6 bg-slate-50">
                    <h4 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                      <Package className="h-5 w-5 text-slate-700" />
                      {formData.hasVariants ? 'Base Unit Pricing & Stock' : 'Single Unit Pricing & Stock'}
                    </h4>
                    <p className="text-sm text-slate-600 mb-6">
                      {formData.hasVariants
                        ? 'Set the price and stock for the base/default unit of this product (not covered by variants).'
                        : 'Set the price and stock for this product.'}
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Base Price *
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-2 text-slate-500">₹</span>
                          <input
                            type="number"
                            name="basePrice"
                            value={formData.basePrice || ''}
                            onChange={handleInputChange}
                            required
                            min="0"
                            step="0.01"
                            className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                            placeholder="0.00"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          {formData.hasVariants ? 'Base Unit Stock *' : 'Stock Quantity *'}
                        </label>
                        <input
                          type="number"
                          name="totalStock"
                          value={formData.totalStock || ''}
                          onChange={handleInputChange}
                          required
                          readOnly={isEdit}
                          className={`w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent ${isEdit ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''}`}
                          placeholder="0"
                        />
                        {isEdit && (
                          <p className="text-[10px] text-amber-600 mt-1">Manage stock via Inventory</p>
                        )}
                      </div>
                    </div>

                    {formData.hasVariants && (
                      <div className="mt-6 p-4 bg-brand-50 border border-brand-200 rounded-lg shadow-sm">
                        <div className="flex justify-between items-center">
                          <div className="space-y-1">
                            <span className="text-slate-800 font-semibold block">Total Aggregate Stock:</span>
                            <span className="text-xs text-slate-500">Base Unit ({formData.totalStock}) + All Variants ({formData.variants.reduce((sum, v) => sum + v.stock, 0)})</span>
                          </div>
                          <div className="text-right">
                            <span className="text-3xl font-bold text-brand-600">
                              {formData.totalStock + formData.variants.reduce((sum, v) => sum + v.stock, 0)}
                            </span>
                            <span className="text-sm font-medium text-slate-600 ml-1">Units</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {!formData.hasVariants && formData.basePrice > 0 && (
                      <div className="mt-4 p-4 bg-white border border-slate-300 rounded-lg">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-700">Selling Price:</span>
                          <span className="text-2xl font-bold text-slate-900">₹{formData.basePrice.toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Pricing Tab */}
            {activeTab === 'pricing' && (
              <Card>
                <CardHeader>
                  <CardTitle>Pricing Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* GST Selection */}
                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <h4 className="font-medium text-slate-900 mb-3">Tax Configuration</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Dropdown
                          label="GST Rate"
                          value={(() => {
                            if (gstOthers) return 'others'
                            if (formData.gstPercentage == null) return ''
                            const inList = gstRates.some(r => r.isActive && r.percentage === formData.gstPercentage)
                            return inList ? String(formData.gstPercentage) : 'others'
                          })()}
                          options={[
                            { value: '', label: 'Select GST Rate' },
                            ...gstRates.filter(r => r.isActive).map(r => ({
                              value: r.percentage.toString(),
                              label: `${r.percentage}% - ${r.description || 'GST'}`,
                            })),
                            { value: 'others', label: 'Others (custom tax)' },
                          ]}
                          onChange={(value) => {
                            if (value === 'others') {
                              setGstOthers(true)
                              setFormData(prev => {
                                const inList = gstRates.some(r => r.isActive && r.percentage === prev.gstPercentage)
                                return { ...prev, gstPercentage: inList ? undefined : prev.gstPercentage }
                              })
                            } else {
                              setGstOthers(false)
                              setFormData(prev => ({ ...prev, gstPercentage: value ? parseFloat(value as string) : undefined }))
                            }
                          }}
                          placeholder={isLoadingGst ? 'Loading rates...' : 'Select GST Rate'}
                          disabled={isLoadingGst}
                        />
                        <p className="text-xs text-slate-500 mt-1">Select the applicable tax rate for this product</p>
                        {!formData.gstPercentage && (
                          <p className="text-xs text-red-500 mt-1">Tax rate is required</p>
                        )}
                      </div>
                      {(gstOthers || (formData.gstPercentage != null && !gstRates.some(r => r.isActive && r.percentage === formData.gstPercentage))) && (
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">Custom Tax Rate</label>
                          <div className="relative">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={formData.gstPercentage ?? ''}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) => setFormData(prev => ({
                                ...prev,
                                gstPercentage: e.target.value === '' ? undefined : parseFloat(e.target.value)
                              }))}
                              placeholder="e.g., 12"
                              className="w-full px-4 py-3 pr-8 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent text-sm bg-white"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">%</span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1">Enter any other applicable tax percentage</p>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Single Price Section */}
                  <div className="border-2 border-slate-300 rounded-lg p-6">
                    <h4 className="font-semibold text-slate-900 mb-4 flex items-center">
                      <span className="w-2 h-2 bg-brand-600 rounded-full mr-2"></span>
                      Product Pricing
                    </h4>

                    {/* Pricing Configuration — 4-column breakdown (matches vendor) */}
                    {(() => {
                      const gst = formData.gstPercentage ?? 0
                      // Mirror the storefront exactly: getRegionalPrice() in lib/currency.ts resolves
                      // priceINR → adminFixedPrice → basePrice, and checkout then adds GST on top of
                      // that. Anything else shown here would not be the amount the customer is charged.
                      const buyerPrice = formData.priceINR || formData.adminFixedPrice || formData.basePrice || 0
                      const priceSource = formData.priceINR ? 'Price on .in' : formData.adminFixedPrice ? 'Admin Fixed Price' : 'Base Price'
                      const taxAmt = buyerPrice * gst / 100
                      const finalPrice = buyerPrice + taxAmt
                      const readOnlyClass = 'flex min-h-[42px] w-full items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2'
                      const rupeeMark = <span className="text-sm text-slate-400 shrink-0">₹</span>
                      return (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                          {/* 1. Base Price */}
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Base Price *</label>
                            <div className="relative">
                              <span className="absolute left-3 top-2 text-slate-500">₹</span>
                              <input
                                type="number"
                                name="basePrice"
                                value={formData.basePrice || ''}
                                onChange={handleInputChange}
                                required
                                className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                                placeholder="0"
                              />
                            </div>
                            <p className="text-xs text-slate-600 mt-1">Vendor price for single unit</p>
                          </div>
                          {/* 2. Buyer Price (read-only) — what the storefront actually displays */}
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Buyer Price</label>
                            <div className={readOnlyClass}>{rupeeMark}<span className="text-sm font-semibold text-slate-700">{buyerPrice.toFixed(2)}</span></div>
                            <p className="text-xs text-slate-500 mt-1">{buyerPrice > 0 ? `Shown on site · from ${priceSource}` : 'Set a price below'}</p>
                          </div>
                          {/* 3. Tax Amount (read-only) — GST checkout adds on top of Buyer Price */}
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Tax Amount</label>
                            <div className={readOnlyClass}>{rupeeMark}<span className="text-sm font-semibold text-slate-700">{taxAmt.toFixed(2)}</span></div>
                            <p className="text-xs text-slate-500 mt-1">{gst > 0 ? `${gst}% GST on buyer price` : 'No GST applied'}</p>
                          </div>
                          {/* 4. Final Price (read-only) — matches the checkout total per unit */}
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Final Price</label>
                            <div className={readOnlyClass}>{rupeeMark}<span className="text-sm font-bold tracking-tight text-brand-500">{finalPrice.toFixed(2)}</span></div>
                            <p className="text-xs text-slate-500 mt-1">Buyer price + tax · charged at checkout</p>
                          </div>
                        </div>
                      )
                    })()}
                  </div>

                  {/* Pricing Section */}
                  <div className="border-2 border-brand-200 rounded-lg p-6 bg-brand-50/30">
                    <h4 className="font-semibold text-slate-900 mb-1">Selling Price & Currency</h4>
                    <p className="text-xs text-slate-500 mb-4">Set the admin selling price in INR. USD price is auto-calculated from the centralized exchange rate.</p>

                    {/* Admin Override */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
                      <div>
                        <label htmlFor="edit-admin-fixed" className="block text-sm font-medium text-slate-700 mb-2">Admin Fixed Price</label>
                        <div className="relative">
                          <input
                            id="edit-admin-fixed"
                            type="number"
                            value={formData.adminFixedPrice ?? ''}
                            onChange={(e) => setFormData(prev => ({ ...prev, adminFixedPrice: e.target.value ? parseFloat(e.target.value) : null }))}
                            className="w-full px-3 py-2.5 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors duration-200"
                            placeholder="Override vendor base price"
                            step="0.01"
                            min="0"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">Overrides vendor base price</p>
                      </div>
                    </div>

                    {/* Currency Preview */}
                    <p className="text-xs font-medium text-slate-600 mb-2 border-b border-brand-200 pb-1">Currency Pricing</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="bg-slate-50 rounded-md p-3 border border-slate-200">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Price on .in</p>
                        <p className="text-lg font-bold text-slate-900">₹{formData.adminFixedPrice || formData.priceINR || '—'}</p>
                      </div>
                      <div className="bg-slate-50 rounded-md p-3 border border-slate-200">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Price on .com</p>
                        <p className="text-lg font-bold text-slate-900">{formData.priceUSD ? `$${formData.priceUSD.toFixed(2)}` : (formData.adminFixedPrice || formData.priceINR) ? `$${convertINRtoUSD(formData.adminFixedPrice || formData.priceINR || 0).toFixed(2)}` : '—'}</p>
                        <p className="text-[10px] text-green-600">Auto-calculated from exchange rate</p>
                      </div>
                    </div>

                    {/* Original Prices (MRP) */}
                    <p className="text-xs font-medium text-slate-600 mb-2 mt-4 border-b border-brand-200 pb-1">Original Prices (MRP)</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                      <div>
                        <label htmlFor="edit-original-inr" className="block text-sm font-medium text-slate-700 mb-2">Original ₹ (MRP)</label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-slate-500">₹</span>
                          <input
                            id="edit-original-inr"
                            type="number"
                            value={formData.originalPriceINR ?? ''}
                            onChange={(e) => setFormData(prev => ({ ...prev, originalPriceINR: e.target.value ? parseFloat(e.target.value) : null }))}
                            className="w-full pl-7 pr-3 py-2.5 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors duration-200"
                            placeholder="MRP for .in domain"
                            step="0.01"
                            min="0"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">Strikethrough on .in</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Original $ (MRP)</label>
                        <div className="w-full px-3 py-2.5 border border-slate-200 rounded-md bg-slate-50 text-sm text-slate-600">
                          {formData.originalPriceUSD ? `$${formData.originalPriceUSD.toFixed(2)}` : formData.originalPriceINR ? `$${convertINRtoUSD(formData.originalPriceINR).toFixed(2)}` : 'Auto-calculated'}
                        </div>
                        <p className="text-[10px] text-green-600 mt-1">Auto-calculated from exchange rate</p>
                      </div>
                      <div>
                        <label htmlFor="edit-visibility" className="block text-sm font-medium text-slate-700 mb-2">Visibility</label>
                        <Dropdown
                          id="edit-visibility"
                          value={formData.priceVisibility || 'BOTH'}
                          onChange={(v) => setFormData(prev => ({ ...prev, priceVisibility: v as 'IN_ONLY' | 'COM_ONLY' | 'BOTH' }))}
                          options={[
                            { value: 'BOTH', label: 'Both (.in + .com)' },
                            { value: 'IN_ONLY', label: '.in Only (India)' },
                            { value: 'COM_ONLY', label: '.com Only (International)' },
                          ]}
                        />
                        <p className="text-[10px] text-slate-500 mt-1">Where product appears</p>
                      </div>
                    </div>

                    <div className="mt-3 p-3 bg-brand-50 border border-brand-100 rounded-lg">
                      <p className="text-xs text-brand-700">
                        <strong>Price priority:</strong> Admin Selling Price (₹) → Base Price. USD is auto-calculated from exchange rate.
                        Customers on .in see INR price, .com see USD price. If not set, falls back to admin fixed price, then base price.
                      </p>
                    </div>
                  </div>

                  {/* Variant Pricing Section */}
                  {formData.hasVariants && formData.variants.length > 0 && (
                    <div className="border-2 border-slate-300 rounded-lg p-6">
                      <h4 className="font-semibold text-slate-900 mb-4">Variant Pricing</h4>
                      <p className="text-sm text-slate-600 mb-4">Set individual pricing for each variant. Original price and discount are optional — used to show strikethrough pricing to customers.</p>
                      <div className="space-y-3 max-h-[500px] overflow-y-auto">
                        {formData.variants.map((variant) => (
                          <div key={variant.id} className="p-4 border border-slate-200 rounded-lg bg-white">
                            <div className="flex items-center gap-2 mb-3">
                              <div
                                className="w-5 h-5 rounded-full border border-slate-300"
                                style={{ backgroundColor: variant.colorHex || '#ccc' }}
                              />
                              <span className="text-sm font-medium text-slate-900">
                                {[variant.size, variant.color].filter(Boolean).join(' - ') || '—'}
                              </span>
                              <span className="text-xs text-slate-500 font-mono">({variant.sku})</span>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Base Price (₹) *
                                </label>
                                <div className="relative">
                                  <span className="absolute left-2 top-1/2 transform -translate-y-1/2 text-slate-500 text-xs">₹</span>
                                  <input
                                    type="number"
                                    value={variant.price || ''}
                                    onChange={(e) => updateVariant(variant.id, 'price', parseFloat(e.target.value) || 0)}
                                    className="w-full pl-6 pr-2 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                                    step="0.01"
                                    min="0"
                                  />
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">Admin Fixed</label>
                                <input
                                  type="number"
                                  value={variant.adminFixedPrice ?? ''}
                                  onChange={(e) => updateVariant(variant.id, 'adminFixedPrice', e.target.value ? parseFloat(e.target.value) : null)}
                                  className="w-full px-2 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                                  placeholder="Override"
                                  step="0.01"
                                  min="0"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">Visibility</label>
                                <Dropdown
                                  value={variant.priceVisibility || 'BOTH'}
                                  onChange={(v) => updateVariant(variant.id, 'priceVisibility', v as string)}
                                  options={[
                                    { value: 'BOTH', label: 'Both' },
                                    { value: 'IN_ONLY', label: '.in' },
                                    { value: 'COM_ONLY', label: '.com' },
                                  ]}
                                />
                              </div>
                            </div>

                            {/* Original Price + Discount */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">Original ₹ (MRP)</label>
                                <input
                                  type="number"
                                  value={variant.originalPrice ?? ''}
                                  onChange={(e) => updateVariant(variant.id, 'originalPrice', e.target.value ? parseFloat(e.target.value) : null)}
                                  className="w-full px-2 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                                  placeholder="MRP"
                                  step="0.01"
                                  min="0"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">Original $ (MRP)</label>
                                <div className="w-full px-2 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm text-slate-600">
                                  {variant.originalPriceUSD ? `$${variant.originalPriceUSD.toFixed(2)}` : variant.originalPrice ? `$${convertINRtoUSD(variant.originalPrice).toFixed(2)}` : 'Auto'}
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">Discount %</label>
                                <div className="w-full px-2 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm text-slate-600">
                                  {variant.originalPrice && (variant.adminFixedPrice || variant.price)
                                    ? `${Math.round(((variant.originalPrice - (variant.adminFixedPrice || variant.price)) / variant.originalPrice) * 100)}% off`
                                    : '—'}
                                </div>
                              </div>
                            </div>

                            {/* Variant Currency Preview */}
                            {(() => {
                              const vGst = formData.gstPercentage ?? 0
                              // Mirror the storefront chain (getRegionalPrice) and checkout's per-item
                              // GST, which taxes the variant's own price using the product-level rate.
                              const inr = variant.priceINR || variant.adminFixedPrice || variant.price || 0
                              const usd = variant.priceUSD || (inr ? convertINRtoUSD(inr) : 0)
                              const inrTax = inr * vGst / 100
                              const usdTax = usd * vGst / 100
                              return (
                                <div className="mt-3 p-2 bg-brand-50 rounded-lg border border-brand-100">
                                  <p className="text-[10px] font-medium text-brand-600 mb-1.5">Currency Pricing</p>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="bg-white rounded p-2 border border-brand-100">
                                      <p className="text-[10px] text-slate-500">Price (.in)</p>
                                      <p className="text-sm font-bold">{inr ? `₹${inr}` : '—'}</p>
                                      {variant.originalPrice ? (
                                        <p className="text-[10px] text-slate-400 line-through">₹{variant.originalPrice}</p>
                                      ) : null}
                                      {vGst > 0 && inr > 0 ? (
                                        <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                                          <p className="text-[10px] text-slate-500">+ {vGst}% GST ₹{inrTax.toFixed(2)}</p>
                                          <p className="text-[10px] text-slate-500 mt-1">Final</p>
                                          <p className="text-lg font-bold tracking-tight text-brand-500 leading-tight">₹{(inr + inrTax).toFixed(2)}</p>
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className="bg-white rounded p-2 border border-brand-100">
                                      <p className="text-[10px] text-slate-500">Price (.com)</p>
                                      <p className="text-sm font-bold">{usd ? `$${usd.toFixed(2)}` : '—'}</p>
                                      {variant.originalPrice ? (
                                        <p className="text-[10px] text-slate-400 line-through">${variant.originalPriceUSD ? variant.originalPriceUSD.toFixed(2) : convertINRtoUSD(variant.originalPrice).toFixed(2)}</p>
                                      ) : null}
                                      <p className="text-[8px] text-green-600">Auto from exchange rate</p>
                                      {vGst > 0 && usd > 0 ? (
                                        <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                                          <p className="text-[10px] text-slate-500">+ {vGst}% GST ${usdTax.toFixed(2)}</p>
                                          <p className="text-[10px] text-slate-500 mt-1">Final</p>
                                          <p className="text-lg font-bold tracking-tight text-brand-500 leading-tight">${(usd + usdTax).toFixed(2)}</p>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              )
                            })()}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Inventory Tab */}
            {activeTab === 'inventory' && (
              <Card>
                <CardHeader>
                  <CardTitle>Stock Quantity Management</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      name="trackInventory"
                      checked={formData.trackInventory}
                      onChange={handleInputChange}
                      className="rounded border-slate-300 text-slate-700 focus:ring-brand-500/40"
                    />
                    <label className="text-sm font-medium text-slate-700">
                      Track inventory for this product
                    </label>
                  </div>

                  {formData.trackInventory && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            {formData.hasVariants ? 'Total Aggregate Stock (Autofilled)' : 'Total Stock Quantity'} {!isEdit && '*'}
                          </label>
                          <input
                            type="number"
                            name="totalStock"
                            value={(formData.hasVariants
                              ? formData.totalStock + formData.variants.reduce((sum, v) => sum + v.stock, 0)
                              : formData.totalStock
                            ) || ''}
                            onChange={handleInputChange}
                            required={!isEdit}
                            readOnly={isEdit || formData.hasVariants}
                            min="0"
                            className={`w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent ${isEdit || formData.hasVariants ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''
                              }`}
                          />
                          {formData.hasVariants && !isEdit && (
                            <p className="text-xs text-blue-600 mt-1">
                              Calculated as: Base ({formData.totalStock}) + Variants ({formData.variants.reduce((sum, v) => sum + v.stock, 0)})
                            </p>
                          )}
                          {isEdit ? (
                            <p className="text-xs text-amber-600 mt-1">
                              🔒 Stock cannot be changed here. Use <strong>Inventory → Update Stock</strong>.
                            </p>
                          ) : !formData.hasVariants && (
                            <p className="text-xs text-slate-500 mt-1">
                              Opening stock for this product.
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            Low Stock Threshold
                          </label>
                          <input
                            type="number"
                            name="lowStockThreshold"
                            value={formData.lowStockThreshold || ''}
                            onChange={handleInputChange}
                            min={5}
                            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                          />
                        </div>
                      </div>

                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Shipping Tab */}
            {activeTab === 'shipping' && (
              <Card>
                <CardHeader>
                  <CardTitle>Dispatch Timeline Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Processing Days *
                      </label>
                      <input
                        type="number"
                        name="dispatchTimeline.processingDays"
                        value={formData.dispatchTimeline.processingDays || ''}
                        onChange={handleInputChange}
                        required
                        min="0"
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                      />
                      <p className="text-xs text-slate-500 mt-1">Days to prepare order</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Shipping Days *
                      </label>
                      <input
                        type="number"
                        name="dispatchTimeline.shippingDays"
                        value={formData.dispatchTimeline.shippingDays || ''}
                        onChange={handleInputChange}
                        required
                        min="0"
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                      />
                      <p className="text-xs text-slate-500 mt-1">Days for delivery</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Total Days
                      </label>
                      <input
                        type="number"
                        value={formData.dispatchTimeline.totalDays || ''}
                        disabled
                        className="w-full px-3 py-2 border border-slate-300 rounded-md bg-slate-100 text-slate-600"
                      />
                      <p className="text-xs text-slate-500 mt-1">Auto-calculated</p>
                    </div>
                  </div>

                  <div className="bg-brand-50 border border-brand-200 rounded-lg p-4">
                    <h4 className="font-medium text-brand-700 mb-2">Delivery Timeline Summary</h4>
                    <p className="text-sm text-brand-700">
                      Orders will be processed in <strong>{formData.dispatchTimeline.processingDays} day(s)</strong> and
                      delivered within <strong>{formData.dispatchTimeline.totalDays} day(s)</strong> from order confirmation.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Logistics Tab */}
            {activeTab === 'logistics' && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Shipping Weight Configuration</CardTitle>
                    <p className="text-sm text-slate-500 mt-1">Used for shipping cost calculation. Different from the display weight in Basic Info.</p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Shipping Weight *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.logisticsConfig?.unitWeight || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: { ...prev.logisticsConfig!, unitWeight: parseFloat(e.target.value) || 0 }
                          }))}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                          placeholder="e.g. 0.5"
                        />
                        <p className="text-xs text-slate-500 mt-1">Weight per single unit</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Unit of Measurement *</label>
                        <Dropdown
                          value={formData.logisticsConfig?.weightUom || 'KG'}
                          onChange={(v) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: { ...prev.logisticsConfig!, weightUom: v as string }
                          }))}
                          options={[
                            { value: 'KG', label: 'Kilogram (KG)' },
                            { value: 'GRAM', label: 'Gram (g)' },
                            { value: 'TON', label: 'Ton' },
                          ]}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Max Shippable Weight</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.logisticsConfig?.maxWeight || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: { ...prev.logisticsConfig!, maxWeight: parseFloat(e.target.value) || 0 }
                          }))}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                          placeholder="e.g. 5000"
                        />
                        <p className="text-xs text-slate-500 mt-1">Max weight per order (in {formData.logisticsConfig?.weightUom || 'KG'})</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Shipping Dimensions</CardTitle>
                    <p className="text-sm text-slate-500 mt-1">Exact dimensions for shipping cost (CBM/volumetric). Different from the display dimensions in Basic Info.</p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Length</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.logisticsConfig?.dimensions?.length || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: {
                              ...prev.logisticsConfig!,
                              dimensions: {
                                ...(prev.logisticsConfig?.dimensions || { length: 0, width: 0, height: 0, unit: 'CM' }),
                                length: parseFloat(e.target.value) || 0
                              }
                            }
                          }))}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Width</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.logisticsConfig?.dimensions?.width || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: {
                              ...prev.logisticsConfig!,
                              dimensions: {
                                ...(prev.logisticsConfig?.dimensions || { length: 0, width: 0, height: 0, unit: 'CM' }),
                                width: parseFloat(e.target.value) || 0
                              }
                            }
                          }))}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Height</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.logisticsConfig?.dimensions?.height || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: {
                              ...prev.logisticsConfig!,
                              dimensions: {
                                ...(prev.logisticsConfig?.dimensions || { length: 0, width: 0, height: 0, unit: 'CM' }),
                                height: parseFloat(e.target.value) || 0
                              }
                            }
                          }))}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">Unit</label>
                        <Dropdown
                          value={formData.logisticsConfig?.dimensions?.unit || 'CM'}
                          onChange={(v) => setFormData(prev => ({
                            ...prev,
                            logisticsConfig: {
                              ...prev.logisticsConfig!,
                              dimensions: {
                                ...(prev.logisticsConfig?.dimensions || { length: 0, width: 0, height: 0, unit: 'CM' }),
                                unit: v as string
                              }
                            }
                          }))}
                          options={[
                            { value: 'CM', label: 'CM' },
                            { value: 'IN', label: 'Inches' },
                          ]}
                        />
                      </div>
                    </div>

                    {/* Auto-calculated CBM (volumetric shipping volume in cubic metres).
                        Formula: (L × W × H) ÷ 1000 ÷ 1000 for centimetres — i.e. convert
                        each edge to metres and multiply. Inches convert via ×2.54³. */}
                    {(() => {
                      const d = formData.logisticsConfig?.dimensions;
                      const unit = (d?.unit || 'CM').toUpperCase();
                      const toMetres = (v?: number) => (unit === 'IN' ? (v || 0) * 0.0254 : (v || 0) / 100);
                      const cbm = toMetres(d?.length) * toMetres(d?.width) * toMetres(d?.height);
                      return (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                          <div>
                            <label className="block text-sm font-medium text-slate-700">CBM (Cubic Meter)</label>
                            <p className="mt-0.5 text-xs text-slate-400">
                              Auto-calculated · L × W × H {unit === 'IN' ? '× 2.54³ ÷ 1,000,000' : '÷ 1000 ÷ 1000'}
                            </p>
                          </div>
                          <div className="text-xl font-bold tabular-nums text-slate-900">
                            {cbm.toFixed(4)} <span className="text-xs font-medium text-slate-500">m³</span>
                          </div>
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Transport Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">Available Transport Types</label>
                      {/* Labels + courier list follow the product's visibility: domestic
                          (Air / Surface-Road, Indian couriers) for .in, international
                          (Air / Sea Freight, global couriers) for .com. */}
                      <div className="flex gap-4">
                        {['AIR', 'SHIP'].map((type) => (
                          <label key={type} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={formData.logisticsConfig?.transportTypes?.includes(type) || false}
                              onChange={(e) => {
                                setFormData(prev => {
                                  const types = prev.logisticsConfig?.transportTypes || [];
                                  const updated = e.target.checked
                                    ? [...types, type]
                                    : types.filter((t: string) => t !== type);
                                  return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, transportTypes: updated.length > 0 ? updated : [type] } };
                                });
                              }}
                              className="w-4 h-4 text-slate-700 border-slate-300 rounded focus:ring-brand-500/40"
                            />
                            <span className="text-sm font-medium text-slate-700">{transportModeLabel(type as 'AIR' | 'SHIP', formData.priceVisibility)}</span>
                          </label>
                        ))}
                      </div>

                      {/* Courier partner picker — the admin-managed couriers this product
                          ships with. Eligible list is filtered by the product's visibility
                          (region) and the selected transport modes; the admin ticks which
                          apply. Stored in logisticsConfig.courierIds. */}
                      {(() => {
                        const vis = formData.priceVisibility || 'BOTH';
                        const regions = vis === 'IN_ONLY' ? ['IN'] : vis === 'COM_ONLY' ? ['US'] : ['IN', 'US'];
                        const modes = (formData.logisticsConfig?.transportTypes || []) as ('AIR' | 'SHIP')[];
                        const eligible = couriers.filter(
                          (c) => regions.includes(c.region) && c.modes.some((m) => modes.includes(m as 'AIR' | 'SHIP'))
                        );
                        const selected = formData.logisticsConfig?.courierIds || [];
                        const toggle = (id: string) => setFormData(prev => {
                          const cur = prev.logisticsConfig?.courierIds || [];
                          const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
                          return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, courierIds: next } };
                        });
                        return (
                          <div className="mt-3 rounded-md bg-slate-50 border border-slate-200 p-3">
                            <p className="text-xs font-semibold text-slate-600 mb-2">
                              Courier partners for this product
                              <span className="text-slate-400 font-medium"> · tick the ones buyers can choose ({selected.length} selected)</span>
                            </p>
                            {couriers.length === 0 ? (
                              <p className="text-xs text-slate-400">No couriers configured. Add them under Catalog → Courier Partners.</p>
                            ) : eligible.length === 0 ? (
                              <p className="text-xs text-slate-400">No couriers match this product&apos;s region + transport modes. Add matching couriers, or adjust visibility/modes.</p>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {eligible.map((c) => {
                                  const on = selected.includes(c.id);
                                  return (
                                    <button
                                      key={c.id}
                                      type="button"
                                      onClick={() => toggle(c.id)}
                                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs border transition-colors ${on ? 'bg-[#e01a1b] text-white border-[#e01a1b]' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-400'}`}
                                    >
                                      <CourierBadge courier={c} className="w-4 h-4 rounded" codeClassName="text-[8px]" />
                                      {c.name}
                                      <span className="text-[9px] opacity-70">{c.region === 'IN' ? '.in' : '.com'}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Per-lane delivery + cost. Air is one shared lane; the SHIP lane
                        splits into Sea Freight (international, .com) and Surface / Road
                        (domestic India, .in). Which lanes show follow the product's
                        visibility, so a BOTH product can price Sea and Surface separately. */}
                    {(() => {
                      const vis = formData.priceVisibility || 'BOTH';
                      const showSea = vis === 'COM_ONLY' || vis === 'BOTH';
                      const showSurface = vis === 'IN_ONLY' || vis === 'BOTH';
                      const lc = formData.logisticsConfig!;
                      const setLC = (patch: Partial<typeof lc>) =>
                        setFormData(prev => ({ ...prev, logisticsConfig: { ...prev.logisticsConfig!, ...patch } }));
                      // Plain function (NOT a <Component/>) so inputs don't remount and
                      // lose focus on each keystroke.
                      const lane = (
                        title: string, sub: string,
                        days: number | undefined, cost: number | undefined,
                        onDays: (v: number) => void, onCost: (v: number) => void, costPlaceholder: string,
                        costNote?: React.ReactNode,
                      ) => (
                        <div key={title} className="rounded-lg border border-slate-200 p-3">
                          <p className="text-sm font-semibold text-slate-800">{title} <span className="text-xs font-normal text-slate-400">· {sub}</span></p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">Delivery Days</label>
                              <input type="number" min="1" value={days || ''} onChange={(e) => onDays(parseInt(e.target.value) || 0)}
                                className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">Cost per KG (₹)</label>
                              <input type="number" step="0.01" min="0" value={cost || ''} onChange={(e) => onCost(parseFloat(e.target.value) || 0)}
                                className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent" placeholder={costPlaceholder} />
                            </div>
                          </div>
                          {costNote}
                        </div>
                      );
                      const surfaceNote = liveRatesActive ? (
                        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                          <p className="text-[11px] leading-snug text-amber-800">
                            Domestic shipping is priced live by Delhivery — this per-kg rate is used only for international
                            shipping or when live rates are off. Weight &amp; dimensions are still required.
                          </p>
                        </div>
                      ) : undefined;
                      return (
                        <div className="space-y-3">
                          {lane('Air', 'express', lc.airDeliveryDays, lc.airCostPerKg, (v) => setLC({ airDeliveryDays: v }), (v) => setLC({ airCostPerKg: v }), 'e.g. 100')}
                          {showSea && lane('Sea Freight', 'international · .com', lc.shipDeliveryDays, lc.shipCostPerKg, (v) => setLC({ shipDeliveryDays: v }), (v) => setLC({ shipCostPerKg: v }), 'e.g. 20')}
                          {showSurface && lane('Surface / Road', 'domestic India · .in', lc.surfaceDeliveryDays, lc.surfaceCostPerKg, (v) => setLC({ surfaceDeliveryDays: v }), (v) => setLC({ surfaceCostPerKg: v }), 'e.g. 40', surfaceNote)}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Weight Range Rules</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-slate-600">Define weight ranges to auto-recommend transport type. Weights are in KG (normalized).</p>
                    <p className="mt-1 text-xs text-slate-500"><strong>Air</strong> applies to all regions. <strong>Sea</strong> applies to international (.com) orders only, and <strong>Surface / Road</strong> to domestic India (.in) only — so each market can have its own weight bands (e.g. Surface 5–15 kg for India, Sea 50–100 kg internationally). Sea &amp; Surface both ship via the “Ship” lane under the hood.</p>
                    <div className="space-y-3">
                      {(formData.logisticsConfig?.weightRanges || []).map((range: { minWeight: number; maxWeight: number; recommendedTransport: string }, idx: number) => (
                        <div key={idx} className="flex items-center gap-3">
                          <div className="flex-1">
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              value={range.minWeight || ''}
                              onChange={(e) => {
                                setFormData(prev => {
                                  const ranges = [...(prev.logisticsConfig?.weightRanges || [])];
                                  ranges[idx] = { ...ranges[idx], minWeight: parseFloat(e.target.value) || 0 };
                                  return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, weightRanges: ranges } };
                                });
                              }}
                              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                              placeholder="Min KG"
                            />
                          </div>
                          <span className="text-slate-400 text-sm">to</span>
                          <div className="flex-1">
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              value={range.maxWeight || ''}
                              onChange={(e) => {
                                setFormData(prev => {
                                  const ranges = [...(prev.logisticsConfig?.weightRanges || [])];
                                  ranges[idx] = { ...ranges[idx], maxWeight: parseFloat(e.target.value) || 0 };
                                  return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, weightRanges: ranges } };
                                });
                              }}
                              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                              placeholder="Max KG"
                            />
                          </div>
                          <div className="min-w-[120px]">
                            <Dropdown
                              value={range.recommendedTransport}
                              onChange={(v) => {
                                setFormData(prev => {
                                  const ranges = [...(prev.logisticsConfig?.weightRanges || [])];
                                  ranges[idx] = { ...ranges[idx], recommendedTransport: v as string };
                                  return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, weightRanges: ranges } };
                                });
                              }}
                              options={[
                                { value: 'AIR', label: 'Air — all regions' },
                                { value: 'SEA', label: 'Sea — International (.com)' },
                                { value: 'SURFACE', label: 'Surface / Road — India (.in)' },
                                // Keep legacy 'SHIP' visible for ranges saved before the
                                // Sea/Surface split (applies to both markets).
                                ...(range.recommendedTransport === 'SHIP'
                                  ? [{ value: 'SHIP', label: 'Ship (legacy — both)' }]
                                  : []),
                              ]}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setFormData(prev => {
                                const ranges = (prev.logisticsConfig?.weightRanges || []).filter((_: unknown, i: number) => i !== idx);
                                return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, weightRanges: ranges } };
                              });
                            }}
                            className="text-red-500 hover:text-red-700 text-sm font-medium px-2"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setFormData(prev => {
                          const ranges = [...(prev.logisticsConfig?.weightRanges || []), { minWeight: 0, maxWeight: 100, recommendedTransport: 'SHIP' }];
                          return { ...prev, logisticsConfig: { ...prev.logisticsConfig!, weightRanges: ranges } };
                        });
                      }}
                      className="text-sm text-slate-700 hover:text-slate-900 font-medium border border-slate-300 rounded-md px-4 py-2 hover:bg-slate-50 transition-colors"
                    >
                      + Add Weight Range
                    </button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Customer-Facing Logistics Notes</CardTitle>
                    <p className="text-sm text-slate-500 mt-1">This note will be visible to customers on the product page.</p>
                  </CardHeader>
                  <CardContent>
                    <textarea
                      value={formData.logisticsConfig?.notes || ''}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        logisticsConfig: { ...prev.logisticsConfig!, notes: e.target.value }
                      }))}
                      rows={3}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                      placeholder="e.g., Bulk orders above 50 KG ship via sea freight for best rates. Air freight available for urgent orders."
                    />
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Tab navigation footer */}
            <div className="flex items-center justify-between border-t border-slate-200 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={goToPrevTab}
                disabled={activeTabIndex <= 0}
              >
                <ChevronLeft className="h-4 w-4 mr-2" />
                Previous
              </Button>
              {activeTabIndex < productTabs.length - 1 ? (
                <Button
                  type="button"
                  onClick={goToNextTab}
                  className="bg-brand-500 text-white hover:bg-brand-600 transition-colors"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="bg-brand-500 text-white hover:bg-brand-600 transition-colors shadow-sm shadow-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isLoading ? 'Saving...' : (isEdit ? 'Update Product' : 'Create Product')}
                </Button>
              )}
            </div>
          </div>

          {/* Sidebar — sticks below the pinned header while the form scrolls */}
          <div className="space-y-6 lg:sticky lg:top-[150px] lg:self-start">
            <Card>
              <CardHeader>
                <CardTitle>Status & Availability</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Dropdown
                    label="Product Status"
                    value={formData.status}
                    options={[
                      { value: 'ACTIVE', label: 'Active' },
                      { value: 'INACTIVE', label: 'Inactive' },
                      { value: 'OUT_OF_STOCK', label: 'Out of Stock' }
                    ]}
                    onChange={(value) => setFormData(prev => ({ ...prev, status: value as 'ACTIVE' | 'INACTIVE' | 'OUT_OF_STOCK' }))}
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    name="inStock"
                    checked={formData.inStock}
                    onChange={handleInputChange}
                    className="rounded border-slate-300 text-slate-700 focus:ring-brand-500/40"
                  />
                  <label className="ml-2 text-sm text-slate-700">
                    In Stock
                  </label>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Product Images</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* Cover Image — upload box when empty, otherwise a live preview (matches the vendor form) */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-slate-700">Cover Image <span className="text-red-500">*</span></h4>
                      <span className="text-xs text-slate-500">1 image only</span>
                    </div>
                    {formData.images.filter(img => img.imageType === 'cover').length === 0 ? (
                      <div
                        role="button"
                        tabIndex={0}
                        className="border-2 border-dashed border-blue-300 rounded-lg p-4 text-center hover:border-blue-400 transition-colors cursor-pointer bg-blue-50 outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 focus-visible:border-blue-500"
                        onClick={() => document.getElementById('cover-image-upload')?.click()}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                      >
                        <Upload className="mx-auto h-8 w-8 text-blue-400" />
                        <p className="mt-1 text-sm text-blue-600">Upload Cover Image</p>
                        <p className="text-xs text-blue-500">PNG, JPG, GIF up to 10MB</p>
                        <input
                          id="cover-image-upload"
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleImageUpload(e, 'cover')}
                        />
                      </div>
                    ) : (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                        <p className="text-sm text-green-800">✓ Cover image uploaded</p>
                        <p className="text-xs text-green-600">Upload limit: 1/1</p>
                      </div>
                    )}

                    {/* Cover Image Preview */}
                    {formData.images.filter(img => img.imageType === 'cover').map((image) => (
                      <div key={image.id} className="relative group">
                        <img
                          src={image.url}
                          alt={image.alt}
                          className="w-full h-32 object-cover rounded border-2 border-slate-800"
                        />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded flex items-center justify-center">
                          <button
                            type="button"
                            onClick={() => removeImage(image.id)}
                            className="text-white hover:text-red-300 bg-red-600 p-2 rounded-full"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="absolute top-2 left-2 bg-brand-600 text-white text-xs px-2 py-1 rounded">Cover Image</div>
                      </div>
                    ))}
                  </div>

                  {/* Gallery Images */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-slate-700">Gallery Images (Max 3 images)</h4>
                      <span className="text-xs text-slate-500">{formData.images.filter(img => img.imageType === 'gallery').length}/3 images</span>
                    </div>
                    {formData.images.filter(img => img.imageType === 'gallery').length < 3 ? (
                      <div
                        role="button"
                        tabIndex={0}
                        className="border-2 border-dashed border-green-300 rounded-lg p-4 text-center hover:border-green-400 transition-colors cursor-pointer bg-green-50 outline-none focus-visible:ring-2 focus-visible:ring-green-400/40 focus-visible:border-green-500"
                        onClick={() => document.getElementById('gallery-image-upload')?.click()}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                      >
                        <Upload className="mx-auto h-8 w-8 text-green-400" />
                        <p className="mt-1 text-sm text-green-600">Upload Gallery Images</p>
                        <p className="text-xs text-green-500">
                          {3 - formData.images.filter(img => img.imageType === 'gallery').length} slot{3 - formData.images.filter(img => img.imageType === 'gallery').length > 1 ? 's' : ''} remaining • Multiple selection allowed
                        </p>
                        <input
                          id="gallery-image-upload"
                          type="file"
                          multiple
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleImageUpload(e, 'gallery')}
                        />
                      </div>
                    ) : (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                        <p className="text-sm text-green-800">✓ Gallery images full</p>
                        <p className="text-xs text-green-600">Upload limit: 3/3 reached</p>
                      </div>
                    )}

                    {/* Gallery Images Preview + empty slots */}
                    {formData.images.filter(img => img.imageType === 'gallery').length > 0 && (
                      <div className="grid grid-cols-3 gap-2">
                        {formData.images.filter(img => img.imageType === 'gallery').map((image) => (
                          <div key={image.id} className="relative group">
                            <img src={image.url} alt={image.alt} className="w-full h-20 object-cover rounded border" />
                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded flex items-center justify-center gap-1">
                              {formData.images.filter(img => img.imageType === 'cover').length === 0 && (
                                <button
                                  type="button"
                                  onClick={() => setImageType(image.id, 'cover')}
                                  className="text-white text-xs bg-brand-600 px-1 py-1 rounded hover:bg-brand-700"
                                >
                                  Cover
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => removeImage(image.id)}
                                className="text-white hover:text-red-300 bg-red-600 p-1 rounded"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="absolute top-1 left-1 bg-slate-600 text-white text-xs px-1 rounded">Gallery</div>
                          </div>
                        ))}
                        {Array.from({ length: 3 - formData.images.filter(img => img.imageType === 'gallery').length }).map((_, index) => (
                          <div key={`empty-${index}`} className="w-full h-20 border-2 border-dashed border-slate-200 rounded flex items-center justify-center">
                            <span className="text-[10px] text-slate-400">Empty</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Quick Stats */}
            <Card>
              <CardHeader>
                <CardTitle>Quick Stats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {formData.vendorName && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Vendor:</span>
                    <span className="font-medium">{formData.vendorName}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Total Variants:</span>
                  <span className="font-medium">{formData.variants.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Total Stock:</span>
                  <span className="font-medium">
                    {formData.hasVariants
                      ? formData.variants.reduce((sum, v) => sum + v.stock, 0)
                      : formData.totalStock
                    }
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Price Range:</span>
                  <span className="font-medium">
                    {formData.hasVariants && formData.variants.length > 0
                      ? `₹${Math.min(...formData.variants.map(v => v.price))} - ₹${Math.max(...formData.variants.map(v => v.price))}`
                      : `₹${formData.basePrice}`
                    }
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Dispatch Time:</span>
                  <span className="font-medium">{formData.dispatchTimeline.totalDays} days</span>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <Card>
              <CardHeader>
                <CardTitle>Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-brand-500 text-white hover:bg-brand-600"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isLoading ? 'Saving...' : (isEdit ? 'Update Product' : 'Create Product')}
                </Button>

                {!isEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSaveDraft}
                    disabled={isLoading}
                    className="w-full"
                  >
                    Save as Draft
                  </Button>
                )}

                <Link href="/admin/dashboard/products" className="block">
                  <Button type="button" variant="outline" className="w-full">
                    Cancel
                  </Button>
                </Link>

                {hasUnsavedChanges && (
                  <p className="text-xs text-amber-600 text-center">
                    You have unsaved changes
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </form>

      {editingVariantId && (
        <VariantImageModal
          isOpen={!!editingVariantId}
          onClose={() => setEditingVariantId(null)}
          variantData={{
            id: editingVariantId,
            size: getEditingVariant()?.size || '',
            color: getEditingVariant()?.color || '',
            images: getEditingVariant()?.images || []
          }}
          onUpdateImages={handleVariantImagesUpdate}
        />
      )}

      <CareInstructionModal
        isOpen={careModalOpen}
        selected={formData.fabricSpecifications.careInstructions}
        onAdd={handleAddCareInstructions}
        onClose={() => setCareModalOpen(false)}
      />

      {/* Manufacturer photo cropper */}
      {mfrCropState && (
        <ImageCropModal
          src={mfrCropState.src}
          fileName={mfrCropState.name}
          title="Crop Manufacturer Photo"
          cropShape="round"
          onCancel={closeMfrCropper}
          onCropped={onMfrPhotoCropped}
        />
      )}
    </div>
  )
}