const { prisma } = require('../config/database');
const {
  resolveProductImageUrls,
  resolveVariantImageUrls,
  resolveBase64InValue,
} = require('../config/cloudinary');
const { generateBaseSku, reconcileBaseSku, variantSkuFor } = require('../utils/skuGenerator');
const { usdFromINR, resolveUsdRate } = require('../utils/orderCurrency');
const { stripAdminPricing, attachVendorPayout } = require('../utils/vendorPricing');
const { getCurrentExchangeRate } = require('./exchangeRateController');
const { visibilityWhere, isVisibleInRegion, normalizeRegion } = require('../utils/regionVisibility');
const { buildActiveOffer } = require('../utils/offers');

// Normalize the packaging selection into { packagingType, packingType, unpackedType, unpackedNote }.
//  packagingType: 'PACKED' | 'UNPACKED' | null
//  packingType:   'BALE' | 'CARTON' | null — only kept when PACKED.
//  unpackedType:  'STITCHED' | 'UNSTITCHED' | 'OTHER' | null — only kept when UNPACKED.
//  unpackedNote:  free-text remark — only kept when UNPACKED.
function normalizePackaging(packagingType, packingType, unpackedType, unpackedNote) {
  const pkg = ['PACKED', 'UNPACKED'].includes(packagingType) ? packagingType : null;
  const method = pkg === 'PACKED' && ['BALE', 'CARTON'].includes(packingType) ? packingType : null;
  const uType = pkg === 'UNPACKED' && ['STITCHED', 'UNSTITCHED', 'OTHER'].includes(unpackedType) ? unpackedType : null;
  const uNote = pkg === 'UNPACKED' && typeof unpackedNote === 'string' && unpackedNote.trim() ? unpackedNote.trim() : null;
  return { packagingType: pkg, packingType: method, unpackedType: uType, unpackedNote: uNote };
}

/**
 * Load live per-product offers for a storefront request and return a decorator that
 * attaches an `activeOffer` badge to each product. Additive and fail-open: any error
 * (or simply no offers configured) yields a decorator that returns products unchanged,
 * so the catalogue never breaks because of the offers layer. THRESHOLD offers are
 * cart-level and are intentionally not attached to individual products.
 */
async function buildOfferDecorator(region) {
  try {
    const now = new Date();
    const offers = await prisma.offer.findMany({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
    });
    if (offers.length === 0) return (p) => p;
    const currency = normalizeRegion(region) === 'US' ? 'USD' : 'INR';
    const rate = currency === 'USD' ? await resolveUsdRate(prisma) : null;
    return (p) => {
      const activeOffer = buildActiveOffer(p, offers, currency, rate, now);
      return activeOffer ? { ...p, activeOffer } : p;
    };
  } catch (e) {
    console.warn('[products] offer enrichment skipped:', e.message);
    return (p) => p;
  }
}

/**
 * Validate the product's GST rate.
 *
 * A null rate used to persist silently and then be read as 0% at checkout — so the
 * customer was under-charged tax on a document titled "TAX INVOICE", AND the vendor
 * was under-paid their own GST (the same field drives both, see orderController).
 * Requiring it here removes the ambiguity at the source: an admin who genuinely sells
 * a zero-rated good must now enter 0 explicitly rather than leaving the field blank.
 *
 * @returns {string|null} An error message, or null when the value is acceptable.
 */
const validateGstPercentage = (v) => {
  if (v === null || v === undefined || v === '') {
    return 'GST rate is required. Enter 0 if this product is zero-rated.';
  }
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 'GST rate must be a number';
  if (n < 0 || n > 100) return 'GST rate must be between 0 and 100';
  return null;
};

/** Parse a money input to a number, or null when it is absent/blank/non-numeric. */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** First candidate that is actually set (0 counts as set; null/undefined do not). */
const firstSet = (...values) => {
  for (const v of values) {
    if (v != null) return v;
  }
  return null;
};

/**
 * Discount percentage off the original price.
 *
 * Discount is always a fraction OF THE ORIGINAL — "20% off ₹400" means the shopper pays
 * ₹320 and saves ₹80/₹400. Dividing by the selling price instead answers a different
 * question (the mark-up) and always overstates the saving: ₹400→₹350 is 12.5% off, but
 * ÷350 reports 14%. That figure is advertised on the storefront badge, so it has to be
 * the real one.
 *
 * Returns null when there is no genuine discount — the caller then leaves the field
 * alone rather than writing a 0 or a negative.
 */
const discountPercent = (originalPrice, sellingPrice) => {
  const orig = numOrNull(originalPrice);
  const sell = numOrNull(sellingPrice);
  if (orig == null || sell == null || orig <= 0 || sell >= orig) return null;
  return Math.round(((orig - sell) / orig) * 100);
};

/**
 * Build the regional price fields for a product or variant from admin input.
 *
 * INR is the source of truth and USD is derived from it, so an admin who fills in only
 * the INR price still gets a correct .com price. An explicitly supplied USD price wins
 * — that is the manual override — but a blank one is computed, never left null: a null
 * priceUSD forces the storefront to convert on the fly, and used to make the order
 * path bill the INR figure as USD.
 */
const deriveRegionalPrices = (src, rate) => {
  const priceINR = firstSet(numOrNull(src.priceINR), numOrNull(src.adminFixedPrice));
  const originalPriceINR = firstSet(numOrNull(src.originalPriceINR), numOrNull(src.originalPrice));
  return {
    priceINR,
    priceUSD: numOrNull(src.priceUSD) ?? usdFromINR(priceINR, rate),
    originalPriceINR,
    originalPriceUSD: numOrNull(src.originalPriceUSD) ?? usdFromINR(originalPriceINR, rate),
  };
};

const generateSlug = (name) => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
};

const generateUniqueSlug = async (name, excludeId = null) => {
  let slug = generateSlug(name);
  let suffix = 0;
  let candidate = slug;

  while (true) {
    const existing = await prisma.product.findUnique({ where: { slug: candidate } });
    if (!existing || (excludeId && existing.id === excludeId)) return candidate;
    suffix++;
    candidate = `${slug}-${suffix}`;
  }
};

// Uploads any base64 data URIs in `images` and `variants[].images` to
// Cloudinary and replaces them with secure URLs. Mutates and returns input.
const ensureImageUrls = async ({ images, variants }) => {
  const [resolvedImages, resolvedVariants] = await Promise.all([
    images ? resolveProductImageUrls(images) : Promise.resolve(images),
    Array.isArray(variants)
      ? Promise.all(
          variants.map(async (v) => ({
            ...v,
            images: await resolveVariantImageUrls(v?.images),
          })),
        )
      : Promise.resolve(variants),
  ]);
  return { images: resolvedImages, variants: resolvedVariants };
};

// Create new product
const createProduct = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;
    const {
      // Inventory Connection
      inventoryItemId,
      isFromInventory,

      // Basic Information
      name,
      description,
      category,
      subCategory,

      // Pricing Information
      basePrice,
      originalPrice,
      discount,
      gstPercentage,
      hsnCode,
      returnable,
      packagingType,
      packingType,
      unpackedType,
      unpackedNote,

      // Single Unit Pricing Configuration
      singleUnitSize,
      singleUnitColor,
      singleUnitColorHex,

      // Fabric & Specifications
      fabricType,
      material,
      fabricSpecifications,

      // Variants Management
      hasVariants,

      // Base Product Info
      baseSku,

      // Stock Management
      totalStock,
      lowStockThreshold,
      trackInventory,

      // Dispatch & Shipping
      dispatchTimeline,

      // Additional Info
      uom,
      tags,
      dimensions,
      weight,
      weightUnit,
      inStock,
      status,

      // Logistics Configuration
      logisticsConfig,

      // Who made the item (JSON: photo, title, fullName, role, experience, description)
      manufacturerInfo
    } = req.body;

    // Resolve base64 images to URLs
    let { images, variants } = req.body;
    ({ images, variants } = await ensureImageUrls({ images, variants }));

    // The manufacturer photo arrives as a base64 data URL like the product images —
    // resolve it (and any embedded base64) to a hosted Cloudinary URL on save.
    const resolvedManufacturerInfo = manufacturerInfo
      ? await resolveBase64InValue(manufacturerInfo, { folder: 'manufacturer-photos' })
      : null;

    // Validate required fields. SKU is NOT required from the client — it is
    // auto-generated server-side (immutable, globally unique) below.
    // Sub-category is NOT required: vendors don't pick one — the admin assigns
    // it when approving/publishing the product (schema field is optional).
    if (!name || !description || !category) {
      return res.status(400).json({
        success: false,
        message: 'Name, description, and category are required'
      });
    }

    if (lowStockThreshold !== undefined && parseInt(lowStockThreshold) < 5) {
      return res.status(400).json({
        success: false,
        message: 'Low stock alert must be 5 or more'
      });
    }

    if (hasVariants && (!variants || variants.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'At least one variant is required when variants are enabled'
      });
    }

    const gstError = validateGstPercentage(gstPercentage);
    if (gstError) {
      return res.status(400).json({ success: false, message: gstError });
    }

    // If connecting to inventory, validate and update inventory item
    let inventoryItem = null;
    if (isFromInventory && inventoryItemId) {
      inventoryItem = await prisma.inventory.findFirst({
        where: {
          id: inventoryItemId,
          vendorId,
          hasProductCreated: false
        }
      });

      if (!inventoryItem) {
        return res.status(400).json({
          success: false,
          message: 'Inventory item not found or already has a product created'
        });
      }
    }

    // Fetch the vendor's company name for the SKU company-code prefix.
    const vendorRecord = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { companyName: true },
    });

    // Start transaction with extended timeout for multiple DB operations
    const result = await prisma.$transaction(async (tx) => {
      // Base SKU: reuse the inventory item's master SKU when this product is
      // created from inventory (so they stay identical); otherwise auto-generate
      // a fresh immutable SKU INSIDE the transaction (atomic counter increment).
      const baseSku = (isFromInventory && inventoryItem?.sku)
        ? inventoryItem.sku
        : await generateBaseSku(tx, vendorRecord?.companyName);
      const variantCount = hasVariants && variants ? variants.length : 0;
      if (variantCount > 0) {
        // Variants are assigned alphabetical suffixes A, B, C … in order.
        variants = variants.map((v, i) => ({ ...v, sku: variantSkuFor(baseSku, i + 1) }));
      }

      // Determine the stock to use
      let productStock = 0;
      let baseStockValue = 0;

      if (hasVariants && variants && variants.length > 0) {
        // If has variants, total stock = base stock + variant stocks
        const variantStockSum = variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
        baseStockValue = parseInt(totalStock) || 0;
        productStock = baseStockValue + variantStockSum;
      } else if (isFromInventory && inventoryItem) {
        // If from inventory (and no variants), use user-entered stock or fallback to inventory stock
        productStock = parseInt(totalStock) || inventoryItem.currentStock;
        baseStockValue = productStock;
      } else {
        // Otherwise use provided total stock
        productStock = parseInt(totalStock) || 0;
        baseStockValue = productStock;
      }

      // Generate unique slug
      const slug = await generateUniqueSlug(name);

      // Create product
      const product = await tx.product.create({
        data: {
          vendorId,
          inventoryItemId: isFromInventory ? inventoryItemId : null,
          isFromInventory: isFromInventory || false,
          name,
          slug,
          description,
          category,
          subCategory,
          basePrice: parseFloat(basePrice) || 0,
          originalPrice: originalPrice ? parseFloat(originalPrice) : null,
          discount: discount ? parseFloat(discount) : null,
          gstPercentage: gstPercentage !== null && gstPercentage !== undefined && gstPercentage !== '' ? parseFloat(gstPercentage) : null,
          hsnCode: hsnCode ? String(hsnCode).trim() : null,
          // Return eligibility — defaults to true unless explicitly turned off.
          returnable: returnable === false || returnable === 'false' || returnable === 'no' ? false : true,
          // Packaging (packed/unpacked → bale/carton).
          ...normalizePackaging(packagingType, packingType, unpackedType, unpackedNote),

          // Single Unit Pricing Configuration
          singleUnitSize: singleUnitSize || null,
          singleUnitColor: singleUnitColor || null,
          singleUnitColorHex: singleUnitColorHex || null,
          fabricType,
          material,
          fabricSpecifications: fabricSpecifications || {},
          manufacturerInfo: resolvedManufacturerInfo || undefined,
          hasVariants: hasVariants || false,
          baseSku,
          variantSeq: variantCount,
          totalStock: productStock,
          lowStockThreshold: parseInt(lowStockThreshold) || 5,
          trackInventory: trackInventory !== false,
          dispatchTimeline: dispatchTimeline ? {
            processingDays: parseInt(dispatchTimeline.processingDays) || 1,
            shippingDays: parseInt(dispatchTimeline.shippingDays) || 3,
            totalDays: parseInt(dispatchTimeline.totalDays) || 4
          } : {
            processingDays: 1,
            shippingDays: 3,
            totalDays: 4
          },
          uom: uom || 'pcs',
          tags: tags || [],
          dimensions,
          weight,
          weightUnit,
          inStock: inStock !== false,
          logisticsConfig: logisticsConfig || null,
          status: 'ACTIVE', // Default status is ACTIVE
          approvalStatus: 'PENDING' // Default approval status is PENDING
        }
      });

      // Create variants if enabled
      if (hasVariants && variants && variants.length > 0) {
        const variantData = variants.map(variant => ({
          productId: product.id,
          variantName: variant.variantName || null,
          size: variant.size || '',
          color: variant.color,
          colorHex: variant.colorHex,
          sku: variant.sku,
          price: parseFloat(variant.price),
          originalPrice: variant.originalPrice ? parseFloat(variant.originalPrice) : null,
          discount: variant.discount ? parseFloat(variant.discount) : null,
          adminFixedPrice: variant.adminFixedPrice ? parseFloat(variant.adminFixedPrice) : null,
          priceINR: variant.priceINR ? parseFloat(variant.priceINR) : null,
          priceUSD: variant.priceUSD ? parseFloat(variant.priceUSD) : null,
          originalPriceINR: variant.originalPriceINR ? parseFloat(variant.originalPriceINR) : null,
          originalPriceUSD: variant.originalPriceUSD ? parseFloat(variant.originalPriceUSD) : null,
          priceVisibility: variant.priceVisibility || 'BOTH',
          stock: parseInt(variant.stock) || 0,
          lowStockThreshold: variant.lowStockThreshold != null && variant.lowStockThreshold !== '' ? parseInt(variant.lowStockThreshold) : null,
          images: variant.images || []
        }));

        await tx.productVariant.createMany({
          data: variantData
        });
      }

      // Create images if provided
      if (images && images.length > 0) {
        const imageData = images.map((image, index) => ({
          productId: product.id,
          url: image.url,
          alt: image.alt || name,
          isPrimary: image.isPrimary || false,
          imageType: image.imageType || 'gallery',
          sortOrder: index
        }));

        await tx.productImage.createMany({
          data: imageData
        });
      }

      // Update inventory item if connected
      if (isFromInventory && inventoryItemId) {
        let inventoryUpdateData = {
          hasProductCreated: true,
          productId: product.id
        };

        // Set base stock and total stock properly
        if (hasVariants && variants && variants.length > 0) {
          // For products with variants:
          // - baseStock = user-entered base stock value
          // - currentStock = base stock + variant stocks
          inventoryUpdateData.baseStock = baseStockValue;
          inventoryUpdateData.currentStock = productStock; // Already includes base + variants
        } else {
          // For products without variants, sync inventory stock with product stock
          inventoryUpdateData.baseStock = productStock;
          inventoryUpdateData.currentStock = productStock;
        }

        await tx.inventory.update({
          where: { id: inventoryItemId },
          data: inventoryUpdateData
        });
      }

      return product;
    }, { timeout: 30000 });

    // Fetch the complete product with relations
    const completeProduct = await prisma.product.findUnique({
      where: { id: result.id },
      include: {
        variants: true,
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true
          }
        }
      }
    });

    // Notify admins — new product pending approval
    const { createNotificationForRole: notifyAdminsProd } = require('./notificationController');
    notifyAdminsProd({
      role: 'ADMIN', type: 'PRODUCT_PENDING_APPROVAL',
      title: 'Product Pending Approval',
      message: `New product "${result.name}" submitted by vendor awaiting approval.`,
      data: { productId: result.id }
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: completeProduct
    });

  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get all products for a vendor
const getVendorProducts = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status,
      hasVariants,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build filter conditions
    const where = {
      vendorId,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { baseSku: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      }),
      ...(category && { category }),
      ...(status && { status }),
      ...(hasVariants !== undefined && { hasVariants: hasVariants === 'true' })
    };

    // Get total count for pagination
    const totalItems = await prisma.product.count({ where });

    // Get products with pagination
    const products = await prisma.product.findMany({
      where,
      include: {
        variants: {
          select: {
            id: true,
            variantName: true,
            size: true,
            color: true,
            price: true,
            stock: true
          }
        },
        images: {
          where: { isPrimary: true },
          select: {
            url: true,
            alt: true
          },
          take: 1
        },
        inventory: {
          select: {
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true
          }
        }
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    // This is a vendor-only endpoint, but the query uses `include` (no product-level
    // `select`), so every product ships its admin selling price + MRP + discount. Strip
    // them and attach the vendor's own payout economics instead — same rule as the
    // single-product view. One GSTIN lookup covers the batch: all products are this
    // vendor's.
    const vendorRow = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { gstNumber: true },
    });
    const vendorHasGstin = !!vendorRow?.gstNumber;
    for (const product of products) {
      stripAdminPricing(product);
      attachVendorPayout(product, vendorHasGstin);
    }

    // Calculate pagination info
    const totalPages = Math.ceil(totalItems / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    res.json({
      success: true,
      data: {
        items: products,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalItems,
          hasNextPage,
          hasPrevPage,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get single product
const getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const whereCondition = { id };

    // Only vendors should be restricted to their own products
    if (req.user.role === 'VENDOR') {
      const vendorId = req.user.vendorId || req.user.id;
      whereCondition.vendorId = vendorId;
    }

    const isVendor = req.user.role === 'VENDOR';

    const product = await prisma.product.findFirst({
      where: whereCondition,
      include: {
        variants: {
          orderBy: { createdAt: 'asc' }
        },
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true,
            category: true
          }
        },
        // Vendors need their GSTIN status to know whether GST is added to their payout.
        ...(isVendor ? { vendor: { select: { gstNumber: true } } } : {}),
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Admin and vendor share this endpoint. The admin needs the selling price and MRP;
    // the vendor must not see either (MRP + discount reconstruct the selling price), so
    // those are stripped and replaced with the vendor's own payout economics.
    if (isVendor) {
      const vendorHasGstin = !!product.vendor?.gstNumber;
      delete product.vendor; // was fetched only to read gstNumber
      stripAdminPricing(product);
      attachVendorPayout(product, vendorHasGstin);
    }

    res.json({
      success: true,
      data: product
    });

  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Update product
const updateProduct = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;
    const { id } = req.params;
    const updateData = req.body;

    const resolved = await ensureImageUrls({
      images: updateData.images,
      variants: updateData.variants,
    });
    if (updateData.images !== undefined) updateData.images = resolved.images;
    if (updateData.variants !== undefined) updateData.variants = resolved.variants;

    // Resolve the manufacturer photo (base64 → Cloudinary) if it was edited.
    if (updateData.manufacturerInfo !== undefined && updateData.manufacturerInfo !== null) {
      updateData.manufacturerInfo = await resolveBase64InValue(updateData.manufacturerInfo, { folder: 'manufacturer-photos' });
    }

    // Check if product exists and belongs to vendor
    const existingProduct = await prisma.product.findFirst({
      where: {
        id,
        vendorId
      },
      include: {
        variants: true,
        images: true
      }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Block vendor from editing approved products — only admin can modify
    if (existingProduct.approvalStatus === 'APPROVED') {
      return res.status(403).json({
        success: false,
        message: 'This product has been approved by admin and cannot be edited. Only admin can modify approved products.'
      });
    }

    // Check if base SKU is being changed and if new SKU already exists
    // SKU is immutable — never change the base SKU on update, whatever the
    // client sends.
    updateData.baseSku = existingProduct.baseSku;

    // Allocate variant SKUs without reusing past suffixes: existing variants
    // keep their SKU; brand-new variants get the next alphabetical suffix from
    // Product.variantSeq (a high-water mark that only ever increments).
    if (updateData.variants && updateData.variants.length > 0) {
      const existingSkuSet = new Set((existingProduct.variants || []).map(v => v.sku));
      let seq = existingProduct.variantSeq || (existingProduct.variants?.length || 0);
      updateData.variants = updateData.variants.map(v => {
        if (v.sku && existingSkuSet.has(v.sku)) return v; // keep existing variant SKU
        seq += 1;
        return { ...v, sku: variantSkuFor(existingProduct.baseSku, seq) };
      });
      updateData.__nextVariantSeq = seq;
    }

    if (false && updateData.variants && updateData.variants.length > 0) {
      const variantSkus = updateData.variants.map(v => v.sku);
      const duplicateSkus = variantSkus.filter((sku, index) => variantSkus.indexOf(sku) !== index);

      if (duplicateSkus.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Duplicate variant SKUs found: ${duplicateSkus.join(', ')}`
        });
      }

      // Check if any variant SKU already exists (excluding current product variants)
      const existingVariantSkus = await prisma.productVariant.findMany({
        where: {
          sku: { in: variantSkus },
          productId: { not: id }
        }
      });

      if (existingVariantSkus.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Variant SKUs already exist: ${existingVariantSkus.map(v => v.sku).join(', ')}`
        });
      }
    }

    // Only enforced when the caller actually sends the field, so a partial update
    // that never touches GST is unaffected — but an explicit blank is rejected
    // rather than silently persisting null (which reads as 0% at checkout).
    if (updateData.gstPercentage !== undefined) {
      const gstError = validateGstPercentage(updateData.gstPercentage);
      if (gstError) {
        return res.status(400).json({ success: false, message: gstError });
      }
    }

    // Start transaction for update
    const result = await prisma.$transaction(async (tx) => {
      // Calculate total stock from variants if we are updating variants
      let newTotalStock = undefined;

      if ((updateData.hasVariants === true || (existingProduct.hasVariants && updateData.hasVariants !== false)) && updateData.variants && updateData.variants.length > 0) {
        newTotalStock = updateData.variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
      } else if (updateData.totalStock !== undefined) {
        newTotalStock = parseInt(updateData.totalStock);
      }

      // Update product
      const updatedProduct = await tx.product.update({
        where: { id },
        data: {
          ...(updateData.name && { name: updateData.name }),
          ...(updateData.description && { description: updateData.description }),
          ...(updateData.category && { category: updateData.category }),
          ...(updateData.subCategory !== undefined && { subCategory: updateData.subCategory }),
          ...(updateData.basePrice !== undefined && { basePrice: parseFloat(updateData.basePrice) }),
          ...(updateData.originalPrice !== undefined && {
            originalPrice: updateData.originalPrice ? parseFloat(updateData.originalPrice) : null
          }),
          ...(updateData.discount !== undefined && {
            discount: updateData.discount ? parseFloat(updateData.discount) : null
          }),
          ...(updateData.gstPercentage !== undefined && {
            gstPercentage: parseFloat(updateData.gstPercentage)
          }),
          ...(updateData.hsnCode !== undefined && {
            hsnCode: updateData.hsnCode ? String(updateData.hsnCode).trim() : null
          }),
          ...(updateData.returnable !== undefined && {
            returnable: !(updateData.returnable === false || updateData.returnable === 'false' || updateData.returnable === 'no')
          }),
          ...(updateData.packagingType !== undefined && normalizePackaging(updateData.packagingType, updateData.packingType, updateData.unpackedType, updateData.unpackedNote)),

          // Single Unit Pricing Configuration
          ...(updateData.singleUnitSize !== undefined && { singleUnitSize: updateData.singleUnitSize }),
          ...(updateData.singleUnitColor !== undefined && { singleUnitColor: updateData.singleUnitColor }),
          ...(updateData.singleUnitColorHex !== undefined && { singleUnitColorHex: updateData.singleUnitColorHex }),
          ...(updateData.fabricType !== undefined && { fabricType: updateData.fabricType }),
          ...(updateData.material !== undefined && { material: updateData.material }),
          ...(updateData.fabricSpecifications !== undefined && {
            fabricSpecifications: updateData.fabricSpecifications
          }),
          ...(updateData.manufacturerInfo !== undefined && { manufacturerInfo: updateData.manufacturerInfo }),
          ...(updateData.hasVariants !== undefined && { hasVariants: updateData.hasVariants }),
          ...(updateData.baseSku && { baseSku: updateData.baseSku }),
          ...(updateData.__nextVariantSeq !== undefined && { variantSeq: updateData.__nextVariantSeq }),

          // Use calculated stock if available, otherwise just update if provided
          ...(newTotalStock !== undefined && { totalStock: newTotalStock }),

          ...(updateData.lowStockThreshold !== undefined && {
            lowStockThreshold: parseInt(updateData.lowStockThreshold)
          }),
          ...(updateData.trackInventory !== undefined && { trackInventory: updateData.trackInventory }),
          ...(updateData.dispatchTimeline !== undefined && {
            dispatchTimeline: updateData.dispatchTimeline ? {
              processingDays: parseInt(updateData.dispatchTimeline.processingDays) || 1,
              shippingDays: parseInt(updateData.dispatchTimeline.shippingDays) || 3,
              totalDays: parseInt(updateData.dispatchTimeline.totalDays) || 4
            } : updateData.dispatchTimeline
          }),
          ...(updateData.uom !== undefined && { uom: updateData.uom }),
          ...(updateData.tags !== undefined && { tags: updateData.tags }),
          ...(updateData.dimensions !== undefined && { dimensions: updateData.dimensions }),
          ...(updateData.weight !== undefined && { weight: updateData.weight }),
          ...(updateData.weightUnit !== undefined && { weightUnit: updateData.weightUnit }),
          ...(updateData.inStock !== undefined && { inStock: updateData.inStock }),
          ...(updateData.logisticsConfig !== undefined && { logisticsConfig: updateData.logisticsConfig }),
          ...(updateData.status && { status: updateData.status.toUpperCase() })
        }
      });

      // Update variants if provided
      if (updateData.variants !== undefined) {
        // Delete existing variants
        await tx.productVariant.deleteMany({
          where: { productId: id }
        });

        // Create new variants
        if (updateData.variants.length > 0) {
          // Auto-calculate variant INR/USD from adminFixedPrice using exchange rate
          const { getCurrentExchangeRate: getVarRate } = require('./exchangeRateController');
          const varExchangeRate = await getVarRate();

          const variantData = updateData.variants.map(variant => {
            const varPrice = parseFloat(variant.price) || 0;
            const varAdminPrice = variant.adminFixedPrice ? parseFloat(variant.adminFixedPrice) : null;
            const varOriginal = variant.originalPrice ? parseFloat(variant.originalPrice) : null;
            const sellingINR = varAdminPrice || varPrice;
            const sellingUSD = sellingINR > 0 ? Math.round((sellingINR / varExchangeRate) * 100) / 100 : null;
            const originalUSD = varOriginal ? Math.round((varOriginal / varExchangeRate) * 100) / 100 : null;

            let discount = variant.discount ? parseFloat(variant.discount) : null;
            if (varOriginal && sellingINR && varOriginal > sellingINR) {
              discount = discountPercent(varOriginal, sellingINR);
            }

            return {
              productId: id,
              variantName: variant.variantName || null,
              size: variant.size || '',
              color: variant.color,
              colorHex: variant.colorHex,
              sku: variant.sku,
              price: varPrice,
              originalPrice: varOriginal,
              discount,
              adminFixedPrice: varAdminPrice,
              priceINR: sellingINR,
              priceUSD: sellingUSD,
              originalPriceINR: varOriginal,
              originalPriceUSD: originalUSD,
              priceVisibility: variant.priceVisibility || 'BOTH',
              stock: parseInt(variant.stock) || 0,
              lowStockThreshold: variant.lowStockThreshold != null && variant.lowStockThreshold !== '' ? parseInt(variant.lowStockThreshold) : null,
              images: variant.images || []
            };
          });

          await tx.productVariant.createMany({
            data: variantData
          });
        }
      }

      // Update images if provided
      if (updateData.images !== undefined) {
        // Delete existing images
        await tx.productImage.deleteMany({
          where: { productId: id }
        });

        // Create new images
        if (updateData.images.length > 0) {
          const imageData = updateData.images.map((image, index) => ({
            productId: id,
            url: image.url,
            alt: image.alt || updatedProduct.name,
            isPrimary: image.isPrimary || false,
            imageType: image.imageType || 'gallery',
            sortOrder: index
          }));

          await tx.productImage.createMany({
            data: imageData
          });
        }
      }

      return updatedProduct;
    });

    // Fetch the complete updated product
    const completeProduct = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: true,
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true
          }
        }
      }
    });

    // Sync stock with linked inventory (outside transaction)
    // If has variants, use calculated total stock. If not, use provided totalStock
    let finalStock = 0;
    if (updateData.hasVariants && updateData.variants && updateData.variants.length > 0) {
      finalStock = updateData.variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
    } else if (existingProduct.hasVariants && (!updateData.variants || updateData.variants.length === 0)) {
      // Using existing variants (if not updated) - we need to fetch them if not in existingProduct include
      // But for now, let's assume if variants aren't in updateData, stock isn't changing via variants
      // This might be an edge case, but typically updates include variants if they are being changed.
      // Better approach: calculate final stock trigger.
      finalStock = parseInt(updateData.totalStock) || existingProduct.totalStock; // Fallback
    } else {
      finalStock = parseInt(updateData.totalStock);
    }

    // Special case: If we just calculated stock from variants, we should verify/update the product's totalStock too if it wasn't done in transaction
    // Actually, we should have done it IN the transaction.
    // Let's refactor the update logic above to be safer.

    // RE-FETCH the finalized product to get the true stock
    const finalizedProduct = await prisma.product.findUnique({
      where: { id },
      include: { variants: true }
    });

    if (finalizedProduct) {
      let trueTotalStock = finalizedProduct.totalStock;

      // Total stock = the inventory's base pool (non-variant units) + the sum of
      // variant stocks. This matches the order-deduction invariant
      // (orderController: newTotalStock = inventory.baseStock + variantSum).
      // Using variantSum alone silently dropped the base pool and corrupted
      // totalStock (and inventory.currentStock) for products that carry base
      // stock alongside variants.
      if (finalizedProduct.hasVariants && finalizedProduct.variants.length > 0) {
        const variantSum = finalizedProduct.variants.reduce((sum, v) => sum + v.stock, 0);
        let baseStock = 0;
        if (existingProduct.inventoryItemId) {
          const inv = await prisma.inventory.findUnique({
            where: { id: existingProduct.inventoryItemId },
            select: { baseStock: true },
          });
          baseStock = inv?.baseStock || 0;
        }
        trueTotalStock = baseStock + variantSum;

        if (trueTotalStock !== finalizedProduct.totalStock) {
          await prisma.product.update({
            where: { id },
            data: { totalStock: trueTotalStock }
          });
        }
      }

      // Now sync with Inventory
      if (existingProduct.inventoryItemId) {
        await prisma.inventory.update({
          where: { id: existingProduct.inventoryItemId },
          data: { currentStock: trueTotalStock }
        });
        console.log('✅ Synced stock with inventory:', existingProduct.inventoryItemId, 'New Stock:', trueTotalStock);
      }
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: completeProduct
    });

  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Delete product
const deleteProduct = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;
    const { id } = req.params;

    // Check if product exists and belongs to vendor
    const existingProduct = await prisma.product.findFirst({
      where: {
        id,
        vendorId
      }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Start transaction for deletion
    await prisma.$transaction(async (tx) => {
      // Delete variants
      await tx.productVariant.deleteMany({
        where: { productId: id }
      });

      // Delete images
      await tx.productImage.deleteMany({
        where: { productId: id }
      });

      // Update inventory item if connected
      if (existingProduct.inventoryItemId) {
        await tx.inventory.update({
          where: { id: existingProduct.inventoryItemId },
          data: {
            hasProductCreated: false,
            productId: null
          }
        });
      }

      // Delete product
      await tx.product.delete({
        where: { id }
      });
    });

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get product statistics
const getProductStats = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;

    // Get total products
    const totalProducts = await prisma.product.count({
      where: { vendorId }
    });

    // Get active products
    const activeProducts = await prisma.product.count({
      where: { vendorId, status: 'ACTIVE' }
    });

    // Get pending products (awaiting approval)
    const pendingProducts = await prisma.product.count({
      where: { vendorId, approvalStatus: 'PENDING' }
    });

    // Get out of stock products
    const outOfStockProducts = await prisma.product.count({
      where: { vendorId, inStock: false }
    });

    // Get products with variants
    const productsWithVariants = await prisma.product.count({
      where: { vendorId, hasVariants: true }
    });

    // Get total stock across all products
    const productsWithStock = await prisma.product.findMany({
      where: { vendorId, trackInventory: true },
      select: {
        totalStock: true,
        variants: {
          select: {
            stock: true
          }
        },
        hasVariants: true
      }
    });

    const totalStock = productsWithStock.reduce((sum, product) => {
      if (product.hasVariants) {
        return sum + product.variants.reduce((variantSum, variant) => variantSum + variant.stock, 0);
      } else {
        return sum + product.totalStock;
      }
    }, 0);

    res.json({
      success: true,
      data: {
        totalProducts,
        activeProducts,
        pendingProducts,
        outOfStockProducts,
        productsWithVariants,
        totalStock
      }
    });

  } catch (error) {
    console.error('Error fetching product stats:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get available inventory items for product creation
const getAvailableInventoryItems = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;

    const availableItems = await prisma.inventory.findMany({
      where: {
        vendorId,
        hasProductCreated: false,
        status: 'ACTIVE'
      },
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
        subcategory: true,
        description: true,
        currentStock: true
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: availableItems
    });

  } catch (error) {
    console.error('Error fetching available inventory items:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Admin: Approve product
const approveProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminPrice, variantPrices, originalPrice, variantOriginalPrices, priceINR, priceUSD, originalPriceINR, originalPriceUSD, priceVisibility, variantPricesINR, variantPricesUSD, variantOriginalPricesINR, variantOriginalPricesUSD, variantVisibilities, subCategory, categoryAction, categoryMergeTargetId, returnable } = req.body;
    const adminId = req.user.id;

    // Find the product with variants
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        variants: true,
        vendor: {
          select: {
            id: true,
            companyName: true,
            ownerName: true,
            businessEmail: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (product.approvalStatus === 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: 'Product is already approved'
      });
    }

    // QC clearance is the entry requirement. A product mid-negotiation
    // (NEGOTIATION) is ALSO approvable — a negotiation only ever starts from a
    // QC_APPROVED product, and it stays NEGOTIATION until the admin finalises.
    // Approving from NEGOTIATION is how the admin publishes once a price is
    // agreed (or after the vendor walked away and the admin keeps the current
    // price). The open-offer guard below is what actually blocks a premature
    // approval while a price is still being haggled.
    if (!['QC_SUBMITTED', 'QC_APPROVED', 'NEGOTIATION'].includes(product.approvalStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Product must have a submitted QC inspection before Admin approval'
      });
    }

    // Block approval while a price offer is still awaiting a response — the
    // vendor's buying price is not yet settled. (Also sweeps any offer that
    // has since expired.)
    {
      const { getOpenOffer, expireStaleOffers } = require('./priceNegotiationController');
      await expireStaleOffers(id);
      const openOffer = await getOpenOffer(id);
      if (openOffer) {
        return res.status(409).json({
          success: false,
          message: `A price offer (₹${openOffer.proposedPrice}) is awaiting a response. Resolve the negotiation before approving.`,
        });
      }
    }

    // ── Vendor-proposed category gate ──────────────────────────────────────
    // A product may sit on a category the vendor invented (status PENDING), which
    // is invisible to the storefront. Approving it as-is would publish a product
    // nobody can reach by browsing, so the admin must resolve the category in the
    // same action: approve it into the taxonomy, or merge it into an existing one.
    const pendingCategory = await prisma.category.findFirst({
      where: { name: product.category, status: 'PENDING' },
      select: { id: true, name: true, createdByVendorId: true },
    });

    if (pendingCategory) {
      if (categoryAction === 'approve') {
        await prisma.category.update({
          where: { id: pendingCategory.id },
          data: { status: 'ACTIVE', updatedBy: adminId },
        });
      } else if (categoryAction === 'merge') {
        if (!categoryMergeTargetId) {
          return res.status(400).json({
            success: false,
            code: 'CATEGORY_PENDING_REVIEW',
            message: 'categoryMergeTargetId is required to merge the pending category',
            data: { categoryId: pendingCategory.id, categoryName: pendingCategory.name },
          });
        }
        const target = await prisma.category.findUnique({ where: { id: categoryMergeTargetId } });
        if (!target || target.status !== 'ACTIVE') {
          return res.status(400).json({
            success: false,
            message: 'Merge target must be an existing active category',
          });
        }
        // Repoint every product on the pending name (this one included), then
        // drop the now-unused proposal.
        await prisma.product.updateMany({
          where: { category: pendingCategory.name },
          data: { category: target.name },
        });
        await prisma.category.delete({ where: { id: pendingCategory.id } });
        // Keep the in-memory copy consistent with what we just wrote.
        product.category = target.name;
      } else {
        // No decision supplied — tell the client what needs resolving so it can
        // prompt, rather than silently publishing an unbrowsable product.
        return res.status(400).json({
          success: false,
          code: 'CATEGORY_PENDING_REVIEW',
          message: `"${pendingCategory.name}" is a vendor-proposed category awaiting review. Approve it or merge it into an existing category before publishing this product.`,
          data: { categoryId: pendingCategory.id, categoryName: pendingCategory.name },
        });
      }
    }

    // Live exchange rate — fetched up-front because the variant pricing branch
    // below auto-calculates USD prices and needs it before the base-price block.
    const { getCurrentExchangeRate } = require('./exchangeRateController');
    const exchangeRate = await getCurrentExchangeRate();

    // Prepare update data
    const updateData = {
      approvalStatus: 'APPROVED',
      status: 'ACTIVE',
      approvedAt: new Date(),
      approvedBy: adminId,
      rejectionReason: null
    };

    // Admin assigns the website subcategory at approval time (optional — custom
    // categories have none). Only overwrite when a non-empty value is sent.
    if (typeof subCategory === 'string' && subCategory.trim()) {
      updateData.subCategory = subCategory.trim();
    }

    // Return eligibility is finalised by the admin at approval (governs the
    // customer's return option on the website). Only set when explicitly sent.
    if (returnable !== undefined) {
      updateData.returnable = !(returnable === false || returnable === 'false' || returnable === 'no');
    }

    // Handle pricing based on whether product has variants
    if (product.hasVariants && product.variants.length > 0) {
      // Product has variants - require variant prices
      if (!variantPrices || Object.keys(variantPrices).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Variant prices are required for products with variants'
        });
      }

      // Validate that all variants have prices
      const missingPrices = product.variants.filter(v => !variantPrices[v.id] || parseFloat(variantPrices[v.id]) <= 0);
      if (missingPrices.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Admin prices are required for all variants. Missing prices for: ${missingPrices.map(v => (v.variantName && v.variantName.trim()) || [v.size, v.color].filter(Boolean).join('-') || v.sku || 'variant').join(', ')}`
        });
      }

      // Update each variant with admin price — auto-calculate INR/USD from exchange rate
      await Promise.all(
        product.variants.map(variant => {
          const adminFixed = parseFloat(variantPrices[variant.id]);
          const variantData = {
            adminFixedPrice: adminFixed,
            priceINR: adminFixed,
            priceUSD: Math.round((adminFixed / exchangeRate) * 100) / 100,
          };

          if (variantOriginalPrices && variantOriginalPrices[variant.id]) {
            const origPrice = parseFloat(variantOriginalPrices[variant.id]);
            variantData.originalPrice = origPrice;
            variantData.originalPriceINR = origPrice;
            variantData.originalPriceUSD = Math.round((origPrice / exchangeRate) * 100) / 100;
            if (origPrice > adminFixed) {
              variantData.discount = discountPercent(origPrice, adminFixed);
            }
          }

          if (variantVisibilities && variantVisibilities[variant.id]) {
            variantData.priceVisibility = variantVisibilities[variant.id];
          }

          return prisma.productVariant.update({
            where: { id: variant.id },
            data: variantData
          });
        })
      );

      // Set base admin price for the product
      if (adminPrice !== undefined && adminPrice !== null && parseFloat(adminPrice) > 0) {
        updateData.adminFixedPrice = parseFloat(adminPrice);
      }

      // Set original price and discount for the product
      if (originalPrice !== undefined && originalPrice !== null && parseFloat(originalPrice) > 0) {
        const origPrice = parseFloat(originalPrice);
        updateData.originalPrice = origPrice;
        const pct = discountPercent(origPrice, updateData.adminFixedPrice);
        if (pct != null) updateData.discount = pct;
      }

    } else {
      // Product without variants - require single admin price
      const finalAdminPrice = adminPrice !== undefined && adminPrice !== null ? adminPrice : product.adminFixedPrice;

      if (!finalAdminPrice || finalAdminPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Admin price is required for approval and must be greater than 0'
        });
      }

      updateData.adminFixedPrice = parseFloat(finalAdminPrice);

      // Set original price and discount for the product
      if (originalPrice !== undefined && originalPrice !== null && parseFloat(originalPrice) > 0) {
        const origPrice = parseFloat(originalPrice);
        updateData.originalPrice = origPrice;
        const pct = discountPercent(origPrice, finalAdminPrice);
        if (pct != null) updateData.discount = pct;
      }
    }

    // Centralized pricing: adminFixedPrice IS the selling price
    // priceINR = adminFixedPrice (synced automatically)
    // priceUSD = adminFixedPrice / exchangeRate (auto-calculated)
    const sellingPrice = updateData.adminFixedPrice || (priceINR ? parseFloat(priceINR) : null);
    if (sellingPrice) {
      updateData.adminFixedPrice = sellingPrice;
      updateData.priceINR = sellingPrice;
      updateData.priceUSD = Math.round((sellingPrice / exchangeRate) * 100) / 100;
    }

    const originalINR = originalPriceINR ? parseFloat(originalPriceINR) : null;
    if (originalINR && originalINR > 0) {
      updateData.originalPriceINR = originalINR;
      updateData.originalPriceUSD = Math.round((originalINR / exchangeRate) * 100) / 100;
    }
    if (priceVisibility) {
      updateData.priceVisibility = priceVisibility;
    }

    // Update product approval status
    const updatedProduct = await prisma.product.update({
      where: { id: id },
      data: updateData,
      include: {
        variants: true,
        vendor: {
          select: {
            companyName: true,
            ownerName: true
          }
        }
      }
    });

    // Notify vendor about product approval
    const { createNotification } = require('./notificationController');
    createNotification({
      userId: product.vendorId, role: 'VENDOR', type: 'PRODUCT_APPROVED',
      title: 'Product Approved',
      message: `Your product "${product.name}" has been approved and is now live.`,
      data: { productId: product.id }
    }).catch(() => {});

    res.json({
      success: true,
      message: 'Product approved successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Approve product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve product'
    });
  }
};

// Admin: Reject product
const rejectProduct = async (req, res) => {
  try {
    const { id } = req.params; // Changed from productId to id
    const { rejectionReason } = req.body;
    const adminId = req.user.id; // Admin ID from auth middleware

    if (!rejectionReason || rejectionReason.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }

    // Find the product
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        vendor: {
          select: {
            id: true,
            companyName: true,
            ownerName: true,
            businessEmail: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (product.approvalStatus === 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: 'Product is already rejected'
      });
    }

    // Rejecting ends any live price talks: leaving an offer PENDING would show
    // the vendor an actionable negotiation for a product that is already dead,
    // and would block a later re-approval on the open-offer check above.
    await prisma.priceNegotiation.updateMany({
      where: { productId: id, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });

    // Update product approval status
    const updatedProduct = await prisma.product.update({
      where: { id: id },
      data: {
        approvalStatus: 'REJECTED',
        rejectionReason: rejectionReason.trim(),
        approvedAt: null,
        approvedBy: null
      },
      include: {
        vendor: {
          select: {
            companyName: true,
            ownerName: true
          }
        }
      }
    });

    // Notify vendor about product rejection
    const { createNotification: createRejectNotif } = require('./notificationController');
    createRejectNotif({
      userId: product.vendorId, role: 'VENDOR', type: 'PRODUCT_REJECTED',
      title: 'Product Rejected',
      message: `Your product "${product.name}" was rejected: ${rejectionReason.trim()}`,
      data: { productId: product.id }
    }).catch(() => {});

    res.json({
      success: true,
      message: 'Product rejected successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Reject product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject product'
    });
  }
};

// Admin: Assign QC Checker to Product
const assignQCCheckerToProduct = async (req, res) => {
  try {
    const { id } = req.params;
    // qcCheckerId is required; the schedule fields mirror the factory assignment form.
    const { qcCheckerId, clientName, scheduledDate, scheduledTime, priority, estimatedDuration } = req.body;

    if (!qcCheckerId) {
      return res.status(400).json({ error: 'QC Checker ID is required' });
    }

    // Build the schedule snapshot only from fields the admin actually supplied, so a
    // bare { qcCheckerId } call (legacy / quick reassign) still works and doesn't wipe
    // an existing schedule with blanks.
    const qcAssignment = {};
    if (clientName !== undefined) qcAssignment.clientName = clientName;
    if (scheduledDate !== undefined) qcAssignment.scheduledDate = scheduledDate;
    if (scheduledTime !== undefined) qcAssignment.scheduledTime = scheduledTime;
    if (priority !== undefined) qcAssignment.priority = priority;
    if (estimatedDuration !== undefined) qcAssignment.estimatedDuration = estimatedDuration;
    // Stamp the (re)assignment moment so the "Assigned" date reflects THIS assignment,
    // not the product's creation date — it updates every time the admin reassigns.
    qcAssignment.assignedAt = new Date().toISOString();

    // Verify QC Checker exists
    const checker = await prisma.qCChecker.findUnique({ where: { id: qcCheckerId } });
    if (!checker) {
      return res.status(404).json({ error: 'QC Checker not found' });
    }

    // Find the product to check its current status
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Determine the status after assignment
    // If it was REINSPECTION, keep it as REINSPECTION so the checker knows it's a second round
    // If it was PENDING or anything else, ensure it is set appropriately
    let newApprovalStatus = product.approvalStatus;
    if (product.approvalStatus === 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: 'Cannot reassign a product that has already been final approved. Use the manual update if absolutely necessary.'
      });
    }

    // Update the product with the new checker (+ schedule, when supplied)
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        assignedQcId: qcCheckerId,
        // Always merge (never wipe an existing schedule) so a bare quick-reassign
        // still records the new assignedAt while keeping the booked window.
        qcAssignment: { ...(product.qcAssignment || {}), ...qcAssignment },
      },
      include: {
        assignedQc: {
          select: { name: true, email: true }
        }
      }
    });

    // Notify the QC checker — in-app feed + FCM push
    const { createNotification: createQcNotif } = require('./notificationController');
    createQcNotif({
      userId: qcCheckerId, role: 'QC_CHECKER', type: 'PRODUCT_ASSIGNED',
      title: 'New Product Assigned',
      message: `"${product.name}" has been assigned to you for inspection.`,
      data: { screen: 'products', productId: product.id }
    }).catch(() => {});

    // Notify vendor that QC checker has been assigned
    createQcNotif({
      userId: product.vendorId, role: 'VENDOR', type: 'QC_ASSIGNED',
      title: 'QC Checker Assigned',
      message: `A QC Checker has been assigned to inspect your product "${product.name}".`,
      data: { productId: product.id }
    }).catch(() => {});

    // Email the vendor immediately that a product inspection is assigned.
    // Fire-and-forget — a mail failure must never fail the assignment itself.
    try {
      const vendorRec = await prisma.vendor.findUnique({
        where: { id: product.vendorId },
        select: { companyName: true, ownerName: true, email: true, businessEmail: true, ownerEmail: true },
      });
      const { sendProductInspectionAssignedEmail } = require('../utils/email/vendorEmailSender');
      sendProductInspectionAssignedEmail({
        to: vendorRec?.email || vendorRec?.businessEmail || vendorRec?.ownerEmail,
        companyName: vendorRec?.companyName,
        ownerName: vendorRec?.ownerName,
        productName: product.name,
        checkerName: checker?.name,
        scheduledDate: qcAssignment.scheduledDate,
        scheduledTime: qcAssignment.scheduledTime,
        priority: qcAssignment.priority,
        estimatedDuration: qcAssignment.estimatedDuration,
      }).catch((e) => console.error('Product-inspection vendor email failed:', e?.message || e));
    } catch (e) {
      console.error('Product-inspection vendor email dispatch error:', e?.message || e);
    }

    res.json({
      success: true,
      message: product.assignedQcId ? 'QC Checker reassigned successfully' : 'QC Checker assigned successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Error assigning QC Checker to product:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(500).json({ error: 'Database error', details: error.message });
  }
};

// Admin: Get single product by ID (no vendor restriction)
const getProductForAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: {
          orderBy: { createdAt: 'asc' }
        },
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        vendor: {
          select: {
            id: true,
            companyName: true,
            ownerName: true,
            businessEmail: true,
            status: true
          }
        },
        assignedQc: {
          select: {
            id: true,
            name: true,
            email: true,
          }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true,
            category: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      data: product
    });

  } catch (error) {
    console.error('Error fetching product for admin:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Admin: Create new product
const createProductByAdmin = async (req, res) => {
  try {
    const adminId = req.user.id;
    const {
      // Vendor Information (REQUIRED for admin)
      vendorId,

      // Inventory Connection
      inventoryItemId,
      isFromInventory,

      // Basic Information
      name,
      description,
      category,
      subCategory,

      // Pricing Information
      basePrice,
      originalPrice,
      discount,
      gstPercentage,
      hsnCode,
      returnable,
      packagingType,
      packingType,
      unpackedType,
      unpackedNote,
      adminFixedPrice, // Admin can set their own price
      priceINR,
      priceUSD,
      originalPriceINR,
      originalPriceUSD,
      priceVisibility,

      // Single Unit Pricing Configuration
      singleUnitSize,
      singleUnitColor,
      singleUnitColorHex,

      // Fabric & Specifications
      fabricType,
      material,
      fabricSpecifications,

      // Variants Management
      hasVariants,

      // Base Product Info
      baseSku,

      // Stock Management
      totalStock,
      lowStockThreshold,
      trackInventory,

      // Dispatch & Shipping
      dispatchTimeline,

      // Additional Info
      uom,
      tags,
      dimensions,
      weight,
      weightUnit,
      inStock,
      status,
      approvalStatus, // Admin can set approval status directly

      // Logistics Configuration
      logisticsConfig,

      // Who made the item (JSON: photo, title, fullName, role, experience, description)
      manufacturerInfo
    } = req.body;

    // Resolve base64 images to URLs
    let { images, variants } = req.body;
    ({ images, variants } = await ensureImageUrls({ images, variants }));

    const resolvedManufacturerInfo = manufacturerInfo
      ? await resolveBase64InValue(manufacturerInfo, { folder: 'manufacturer-photos' })
      : null;

    // Validate required fields
    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: 'Vendor ID is required for admin product creation'
      });
    }

    if (!name || !description || !category || !baseSku) {
      return res.status(400).json({
        success: false,
        message: 'Name, description, category, and base SKU are required'
      });
    }

    if (lowStockThreshold !== undefined && parseInt(lowStockThreshold) < 5) {
      return res.status(400).json({
        success: false,
        message: 'Low stock alert must be 5 or more'
      });
    }

    // Verify vendor exists
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!vendor) {
      return res.status(400).json({
        success: false,
        message: 'Vendor not found'
      });
    }

    if (hasVariants && (!variants || variants.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'At least one variant is required when variants are enabled'
      });
    }

    const gstError = validateGstPercentage(gstPercentage);
    if (gstError) {
      return res.status(400).json({ success: false, message: gstError });
    }

    // Check if base SKU already exists
    const existingSku = await prisma.product.findFirst({
      where: { baseSku }
    });

    if (existingSku) {
      return res.status(400).json({
        success: false,
        message: 'Base SKU already exists. Please use a unique SKU.'
      });
    }

    // If connecting to inventory, validate and update inventory item
    let inventoryItem = null;
    if (isFromInventory && inventoryItemId) {
      inventoryItem = await prisma.inventory.findFirst({
        where: {
          id: inventoryItemId,
          vendorId,
          hasProductCreated: false
        }
      });

      if (!inventoryItem) {
        return res.status(400).json({
          success: false,
          message: 'Inventory item not found or already has a product created'
        });
      }
    }

    // Fetch the vendor's company name for the SKU company-code prefix.
    const vendorRecord = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { companyName: true },
    });

    // Start transaction with extended timeout for multiple DB operations
    const result = await prisma.$transaction(async (tx) => {
      // Base SKU: reuse the inventory item's master SKU when this product is
      // created from inventory (so they stay identical); otherwise auto-generate
      // a fresh immutable SKU INSIDE the transaction (atomic counter increment).
      const baseSku = (isFromInventory && inventoryItem?.sku)
        ? inventoryItem.sku
        : await generateBaseSku(tx, vendorRecord?.companyName);
      const variantCount = hasVariants && variants ? variants.length : 0;
      if (variantCount > 0) {
        // Variants are assigned alphabetical suffixes A, B, C … in order.
        variants = variants.map((v, i) => ({ ...v, sku: variantSkuFor(baseSku, i + 1) }));
      }

      // Determine the stock to use
      let productStock = 0;
      let baseStockValue = 0;

      if (hasVariants && variants && variants.length > 0) {
        // If has variants, total stock = base stock + variant stocks
        const variantStockSum = variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
        baseStockValue = parseInt(totalStock) || 0;
        productStock = baseStockValue + variantStockSum;
      } else if (isFromInventory && inventoryItem) {
        // If from inventory (and no variants), use user-entered stock or fallback to inventory stock
        productStock = parseInt(totalStock) || inventoryItem.currentStock;
        baseStockValue = productStock;
      } else {
        // Otherwise use provided total stock
        productStock = parseInt(totalStock) || 0;
        baseStockValue = productStock;
      }

      // Generate unique slug
      const adminSlug = await generateUniqueSlug(name);

      // Derive the USD prices the same way approveProduct and updateProductByAdmin do.
      // Without this an admin-created product goes live with priceUSD = null, and the
      // .com storefront has to convert it on the fly on every render.
      const createRate = await getCurrentExchangeRate();
      const productPrices = deriveRegionalPrices(
        { priceINR, priceUSD, originalPriceINR, originalPriceUSD, adminFixedPrice, originalPrice },
        createRate
      );

      // Create product
      const product = await tx.product.create({
        data: {
          vendorId,
          inventoryItemId: isFromInventory ? inventoryItemId : null,
          isFromInventory: isFromInventory || false,
          name,
          slug: adminSlug,
          description,
          category,
          subCategory,
          basePrice: parseFloat(basePrice) || 0,
          originalPrice: originalPrice ? parseFloat(originalPrice) : null,
          discount: discount ? parseFloat(discount) : null,
          gstPercentage: gstPercentage !== null && gstPercentage !== undefined && gstPercentage !== '' ? parseFloat(gstPercentage) : null,
          hsnCode: hsnCode ? String(hsnCode).trim() : null,
          // Return eligibility — defaults to true unless explicitly turned off.
          returnable: returnable === false || returnable === 'false' || returnable === 'no' ? false : true,
          ...normalizePackaging(packagingType, packingType, unpackedType, unpackedNote),
          adminFixedPrice: numOrNull(adminFixedPrice),
          ...productPrices,
          priceVisibility: priceVisibility || 'BOTH',

          // Single Unit Pricing Configuration
          singleUnitSize: singleUnitSize || null,
          singleUnitColor: singleUnitColor || null,
          singleUnitColorHex: singleUnitColorHex || null,
          fabricType,
          material,
          fabricSpecifications: fabricSpecifications || {},
          manufacturerInfo: resolvedManufacturerInfo || undefined,
          hasVariants: hasVariants || false,
          baseSku,
          variantSeq: variantCount,
          totalStock: productStock,
          lowStockThreshold: parseInt(lowStockThreshold) || 5,
          trackInventory: trackInventory !== false,
          dispatchTimeline: dispatchTimeline ? {
            processingDays: parseInt(dispatchTimeline.processingDays) || 1,
            shippingDays: parseInt(dispatchTimeline.shippingDays) || 3,
            totalDays: parseInt(dispatchTimeline.totalDays) || 4
          } : {
            processingDays: 1,
            shippingDays: 3,
            totalDays: 4
          },
          uom: uom || 'pcs',
          tags: tags || [],
          dimensions,
          weight,
          weightUnit,
          inStock: inStock !== false,
          logisticsConfig: logisticsConfig || null,
          status: status ? status.toUpperCase() : 'ACTIVE',
          approvalStatus: approvalStatus ? approvalStatus.toUpperCase() : 'PENDING', // Default to PENDING for admin creations
          approvedAt: approvalStatus === 'APPROVED' ? new Date() : null,
          approvedBy: approvalStatus === 'APPROVED' ? adminId : null
        }
      });

      // Create variants if enabled
      if (hasVariants && variants && variants.length > 0) {
        const variantData = variants.map(variant => ({
          productId: product.id,
          variantName: variant.variantName || null,
          size: variant.size || '',
          color: variant.color,
          colorHex: variant.colorHex,
          sku: variant.sku,
          price: parseFloat(variant.price),
          originalPrice: variant.originalPrice ? parseFloat(variant.originalPrice) : null,
          discount: variant.discount ? parseFloat(variant.discount) : null,
          adminFixedPrice: numOrNull(variant.adminFixedPrice),
          // INR is the source of truth; USD is derived. Same rule as the parent product.
          ...deriveRegionalPrices(variant, createRate),
          priceVisibility: variant.priceVisibility || 'BOTH',
          stock: parseInt(variant.stock) || 0,
          lowStockThreshold: variant.lowStockThreshold != null && variant.lowStockThreshold !== '' ? parseInt(variant.lowStockThreshold) : null,
          images: variant.images || []
        }));

        await tx.productVariant.createMany({
          data: variantData
        });
      }

      // Create images if provided
      if (images && images.length > 0) {
        const imageData = images.map((image, index) => ({
          productId: product.id,
          url: image.url,
          alt: image.alt || name,
          isPrimary: image.isPrimary || false,
          imageType: image.imageType || 'gallery',
          sortOrder: index
        }));

        await tx.productImage.createMany({
          data: imageData
        });
      }

      // Update inventory item if connected
      if (isFromInventory && inventoryItemId) {
        let inventoryUpdateData = {
          hasProductCreated: true,
          productId: product.id
        };

        // Set base stock and total stock properly
        if (hasVariants && variants && variants.length > 0) {
          // For products with variants:
          // - baseStock = user-entered base stock value
          // - currentStock = base stock + variant stocks
          inventoryUpdateData.baseStock = baseStockValue;
          inventoryUpdateData.currentStock = productStock; // Already includes base + variants
        } else {
          // For products without variants, sync inventory stock with product stock
          inventoryUpdateData.baseStock = productStock;
          inventoryUpdateData.currentStock = productStock;
        }

        await tx.inventory.update({
          where: { id: inventoryItemId },
          data: inventoryUpdateData
        });
      }

      return product;
    }, { timeout: 30000 });

    // Fetch the complete product with relations
    const completeProduct = await prisma.product.findUnique({
      where: { id: result.id },
      include: {
        variants: true,
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        vendor: {
          select: {
            id: true,
            companyName: true,
            ownerName: true,
            businessEmail: true
          }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully by admin',
      data: completeProduct
    });

  } catch (error) {
    console.error('Error creating product by admin:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Admin: Update product
const updateProductByAdmin = async (req, res) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params;
    const updateData = req.body;

    const resolved = await ensureImageUrls({
      images: updateData.images,
      variants: updateData.variants,
    });
    if (updateData.images !== undefined) updateData.images = resolved.images;
    if (updateData.variants !== undefined) updateData.variants = resolved.variants;

    // Resolve the manufacturer photo (base64 → Cloudinary) if it was edited.
    if (updateData.manufacturerInfo !== undefined && updateData.manufacturerInfo !== null) {
      updateData.manufacturerInfo = await resolveBase64InValue(updateData.manufacturerInfo, { folder: 'manufacturer-photos' });
    }

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: true,
        images: true,
        vendor: true
      }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if base SKU is being changed and if new SKU already exists
    // SKU is immutable — never change the base SKU on update, whatever the
    // client sends.
    updateData.baseSku = existingProduct.baseSku;

    // Allocate variant SKUs without reusing past suffixes: existing variants
    // keep their SKU; brand-new variants get the next alphabetical suffix from
    // Product.variantSeq (a high-water mark that only ever increments).
    if (updateData.variants && updateData.variants.length > 0) {
      const existingSkuSet = new Set((existingProduct.variants || []).map(v => v.sku));
      let seq = existingProduct.variantSeq || (existingProduct.variants?.length || 0);
      updateData.variants = updateData.variants.map(v => {
        if (v.sku && existingSkuSet.has(v.sku)) return v; // keep existing variant SKU
        seq += 1;
        return { ...v, sku: variantSkuFor(existingProduct.baseSku, seq) };
      });
      updateData.__nextVariantSeq = seq;
    }

    if (false && updateData.variants && updateData.variants.length > 0) {
      const variantSkus = updateData.variants.map(v => v.sku);
      const duplicateSkus = variantSkus.filter((sku, index) => variantSkus.indexOf(sku) !== index);

      if (duplicateSkus.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Duplicate variant SKUs found: ${duplicateSkus.join(', ')}`
        });
      }

      // Check if any variant SKU already exists (excluding current product variants)
      const existingVariantSkus = await prisma.productVariant.findMany({
        where: {
          sku: { in: variantSkus },
          productId: { not: id }
        }
      });

      if (existingVariantSkus.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Variant SKUs already exist: ${existingVariantSkus.map(v => v.sku).join(', ')}`
        });
      }
    }

    // Only enforced when the caller actually sends the field, so a partial update
    // that never touches GST is unaffected — but an explicit blank is rejected
    // rather than silently persisting null (which reads as 0% at checkout).
    if (updateData.gstPercentage !== undefined) {
      const gstError = validateGstPercentage(updateData.gstPercentage);
      if (gstError) {
        return res.status(400).json({ success: false, message: gstError });
      }
    }

    // Start transaction for update
    const result = await prisma.$transaction(async (tx) => {
      // Calculate newTotalStock based on variants or direct totalStock.
      // For variant products the total is the base pool (non-variant units held
      // on the linked inventory) PLUS the sum of variant stocks — matching the
      // order-deduction invariant. Summing variants alone dropped the base pool.
      let newTotalStock = undefined;
      if (updateData.hasVariants && updateData.variants && updateData.variants.length > 0) {
        const variantSum = updateData.variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
        let baseStock = 0;
        if (existingProduct.inventoryItemId) {
          const inv = await tx.inventory.findUnique({
            where: { id: existingProduct.inventoryItemId },
            select: { baseStock: true },
          });
          baseStock = inv?.baseStock || 0;
        }
        newTotalStock = baseStock + variantSum;
      } else if (updateData.totalStock !== undefined) {
        newTotalStock = parseInt(updateData.totalStock);
      }

      // Prepare update data
      const productUpdateData = {
        ...(updateData.name && { name: updateData.name }),
        ...(updateData.description && { description: updateData.description }),
        ...(updateData.category && { category: updateData.category }),
        ...(updateData.subCategory !== undefined && { subCategory: updateData.subCategory }),
        ...(updateData.basePrice !== undefined && { basePrice: parseFloat(updateData.basePrice) }),
        ...(updateData.originalPrice !== undefined && {
          originalPrice: updateData.originalPrice ? parseFloat(updateData.originalPrice) : null
        }),
        ...(updateData.discount !== undefined && {
          discount: updateData.discount ? parseFloat(updateData.discount) : null
        }),
        ...(updateData.gstPercentage !== undefined && {
          gstPercentage: parseFloat(updateData.gstPercentage)
        }),
        ...(updateData.hsnCode !== undefined && {
          hsnCode: updateData.hsnCode ? String(updateData.hsnCode).trim() : null
        }),
        ...(updateData.returnable !== undefined && {
          returnable: !(updateData.returnable === false || updateData.returnable === 'false' || updateData.returnable === 'no')
        }),
        ...(updateData.packagingType !== undefined && normalizePackaging(updateData.packagingType, updateData.packingType, updateData.unpackedType, updateData.unpackedNote)),
        ...(updateData.adminFixedPrice !== undefined && {
          adminFixedPrice: updateData.adminFixedPrice ? parseFloat(updateData.adminFixedPrice) : null
        }),
        ...(updateData.priceINR !== undefined && {
          priceINR: updateData.priceINR ? parseFloat(updateData.priceINR) : null
        }),
        ...(updateData.priceUSD !== undefined && {
          priceUSD: updateData.priceUSD ? parseFloat(updateData.priceUSD) : null
        }),
        ...(updateData.originalPriceINR !== undefined && {
          originalPriceINR: updateData.originalPriceINR ? parseFloat(updateData.originalPriceINR) : null
        }),
        ...(updateData.originalPriceUSD !== undefined && {
          originalPriceUSD: updateData.originalPriceUSD ? parseFloat(updateData.originalPriceUSD) : null
        }),
        ...(updateData.priceVisibility !== undefined && { priceVisibility: updateData.priceVisibility }),

        // Single Unit Pricing Configuration
        ...(updateData.singleUnitSize !== undefined && { singleUnitSize: updateData.singleUnitSize }),
        ...(updateData.singleUnitColor !== undefined && { singleUnitColor: updateData.singleUnitColor }),
        ...(updateData.singleUnitColorHex !== undefined && { singleUnitColorHex: updateData.singleUnitColorHex }),
        ...(updateData.fabricType !== undefined && { fabricType: updateData.fabricType }),
        ...(updateData.material !== undefined && { material: updateData.material }),
        ...(updateData.fabricSpecifications !== undefined && {
          fabricSpecifications: updateData.fabricSpecifications
        }),
        ...(updateData.manufacturerInfo !== undefined && { manufacturerInfo: updateData.manufacturerInfo }),
        ...(updateData.hasVariants !== undefined && { hasVariants: updateData.hasVariants }),
        ...(updateData.baseSku && { baseSku: updateData.baseSku }),

        // Use calculated stock if available, otherwise just update if provided
        ...(newTotalStock !== undefined && { totalStock: newTotalStock }),


        ...(updateData.lowStockThreshold !== undefined && {
          lowStockThreshold: parseInt(updateData.lowStockThreshold)
        }),
        ...(updateData.trackInventory !== undefined && { trackInventory: updateData.trackInventory }),
        ...(updateData.dispatchTimeline !== undefined && {
          dispatchTimeline: updateData.dispatchTimeline ? {
            processingDays: parseInt(updateData.dispatchTimeline.processingDays) || 1,
            shippingDays: parseInt(updateData.dispatchTimeline.shippingDays) || 3,
            totalDays: parseInt(updateData.dispatchTimeline.totalDays) || 4
          } : updateData.dispatchTimeline
        }),
        ...(updateData.uom !== undefined && { uom: updateData.uom }),
        ...(updateData.tags !== undefined && { tags: updateData.tags }),
        ...(updateData.dimensions !== undefined && { dimensions: updateData.dimensions }),
        ...(updateData.weight !== undefined && { weight: updateData.weight }),
        ...(updateData.weightUnit !== undefined && { weightUnit: updateData.weightUnit }),
        ...(updateData.inStock !== undefined && { inStock: updateData.inStock }),
        ...(updateData.logisticsConfig !== undefined && { logisticsConfig: updateData.logisticsConfig }),
        ...(updateData.status && { status: updateData.status.toUpperCase() }),
        ...(updateData.approvalStatus && {
          approvalStatus: updateData.approvalStatus.toUpperCase(),
          ...(updateData.approvalStatus.toUpperCase() === 'APPROVED' && {
            approvedAt: new Date(),
            approvedBy: adminId,
            rejectionReason: null
          })
        })
      };

      // Update product
      const updatedProduct = await tx.product.update({
        where: { id },
        data: productUpdateData
      });

      // Sync stock with linked inventory (outside transaction logic but here we do it inside if needed, or trigger it)
      // Note: we can't easily access the updated totalStock if we rely on DB return, but we have newTotalStock

      // If we calculated newTotalStock, usage that.
      const stockToSync = newTotalStock !== undefined ? newTotalStock : (updateData.totalStock !== undefined ? parseInt(updateData.totalStock) : undefined);

      if (stockToSync !== undefined && existingProduct.inventoryItemId) {
        await tx.inventory.update({
          where: { id: existingProduct.inventoryItemId },
          data: { currentStock: stockToSync }
        });
        console.log('✅ Synced stock with inventory:', existingProduct.inventoryItemId);
      }
      // Update variants if provided
      if (updateData.variants !== undefined) {
        // Delete existing variants
        await tx.productVariant.deleteMany({
          where: { productId: id }
        });

        // Create new variants
        if (updateData.variants.length > 0) {
          // Auto-calculate variant INR/USD from adminFixedPrice using exchange rate
          const { getCurrentExchangeRate: getVarRate } = require('./exchangeRateController');
          const varExchangeRate = await getVarRate();

          const variantData = updateData.variants.map(variant => {
            const varPrice = parseFloat(variant.price) || 0;
            const varAdminPrice = variant.adminFixedPrice ? parseFloat(variant.adminFixedPrice) : null;
            const varOriginal = variant.originalPrice ? parseFloat(variant.originalPrice) : null;
            const sellingINR = varAdminPrice || varPrice;
            const sellingUSD = sellingINR > 0 ? Math.round((sellingINR / varExchangeRate) * 100) / 100 : null;
            const originalUSD = varOriginal ? Math.round((varOriginal / varExchangeRate) * 100) / 100 : null;

            let discount = variant.discount ? parseFloat(variant.discount) : null;
            if (varOriginal && sellingINR && varOriginal > sellingINR) {
              discount = discountPercent(varOriginal, sellingINR);
            }

            return {
              productId: id,
              variantName: variant.variantName || null,
              size: variant.size || '',
              color: variant.color,
              colorHex: variant.colorHex,
              sku: variant.sku,
              price: varPrice,
              originalPrice: varOriginal,
              discount,
              adminFixedPrice: varAdminPrice,
              priceINR: sellingINR,
              priceUSD: sellingUSD,
              originalPriceINR: varOriginal,
              originalPriceUSD: originalUSD,
              priceVisibility: variant.priceVisibility || 'BOTH',
              stock: parseInt(variant.stock) || 0,
              lowStockThreshold: variant.lowStockThreshold != null && variant.lowStockThreshold !== '' ? parseInt(variant.lowStockThreshold) : null,
              images: variant.images || []
            };
          });

          await tx.productVariant.createMany({
            data: variantData
          });
        }
      }

      // Update images if provided
      if (updateData.images !== undefined) {
        // Delete existing images
        await tx.productImage.deleteMany({
          where: { productId: id }
        });

        // Create new images
        if (updateData.images.length > 0) {
          const imageData = updateData.images.map((image, index) => ({
            productId: id,
            url: image.url,
            alt: image.alt || updatedProduct.name,
            isPrimary: image.isPrimary || false,
            imageType: image.imageType || 'gallery',
            sortOrder: index
          }));

          await tx.productImage.createMany({
            data: imageData
          });
        }
      }

      return updatedProduct;
    });

    // Fetch the complete updated product
    const completeProduct = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: true,
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        vendor: {
          select: {
            id: true,
            companyName: true,
            ownerName: true,
            businessEmail: true
          }
        },
        inventory: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
            baseStock: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: 'Product updated successfully by admin',
      data: completeProduct
    });

  } catch (error) {
    console.error('Error updating product by admin:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Admin: Delete product
const deleteProductByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Start transaction for deletion
    await prisma.$transaction(async (tx) => {
      // Delete variants
      await tx.productVariant.deleteMany({
        where: { productId: id }
      });

      // Delete images
      await tx.productImage.deleteMany({
        where: { productId: id }
      });

      // Update inventory item if connected
      if (existingProduct.inventoryItemId) {
        await tx.inventory.update({
          where: { id: existingProduct.inventoryItemId },
          data: {
            hasProductCreated: false,
            productId: null
          }
        });
      }

      // Delete product
      await tx.product.delete({
        where: { id }
      });
    });

    res.json({
      success: true,
      message: 'Product deleted successfully by admin'
    });

  } catch (error) {
    console.error('Error deleting product by admin:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Admin: Get all products with approval status filter
const getAllProductsForAdmin = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      approvalStatus,
      status,
      search,
      vendorId,
      category,
      dateFrom,
      dateTo
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build where clause
    const where = {};

    if (approvalStatus) {
      where.approvalStatus = approvalStatus.toUpperCase();
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    if (vendorId) {
      where.vendorId = vendorId;
    }

    if (category) {
      where.category = { contains: category, mode: 'insensitive' };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { baseSku: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Created-date range filter (YYYY-MM-DD)
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) where.createdAt.lte = new Date(`${dateTo}T23:59:59.999Z`);
    }

    // Get products with pagination
    const [products, totalCount] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          vendor: {
            select: {
              id: true,
              companyName: true,
              ownerName: true,
              businessEmail: true,
              status: true
            }
          },
          assignedQc: {
            select: {
              id: true,
              checkerId: true,
              name: true,
              email: true,
              status: true
            }
          },
          images: {
            where: { isPrimary: true },
            take: 1
          },
          variants: {
            select: {
              id: true,
              variantName: true,
              size: true,
              color: true,
              colorHex: true,
              sku: true,
              price: true,
              originalPrice: true,
              stock: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.product.count({ where })
    ]);

    // Per-approval-status counts for the metric cards. Ignore the approvalStatus
    // filter itself (so selecting one card doesn't shrink the others) while still
    // respecting search / status / vendor / category / date filters.
    const countsWhere = { ...where };
    delete countsWhere.approvalStatus;
    const grouped = await prisma.product.groupBy({
      by: ['approvalStatus'],
      where: countsWhere,
      _count: { _all: true }
    });
    const counts = { total: 0, PENDING: 0, QC_SUBMITTED: 0, QC_APPROVED: 0, APPROVED: 0, REJECTED: 0, REINSPECTION: 0 };
    for (const g of grouped) {
      const n = g._count._all;
      if (counts[g.approvalStatus] !== undefined) counts[g.approvalStatus] = n;
      counts.total += n;
    }

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.json({
      success: true,
      data: {
        products,
        counts,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalCount,
          limit: parseInt(limit),
          hasNext: parseInt(page) < totalPages,
          hasPrev: parseInt(page) > 1
        }
      }
    });
  } catch (error) {
    console.error('Get all products for admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
};

// Public endpoint: Get all approved products for website
// Public endpoint: Get all approved products for website
const getPublicProducts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 12,
      search,
      category,
      subCategory,
      minPrice,
      maxPrice,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      inStock,
      tag,
      colors,
      sizes,
      materials,
      fabricTypes,
      minDiscount,
      newArrivals,
      minRating,
      region
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build where clause
    const where = {
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    };

    // Region visibility — applied server-side so IN_ONLY/COM_ONLY products are neither
    // sent over the wire to the wrong storefront nor counted in pagination totals.
    Object.assign(where, visibilityWhere(region));

    if (tag) {
      where.tags = { has: tag };
    }

    if (search) {
      // Partial keyword match across every searchable field, so short keywords like
      // "tow", "cotton", "red", "men" find products by name, category, material,
      // colour/size (incl. variants), SKU, tags or description — not just exact names.
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { subCategory: { contains: search, mode: 'insensitive' } },
        { material: { contains: search, mode: 'insensitive' } },
        { fabricType: { contains: search, mode: 'insensitive' } },
        { baseSku: { contains: search, mode: 'insensitive' } },
        { singleUnitColor: { contains: search, mode: 'insensitive' } },
        { singleUnitSize: { contains: search, mode: 'insensitive' } },
        { tags: { has: search } },
        { variants: { some: { OR: [
          { color: { contains: search, mode: 'insensitive' } },
          { size: { contains: search, mode: 'insensitive' } },
          { variantName: { contains: search, mode: 'insensitive' } },
        ] } } },
      ];
    }

    if (category) {
      // One category, or a comma-separated set (banners can target several).
      const cats = String(category).split(',').map((c) => c.trim()).filter(Boolean);
      if (cats.length > 1) {
        // AND-wrapped so it never collides with the search OR above.
        where.AND = [
          ...(where.AND || []),
          { OR: cats.map((c) => ({ category: { equals: c, mode: 'insensitive' } })) },
        ];
      } else if (cats.length === 1) {
        where.category = { equals: cats[0], mode: 'insensitive' };
      }
    }

    // Explicit product set (by slug) — used by banners that target specific products.
    if (req.query.products) {
      const slugs = String(req.query.products).split(',').map((s) => s.trim()).filter(Boolean);
      if (slugs.length > 0) where.slug = { in: slugs };
    }

    // Product set by key (id OR slug) — used by the Coupons & Offers filter, since
    // offers store product IDs while coupons may store slugs. AND-wrapped so it
    // never collides with the search OR.
    if (req.query.productKeys) {
      const keys = String(req.query.productKeys).split(',').map((s) => s.trim()).filter(Boolean);
      if (keys.length > 0) {
        where.AND = [
          ...(where.AND || []),
          { OR: [{ id: { in: keys } }, { slug: { in: keys } }] },
        ];
      }
    }

    if (subCategory) {
      where.subCategory = { equals: subCategory, mode: 'insensitive' };
    }

    // Price filtering — uses AND so it doesn't conflict with search OR
    if (minPrice || maxPrice) {
      const priceConditions = [];

      if (minPrice && maxPrice) {
        priceConditions.push({
          adminFixedPrice: { gte: parseFloat(minPrice), lte: parseFloat(maxPrice) }
        });
        priceConditions.push({
          AND: [
            { adminFixedPrice: null },
            { basePrice: { gte: parseFloat(minPrice), lte: parseFloat(maxPrice) } }
          ]
        });
      } else if (minPrice) {
        priceConditions.push({ adminFixedPrice: { gte: parseFloat(minPrice) } });
        priceConditions.push({
          AND: [
            { adminFixedPrice: null },
            { basePrice: { gte: parseFloat(minPrice) } }
          ]
        });
      } else if (maxPrice) {
        priceConditions.push({ adminFixedPrice: { lte: parseFloat(maxPrice) } });
        priceConditions.push({
          AND: [
            { adminFixedPrice: null },
            { basePrice: { lte: parseFloat(maxPrice) } }
          ]
        });
      }

      // Wrap price conditions in AND so they don't mix with search OR
      where.AND = where.AND || [];
      where.AND.push({ OR: priceConditions });
    }

    if (inStock === 'true') {
      where.inStock = true;
      where.totalStock = { gt: 0 };
    }

    // Color filter — uses AND so it doesn't conflict with search OR
    if (colors) {
      const colorList = colors.split(',').map(c => c.trim().toLowerCase());
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { tags: { hasSome: colorList } },
          { singleUnitColor: { in: colorList, mode: 'insensitive' } },
          { variants: { some: { color: { in: colorList, mode: 'insensitive' } } } }
        ]
      });
    }

    // Size filter — single-unit size or any variant size
    if (sizes) {
      const sizeList = sizes.split(',').map(s => s.trim()).filter(Boolean);
      if (sizeList.length) {
        where.AND = where.AND || [];
        where.AND.push({
          OR: [
            { singleUnitSize: { in: sizeList, mode: 'insensitive' } },
            { variants: { some: { size: { in: sizeList, mode: 'insensitive' } } } }
          ]
        });
      }
    }

    // Material filter
    if (materials) {
      const list = materials.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        where.AND = where.AND || [];
        where.AND.push({ material: { in: list, mode: 'insensitive' } });
      }
    }

    // Fabric type filter
    if (fabricTypes) {
      const list = fabricTypes.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        where.AND = where.AND || [];
        where.AND.push({ fabricType: { in: list, mode: 'insensitive' } });
      }
    }

    // Discount filter — the product or one of its variants is at least N% off
    if (minDiscount) {
      const d = parseFloat(minDiscount);
      if (!isNaN(d) && d > 0) {
        where.AND = where.AND || [];
        where.AND.push({
          OR: [
            { discount: { gte: d } },
            { variants: { some: { discount: { gte: d } } } }
          ]
        });
      }
    }

    // New arrivals — created within the last 30 days
    if (newArrivals === 'true') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      where.AND = where.AND || [];
      where.AND.push({ createdAt: { gte: cutoff } });
    }

    // Rating filter
    if (minRating) {
      where.rating = { gte: parseFloat(minRating) };
    }

    // Get total count
    const totalItems = await prisma.product.count({ where });

    // Get products
    const products = await prisma.product.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { [sortBy]: sortOrder },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: true,
        subCategory: true,
        basePrice: true,
        adminFixedPrice: true, // Include admin fixed price
        originalPrice: true,
        originalPriceINR: true,
        originalPriceUSD: true,
        discount: true,
        singleUnitSize: true,
        singleUnitColor: true,
        singleUnitColorHex: true,
        rating: true,
        reviews: true,
        images: true,
        tags: true,
        inStock: true,
        totalStock: true,
        hasVariants: true,
        variants: {
          select: {
            id: true,
            variantName: true,
            size: true,
            color: true,
            colorHex: true,
            sku: true,
            price: true,
            originalPrice: true,
            originalPriceINR: true,
            originalPriceUSD: true,
            discount: true,
            adminFixedPrice: true,
            priceINR: true,
            priceUSD: true,
            priceVisibility: true,
            stock: true,
            images: true
          }
        },
        fabricType: true,
        material: true,
        uom: true,
        priceINR: true,
        priceUSD: true,
        priceVisibility: true,
        dimensions: true,
        weight: true,
        weightUnit: true,
        createdAt: true
      }
    });

    const totalPages = Math.ceil(totalItems / parseInt(limit));

    // Attach the live offer badge (if any) to each product. Additive: products with no
    // matching offer are returned untouched.
    const decorate = await buildOfferDecorator(region);
    const decoratedItems = products.map((p) => {
      const d = decorate(p);
      // Drop variants not visible in the caller's region (parity with the product
      // detail endpoint) so out-of-region SKUs/prices/stock don't leak to the list.
      if (Array.isArray(d.variants)) {
        d.variants = d.variants.filter((v) => isVisibleInRegion(v.priceVisibility, region));
      }
      return d;
    });

    res.json({
      success: true,
      data: {
        items: decoratedItems,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalItems,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1,
          limit: parseInt(limit)
        }
      }
    });
  } catch (error) {
    console.error('Get public products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
};

// Public autocomplete: a small, relevance-ranked set of product suggestions for the
// header search-as-you-type. Matches partial keywords across name/category/material/
// colour/size/SKU/tags/description/variants, then ranks in JS by field priority so a
// name hit outranks a description hit. Returns ~8 lightweight rows (no full catalogue).
const getPublicProductSuggestions = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const region = req.query.region;
    if (q.length < 2) return res.json({ success: true, data: [] });

    const where = {
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { subCategory: { contains: q, mode: 'insensitive' } },
        { material: { contains: q, mode: 'insensitive' } },
        { fabricType: { contains: q, mode: 'insensitive' } },
        { baseSku: { contains: q, mode: 'insensitive' } },
        { singleUnitColor: { contains: q, mode: 'insensitive' } },
        { singleUnitSize: { contains: q, mode: 'insensitive' } },
        { tags: { has: q } },
        { variants: { some: { OR: [
          { color: { contains: q, mode: 'insensitive' } },
          { size: { contains: q, mode: 'insensitive' } },
          { variantName: { contains: q, mode: 'insensitive' } },
        ] } } },
      ],
    };
    Object.assign(where, visibilityWhere(region));

    // Pull a bounded candidate set, then rank in JS (Prisma/Mongo has no relevance score).
    const candidates = await prisma.product.findMany({
      where,
      select: {
        id: true, name: true, category: true, subCategory: true, material: true,
        fabricType: true, description: true, tags: true, baseSku: true,
        adminFixedPrice: true, basePrice: true, priceINR: true, priceUSD: true,
        singleUnitColor: true, singleUnitSize: true,
        images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
        variants: { select: { color: true, size: true, variantName: true }, take: 20 },
      },
      take: 40,
    });

    const ql = q.toLowerCase();
    const has = (v) => typeof v === 'string' && v.toLowerCase().includes(ql);
    const starts = (v) => typeof v === 'string' && v.toLowerCase().startsWith(ql);
    // Field-priority score (spec §6): name > tag/keyword > category/sub > material/attr > desc.
    const scoreOf = (p) => {
      let s = 0;
      if (starts(p.name)) s += 120; else if (has(p.name)) s += 90;
      if (Array.isArray(p.tags) && p.tags.some((t) => has(t))) s += 60;
      if (has(p.category) || has(p.subCategory)) s += 45;
      if (has(p.material) || has(p.fabricType) || has(p.singleUnitColor) || has(p.singleUnitSize)) s += 30;
      if (Array.isArray(p.variants) && p.variants.some((v) => has(v.color) || has(v.size) || has(v.variantName))) s += 25;
      if (has(p.baseSku)) s += 20;
      if (has(p.description)) s += 10;
      return s;
    };

    const data = candidates
      .map((p) => ({ p, s: scoreOf(p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(({ p }) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        image: p.images?.[0]?.url || null,
        adminFixedPrice: p.adminFixedPrice,
        basePrice: p.basePrice,
        priceINR: p.priceINR,
        priceUSD: p.priceUSD,
      }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Suggestion search error:', error);
    res.json({ success: true, data: [] }); // never break the search box
  }
};

// Public endpoint: available filter facets for the storefront.
// Everything is computed live from the ACTIVE/APPROVED catalogue (optionally
// scoped to the current search/category context) — no hardcoded option lists.
const getPublicProductFacets = async (req, res) => {
  try {
    const { search, category, subCategory, region } = req.query;

    const where = { status: 'ACTIVE', approvalStatus: 'APPROVED' };
    Object.assign(where, visibilityWhere(region));

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { tags: { has: search } }
      ];
    }
    if (category) where.category = { equals: category, mode: 'insensitive' };
    if (subCategory) where.subCategory = { equals: subCategory, mode: 'insensitive' };

    // Minimal projection — just what the facets need.
    const products = await prisma.product.findMany({
      where,
      select: {
        singleUnitColor: true,
        singleUnitColorHex: true,
        singleUnitSize: true,
        material: true,
        fabricType: true,
        basePrice: true,
        adminFixedPrice: true,
        discount: true,
        originalPrice: true,
        variants: {
          select: { color: true, colorHex: true, size: true, discount: true, price: true, originalPrice: true }
        }
      }
    });

    // key (lowercased) -> { value, hex?, count }
    const colorMap = new Map();
    const sizeMap = new Map();
    const materialMap = new Map();
    const fabricMap = new Map();
    let minPrice = Infinity;
    let maxPrice = 0;
    let maxDiscount = 0;

    const addColor = (name, hex) => {
      if (name == null || String(name).trim() === '') return;
      const value = String(name).trim();
      const key = value.toLowerCase();
      const ex = colorMap.get(key);
      if (ex) { ex.count++; if (!ex.hex && hex) ex.hex = hex; }
      else colorMap.set(key, { value, hex: hex || null, count: 1 });
    };
    const addTo = (map, val) => {
      if (val == null || String(val).trim() === '') return;
      const value = String(val).trim();
      const key = value.toLowerCase();
      const ex = map.get(key);
      if (ex) ex.count++;
      else map.set(key, { value, count: 1 });
    };
    const discountFrom = (orig, eff) =>
      (typeof orig === 'number' && typeof eff === 'number' && orig > eff)
        ? Math.round((1 - eff / orig) * 100) : 0;

    for (const p of products) {
      addColor(p.singleUnitColor, p.singleUnitColorHex);
      addTo(sizeMap, p.singleUnitSize);
      addTo(materialMap, p.material);
      addTo(fabricMap, p.fabricType);

      const eff = p.adminFixedPrice != null ? p.adminFixedPrice : p.basePrice;
      if (typeof eff === 'number') { minPrice = Math.min(minPrice, eff); maxPrice = Math.max(maxPrice, eff); }
      maxDiscount = Math.max(maxDiscount, typeof p.discount === 'number' ? p.discount : discountFrom(p.originalPrice, eff));

      for (const v of (p.variants || [])) {
        addColor(v.color, v.colorHex);
        addTo(sizeMap, v.size);
        if (typeof v.price === 'number') { minPrice = Math.min(minPrice, v.price); maxPrice = Math.max(maxPrice, v.price); }
        maxDiscount = Math.max(maxDiscount, typeof v.discount === 'number' ? v.discount : discountFrom(v.originalPrice, v.price));
      }
    }

    const byCount = (a, b) => b.count - a.count || a.value.localeCompare(b.value);

    res.json({
      success: true,
      data: {
        colors: [...colorMap.values()].sort(byCount),
        sizes: [...sizeMap.values()].sort(byCount),
        materials: [...materialMap.values()].sort(byCount),
        fabricTypes: [...fabricMap.values()].sort(byCount),
        priceRange: { min: minPrice === Infinity ? 0 : Math.floor(minPrice), max: Math.ceil(maxPrice) },
        maxDiscount: Math.round(maxDiscount)
      }
    });
  } catch (error) {
    console.error('Get product facets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product facets' });
  }
};

// Public endpoint: Get single product by ID for website
// Public endpoint: Get single product by ID for website
const getPublicProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // Support both slug and ID lookup
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const where = {
      ...(isObjectId ? { id } : { slug: id }),
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    };

    const product = await prisma.product.findFirst({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: true,
        subCategory: true,
        basePrice: true,
        adminFixedPrice: true, // Include admin fixed price
        priceINR: true,
        priceUSD: true,
        originalPriceINR: true,
        originalPriceUSD: true,
        priceVisibility: true,
        originalPrice: true,
        discount: true,
        singleUnitSize: true,
        singleUnitColor: true,
        singleUnitColorHex: true,
        rating: true,
        reviews: true,
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        tags: true,
        inStock: true,
        totalStock: true,
        hasVariants: true,
        variants: {
          select: {
            id: true,
            variantName: true,
            size: true,
            color: true,
            colorHex: true,
            sku: true,
            price: true,
            originalPrice: true,
            discount: true,
            adminFixedPrice: true,
            priceINR: true,
            priceUSD: true,
            originalPriceINR: true,
            originalPriceUSD: true,
            priceVisibility: true,
            stock: true,
            images: true
          },
          orderBy: { createdAt: 'asc' }
        },
        fabricType: true,
        material: true,
        fabricSpecifications: true,
        manufacturerInfo: true, // who made the item — shown on the storefront product page
        uom: true,
        priceINR: true,
        priceUSD: true,
        priceVisibility: true,
        dimensions: true,
        weight: true,
        weightUnit: true,
        dispatchTimeline: true,
        logisticsConfig: true,
        returnable: true, // return eligibility — drives the "Easy return" badge + policy note
        packagingType: true, // 'PACKED' | 'UNPACKED'
        packingType: true, // 'BALE' | 'CARTON' (when packed)
        unpackedType: true, // 'STITCHED' | 'UNSTITCHED' | 'OTHER' (when unpacked)
        unpackedNote: true, // remark for the unpacked selection
        createdAt: true,
        updatedAt: true,
        inventory: {
          select: {
            currentStock: true,
            baseStock: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or not available'
      });
    }

    // Region gate: an out-of-region product must not be openable by direct URL, and
    // its payload must never ship to the wrong storefront. Treated as not-found so we
    // don't reveal that it exists elsewhere. `region` comes from the query (the .in /
    // .com frontend sends its own region).
    if (!isVisibleInRegion(product.priceVisibility, req.query.region)) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or not available'
      });
    }

    // Drop variants hidden in this region so their SKUs/prices never ship to the
    // wrong storefront — the client would hide them anyway, but the data shouldn't
    // leave the server. Mirrors the product-level gate above.
    let publicProduct = { ...product };
    if (Array.isArray(publicProduct.variants)) {
      publicProduct.variants = publicProduct.variants.filter(
        (v) => isVisibleInRegion(v.priceVisibility, req.query.region)
      );
    }

    // Sanitize logisticsConfig — only expose customer-facing fields, not admin internals
    if (product.logisticsConfig) {
      const lc = product.logisticsConfig;
      publicProduct.logisticsConfig = {
        unitWeight: lc.unitWeight || 0,
        weightUom: lc.weightUom || 'KG',
        maxWeight: lc.maxWeight || 0,
        dimensions: lc.dimensions || null,
        transportTypes: lc.transportTypes || ['AIR', 'SHIP'],
        // Customer sees delivery days and total cost — NOT per-kg rates
        airDeliveryDays: lc.airDeliveryDays || 7,
        shipDeliveryDays: lc.shipDeliveryDays || 30,
        // Domestic (.in) surface lane — the storefront picks these on the .in region.
        // Undefined (legacy products) falls back to the ship/sea figures in the calc.
        surfaceDeliveryDays: lc.surfaceDeliveryDays,
        surfaceCostPerKg: lc.surfaceCostPerKg,
        // Which admin-managed couriers this product ships with (storefront filters the
        // shown couriers to these). Empty/undefined → show all region+mode couriers.
        courierIds: lc.courierIds || [],
        // Send cost per KG for client-side calculation but keep weight ranges internal
        airCostPerKg: lc.airCostPerKg || 0,
        shipCostPerKg: lc.shipCostPerKg || 0,
        // Weight ranges needed for auto-recommendation on frontend
        weightRanges: (lc.weightRanges || []).map(r => ({
          minWeight: r.minWeight,
          maxWeight: r.maxWeight,
          recommendedTransport: r.recommendedTransport,
        })),
        // Only show customer-facing notes, not internal admin notes
        notes: lc.notes || '',
      };
    }

    // Attach the live offer badge (if any). Additive: no matching offer → unchanged.
    const decorate = await buildOfferDecorator(req.query.region);
    publicProduct = decorate(publicProduct);

    res.json({
      success: true,
      data: publicProduct
    });
  } catch (error) {
    console.error('Get public product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product'
    });
  }
};

module.exports = {
  createProduct,
  getVendorProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  getProductStats,
  getAvailableInventoryItems,
  // Admin functions
  getProductForAdmin,
  createProductByAdmin,
  updateProductByAdmin,
  deleteProductByAdmin,
  approveProduct,
  rejectProduct,
  getAllProductsForAdmin,
  // Public functions
  getPublicProducts,
  getPublicProduct
};

// Update variant stocks (Admin and Vendor)
const updateVariantStocks = async (req, res) => {
  try {
    const { id } = req.params;
    const { variants, reason, notes } = req.body;

    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Variants array is required'
      });
    }

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Reason for stock change is required'
      });
    }

    // Get product with variants
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: true,
        inventory: true
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check authorization
    const isAdmin = req.user.role?.toUpperCase() === 'ADMIN';
    const vendorId = req.user.vendorId || req.user.id;

    if (!isAdmin && product.vendorId !== vendorId) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this product'
      });
    }

    if (!product.hasVariants) {
      return res.status(400).json({
        success: false,
        message: 'This product does not have variants'
      });
    }

    // Get user information for history
    let changedByName = '';
    if (isAdmin) {
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { name: true }
      });
      changedByName = admin?.name || 'Admin';
    } else {
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { ownerName: true }
      });
      changedByName = vendor?.ownerName || 'Vendor';
    }

    // Update variants and create history in transaction
    const result = await prisma.$transaction(async (tx) => {
      const updatedVariants = [];
      const historyRecords = [];

      for (const variantUpdate of variants) {
        const { variantId, stock } = variantUpdate;

        if (!variantId || stock === undefined) {
          throw new Error('Each variant must have variantId and stock');
        }

        // Find existing variant
        const existingVariant = product.variants.find(v => v.id === variantId);
        if (!existingVariant) {
          throw new Error(`Variant ${variantId} not found`);
        }

        const previousStock = existingVariant.stock;
        const newStock = parseInt(stock);
        const changeAmount = newStock - previousStock;

        // Update variant stock
        const updatedVariant = await tx.productVariant.update({
          where: { id: variantId },
          data: { stock: newStock }
        });

        updatedVariants.push(updatedVariant);

        // Create history record if stock changed
        if (changeAmount !== 0 && product.inventoryItemId) {
          historyRecords.push({
            inventoryId: product.inventoryItemId,
            previousStock,
            newStock,
            changeAmount,
            reason: `${reason.trim()} (Variant: ${existingVariant.size} - ${existingVariant.color})`,
            changedBy: req.user.id,
            changedByType: isAdmin ? 'admin' : 'vendor',
            changedByName
          });
        }
      }

      // Calculate new total stock
      let baseStock = 0;
      if (product.inventory) {
        baseStock = product.inventory.currentStock;
      }
      const totalStock = updatedVariants.reduce((sum, v) => sum + v.stock, 0) + baseStock;

      // Update product total stock
      const updatedProduct = await tx.product.update({
        where: { id },
        data: { totalStock }
      });

      // Update inventory stock if linked
      if (product.inventoryItemId) {
        await tx.inventory.update({
          where: { id: product.inventoryItemId },
          data: {
            // currentStock: totalStock, // STOP SYNCING TOTAL STOCK
            lastRestocked: new Date()
          }
        });
      }

      // Create history records
      if (historyRecords.length > 0) {
        await tx.stockChangeHistory.createMany({
          data: historyRecords
        });
      }

      return { updatedProduct, updatedVariants };
    });

    res.json({
      success: true,
      message: 'Variant stocks updated successfully',
      data: result
    });

  } catch (error) {
    console.error('Error updating variant stocks:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

module.exports = {
  createProduct,
  getVendorProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  getProductStats,
  getAvailableInventoryItems,
  getProductForAdmin,
  createProductByAdmin,
  updateProductByAdmin,
  deleteProductByAdmin,
  approveProduct,
  rejectProduct,
  assignQCCheckerToProduct,
  getAllProductsForAdmin,
  getPublicProducts,
  getPublicProductFacets,
  getPublicProductSuggestions,
  getPublicProduct,
  updateVariantStocks
};
