const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { uploadToCloudinary, deleteFromCloudinary, resolveBase64InValue } = require('../config/cloudinary');
const { prisma } = require('../config/database');
const { normalizeCategoryValues } = require('../utils/categoryResolver');
const { generateVendorCode, reconcileAndGenerate } = require('../utils/vendorCodeGenerator');
const { resolveVendorCoordinates } = require('../utils/locationUtils');
const { syncVendorCustomCategories } = require('../utils/customCategories');
const { REFERRAL_SOURCES } = require('../utils/referralSources');
const {
  sendVendorApprovalEmail,
  sendVendorRejectionEmail,
  sendVendorSuspensionEmail,
  sendNewVendorRegistrationEmailToAdmins,
  generateSecurePassword
} = require('../utils/email/vendorEmailSender');
const { getValidVerifiedOtp, consumeOtp } = require('./enquiryController');

// Normalize the product-handling site selection into a validated array of
// 'FACTORY' | 'WAREHOUSE'. Accepts the multi-select array (`sites`) or the legacy
// single value (`single`); JSON-encoded strings (FormData) are parsed. Falls back
// to ['FACTORY'] so a QC product inspection always has a site to geofence against.
function normalizeInspectionSites(sites, single) {
  let arr = sites;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = arr.split(','); }
  }
  if (!Array.isArray(arr)) arr = single != null && single !== '' ? [single] : [];
  const cleaned = [...new Set(
    arr.map((s) => (String(s).toUpperCase() === 'WAREHOUSE' ? 'WAREHOUSE' : 'FACTORY')),
  )];
  return cleaned.length > 0 ? cleaned : ['FACTORY'];
}

// FormData serializes undefined/null as "" (empty string), which JSON.parse
// rejects with "Unexpected end of JSON input". This helper accepts whatever
// shape the field arrives in (already-parsed object, JSON-encoded string,
// or empty) and returns either the parsed value or null — so downstream
// `|| []` / `|| null` guards take over for missing fields. Removing a
// section from the form (Banking Details, etc.) shouldn't crash the
// register/update handlers just because the FormData still ships the key.
const safeJsonParse = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// Finalize any pending (SUBMITTED / UNDER_ADMIN_REVIEW) inspections when admin
// makes a direct vendor status decision (approve / reject / suspend). Without
// this, inspections get stuck in SUBMITTED forever if admin bypasses the
// inspection review flow.
//
// Accepts a Prisma transaction client (`tx`) so inspection updates are atomic
// with the vendor-status change that wraps them.
const finalizeInspectionsForVendor = async (tx, vendorId, { decision }) => {
  const pendingInspections = await tx.inspection.findMany({
    where: {
      vendorId,
      status: { in: ['SUBMITTED', 'UNDER_ADMIN_REVIEW'] },
    },
  });

  if (pendingInspections.length === 0) return null;

  const resultMap = { APPROVED: 'PASSED', REJECTED: 'FAILED', SUSPENDED: 'FAILED' };
  const now = new Date();

  await Promise.all(
    pendingInspections.map((insp) =>
      tx.inspection.update({
        where: { id: insp.id },
        data: {
          status: 'COMPLETED',
          result: resultMap[decision] || insp.result,
          completedAt: now,
          reviewedAt: now,
        },
      })
    )
  );

  return pendingInspections;
};

// Write audit logs for finalized inspections. Called OUTSIDE the transaction
// so a log failure never blocks the main operation (matches codebase pattern).
const writeInspectionAuditLogs = (pendingInspections, { decision, adminId, adminName, reason }) => {
  if (!adminId || !pendingInspections || pendingInspections.length === 0) return;

  const actionMap = { APPROVED: 'ADMIN_APPROVED', REJECTED: 'ADMIN_FINAL_REJECTED', SUSPENDED: 'ADMIN_FINAL_REJECTED' };

  pendingInspections.forEach((insp) => {
    prisma.inspectionAuditLog.create({
      data: {
        entityType: 'FACTORY_INSPECTION',
        entityId: insp.id,
        action: actionMap[decision] || 'ADMIN_APPROVED',
        fromStatus: insp.status,
        toStatus: 'COMPLETED',
        performedById: adminId,
        performedByType: 'ADMIN',
        performedByName: adminName || 'Admin',
        rejectionReason: reason || null,
        cycleNumber: insp.cycleNumber || 1,
      },
    }).catch(err => console.error('Audit log write failed:', err));
  });
};

// Map the multi-select `vendorType` from Step 4 to the `companyType` enum.
// The previous implementation matched `businessType` (legal entity from
// Step 1: proprietorship / pvt-ltd / partnership-firm / llp) against a
// legacy mapping (sole / partnership / corporation / llc) — none of the
// current FE values matched any key, so every vendor was silently tagged
// MANUFACTURER. Deriving from vendorType (manufacturer / importer /
// exporter) makes the column reflect what the user actually selected.
// Factory image slot → admin-facing label. Mirrors FACTORY_IMAGE_SLOTS in
// WarehouseDetails.tsx; keep these in sync if new slots are added. Used by
// both registerVendor and updateVendorById so the document name carries
// the slot identity through every persistence path.
const FACTORY_SLOT_LABEL_MAP = {
  nameBoard: 'Factory Name Board',
  frontView: 'Factory Front View',
  backView: 'Factory Back View',
  leftView: 'Factory Left View',
  rightView: 'Factory Right View',
  roadView: 'Factory Road View',
  insideFactory: 'Factory Interior',
  others: 'Factory Image (Other)',
};

// Factory SITE photos (CompanyDetails step) — stored separately from the
// Warehouse photos (WarehouseDetails step / FACTORY_SLOT_LABEL_MAP above)
// so the two sets remain distinguishable in the document list.
const FACTORY_SITE_SLOT_LABEL_MAP = {
  nameBoard: 'Factory Site Name Board',
  frontView: 'Factory Site Front View',
  backView: 'Factory Site Back View',
  leftView: 'Factory Site Left View',
  rightView: 'Factory Site Right View',
  roadView: 'Factory Site Road View',
  insideFactory: 'Factory Site Interior',
  others: 'Factory Site Image (Other)',
};

const getCompanyTypeEnum = (vendorTypes) => {
  const first = Array.isArray(vendorTypes) ? vendorTypes[0] : vendorTypes;
  const mapping = {
    'manufacturer': 'MANUFACTURER',
    'importer': 'IMPORTER',
    'exporter': 'EXPORTER',
    'trader': 'TRADER',
  };
  return mapping[first] || 'MANUFACTURER';
};

// Helper function to map vendor type to enum
const getVendorTypeEnum = (vendorType) => {
  const mapping = {
    'manufacturer': 'TEXTILE_MANUFACTURER',
    'importer': 'TRADING_COMPANY',
    'exporter': 'TRADING_COMPANY',
    'trader': 'TRADING_COMPANY'
  };

  if (Array.isArray(vendorType)) {
    return mapping[vendorType[0]] || 'TEXTILE_MANUFACTURER';
  }
  return mapping[vendorType] || 'TEXTILE_MANUFACTURER';
};

// Best-effort cleanup for orphaned Cloudinary assets. Called when an
// upload succeeds but a later step (vendor create / cert create / etc.)
// fails — without this, the file lives in Cloudinary forever. Runs as
// fire-and-forget: a delete failure is logged but never thrown, since
// the caller is already in an error path.
const cleanupOrphanedCloudinaryAssets = (publicIds) => {
  if (!Array.isArray(publicIds) || publicIds.length === 0) return;
  publicIds.forEach((publicId) => {
    deleteFromCloudinary(publicId).catch((err) => {
      console.error(`Orphan cleanup failed for ${publicId}:`, err.message);
    });
  });
};

// Helper function to upload files to Cloudinary
const uploadFiles = async (files, folder = 'vendor-documents') => {
  const uploadPromises = files.map(async (file) => {
    try {
      const result = await uploadToCloudinary(file.buffer, {
        folder: folder,
        resource_type: 'auto'
      });
      return {
        originalName: file.originalname,
        cloudinaryUrl: result.secure_url,
        publicId: result.public_id,
        size: file.size,
        mimetype: file.mimetype
      };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw new Error(`Failed to upload ${file.originalname}`);
    }
  });

  return Promise.all(uploadPromises);
};

// Register new vendor
const registerVendor = async (req, res) => {
  // Function-scoped so the outer catch can clean up orphans even if the
  // failure happens before/after the inner upload try-block. `const` inside
  // try would be block-scoped and invisible to the outer catch.
  const uploadedPublicIds = [];
  try {
    const {
      // Company Details
      businessType,
      companyName,
      gstNumber,
      companyIdNumber,        // CIN / Partnership Deed / LLPIN
      iecCode,                // Import Export Code — optional, any type
      panNumber,
      aadhaarNumber,          // Unregistered Vendor identity proof
      email,
      email2,
      phone,
      landlineNumber,
      localLandlineStd,
      intlLandline,
      phoneNumber2,
      website,
      address,
      addressLine2,
      addressLine3,
      landmark,
      city,
      state,
      zipCode,
      country,
      factoryOwnershipType,   // owned / rented / lease for the factory site

      // Acquisition — how the vendor found us (last registration step)
      referralSource,
      referralSourceDetail,

      // Owner Profile
      ownerName,
      designation,             // Proprietor / CEO / Director / Founder / custom
      ownerEmail,
      ownerEmail2,
      ownerPhone,
      ownerPhone2,
      ownerLandline,
      ownerLocalLandlineStd,
      ownerIntlLandline,
      additionalOwners,
      businessStartDate,       // Full date — preferred over legacy yearEstablished
      yearEstablished,         // Legacy year-only fallback
      employeeCount,

      // Warehouse Details
      ownershipType,
      warehouseAddress,
      warehouseAddressLine2,
      warehouseAddressLine3,
      warehouseLandmark,
      warehouseCity,
      warehouseState,
      warehouseZip,
      warehouseCountry,
      mapLink,
      // Coordinates typed on the form. Authoritative — a mapLink is only a fallback.
      latitude,
      longitude,
      warehouseLatitude,
      warehouseLongitude,
      // Where products are handled → the site(s) a QC product inspection geofences
      // against. `productInspectionSites` is the multi-select array; the legacy single
      // `productInspectionSite` is still accepted for older clients.
      productInspectionSite,
      productInspectionSites,

      // Vendor Type & Products
      vendorType,
      marketType,
      selectedCategories,
      categoryRemarks,
      categoryProducts,        // Per-category products: { catId: [{ name, photos: [{preview: dataURI}] }] }
      additionalCategories,    // User-defined categories: [{ id, name, products: [...] }]

      // Manufacturing Facilities (if manufacturer)
      enabledFacilities,
      facilityDetails,

      // Certifications & Logistics
      selectedCertifications,
      certificationExpiryDates,
      otherCertifications,     // User-defined custom certs: [{ id, name, description }]
      qualityControlProcess,
      complianceStandards,
      packagingCapabilities,
      warehousingCapacity,
      factorySiteCapacity,         // Factory site sq-ft — different from warehouse capacity
      logisticsPartners,
      shippingMethods,

      // Contact & Trade Info
      mainContact,
      alternateContacts,
      hasImportExport,
      importCountries,
      exportCountries,
      tradeLicenseNumber,
      businessRegistrationNumber,
      taxIdentificationNumber,
      bankingDetails,

      // Password for vendor login
      password
    } = req.body;

    // Validate required fields — return a structured errors array so the
    // frontend can display each field as a separate row in the error modal.
    const requiredFields = [
      { field: 'companyName',  label: 'Company Name',   step: 0, value: companyName },
      { field: 'email',        label: 'Company Email',   step: 0, value: email },
      { field: 'phone',        label: 'Company Phone',   step: 0, value: phone },
      { field: 'ownerName',    label: 'Owner Name',      step: 2, value: ownerName },
      { field: 'ownerEmail',   label: 'Owner Email',     step: 2, value: ownerEmail },
      { field: 'ownerPhone',   label: 'Owner Phone',     step: 2, value: ownerPhone },
    ];
    const missingFields = requiredFields
      .filter(f => !f.value)
      .map(f => ({ field: f.field, label: f.label, step: f.step, message: `${f.label} is required` }));

    if (missingFields.length > 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: 'Missing required fields',
        errors: missingFields,
      });
    }

    // Normalise email and GST before any duplicate check.
    // Email: lowercase+trim (login identifier, @unique in schema).
    // GST: uppercase+trim (unique business identity for registered vendors;
    //   enforced via a partial unique index created by scripts/createGstIndex.js).
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedOwnerEmail = ownerEmail ? ownerEmail.trim().toLowerCase() : ownerEmail;
    const normalizedGst = gstNumber ? gstNumber.trim().toUpperCase() : '';

    // Public self-registration must prove ownership of the primary email via a
    // one-time code (sent/verified through /api/enquiries/otp/*). Admin-created
    // vendors (authenticated request) skip this — the admin vouches for them.
    // The code is spent only after the vendor row is actually created, below.
    let registrationOtp = null;
    const isAdminActor = !!req.user;
    if (!isAdminActor) {
      registrationOtp = await getValidVerifiedOtp(normalizedEmail, 'vendor_registration');
      if (!registrationOtp) {
        return res.status(403).json({
          code: 'EMAIL_NOT_VERIFIED',
          field: 'email',
          error: 'Please verify your primary email address before submitting your registration.'
        });
      }
    }

    // ── Registered vendor (GST provided) ────────────────────────────────────
    // GST Number is the PRIMARY unique identifier. Check it first and surface
    // the most actionable error. Email is a secondary (login) identifier and
    // is still checked to keep the @unique constraint intact.
    if (normalizedGst) {
      const existingByGst = await prisma.vendor.findFirst({
        where: { gstNumber: normalizedGst },
        select: { id: true }
      });
      if (existingByGst) {
        return res.status(409).json({
          code: 'DUPLICATE_GST',
          field: 'gstNumber',
          error: 'A vendor with this GST Number is already registered. GST Number must be unique for each registered vendor.'
        });
      }
      // Secondary check: email must also be unique for login purposes.
      const existingByEmail = await prisma.vendor.findUnique({
        where: { email: normalizedEmail },
        select: { id: true }
      });
      if (existingByEmail) {
        return res.status(409).json({
          code: 'DUPLICATE_EMAIL',
          field: 'email',
          error: 'This email address is already registered. Please use a different email.'
        });
      }
    } else {
      // ── Unregistered vendor (no GST) ──────────────────────────────────────
      // Email is the PRIMARY unique identifier. Block duplicate registrations
      // based on email alone.
      const existingByEmail = await prisma.vendor.findUnique({
        where: { email: normalizedEmail },
        select: { id: true }
      });
      if (existingByEmail) {
        return res.status(409).json({
          code: 'DUPLICATE_EMAIL',
          field: 'email',
          error: 'A vendor is already registered with this email address. Email must be unique for unregistered vendors.'
        });
      }
    }

    // Hash password if provided
    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 12);
    }

    // Handle file uploads
    let logoUrl = null;
    let gstDocumentUrl = null;
    let panCardUrl = null;
    let typeCertUrl = null;
    let aadhaarUrl = null;
    let iecCertUrl = null;
    let ownerPhotoUrl = null;
    // Factory images carry slot identity (nameBoard / frontView / etc.) so the
    // resulting VendorDocument rows have human-readable names instead of a
    // generic "Factory Image N". Slot IDs arrive in side-channel body fields
    // (`factoryImageSlot_<index>`) — same pattern as `certificationId_<index>`.
    let factoryImageUploads = [];
    let factorySiteImageUploads = [];
    let certificationFileUrls = {};

    try {
      // Each document can arrive one of two ways:
      //   1. As a multipart file (req.files.*) — legacy path; the server uploads
      //      it to Cloudinary here.
      //   2. As a Cloudinary URL in the body (req.body.*Url) — the browser has
      //      already uploaded it directly to Cloudinary (production path that
      //      avoids Vercel's 4.5 MB serverless request-body cap). We just keep
      //      the URL; nothing new is pushed to uploadedPublicIds because those
      //      assets aren't owned by this request's rollback.
      // Upload company logo
      if (req.files?.logo?.[0]) {
        const logoResult = await uploadFiles([req.files.logo[0]], 'vendor-logos');
        logoUrl = logoResult[0].cloudinaryUrl;
        if (logoResult[0].publicId) uploadedPublicIds.push(logoResult[0].publicId);
      } else if (req.body.logoUrl) {
        logoUrl = req.body.logoUrl;
      }

      // Upload GST document
      if (req.files?.gstDocument?.[0]) {
        const gstResult = await uploadFiles([req.files.gstDocument[0]], 'vendor-documents/gst');
        gstDocumentUrl = gstResult[0].cloudinaryUrl;
        if (gstResult[0].publicId) uploadedPublicIds.push(gstResult[0].publicId);
      } else if (req.body.gstDocumentUrl) {
        gstDocumentUrl = req.body.gstDocumentUrl;
      }

      // Upload PAN Card document
      if (req.files?.panCardFile?.[0]) {
        const panResult = await uploadFiles([req.files.panCardFile[0]], 'vendor-documents/pan');
        panCardUrl = panResult[0].cloudinaryUrl;
        if (panResult[0].publicId) uploadedPublicIds.push(panResult[0].publicId);
      } else if (req.body.panCardUrl) {
        panCardUrl = req.body.panCardUrl;
      }

      // Upload type-specific business registration certificate
      // (IEC for Proprietorship / CIN for Pvt Ltd / Deed for Partnership /
      //  LLPIN for LLP). Stored as DocumentType.COMPANY_REGISTRATION.
      if (req.files?.typeCertFile?.[0]) {
        const typeCertResult = await uploadFiles([req.files.typeCertFile[0]], 'vendor-documents/business-cert');
        typeCertUrl = typeCertResult[0].cloudinaryUrl;
        if (typeCertResult[0].publicId) uploadedPublicIds.push(typeCertResult[0].publicId);
      } else if (req.body.typeCertUrl) {
        typeCertUrl = req.body.typeCertUrl;
      }

      // Upload Aadhaar card (Unregistered Vendor identity proof).
      // Stored as DocumentType.AADHAAR_CARD.
      if (req.files?.aadhaarFile?.[0]) {
        const aadhaarResult = await uploadFiles([req.files.aadhaarFile[0]], 'vendor-documents/aadhaar');
        aadhaarUrl = aadhaarResult[0].cloudinaryUrl;
        if (aadhaarResult[0].publicId) uploadedPublicIds.push(aadhaarResult[0].publicId);
      } else if (req.body.aadhaarUrl) {
        aadhaarUrl = req.body.aadhaarUrl;
      }

      // Upload IEC certificate (optional for all business types)
      if (req.files?.iecCertFile?.[0]) {
        const iecCertResult = await uploadFiles([req.files.iecCertFile[0]], 'vendor-documents/iec');
        iecCertUrl = iecCertResult[0].cloudinaryUrl;
        if (iecCertResult[0].publicId) uploadedPublicIds.push(iecCertResult[0].publicId);
      } else if (req.body.iecCertUrl) {
        iecCertUrl = req.body.iecCertUrl;
      }

      // Upload owner photo
      if (req.files?.ownerPhoto?.[0]) {
        const ownerPhotoResult = await uploadFiles([req.files.ownerPhoto[0]], 'vendor-owners');
        ownerPhotoUrl = ownerPhotoResult[0].cloudinaryUrl;
        if (ownerPhotoResult[0].publicId) uploadedPublicIds.push(ownerPhotoResult[0].publicId);
      } else if (req.body.ownerPhotoUrl) {
        ownerPhotoUrl = req.body.ownerPhotoUrl;
      }

      // Upload factory images
      if (req.files?.factoryImages) {
        const factoryResults = await uploadFiles(req.files.factoryImages, 'vendor-factories');
        factoryImageUploads = factoryResults.map((result, index) => ({
          url: result.cloudinaryUrl,
          slotId: req.body[`factoryImageSlot_${index}`] || null,
        }));
        factoryResults.forEach((r) => { if (r.publicId) uploadedPublicIds.push(r.publicId); });
      } else if (req.body.factoryImageUrls) {
        // Browser-uploaded: [{ url, slotId }]
        const parsed = safeJsonParse(req.body.factoryImageUrls);
        if (Array.isArray(parsed)) {
          factoryImageUploads = parsed
            .filter((f) => f && f.url)
            .map((f) => ({ url: f.url, slotId: f.slotId || null }));
        }
      }

      // Upload factory SITE images (CompanyDetails step — separate from warehouse photos above)
      if (req.files?.factorySiteImages) {
        const siteResults = await uploadFiles(req.files.factorySiteImages, 'vendor-factory-sites');
        factorySiteImageUploads = siteResults.map((result, index) => ({
          url: result.cloudinaryUrl,
          slotId: req.body[`factorySiteImageSlot_${index}`] || null,
        }));
        siteResults.forEach((r) => { if (r.publicId) uploadedPublicIds.push(r.publicId); });
      } else if (req.body.factorySiteImageUrls) {
        const parsed = safeJsonParse(req.body.factorySiteImageUrls);
        if (Array.isArray(parsed)) {
          factorySiteImageUploads = parsed
            .filter((f) => f && f.url)
            .map((f) => ({ url: f.url, slotId: f.slotId || null }));
        }
      }

      // Upload certification files
      if (req.files?.certificationFiles) {
        const certResults = await uploadFiles(req.files.certificationFiles, 'vendor-certifications');
        // Map certification files to their respective certification IDs
        certResults.forEach((result, index) => {
          const certId = req.body[`certificationId_${index}`];
          if (certId) {
            certificationFileUrls[certId] = result.cloudinaryUrl;
          }
          if (result.publicId) uploadedPublicIds.push(result.publicId);
        });
      } else if (req.body.certificationFileUrls) {
        // Browser-uploaded: { [certId]: url }
        const parsed = safeJsonParse(req.body.certificationFileUrls);
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([certId, url]) => {
            if (certId && url) certificationFileUrls[certId] = url;
          });
        }
      }
    } catch (uploadError) {
      console.error('File upload error:', uploadError);
      // Best-effort cleanup of anything that did upload before the failure.
      cleanupOrphanedCloudinaryAssets(uploadedPublicIds);
      return res.status(500).json({
        error: 'Failed to upload files: ' + uploadError.message
      });
    }

    // Parse JSON fields (safeJsonParse handles empty-string payloads from
    // FormData without throwing — see the helper near the top of the file)
    const parsedVendorType = safeJsonParse(vendorType);
    const parsedMarketType = safeJsonParse(marketType);
    const parsedSelectedCategories = safeJsonParse(selectedCategories);
    const parsedEnabledFacilities = safeJsonParse(enabledFacilities);
    const parsedFacilityDetails = safeJsonParse(facilityDetails);
    const parsedSelectedCertifications = safeJsonParse(selectedCertifications);
    const parsedCertificationExpiryDates = safeJsonParse(certificationExpiryDates);
    const parsedOtherCertifications = safeJsonParse(otherCertifications);
    const parsedShippingMethods = safeJsonParse(shippingMethods);
    const rawParsedMainContact = safeJsonParse(mainContact);
    const rawParsedAlternateContacts = safeJsonParse(alternateContacts);
    // ── Contact photo upload (Step 7) ─────────────────────────────────────
    // The form stores the main contact's photo as a base64 data URI inside
    // `mainContact.photo` (FileReader.readAsDataURL). Without this resolve,
    // the giant base64 string would be persisted directly into the JSON
    // column and reloaded on every profile view. Deep-walking the object
    // swaps each data URI for a Cloudinary URL while preserving the rest
    // of the contact shape intact.
    const parsedMainContact = await resolveBase64InValue(rawParsedMainContact, {
      folder: 'vendor-contact-photos',
      resource_type: 'image',
    });
    const parsedAlternateContacts = await resolveBase64InValue(rawParsedAlternateContacts, {
      folder: 'vendor-contact-photos',
      resource_type: 'image',
    });
    // Additional owners (Step 3) carry a per-owner profile photo as a base64
    // data URI (`additionalOwners[].photo`) — resolve to Cloudinary URLs the
    // same way as the contact photos above.
    const parsedAdditionalOwners = await resolveBase64InValue(
      safeJsonParse(additionalOwners),
      { folder: 'vendor-owner-photos', resource_type: 'image' },
    );
    const parsedImportCountries = safeJsonParse(importCountries);
    const parsedExportCountries = safeJsonParse(exportCountries);
    const parsedBankingDetails = safeJsonParse(bankingDetails);
    const parsedCategoryProducts = safeJsonParse(categoryProducts);
    const parsedAdditionalCategories = safeJsonParse(additionalCategories);

    // ── Step 4 product photo upload ────────────────────────────────────────
    // Photos arrive as base64 data URIs nested deep inside categoryProducts
    // and additionalCategories (FE uses FileReader.readAsDataURL). Walk the
    // structure once and replace each data URI with its uploaded Cloudinary
    // URL — keeps the rest of the JSON shape (product names, categories,
    // ids) intact so admin UIs can render it as-is.
    const resolvedCategoryProducts = await resolveBase64InValue(
      parsedCategoryProducts,
      { folder: 'vendor-product-photos', resource_type: 'image' },
    );
    const resolvedAdditionalCategories = await resolveBase64InValue(
      parsedAdditionalCategories,
      { folder: 'vendor-product-photos', resource_type: 'image' },
    );

    // ── Vendor type multi-select normalization ───────────────────────────
    // The form lets vendors pick multiple types (manufacturer + importer +
    // exporter). Keep the raw array for `vendorTypes` while the legacy
    // single-enum `vendorType` column gets the first value mapped.
    const vendorTypesArray = Array.isArray(parsedVendorType)
      ? parsedVendorType.filter((v) => typeof v === 'string' && v.length > 0)
      : parsedVendorType
        ? [parsedVendorType]
        : [];

    // ── Production capacity summary (Step 5) ──────────────────────────────
    // Build a human-readable summary string from facilityDetails. The FE
    // stores capacity under prefixed keys (`spinningCapacity`, `weavingCapacity`
    // etc.) — the previous derivation looked for a bare `capacity` key and
    // always produced an empty string. Only enabled facilities are included
    // so a disabled facility with stale data doesn't leak into the summary.
    const buildProductionCapacitySummary = () => {
      if (!parsedFacilityDetails || typeof parsedFacilityDetails !== 'object') return null;
      const enabled = parsedEnabledFacilities || {};
      const parts = [];
      for (const [facilityId, details] of Object.entries(parsedFacilityDetails)) {
        if (!enabled[facilityId]) continue;
        if (!details || typeof details !== 'object') continue;
        const capacityKey = Object.keys(details).find((k) => k.endsWith('Capacity'));
        const capacityValue = capacityKey ? details[capacityKey] : null;
        if (capacityValue) parts.push(`${facilityId}: ${capacityValue} kg/day`);
      }
      return parts.length > 0 ? parts.join(', ') : null;
    };
    const productionCapacitySummary = buildProductionCapacitySummary();

    // Normalize category values to names (drop unresolvable IDs) so the DB
    // never stores raw ObjectIds that would later leak into the UI.
    const normalizedProductCategories = await normalizeCategoryValues(
      Object.keys(parsedSelectedCategories || {})
    );
    const normalizedProductTypes = await normalizeCategoryValues(
      Object.values(parsedSelectedCategories || {}).flat()
    );

    // ── Owner Profile date handling (Step 3) ──────────────────────────────
    // The form sends a full ISO date string (`businessStartDate`); the older
    // `yearEstablished` field is kept as a fallback for legacy clients. We
    // persist the full date AND derive the year so existing code/UI that
    // reads `establishedYear` keeps working without a separate migration.
    const parsedBusinessStartDate = businessStartDate
      ? new Date(businessStartDate)
      : null;
    const businessStartDateValid =
      parsedBusinessStartDate && !isNaN(parsedBusinessStartDate.getTime());
    const derivedEstablishedYear = businessStartDateValid
      ? parsedBusinessStartDate.getFullYear()
      : yearEstablished
        ? parseInt(yearEstablished, 10)
        : null;

    // Build the vendor data payload once — reused if we need to retry after a
    // unique-index collision on vendorCode (e.g. counter drift).
    const buildVendorData = (vendorCode) => ({
      vendorCode,
      email: normalizedEmail,
      password: hashedPassword,
      status: 'PENDING',

      // Owner Profile
      ownerName,
      designation: designation || null,
      ownerEmail: normalizedOwnerEmail,
      ownerEmail2: ownerEmail2 ? ownerEmail2.trim().toLowerCase() : null,
      ownerPhone,
      ownerPhone2: ownerPhone2 || null,
      ownerLandline: ownerLandline || null,
      ownerLocalLandlineStd: ownerLocalLandlineStd || null,
      ownerIntlLandline: ownerIntlLandline || null,
      // Owner address columns dropped from the schema — they always copied
      // the business address. Re-add only when a real owner-address input
      // ships on Step 3.
      ownerPhoto: ownerPhotoUrl,
      additionalOwners: parsedAdditionalOwners,
      businessStartDate: businessStartDateValid ? parsedBusinessStartDate : null,
      employeeCount: employeeCount || null,

      // Company Details
      companyName,
      companyType: getCompanyTypeEnum(parsedVendorType),
      // Persist the raw Step 1 chip selection (proprietorship / pvt-ltd /
      // partnership-firm / llp / others / <custom>). Drives admin label
      // resolution for the regulatory ID (CIN / IEC / Deed / LLPIN) and the
      // type-specific cert document.
      businessType: businessType || null,
      establishedYear: derivedEstablishedYear,
      companyDescription: derivedEstablishedYear
        ? `${companyName} - ${businessType} established in ${derivedEstablishedYear}`
        : `${companyName} - ${businessType}`,
      companyLogo: logoUrl,
      companyIdNumber: companyIdNumber || null,
      iecCode: iecCode || null,
      panNumber: panNumber || null,
      aadhaarNumber: aadhaarNumber || null,
      factoryOwnershipType: factoryOwnershipType || null,

      // Acquisition — normalise to the known option ids so the report groupBy
      // stays clean; anything unrecognised is treated as 'others' with the raw
      // value preserved in the detail column.
      referralSource: REFERRAL_SOURCES.has(referralSource) ? referralSource : (referralSource ? 'others' : null),
      referralSourceDetail: (referralSourceDetail && String(referralSourceDetail).trim())
        || (referralSource && !REFERRAL_SOURCES.has(referralSource) ? String(referralSource).trim() : null)
        || null,

      // Contact & Trade Information
      businessPhone: phone,
      landlineNumber: landlineNumber || null,
      localLandlineStd: localLandlineStd || null,
      intlLandline: intlLandline || null,
      phoneNumber2: phoneNumber2 || null,
      businessEmail: normalizedEmail,
      businessEmail2: email2 ? email2.trim().toLowerCase() : null,
      businessAddress: address,
      addressLine2: addressLine2 || null,
      addressLine3: addressLine3 || null,
      landmark: landmark || null,
      businessCity: city,
      businessState: state,
      businessZipCode: zipCode,
      businessCountry: country || 'India',
      website,
      gstNumber: normalizedGst || null,

      // Trade Information
      // annualTurnover is intentionally not set here — the form doesn't
      // collect it. Schema column is now nullable; left undefined (which
      // Prisma treats as not set, defaulting to null).
      //
      // Derive each experience flag from either the combined "yes" answer
      // OR a non-empty country list — covers the case where a vendor lists
      // countries without explicitly ticking the box.
      importExperience:
        hasImportExport === 'yes' ||
        (Array.isArray(parsedImportCountries) && parsedImportCountries.length > 0),
      exportExperience:
        hasImportExport === 'yes' ||
        (Array.isArray(parsedExportCountries) && parsedExportCountries.length > 0),
      exportCountries: parsedExportCountries || [],
      importCountries: parsedImportCountries || [],
      primaryMarkets: Array.isArray(parsedMarketType) ? parsedMarketType : (parsedMarketType ? [parsedMarketType] : []),

      // Manufacturing Facilities
      enabledFacilities: parsedEnabledFacilities || null,
      facilityDetails: parsedFacilityDetails || null,
      // Factory / Legal Address & Factory Site — from CompanyDetails (address, city, state, etc.)
      // Warehouse Address — from WarehouseDetails (warehouseAddress, warehouseCity, etc.)
      // These are stored in separate DB columns; the QC checker app reads `factory*` directly.
      factoryAddress: address || null,
      factoryCity: city || null,
      factoryState: state || null,
      factoryZipCode: zipCode || null,
      factoryCountry: country || 'India',
      factorySize: factorySiteCapacity
        ? `${factorySiteCapacity} sq ft`
        : (warehousingCapacity ? `${warehousingCapacity} sq ft` : null),
      productionCapacity: productionCapacitySummary,
      // Quality control measures — collected on Step 6 (Certifications &
      // Logistics) but persisted under Manufacturing since the schema column
      // lives in that semantic group.
      qualityControl: qualityControlProcess || null,

      // Warehouse Details
      ownershipType: ownershipType || null,
      warehouseAddress,
      warehouseAddressLine2: warehouseAddressLine2 || null,
      warehouseAddressLine3: warehouseAddressLine3 || null,
      warehouseLandmark: warehouseLandmark || null,
      warehouseCity,
      warehouseState,
      warehouseZipCode: warehouseZip,
      warehouseCountry: warehouseCountry || 'India',
      warehouseSize: warehousingCapacity ? `${warehousingCapacity} sq ft` : null,
      storageCapacity: warehousingCapacity,
      mapLink: mapLink || null,
      // Factory coordinates — the pair the QC inspection geofence measures against.
      // A value typed on the form wins; mapLink is parsed only as a fallback.
      ...resolveVendorCoordinates({ latitude, longitude, mapLink }),
      ...resolveVendorCoordinates({
        latitude: warehouseLatitude,
        longitude: warehouseLongitude,
        latField: 'warehouseLatitude',
        lngField: 'warehouseLongitude',
      }),
      // Product-handling site(s) for QC product-inspection geofencing. The vendor may
      // pick FACTORY, WAREHOUSE, or both; the legacy single field mirrors the first.
      ...(() => {
        const arr = normalizeInspectionSites(productInspectionSites, productInspectionSite);
        return { productInspectionSites: arr, productInspectionSite: arr[0] };
      })(),

      // Vendor Type & Products
      vendorType: getVendorTypeEnum(parsedVendorType),
      vendorTypes: vendorTypesArray,
      productCategories: normalizedProductCategories,
      productTypes: normalizedProductTypes,
      // specializations is intentionally left empty here — it was previously
      // populated from Step 6's `selectedCertifications`, which is wrong.
      // Step 6 already owns certifications via the VendorCertification rows.
      specializations: [],
      categoryRemarks: categoryRemarks || null,
      categoryProducts: resolvedCategoryProducts || null,
      additionalCategories: resolvedAdditionalCategories || null,

      // Logistics Information
      shippingMethods: parsedShippingMethods || [],
      // deliveryTime / minimumOrderQuantity / paymentTerms previously had
      // hardcoded defaults ("7-15 days" / "100 pieces" / ["30 days", "LC"])
      // even though the form doesn't collect them. Removed — admin or
      // vendor settings UI can fill them later. Schema columns stay
      // nullable / default-empty.
      deliveryTime: null,
      minimumOrderQuantity: null,
      paymentTerms: [],
      // Step 6 free-text fields — collected on Certifications & Logistics
      // step. Previously destructured but never written; now persisted.
      packagingCapabilities: packagingCapabilities || null,
      logisticsPartners: logisticsPartners || null,
      complianceStandards: complianceStandards || null,

      // Contact & Trade Information
      mainContact: parsedMainContact || null,
      alternateContacts: parsedAlternateContacts || [],
      tradeLicenseNumber: tradeLicenseNumber || null,
      businessRegistrationNumber: businessRegistrationNumber || null,
      taxIdentificationNumber: taxIdentificationNumber || null,

      // System fields
      applicationStep: 8, // Completed all steps
      completedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
      submittedAt: new Date()
    });

    // Create vendor + generate code atomically. If the unique index on
    // vendorCode rejects our code (counter drifted vs existing rows), self-heal
    // by reconciling the counter to max(existing sequence) + 1 and retry once.
    async function createVendorWithCode() {
      try {
        return await prisma.$transaction(async (tx) => {
          const code = await generateVendorCode(tx);
          return tx.vendor.create({ data: buildVendorData(code) });
        });
      } catch (err) {
        const isDuplicateCode =
          err?.code === 'P2002' &&
          (err.meta?.target === 'vendorCode' ||
            (Array.isArray(err.meta?.target) && err.meta.target.includes('vendorCode')));
        if (!isDuplicateCode) throw err;

        console.warn('vendorCode collision detected — reconciling counter and retrying');
        const code = await reconcileAndGenerate();
        return prisma.vendor.create({ data: buildVendorData(code) });
      }
    }

    const vendor = await createVendorWithCode();

    // Register any vendor-proposed ("Other") categories as PENDING rows in the
    // master taxonomy so they show up in the admin Categories review queue.
    // Invisible to the storefront until an admin approves or merges them.
    await syncVendorCustomCategories(vendor.id, resolvedAdditionalCategories);

    // ── Certifications (Step 6) ─────────────────────────────────────────
    // Two sources feed into VendorCertification:
    //  1. Catalog certs selected via checkbox — `parsedSelectedCertifications`
    //     is an array of cert ids (oeko-tex, gots, iso-9001, …). The id is
    //     mapped to a friendly name via CERT_NAME_MAP so the DB stores
    //     "ISO 9001" not "ISO-9001". Unknown ids fall back to ID.toUpperCase().
    //  2. User-defined custom certs — `parsedOtherCertifications` is an
    //     array of { id, name, description }. These get isCustom=true so
    //     admins can distinguish them from catalog entries.
    const CERT_NAME_MAP = {
      'oeko-tex': 'OEKO-TEX',
      'gots': 'GOTS',
      'grs': 'GRS',
      'smeta': 'SMETA / Sedex',
      'iso-9001': 'ISO 9001',
      'iso-14001': 'ISO 14001',
      'bsci': 'BSCI',
      'fsc': 'FSC',
      'fair-trade': 'Fair Trade',
      'wrap': 'WRAP',
      'bci': 'BCI',
    };

    // issuedBy is now nullable — leave it null on both paths. The
    // `isCustom` flag is the proper signal for "vendor-declared vs catalog";
    // the old "Certification Authority" / "Vendor-provided" placeholder
    // strings carried no actual issuer information.
    const catalogCertRows = (parsedSelectedCertifications || []).map((certId) => ({
      vendorId: vendor.id,
      name: CERT_NAME_MAP[certId] || String(certId).toUpperCase(),
      issuedBy: null,
      expiryDate: parsedCertificationExpiryDates?.[certId]
        ? new Date(parsedCertificationExpiryDates[certId])
        : null,
      documentUrl: certificationFileUrls[certId] || null,
      isCustom: false,
    }));

    const customCertRows = Array.isArray(parsedOtherCertifications)
      ? parsedOtherCertifications
          .filter((c) => c && c.name && String(c.name).trim().length > 0)
          .map((c) => ({
            vendorId: vendor.id,
            name: String(c.name).trim(),
            issuedBy: null,
            description: c.description ? String(c.description).trim() : null,
            // The form collects an expiry date AND a certificate file for
            // each custom cert (same UI as catalog rows). Both live in the
            // shared maps keyed by the custom cert's own id; pull them out
            // here so they actually persist to the row.
            expiryDate: parsedCertificationExpiryDates?.[c.id]
              ? new Date(parsedCertificationExpiryDates[c.id])
              : null,
            documentUrl: certificationFileUrls[c.id] || null,
            isCustom: true,
          }))
      : [];

    const allCertRows = [...catalogCertRows, ...customCertRows];
    if (allCertRows.length > 0) {
      await prisma.vendorCertification.createMany({ data: allCertRows });
    }

    // Create documents
    const documents = [];

    if (gstDocumentUrl) {
      documents.push({
        vendorId: vendor.id,
        type: 'GST_CERTIFICATE',
        name: 'GST Certificate',
        documentUrl: gstDocumentUrl
      });
    }

    if (panCardUrl) {
      documents.push({
        vendorId: vendor.id,
        type: 'PAN_CARD',
        name: 'PAN Card',
        documentUrl: panCardUrl
      });
    }

    if (typeCertUrl) {
      // Stored under COMPANY_REGISTRATION since the actual document type
      // varies by businessType (IEC / CIN / Partnership Deed / LLPIN). The
      // `name` field carries the human-readable label for admins.
      const certLabelMap = {
        'proprietorship': 'IEC Certificate',
        'pvt-ltd': 'CIN Certificate',
        'partnership-firm': 'Partnership Deed Certificate',
        'llp': 'LLPIN Certificate',
      };
      documents.push({
        vendorId: vendor.id,
        type: 'COMPANY_REGISTRATION',
        name: certLabelMap[businessType] || 'Business Registration Certificate',
        documentUrl: typeCertUrl
      });
    }

    if (aadhaarUrl) {
      documents.push({
        vendorId: vendor.id,
        type: 'AADHAAR_CARD',
        name: 'Aadhaar Card',
        documentUrl: aadhaarUrl
      });
    }

    if (iecCertUrl) {
      documents.push({
        vendorId: vendor.id,
        type: 'EXPORT_LICENSE',
        name: 'IEC Certificate',
        documentUrl: iecCertUrl
      });
    }

    if (factoryImageUploads.length > 0) {
      factoryImageUploads.forEach(({ url, slotId }, index) => {
        documents.push({
          vendorId: vendor.id,
          type: 'OTHER',
          name: FACTORY_SLOT_LABEL_MAP[slotId] || `Factory Image ${index + 1}`,
          documentUrl: url,
        });
      });
    }

    if (factorySiteImageUploads.length > 0) {
      factorySiteImageUploads.forEach(({ url, slotId }, index) => {
        documents.push({
          vendorId: vendor.id,
          type: 'OTHER',
          name: FACTORY_SITE_SLOT_LABEL_MAP[slotId] || `Factory Site Image ${index + 1}`,
          documentUrl: url,
        });
      });
    }

    if (documents.length > 0) {
      await prisma.vendorDocument.createMany({
        data: documents
      });
    }

    // ── Bank details (Step 7) ───────────────────────────────────────────
    // Persist honestly: the form collects bankName, accountNumber, swiftCode,
    // and iban — everything else stays null until the form (or admin UI)
    // adds the relevant fields. Previously the controller put `swiftCode`
    // into the `ifscCode` column (mislabeled), invented a `branchName`
    // from concatenation, copied the company address into `branchAddress`,
    // hardcoded `accountType: 'Current'`, and left `accountHolderName`
    // unset entirely — which would throw because the column was non-null.
    if (parsedBankingDetails && parsedBankingDetails.bankName) {
      await prisma.vendorBankDetails.create({
        data: {
          vendorId: vendor.id,
          bankName: parsedBankingDetails.bankName,
          accountNumber: parsedBankingDetails.accountNumber || '',
          swiftCode: parsedBankingDetails.swiftCode || null,
          iban: parsedBankingDetails.iban || null,
          ifscCode: parsedBankingDetails.ifscCode || null,
          accountType: parsedBankingDetails.accountType || null,
          accountHolderName: parsedBankingDetails.accountHolderName || null,
          branchName: parsedBankingDetails.branchName || null,
          branchAddress: parsedBankingDetails.branchAddress || null,
        },
      });
    }

    // Note: alternate contacts are NOT duplicated into VendorReference rows.
    // Earlier code created reference rows from `parsedAlternateContacts`, but
    // (a) VendorReference is for *external trade references* (Clients /
    // Suppliers / Partners), not the vendor's own additional contacts, and
    // (b) the alt contact data is already persisted in full on the vendor
    // row's `alternateContacts` Json[] column. Keep the model unused here
    // and reserve it for an actual references feature later.

    // Generate JWT token for vendor
    const token = jwt.sign(
      { vendorId: vendor.id, type: 'vendor' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Notify admins about new vendor registration
    const { createNotificationForRole: notifyAdminsReg } = require('./notificationController');
    notifyAdminsReg({
      role: 'ADMIN', type: 'NEW_VENDOR_REGISTRATION',
      title: 'New Vendor Registration',
      message: `${vendor.companyName} has submitted a vendor registration.`,
      data: { vendorId: vendor.id }
    }).catch(() => { });

    // Send email to all admins about new registration
    sendNewVendorRegistrationEmailToAdmins({
      companyName: vendor.companyName,
      ownerName: vendor.ownerName || ownerName,
      vendorEmail: vendor.email,
      vendorPhone: vendor.businessPhone,
      city: vendor.businessCity,
      state: vendor.businessState
    }).catch(() => { });

    // Spend the email-verification code now that the vendor exists, so it
    // can't be reused for another registration.
    if (registrationOtp) await consumeOtp(registrationOtp.id);

    // Auto-start any workflow configured to trigger on vendor submission.
    // Fire-and-forget: never blocks or breaks registration.
    const { triggerWorkflowEvent } = require('../utils/workflowEvents');
    triggerWorkflowEvent('vendor.submitted', {
      subjectType: 'VENDOR', subjectId: vendor.id, subjectLabel: vendor.companyName,
      initiatedById: req.user?.id || null, initiatedByName: req.user?.name || vendor.companyName,
      data: { vendorCode: vendor.vendorCode, ownerName: vendor.ownerName },
    });

    res.status(201).json({
      message: 'Vendor registration submitted successfully',
      vendor: {
        id: vendor.id,
        email: vendor.email,
        companyName: vendor.companyName,
        status: vendor.status,
        submittedAt: vendor.submittedAt
      },
      token
    });

  } catch (error) {
    console.error('Vendor registration error:', error);
    // Any failure after files were uploaded leaves orphans in Cloudinary.
    // `uploadedPublicIds` is hoisted to function scope above the try so
    // it's always accessible here, even when the failure happens before
    // the inner upload block runs (in which case the array is empty and
    // cleanup is a no-op).
    cleanupOrphanedCloudinaryAssets(uploadedPublicIds);
    res.status(500).json({
      error: 'Internal server error during vendor registration',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get vendor profile
const getVendorProfile = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        certifications: true,
        documents: true,
        bankDetails: true,
        references: true
      }
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json({
      vendor: {
        ...vendor,
        password: undefined // Don't send password
      }
    });

  } catch (error) {
    console.error('Get vendor profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update vendor profile
const updateVendorProfile = async (req, res) => {
  try {
    const vendorId = req.user.vendorId || req.user.id;
    const updateData = req.body;

    // Remove sensitive fields that shouldn't be updated directly
    delete updateData.id;
    delete updateData.password;
    delete updateData.status;
    delete updateData.approvedAt;
    delete updateData.rejectedAt;

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: updateData,
      include: {
        certifications: true,
        documents: true,
        bankDetails: true,
        references: true
      }
    });

    res.json({
      message: 'Vendor profile updated successfully',
      vendor: {
        ...vendor,
        password: undefined
      }
    });

  } catch (error) {
    console.error('Update vendor profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all vendors (Admin only)
const getAllVendors = async (req, res) => {
  try {
    const { status, page = 1, limit = 10, search, dateFrom, dateTo } = req.query;

    const where = {};

    if (status) {
      where.status = status.toUpperCase();
    }

    if (search) {
      where.OR = [
        { companyName: { contains: search, mode: 'insensitive' } },
        { ownerName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { vendorCode: { contains: search, mode: 'insensitive' } },
        // GST Number is the primary unique key for registered vendors — include
        // it in the search so admins can look up vendors directly by GST.
        { gstNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom + 'T00:00:00.000Z');
      if (dateTo) where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

    const vendors = await prisma.vendor.findMany({
      where,
      include: {
        certifications: true,
        documents: true,
        assignedQc: true,
        // Bank verification status powers the "bank details need verification"
        // row alert in the admin vendors table.
        bankDetails: { select: { isVerified: true } },
        inspections: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          // scheduledDate/Time/estimatedDuration let the admin UI flag an
          // IN_PROGRESS inspection as "Overtime" once its booked window elapses.
          select: {
            id: true, status: true, result: true, completedAt: true,
            scheduledDate: true, scheduledTime: true, estimatedDuration: true,
          },
        },
        _count: {
          select: {
            certifications: true,
            documents: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    const total = await prisma.vendor.count({ where });

    // Fetch category names for the IDs in productCategories and productTypes
    const allCategoryIds = [...new Set([
      ...vendors.flatMap(v => v.productCategories || []),
      ...vendors.flatMap(v => v.productTypes || [])
    ])].filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id));

    let categoryMap = {};
    if (allCategoryIds.length > 0) {
      const categories = await prisma.category.findMany({
        where: { id: { in: allCategoryIds } },
        select: { id: true, name: true }
      });
      categoryMap = categories.reduce((acc, cat) => {
        acc[cat.id] = cat.name;
        return acc;
      }, {});
    }

    // Map Category IDs to Category Names, dropping any unresolved ObjectIds so
    // raw 24-hex strings never leak into the API response.
    const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
    const resolveAndClean = (values) =>
      (values || [])
        .map(v => categoryMap[v] || v)
        .filter(v => !OBJECT_ID_RE.test(v));

    const formattedVendors = vendors.map(vendor => {
      const { inspections, ...rest } = vendor;

      // Mirror the step-count formula used by VendorPanel.tsx and AddEditVendor.tsx
      // so the admin list always shows the same percentage as the registration sidebar.
      //
      // Vendors submitted via the vendor portal store completedSteps as 1-indexed
      // [1..8]; vendors saved via the admin edit form store 0-indexed [0..7].
      // Detect by checking whether any stored value equals 8 (impossible in
      // 0-indexed where the max step index is 7).
      let completionPercentage;
      const rawCompleted = Array.isArray(vendor.completedSteps) ? vendor.completedSteps : [];

      if (rawCompleted.length > 0) {
        const isOneIndexed = rawCompleted.some(s => s >= 8);
        const storedCompletedSteps = isOneIndexed ? rawCompleted.map(s => s - 1) : rawCompleted;
        const rawAppStep = typeof vendor.applicationStep === 'number' ? vendor.applicationStep : 0;
        const currentStep = rawAppStep >= 8 ? rawAppStep - 1 : rawAppStep;

        const isManufacturerVendor = vendor.vendorType === 'manufacturer' ||
          (Array.isArray(vendor.vendorType) && vendor.vendorType.includes('manufacturer'));

        const isStepSkipped = (idx) =>
          idx === 4 &&
          storedCompletedSteps.includes(3) &&
          !isManufacturerVendor;

        const TOTAL_STEPS = 8;
        const visibleStepCount = Array.from({ length: TOTAL_STEPS }, (_, i) => i)
          .filter(i => !isStepSkipped(i)).length;

        // "Review & Submit" (step 7, 0-indexed) is always treated as in-progress
        // (0.4 partial credit) rather than fully complete. This ensures the admin
        // list shows the same ~91–93% the vendor form displayed right before the
        // checker clicked Submit, rather than jumping to 100% on registration alone.
        const SUBMIT_STEP = 7;
        const completedExcludingSubmit = storedCompletedSteps.filter(i => i !== SUBMIT_STEP);
        const submitStepCredit = storedCompletedSteps.includes(SUBMIT_STEP) && !isStepSkipped(SUBMIT_STEP) ? 0.4 : 0;
        const completedVisibleCount = completedExcludingSubmit.filter(i => !isStepSkipped(i)).length;
        // inProgressCredit for intermediate steps (vendor hasn't reached submit yet)
        const inProgressCredit =
          currentStep !== SUBMIT_STEP &&
          !isStepSkipped(currentStep) &&
          !completedExcludingSubmit.includes(currentStep) ? 0.4 : 0;
        completionPercentage = Math.min(99, Math.round(
          ((completedVisibleCount + submitStepCredit + inProgressCredit) / visibleStepCount) * 100
        ));
      } else {
        // Fallback: field-completeness for vendors without stored step data
        // (in-progress vendor-portal registrations or imported records).
        const hasValue = (v) => v !== null && v !== undefined && v !== '' && v !== 0;
        const hasArray = (v) => Array.isArray(v) && v.length > 0;
        const hasObj = (v) => v && typeof v === 'object' && Object.keys(v).length > 0;

        const sections = [
          {
            fields: [vendor.companyName, vendor.gstNumber, vendor.businessEmail, vendor.businessPhone, vendor.businessAddress, vendor.businessCity, vendor.businessState, vendor.businessCountry],
            check: (f) => f.filter(hasValue).length / f.length
          },
          {
            fields: [vendor.warehouseAddress, vendor.warehouseCity, vendor.warehouseState, vendor.warehouseCountry],
            check: (f) => f.filter(hasValue).length / f.length
          },
          {
            fields: [vendor.ownerName, vendor.ownerEmail, vendor.ownerPhone, vendor.establishedYear, vendor.annualTurnover],
            check: (f) => f.filter(hasValue).length / f.length
          },
          {
            fields: [vendor.vendorType, vendor.productCategories],
            check: () => {
              let score = 0, total = 2;
              if (hasValue(vendor.vendorType)) score++;
              if (hasArray(vendor.productCategories)) score++;
              return score / total;
            }
          },
          {
            fields: [],
            check: () => {
              const isManufacturer = vendor.vendorType === 'manufacturer' || (Array.isArray(vendor.vendorType) && vendor.vendorType.includes('manufacturer'));
              if (!isManufacturer) return 1;
              return hasObj(vendor.facilityDetails) ? 1 : 0;
            }
          },
          {
            fields: [],
            check: () => {
              let score = 0, total = 2;
              if (vendor.certifications && vendor.certifications.length > 0) score++;
              if (hasArray(vendor.shippingMethods)) score++;
              return score / total;
            }
          },
          {
            fields: [],
            check: () => {
              if (!vendor.mainContact) return 0;
              const mc = typeof vendor.mainContact === 'string' ? JSON.parse(vendor.mainContact) : vendor.mainContact;
              const contactFields = [mc.name, mc.email || mc.email1, mc.phone || mc.phone1, mc.department];
              return contactFields.filter(hasValue).length / contactFields.length;
            }
          },
          {
            fields: [],
            check: () => hasValue(vendor.submittedAt) ? 1 : 0
          }
        ];
        const sectionScores = sections.map(s => typeof s.check === 'function' ? s.check(s.fields) : 0);
        completionPercentage = Math.round((sectionScores.reduce((sum, s) => sum + s, 0) / sections.length) * 100);
      }

      // Workflow-stage overrides — 100% is reserved for admin approval only.
      // QC milestones add increments above the registration submission baseline.
      let finalCompletionPercentage;
      if (vendor.status === 'APPROVED') {
        finalCompletionPercentage = 100;
      } else if (inspections?.[0]?.status === 'COMPLETED') {
        finalCompletionPercentage = Math.max(completionPercentage, 98);
      } else if (vendor.assignedQcId) {
        finalCompletionPercentage = Math.max(completionPercentage, 95);
      } else {
        finalCompletionPercentage = completionPercentage;
      }

      return {
        ...rest,
        productCategories: resolveAndClean(vendor.productCategories),
        productTypes: resolveAndClean(vendor.productTypes),
        latestInspection: inspections?.[0] || null,
        completionPercentage: finalCompletionPercentage,
        password: undefined,
      };
    });

    // Resolve employee names for pending approval/rejection requests
    const requestedByIds = [
      ...formattedVendors.map(v => v.approvalRequestedBy),
      ...formattedVendors.map(v => v.rejectionRequestedBy)
    ].filter(Boolean);

    let adminNameMap = {};
    if (requestedByIds.length > 0) {
      const admins = await prisma.admin.findMany({
        where: { id: { in: [...new Set(requestedByIds)] } },
        select: { id: true, name: true, email: true }
      });
      adminNameMap = admins.reduce((acc, a) => { acc[a.id] = a.name || a.email; return acc; }, {});
    }

    const vendorsWithNames = formattedVendors.map(v => ({
      ...v,
      approvalRequestedByName: v.approvalRequestedBy ? (adminNameMap[v.approvalRequestedBy] || 'Unknown') : null,
      rejectionRequestedByName: v.rejectionRequestedBy ? (adminNameMap[v.rejectionRequestedBy] || 'Unknown') : null,
    }));

    res.json({
      vendors: vendorsWithNames,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get all vendors error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single vendor by ID (Admin only)
const getVendorById = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        certifications: true,
        documents: true,
        bankDetails: true,
        _count: {
          select: {
            certifications: true,
            documents: true
          }
        }
      }
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

    const idsToFetch = [...new Set([
      ...(vendor.productCategories || []),
      ...(vendor.productTypes || [])
    ])].filter(id => typeof id === 'string' && OBJECT_ID_RE.test(id));

    let categoryMap = {};
    if (idsToFetch.length > 0) {
      const categories = await prisma.category.findMany({
        where: { id: { in: idsToFetch } },
        select: { id: true, name: true }
      });
      categoryMap = categories.reduce((acc, cat) => {
        acc[cat.id] = cat.name;
        return acc;
      }, {});
    }

    // Resolve IDs to names and drop any unresolved ObjectIds so raw 24-hex
    // strings never leak into the API response.
    const resolveAndClean = (values) =>
      (values || [])
        .map(v => categoryMap[v] || v)
        .filter(v => !OBJECT_ID_RE.test(v));

    // Resolve employee names for pending requests
    let approvalRequestedByName = null;
    let rejectionRequestedByName = null;
    const requestIds = [vendor.approvalRequestedBy, vendor.rejectionRequestedBy].filter(Boolean);
    if (requestIds.length > 0) {
      const admins = await prisma.admin.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, name: true, email: true }
      });
      const nameMap = admins.reduce((acc, a) => { acc[a.id] = a.name || a.email; return acc; }, {});
      if (vendor.approvalRequestedBy) approvalRequestedByName = nameMap[vendor.approvalRequestedBy] || 'Unknown';
      if (vendor.rejectionRequestedBy) rejectionRequestedByName = nameMap[vendor.rejectionRequestedBy] || 'Unknown';
    }

    res.json({
      vendor: {
        ...vendor,
        productCategories: resolveAndClean(vendor.productCategories),
        productTypes: resolveAndClean(vendor.productTypes),
        approvalRequestedByName,
        rejectionRequestedByName,
        password: undefined
      }
    });

  } catch (error) {
    console.error('Get vendor by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update vendor by ID (Admin only)
const updateVendorById = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const updateData = req.body;

    console.log('Admin updating vendor:', vendorId);
    console.log('Update data received:', updateData);
    console.log('Files received:', req.files);

    // Check if vendor exists
    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        certifications: true
      }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // ── Uniqueness checks when the admin changes GST or email ───────────
    // GST is the primary unique key for registered vendors. If the admin is
    // setting/changing the GST, verify it isn't already taken by a DIFFERENT
    // vendor. Same guard for email (login identifier, @unique in schema).
    const incomingGst = updateData.gstNumber ? updateData.gstNumber.trim().toUpperCase() : '';
    if (incomingGst && incomingGst !== (existingVendor.gstNumber || '').trim().toUpperCase()) {
      const takenByGst = await prisma.vendor.findFirst({
        where: { gstNumber: incomingGst, NOT: { id: vendorId } },
        select: { id: true, companyName: true }
      });
      if (takenByGst) {
        return res.status(409).json({
          code: 'DUPLICATE_GST',
          field: 'gstNumber',
          error: `GST Number ${incomingGst} is already assigned to vendor "${takenByGst.companyName}".`
        });
      }
    }

    const incomingEmail = updateData.email ? updateData.email.trim().toLowerCase() : '';
    if (incomingEmail && incomingEmail !== (existingVendor.email || '').trim().toLowerCase()) {
      const takenByEmail = await prisma.vendor.findFirst({
        where: { email: incomingEmail, NOT: { id: vendorId } },
        select: { id: true, companyName: true }
      });
      if (takenByEmail) {
        return res.status(409).json({
          code: 'DUPLICATE_EMAIL',
          field: 'email',
          error: `Email ${incomingEmail} is already registered to vendor "${takenByEmail.companyName}".`
        });
      }
    }

    // ── Optional password reset by admin ─────────────────────────────
    // The edit form lets the admin replace the vendor's password from
    // Step 1 (Account Security). Empty value = keep the current bcrypt
    // hash; non-empty = bcrypt the new value and overwrite. We hash
    // upfront so the value flows into `vendorUpdateData` below the same
    // way every other column does. Stripped from `updateData` so the
    // raw plaintext never accidentally lands anywhere downstream.
    let adminPasswordHash = null;
    if (updateData.password && typeof updateData.password === 'string' && updateData.password.length >= 8) {
      adminPasswordHash = await bcrypt.hash(updateData.password, 12);
    }
    delete updateData.password;

    // ── Admin re-uploads of Step 1 files ──────────────────────────────
    // Mirror what registerVendor does for logo / GST / PAN / type cert.
    // Previously updateVendorById parsed these via multer but ignored
    // them — admin uploads silently disappeared. Now: new logo overwrites
    // `companyLogo`; new GST / PAN / type cert documents replace the
    // existing VendorDocument row of the same type. Missing fields leave
    // the existing doc/URL untouched.
    let adminLogoUrl = null;
    if (req.files?.logo?.[0]) {
      const logoResult = await uploadFiles([req.files.logo[0]], 'vendor-logos');
      adminLogoUrl = logoResult[0].cloudinaryUrl;
    }

    const replaceVendorDoc = async (uploadField, docType, folder, displayName) => {
      if (!req.files?.[uploadField]?.[0]) return;
      const result = await uploadFiles([req.files[uploadField][0]], folder);
      await prisma.vendorDocument.deleteMany({
        where: { vendorId, type: docType },
      });
      await prisma.vendorDocument.create({
        data: {
          vendorId,
          type: docType,
          name: displayName,
          documentUrl: result[0].cloudinaryUrl,
        },
      });
    };

    // Type-specific cert label depends on the (possibly just-updated)
    // businessType from the request body — falls back to existing.
    const businessTypeForCertLabel =
      updateData.businessType || existingVendor.businessType || '';
    const certLabelByType = {
      'proprietorship': 'IEC Certificate',
      'pvt-ltd': 'CIN Certificate',
      'partnership-firm': 'Partnership Deed Certificate',
      'llp': 'LLPIN Certificate',
    };
    const typeCertDisplayName =
      certLabelByType[businessTypeForCertLabel] || 'Business Registration Certificate';

    try {
      await replaceVendorDoc('gstDocument', 'GST_CERTIFICATE', 'vendor-documents/gst', 'GST Certificate');
      await replaceVendorDoc('panCardFile', 'PAN_CARD', 'vendor-documents/pan', 'PAN Card');
      await replaceVendorDoc('typeCertFile', 'COMPANY_REGISTRATION', 'vendor-documents/business-cert', typeCertDisplayName);
      await replaceVendorDoc('aadhaarFile', 'AADHAAR_CARD', 'vendor-documents/aadhaar', 'Aadhaar Card');
      await replaceVendorDoc('iecCertFile', 'EXPORT_LICENSE', 'vendor-documents/iec', 'IEC Certificate');
    } catch (uploadError) {
      console.error('Admin document upload error:', uploadError);
      return res.status(500).json({
        error: 'Failed to upload documents: ' + uploadError.message,
      });
    }

    // Handle file uploads for certificates
    let certificationFileUrls = {};
    if (req.files?.certificationFiles) {
      try {
        const certResults = await uploadFiles(req.files.certificationFiles, 'vendor-certifications');
        // Map certification files to their respective certification IDs
        certResults.forEach((result, index) => {
          const certId = req.body[`certificationId_${index}`];
          if (certId) {
            certificationFileUrls[certId] = result.cloudinaryUrl;
          }
        });
        console.log('Uploaded certification files:', certificationFileUrls);
      } catch (uploadError) {
        console.error('Certificate file upload error:', uploadError);
        return res.status(500).json({
          error: 'Failed to upload certificate files: ' + uploadError.message
        });
      }
    }

    // Parse JSON fields if they're strings (safeJsonParse handles empty-
    // string payloads from FormData without throwing).
    const parsedSelectedCertifications = safeJsonParse(updateData.selectedCertifications);
    const parsedCertificationExpiryDates = safeJsonParse(updateData.certificationExpiryDates);
    const parsedSelectedCategories = safeJsonParse(updateData.selectedCategories);
    const parsedMarketType = safeJsonParse(updateData.marketType);
    const parsedVendorType = safeJsonParse(updateData.vendorType);
    const parsedShippingMethods = safeJsonParse(updateData.shippingMethods);
    const parsedExportCountries = safeJsonParse(updateData.exportCountries);
    const parsedImportCountries = safeJsonParse(updateData.importCountries);
    const parsedOtherCertifications = safeJsonParse(updateData.otherCertifications);
    const parsedCategoryProducts = safeJsonParse(updateData.categoryProducts);
    const parsedAdditionalCategories = safeJsonParse(updateData.additionalCategories);
    const parsedBankingDetails = safeJsonParse(updateData.bankingDetails);

    // Resolve any base64 product photos to Cloudinary URLs before persist —
    // same pipeline as the registration flow uses for Step 4 photos.
    const resolvedCategoryProducts = await resolveBase64InValue(
      parsedCategoryProducts,
      { folder: 'vendor-product-photos', resource_type: 'image' },
    );
    const resolvedAdditionalCategories = await resolveBase64InValue(
      parsedAdditionalCategories,
      { folder: 'vendor-product-photos', resource_type: 'image' },
    );

    // Same resolve for the main contact / alternate contact photo fields.
    // The form stores re-uploaded photos as base64 data URIs inside
    // `mainContact.photo` (and `alternateContacts[].photo`); without this,
    // the entire data URI gets persisted into the JSON column and reloaded
    // on every profile view — both bloats the DB and breaks the photo
    // preview in admin UIs that expect a real URL.
    const rawParsedMainContact = safeJsonParse(updateData.mainContact);
    const rawParsedAlternateContacts = safeJsonParse(updateData.alternateContacts) || [];
    const resolvedMainContact = await resolveBase64InValue(rawParsedMainContact, {
      folder: 'vendor-contact-photos',
      resource_type: 'image',
    });
    const resolvedAlternateContacts = await resolveBase64InValue(rawParsedAlternateContacts, {
      folder: 'vendor-contact-photos',
      resource_type: 'image',
    });
    // Additional owners carry a per-owner profile photo as a base64 data URI
    // (`additionalOwners[].photo`) — resolve to Cloudinary URLs like above.
    const resolvedAdditionalOwners =
      updateData.additionalOwners !== undefined
        ? await resolveBase64InValue(safeJsonParse(updateData.additionalOwners), {
            folder: 'vendor-owner-photos',
            resource_type: 'image',
          })
        : undefined;

    // Mirror registration path: keep the raw multi-select array alongside
    // the legacy single-enum derivation so multi-role vendors aren't lossy.
    const vendorTypesArray = Array.isArray(parsedVendorType)
      ? parsedVendorType.filter((v) => typeof v === 'string' && v.length > 0)
      : parsedVendorType
        ? [parsedVendorType]
        : [];

    // Parse businessStartDate + derive establishedYear (same pattern as
    // registerVendor — full date column preferred, year-only for back-compat).
    const parsedBusinessStartDate = updateData.businessStartDate
      ? new Date(updateData.businessStartDate)
      : null;
    const businessStartDateValid =
      parsedBusinessStartDate && !isNaN(parsedBusinessStartDate.getTime());
    const derivedEstablishedYear = businessStartDateValid
      ? parsedBusinessStartDate.getFullYear()
      : updateData.yearEstablished
        ? parseInt(updateData.yearEstablished, 10)
        : null;

    // Production capacity summary derived from enabled facilities — same
    // helper logic as registerVendor (find *Capacity keys per facility).
    const buildProductionCapacityForUpdate = () => {
      const enabledRaw = safeJsonParse(updateData.enabledFacilities);
      const detailsRaw = safeJsonParse(updateData.facilityDetails);
      if (!detailsRaw || typeof detailsRaw !== 'object') return null;
      const enabled = enabledRaw || {};
      const parts = [];
      for (const [facilityId, details] of Object.entries(detailsRaw)) {
        if (!enabled[facilityId]) continue;
        if (!details || typeof details !== 'object') continue;
        const capacityKey = Object.keys(details).find((k) => k.endsWith('Capacity'));
        const capacityValue = capacityKey ? details[capacityKey] : null;
        if (capacityValue) parts.push(`${facilityId}: ${capacityValue} kg/day`);
      }
      return parts.length > 0 ? parts.join(', ') : null;
    };
    const updateProductionCapacity = buildProductionCapacityForUpdate();

    // Normalize categories to names so the DB never stores raw ObjectIds.
    const normalizedProductCategories = await normalizeCategoryValues(
      Object.keys(parsedSelectedCategories || {})
    );
    const normalizedProductTypes = await normalizeCategoryValues(
      Object.values(parsedSelectedCategories || {}).flat()
    );

    // Prepare update data - map form fields to database fields
    const vendorUpdateData = {
      // Conditionally include the new password hash. Spreading an empty
      // object when the admin didn't supply a new password leaves the
      // existing column untouched — Prisma only writes the keys present
      // in the data object, so the bcrypt hash is preserved across edits
      // that don't touch Account Security.
      ...(adminPasswordHash ? { password: adminPasswordHash } : {}),

      // Replace the companyLogo URL only when the admin uploaded a new
      // file. Without this, an empty edit would leave the column alone.
      ...(adminLogoUrl ? { companyLogo: adminLogoUrl } : {}),

      // Company Details
      companyName: updateData.companyName,
      businessType: updateData.businessType || null,
      gstNumber: updateData.gstNumber || null,
      companyIdNumber: updateData.companyIdNumber || null,
      iecCode: updateData.iecCode || null,
      panNumber: updateData.panNumber || null,
      aadhaarNumber: updateData.aadhaarNumber || null,
      businessEmail: updateData.email,
      businessEmail2: updateData.email2 || null,
      businessPhone: updateData.phone,
      landlineNumber: updateData.landlineNumber || null,
      localLandlineStd: updateData.localLandlineStd || null,
      intlLandline: updateData.intlLandline || null,
      phoneNumber2: updateData.phoneNumber2 || null,
      website: updateData.website,
      businessAddress: updateData.address,
      addressLine2: updateData.addressLine2 || null,
      addressLine3: updateData.addressLine3 || null,
      landmark: updateData.landmark || null,
      businessCity: updateData.city,
      businessState: updateData.state,
      businessZipCode: updateData.zipCode || null,
      businessCountry: updateData.country || 'India',
      factoryOwnershipType: updateData.factoryOwnershipType || null,

      // Acquisition — same normalisation as registration so an admin edit and a
      // self-registration can never store the channel in two different shapes.
      referralSource: REFERRAL_SOURCES.has(updateData.referralSource)
        ? updateData.referralSource
        : (updateData.referralSource ? 'others' : null),
      referralSourceDetail: (updateData.referralSourceDetail && String(updateData.referralSourceDetail).trim())
        || (updateData.referralSource && !REFERRAL_SOURCES.has(updateData.referralSource)
          ? String(updateData.referralSource).trim()
          : null)
        || null,

      // Owner Profile
      ownerName: updateData.ownerName,
      designation: updateData.designation || null,
      ownerEmail: updateData.ownerEmail,
      ownerEmail2: updateData.ownerEmail2 || null,
      ownerPhone: updateData.ownerPhone,
      ownerPhone2: updateData.ownerPhone2 || null,
      ownerLandline: updateData.ownerLandline || null,
      ownerLocalLandlineStd: updateData.ownerLocalLandlineStd || null,
      ownerIntlLandline: updateData.ownerIntlLandline || null,
      ...(resolvedAdditionalOwners !== undefined && {
        additionalOwners: resolvedAdditionalOwners
      }),
      businessStartDate: businessStartDateValid ? parsedBusinessStartDate : null,
      establishedYear: derivedEstablishedYear,
      employeeCount: updateData.employeeCount || null,
      // annualTurnover deliberately not set here — the admin form doesn't
      // collect a real turnover value. The previous `employeeCount` proxy
      // was semantic nonsense ("10-20" is a headcount range, not money).

      // Warehouse Details
      ...(updateData.enabledFacilities !== undefined && {
        enabledFacilities: safeJsonParse(updateData.enabledFacilities)
      }),
      ...(updateData.facilityDetails !== undefined && {
        facilityDetails: safeJsonParse(updateData.facilityDetails)
      }),
      ownershipType: updateData.ownershipType || null,
      warehouseAddress: updateData.warehouseAddress,
      warehouseAddressLine2: updateData.warehouseAddressLine2 || null,
      warehouseAddressLine3: updateData.warehouseAddressLine3 || null,
      warehouseLandmark: updateData.warehouseLandmark || null,
      warehouseCity: updateData.warehouseCity,
      warehouseState: updateData.warehouseState,
      warehouseZipCode: updateData.warehouseZip || null,
      warehouseCountry: updateData.warehouseCountry || 'India',
      warehouseSize: updateData.warehousingCapacity ? `${updateData.warehousingCapacity} sq ft` : null,
      // Store the Legal Address & Factory Site (CompanyDetails `address`) in
      // factory* columns — the checker app reads these directly.
      factoryAddress: updateData.address || null,
      factoryCity: updateData.city || null,
      factoryState: updateData.state || null,
      factoryZipCode: updateData.zipCode || null,
      factorySize: updateData.factorySiteCapacity
        ? `${updateData.factorySiteCapacity} sq ft`
        : (updateData.warehousingCapacity ? `${updateData.warehousingCapacity} sq ft` : null),
      productionCapacity: updateProductionCapacity,
      storageCapacity: updateData.warehousingCapacity,
      mapLink: updateData.mapLink || null,
      ...resolveVendorCoordinates({
        latitude: updateData.latitude,
        longitude: updateData.longitude,
        mapLink: updateData.mapLink,
      }),
      ...resolveVendorCoordinates({
        latitude: updateData.warehouseLatitude,
        longitude: updateData.warehouseLongitude,
        latField: 'warehouseLatitude',
        lngField: 'warehouseLongitude',
      }),
      // Product-handling site (QC product-inspection geofence). Only update when the
      // admin form sent a value; normalise to WAREHOUSE/FACTORY.
      ...((updateData.productInspectionSites !== undefined || updateData.productInspectionSite !== undefined)
        ? (() => {
            const arr = normalizeInspectionSites(updateData.productInspectionSites, updateData.productInspectionSite);
            return { productInspectionSites: arr, productInspectionSite: arr[0] };
          })()
        : {}),

      // Vendor Type & Products
      // Mirror registerVendor: keep both legacy single-enum and the role
      // enum in sync with the multi-select array so admin edits propagate
      // through every downstream column (registerVendor sets both; the
      // previous update path left `companyType` stale).
      vendorType: getVendorTypeEnum(parsedVendorType),
      companyType: getCompanyTypeEnum(parsedVendorType),
      vendorTypes: vendorTypesArray,
      primaryMarkets: parsedMarketType || [],
      productCategories: normalizedProductCategories,
      productTypes: normalizedProductTypes,
      categoryRemarks: updateData.categoryRemarks || null,
      categoryProducts: resolvedCategoryProducts || null,
      additionalCategories: resolvedAdditionalCategories || null,

      // Logistics
      shippingMethods: parsedShippingMethods || [],
      qualityControl: updateData.qualityControlProcess || null,
      packagingCapabilities: updateData.packagingCapabilities || null,
      logisticsPartners: updateData.logisticsPartners || null,
      complianceStandards: updateData.complianceStandards || null,

      // Trade Info — mirror the registration-path derivation: either the
      // combined "yes" answer OR a non-empty country list flips the flag.
      importExperience:
        updateData.hasImportExport === 'yes' ||
        (Array.isArray(parsedImportCountries) && parsedImportCountries.length > 0),
      exportExperience:
        updateData.hasImportExport === 'yes' ||
        (Array.isArray(parsedExportCountries) && parsedExportCountries.length > 0),
      exportCountries: parsedExportCountries || [],
      importCountries: parsedImportCountries || [],

      // Contact & Trade Information — `resolvedMainContact` /
      // `resolvedAlternateContacts` come from the resolveBase64InValue
      // pass above so any newly-uploaded photos land in Cloudinary instead
      // of being stuffed as raw data URIs into the JSON column.
      mainContact: resolvedMainContact || null,
      alternateContacts: resolvedAlternateContacts || [],
      tradeLicenseNumber: updateData.tradeLicenseNumber || null,
      businessRegistrationNumber: updateData.businessRegistrationNumber || null,
      taxIdentificationNumber: updateData.taxIdentificationNumber || null,

      // Status (admin can update these)
      status: updateData.status?.toUpperCase() || existingVendor.status,

      // Step tracking — sent by the admin edit form so the vendor list shows
      // the same progress % as the sidebar showed during editing.
      ...(updateData.completedSteps !== undefined && {
        completedSteps: Array.isArray(updateData.completedSteps)
          ? updateData.completedSteps.map(Number)
          : (safeJsonParse(updateData.completedSteps) || []).map(Number)
      }),
      ...(updateData.applicationStep !== undefined && {
        applicationStep: typeof updateData.applicationStep === 'number'
          ? updateData.applicationStep
          : (parseInt(updateData.applicationStep, 10) || 0)
      })
    };

    // ── Bank details upsert (admin update path) ─────────────────────────
    // The previous version of this controller never touched bank info on
    // update — admin edits to bankName/accountNumber/swiftCode/iban were
    // silently dropped. Use upsert so the row is created on first save
    // and updated thereafter.
    //
    // IMPORTANT: only write the columns the caller actually sent. This block
    // used to null every column that was absent from the payload, which
    // destroyed data: the admin vendor form renders no bank inputs but still
    // round-trips a 4-key `bankingDetails` object, so any admin pressing Save
    // wiped accountHolderName / ifscCode / accountType / branchName /
    // branchAddress that the vendor had entered via the vendor portal.
    // A partial payload must never be treated as "clear the rest".
    if (parsedBankingDetails && parsedBankingDetails.bankName) {
      const BANK_FIELDS = [
        'bankName', 'accountNumber', 'swiftCode', 'iban', 'ifscCode',
        'accountType', 'accountHolderName', 'branchName', 'branchAddress',
      ];

      const provided = {};
      for (const key of BANK_FIELDS) {
        const value = parsedBankingDetails[key];
        if (value === undefined) continue;        // not sent → leave column untouched
        provided[key] = value === '' ? null : value; // explicitly cleared → null
      }

      await prisma.vendorBankDetails.upsert({
        where: { vendorId },
        create: {
          vendorId,
          // bankName / accountNumber are non-nullable in the schema.
          bankName: parsedBankingDetails.bankName,
          accountNumber: parsedBankingDetails.accountNumber || '',
          ...provided,
        },
        update: provided,
      });
    }

    // ── Factory images update ──────────────────────────────────────────
    // Frontend sends:
    //   - `existingFactoryImages`: JSON array of URLs to preserve
    //   - `existingFactoryImageSlot_<i>`: slot id for each preserved URL
    //   - `factoryImages` (multer files): new uploads
    //   - `factoryImageSlot_<i>`: slot id for each new file (same pattern
    //     as registerVendor — see line ~327)
    //
    // The frontend ALWAYS sends `existingFactoryImages` (even when empty
    // as `"[]"`) so we can distinguish "admin didn't touch this section"
    // (key absent) from "admin removed everything" (key present, empty).
    // When the key is absent we leave existing rows untouched — fixes the
    // prior data-loss bug where every edit-save wiped all factory photos.
    const factoryImagesTouched = Object.prototype.hasOwnProperty.call(
      updateData,
      'existingFactoryImages',
    ) || !!req.files?.factoryImages;

    if (factoryImagesTouched) {
      const existingFactoryImages = updateData.existingFactoryImages
        ? (typeof updateData.existingFactoryImages === 'string'
            ? JSON.parse(updateData.existingFactoryImages)
            : updateData.existingFactoryImages)
        : [];

      // Upload new factory images, capturing slot identity per file.
      let newFactoryImageUploads = [];
      if (req.files?.factoryImages) {
        try {
          const factoryResults = await uploadFiles(req.files.factoryImages, 'vendor-factories');
          newFactoryImageUploads = factoryResults.map((result, index) => ({
            url: result.cloudinaryUrl,
            slotId: req.body[`factoryImageSlot_${index}`] || null,
          }));
        } catch (uploadError) {
          console.error('Factory image upload error:', uploadError);
          return res.status(500).json({
            error: 'Failed to upload factory images: ' + uploadError.message
          });
        }
      }

      // Delete warehouse-photo documents that are no longer in the preserved list.
      // Use startsWith + NOT startsWith "Factory Site" to avoid touching the
      // factory site photo rows that live under the same type='OTHER'.
      const currentFactoryDocs = await prisma.vendorDocument.findMany({
        where: {
          vendorId,
          type: 'OTHER',
          AND: [
            { name: { startsWith: 'Factory' } },
            { NOT: { name: { startsWith: 'Factory Site' } } },
          ],
        },
      });

      const docsToDelete = currentFactoryDocs.filter(
        doc => !existingFactoryImages.includes(doc.documentUrl)
      );
      if (docsToDelete.length > 0) {
        for (const doc of docsToDelete) {
          try {
            const publicId = doc.documentUrl.split('/').pop().split('.')[0];
            await deleteFromCloudinary(`vendor-factories/${publicId}`);
          } catch (deleteError) {
            console.warn('Failed to delete factory image from Cloudinary:', deleteError.message);
          }
        }
        await prisma.vendorDocument.deleteMany({
          where: { id: { in: docsToDelete.map(d => d.id) } }
        });
      }

      // Update names of preserved docs so each carries the current slot
      // label (admin may have moved a photo from one slot to another).
      for (let i = 0; i < existingFactoryImages.length; i++) {
        const url = existingFactoryImages[i];
        const slotId = req.body[`existingFactoryImageSlot_${i}`];
        const desiredName = FACTORY_SLOT_LABEL_MAP[slotId];
        if (!desiredName) continue;
        await prisma.vendorDocument.updateMany({
          where: { vendorId, documentUrl: url, type: 'OTHER' },
          data: { name: desiredName },
        });
      }

      // Create new factory image documents with proper slot-derived names.
      if (newFactoryImageUploads.length > 0) {
        const newDocs = newFactoryImageUploads.map(({ url, slotId }, index) => ({
          vendorId,
          type: 'OTHER',
          name: FACTORY_SLOT_LABEL_MAP[slotId] || `Factory Image ${index + 1}`,
          documentUrl: url,
        }));
        await prisma.vendorDocument.createMany({ data: newDocs });
      }
    }

    // ── Factory SITE images update ─────────────────────────────────────────
    // Same protocol as factory images above but for CompanyDetails photos.
    // Frontend sends existingFactorySiteImages + factorySiteImages files.
    const factorySiteImagesTouched = Object.prototype.hasOwnProperty.call(
      updateData,
      'existingFactorySiteImages',
    ) || !!req.files?.factorySiteImages;

    if (factorySiteImagesTouched) {
      const existingFactorySiteImages = updateData.existingFactorySiteImages
        ? (typeof updateData.existingFactorySiteImages === 'string'
            ? JSON.parse(updateData.existingFactorySiteImages)
            : updateData.existingFactorySiteImages)
        : [];

      let newFactorySiteImageUploads = [];
      if (req.files?.factorySiteImages) {
        try {
          const siteResults = await uploadFiles(req.files.factorySiteImages, 'vendor-factory-sites');
          newFactorySiteImageUploads = siteResults.map((result, index) => ({
            url: result.cloudinaryUrl,
            slotId: req.body[`factorySiteImageSlot_${index}`] || null,
          }));
        } catch (uploadError) {
          console.error('Factory site image upload error:', uploadError);
          return res.status(500).json({ error: 'Failed to upload factory site images: ' + uploadError.message });
        }
      }

      const currentFactorySiteDocs = await prisma.vendorDocument.findMany({
        where: { vendorId, type: 'OTHER', name: { startsWith: 'Factory Site' } },
      });

      const siteDocsToDelete = currentFactorySiteDocs.filter(
        doc => !existingFactorySiteImages.includes(doc.documentUrl),
      );
      if (siteDocsToDelete.length > 0) {
        for (const doc of siteDocsToDelete) {
          try {
            const publicId = doc.documentUrl.split('/').pop().split('.')[0];
            await deleteFromCloudinary(`vendor-factory-sites/${publicId}`);
          } catch (deleteError) {
            console.warn('Failed to delete factory site image from Cloudinary:', deleteError.message);
          }
        }
        await prisma.vendorDocument.deleteMany({
          where: { id: { in: siteDocsToDelete.map(d => d.id) } },
        });
      }

      for (let i = 0; i < existingFactorySiteImages.length; i++) {
        const url = existingFactorySiteImages[i];
        const slotId = req.body[`existingFactorySiteImageSlot_${i}`];
        const desiredName = FACTORY_SITE_SLOT_LABEL_MAP[slotId];
        if (!desiredName) continue;
        await prisma.vendorDocument.updateMany({
          where: { vendorId, documentUrl: url, type: 'OTHER' },
          data: { name: desiredName },
        });
      }

      if (newFactorySiteImageUploads.length > 0) {
        const newDocs = newFactorySiteImageUploads.map(({ url, slotId }, index) => ({
          vendorId,
          type: 'OTHER',
          name: FACTORY_SITE_SLOT_LABEL_MAP[slotId] || `Factory Site Image ${index + 1}`,
          documentUrl: url,
        }));
        await prisma.vendorDocument.createMany({ data: newDocs });
      }
    }

    // Handle product photos update (stored as VendorDocument with type 'PRODUCT_PHOTO')
    const existingProductPhotos = updateData.existingProductPhotos
      ? (typeof updateData.existingProductPhotos === 'string'
          ? JSON.parse(updateData.existingProductPhotos)
          : updateData.existingProductPhotos)
      : [];

    let newProductPhotoUrls = [];
    if (req.files?.productPhotos) {
      try {
        const productPhotoResults = await uploadFiles(req.files.productPhotos, 'vendor-product-photos');
        newProductPhotoUrls = productPhotoResults.map(result => result.cloudinaryUrl);
        console.log('Uploaded new product photos:', newProductPhotoUrls);
      } catch (uploadError) {
        console.error('Product photo upload error:', uploadError);
        return res.status(500).json({
          error: 'Failed to upload product photos: ' + uploadError.message
        });
      }
    }

    // Delete product photo documents that are no longer in the existing list
    const currentProductDocs = await prisma.vendorDocument.findMany({
      where: {
        vendorId,
        type: 'OTHER',
        name: { startsWith: 'Product Photo' }
      }
    });

    const productDocsToDelete = currentProductDocs.filter(
      doc => !existingProductPhotos.includes(doc.documentUrl)
    );
    if (productDocsToDelete.length > 0) {
      for (const doc of productDocsToDelete) {
        try {
          const publicId = doc.documentUrl.split('/').pop().split('.')[0];
          await deleteFromCloudinary(`vendor-product-photos/${publicId}`);
        } catch (deleteError) {
          console.warn('Failed to delete product photo from Cloudinary:', deleteError.message);
        }
      }
      await prisma.vendorDocument.deleteMany({
        where: { id: { in: productDocsToDelete.map(d => d.id) } }
      });
    }

    // Create new product photo documents
    if (newProductPhotoUrls.length > 0) {
      const existingCount = existingProductPhotos.length;
      const newDocs = newProductPhotoUrls.map((url, index) => ({
        vendorId,
        type: 'OTHER',
        name: `Product Photo ${existingCount + index + 1}`,
        documentUrl: url
      }));
      await prisma.vendorDocument.createMany({ data: newDocs });
    }

    // ── Trim payload to only changed fields ──────────────────────────
    // MongoDB Atlas caps aggregation pipelines at 50 stages. The Vendor
    // model has ~70 columns the admin form writes; sending all of them
    // every edit (most unchanged) blew past that limit with
    // `Pipeline length greater than 50 not supported`. Prisma treats
    // `undefined` keys as "skip this column", so we compare each key
    // against `existingVendor` and drop the ones that already match.
    // Result: a typical edit sends 3-5 keys instead of 70.
    const valuesEqual = (a, b) => {
      const aEmpty = a === null || a === undefined || a === '';
      const bEmpty = b === null || b === undefined || b === '';
      if (aEmpty && bEmpty) return true;
      if (aEmpty !== bEmpty) return false;
      if (typeof a === 'object' && typeof b === 'object') {
        // JSON-stringify works for our shapes (arrays, plain objects, JSON
        // columns) and is fast enough for the ~70-key budget here.
        try {
          return JSON.stringify(a) === JSON.stringify(b);
        } catch {
          return false;
        }
      }
      return a === b;
    };

    const trimmedUpdate = {};
    for (const [key, value] of Object.entries(vendorUpdateData)) {
      if (value === undefined) continue;
      // Always include the password hash when present — it only lands in
      // vendorUpdateData when the admin explicitly typed a new password,
      // and comparing bcrypt hashes char-by-char would never match anyway.
      if (key === 'password') {
        trimmedUpdate[key] = value;
        continue;
      }
      if (valuesEqual(value, existingVendor[key])) continue;
      trimmedUpdate[key] = value;
    }

    // Skip the round-trip entirely when nothing changed (admin clicked
    // Save without editing anything). Prisma would still issue an empty
    // update, which works but is wasted I/O.
    const updatedVendor = Object.keys(trimmedUpdate).length > 0
      ? await prisma.vendor.update({
          where: { id: vendorId },
          data: trimmedUpdate,
        })
      : existingVendor;

    // Keep the master taxonomy in step when the vendor's "Other" categories are
    // edited — new names land as PENDING for admin review (existing ones reuse).
    if (resolvedAdditionalCategories !== undefined) {
      await syncVendorCustomCategories(vendorId, resolvedAdditionalCategories);
    }

    // Handle certifications update
    if (parsedSelectedCertifications && Array.isArray(parsedSelectedCertifications)) {
      // Get existing certifications to preserve document URLs if no new file uploaded
      const existingCerts = await prisma.vendorCertification.findMany({
        where: { vendorId }
      });

      // Same cert-name map used by the registration path — keep them in
      // sync. Falls back to ID.toUpperCase() for unknown / legacy ids.
      const CERT_NAME_MAP = {
        'oeko-tex': 'OEKO-TEX',
        'gots': 'GOTS',
        'grs': 'GRS',
        'smeta': 'SMETA / Sedex',
        'iso-9001': 'ISO 9001',
        'iso-14001': 'ISO 14001',
        'bsci': 'BSCI',
        'fsc': 'FSC',
        'fair-trade': 'Fair Trade',
        'wrap': 'WRAP',
        'bci': 'BCI',
      };

      // Build the reverse lookup (friendly name → chip id) ONCE so existing
      // cert URLs can be re-keyed by chip id. The old `cert.name.toLowerCase()`
      // keying silently failed for multi-word names ("SMETA / Sedex" →
      // "smeta / sedex" ≠ chip id "smeta") and wiped the document URL on
      // every admin save for SMETA / ISO 9001 / ISO 14001 / Fair Trade certs.
      const NAME_TO_CHIP = Object.fromEntries(
        Object.entries(CERT_NAME_MAP).map(([chipId, friendlyName]) => [friendlyName, chipId])
      );

      // Create a map of existing cert URLs keyed by the lookup id the
      // update path will use below — chip id for catalog certs, raw
      // VendorCertification id for custom certs (the form sends back the
      // same id so the lookup matches).
      const existingCertUrls = {};
      existingCerts.forEach(cert => {
        if (!cert.documentUrl) return;
        if (cert.isCustom) {
          existingCertUrls[cert.id] = cert.documentUrl;
          return;
        }
        const chipId = NAME_TO_CHIP[cert.name];
        if (chipId) existingCertUrls[chipId] = cert.documentUrl;
      });

      // Delete existing certifications
      await prisma.vendorCertification.deleteMany({
        where: { vendorId }
      });

      // Catalog certs
      const catalogRows = parsedSelectedCertifications.map((certId) => ({
        vendorId,
        name: CERT_NAME_MAP[certId] || String(certId).toUpperCase(),
        issuedBy: null, // schema is nullable; isCustom flag distinguishes catalog vs custom
        expiryDate: parsedCertificationExpiryDates?.[certId]
          ? new Date(parsedCertificationExpiryDates[certId])
          : null,
        // Use new uploaded file URL, or preserve existing URL, or null
        documentUrl: certificationFileUrls[certId] || existingCertUrls[certId] || null,
        isCustom: false,
      }));

      // Custom certs (Step 6 "other certifications") — vendor-typed name +
      // description. Created with isCustom=true so admins can distinguish
      // them from catalog entries.
      const customRows = Array.isArray(parsedOtherCertifications)
        ? parsedOtherCertifications
            .filter((c) => c && c.name && String(c.name).trim().length > 0)
            .map((c) => ({
              vendorId,
              name: String(c.name).trim(),
              issuedBy: null,
              description: c.description ? String(c.description).trim() : null,
              // Mirror registerVendor — keep expiry + documentUrl for
              // custom certs too. The form keys them by the custom cert's
              // own id in the shared certificationExpiryDates +
              // certificationFiles maps. Falls back to the existing URL
              // (keyed by id in existingCertUrls below) when admin didn't
              // re-upload during edit.
              expiryDate: parsedCertificationExpiryDates?.[c.id]
                ? new Date(parsedCertificationExpiryDates[c.id])
                : null,
              documentUrl: certificationFileUrls[c.id] || existingCertUrls[c.id] || null,
              isCustom: true,
            }))
        : [];

      const allRows = [...catalogRows, ...customRows];
      if (allRows.length > 0) {
        await prisma.vendorCertification.createMany({ data: allRows });
      }
    }

    // Bank details are upserted earlier in this function (see the
    // `vendorBankDetails.upsert` block right after vendorUpdateData is
    // assembled). The legacy fallback that stuffed swiftCode into ifscCode
    // and invented branch values has been removed.

    // Fetch updated vendor with relations
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        certifications: true,
        documents: true,
        bankDetails: true
      }
    });

    res.json({
      message: 'Vendor updated successfully',
      vendor: {
        ...vendor,
        password: undefined
      }
    });

  } catch (error) {
    console.error('Update vendor by ID error:', error);
    res.status(500).json({
      error: 'Failed to update vendor. Please try again.',
      details: error.message
    });
  }
};

// Approve vendor
const approveVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (existingVendor.status === 'APPROVED') {
      return res.status(400).json({ error: 'Vendor is already approved' });
    }

    // Maker-checker: a vendor can only be approved AFTER the registration review
    // and QC inspection stages — i.e. from UNDER_REVIEW (post-inspection),
    // APPROVAL_PENDING (employee-proposed), or REINSPECTION. Block PENDING
    // (not yet reviewed) and REVIEWED (reviewed but QC not done) so the pipeline
    // can't be skipped with a one-click approve.
    const APPROVABLE_FROM = ['UNDER_REVIEW', 'APPROVAL_PENDING', 'REINSPECTION'];
    if (!APPROVABLE_FROM.includes(existingVendor.status)) {
      return res.status(400).json({
        error: existingVendor.status === 'PENDING'
          ? 'This vendor has not been reviewed yet. Review the registration, then assign QC and complete the inspection before approving.'
          : existingVendor.status === 'REVIEWED'
            ? 'Assign a QC checker and complete the factory inspection before approving this vendor.'
            : `Cannot approve a vendor in "${existingVendor.status}" state.`,
      });
    }

    // Check if user is Super Admin — direct approve
    const isSuperAdmin = (req.user.roleName || '').toLowerCase().trim() === 'super admin';

    if (isSuperAdmin) {
      // Super Admin: direct approval
      const temporaryPassword = generateSecurePassword(12);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 12);
      const adminId = req.user?.id || req.userId;
      const adminName = req.user?.name || req.user?.email;

      // Vendor status change + inspection finalization must be atomic
      const { vendor, finalizedInspections } = await prisma.$transaction(async (tx) => {
        const updatedVendor = await tx.vendor.update({
          where: { id: vendorId },
          data: {
            status: 'APPROVED',
            approvedAt: new Date(),
            rejectedAt: null,
            rejectionReason: null,
            rejectionRequestedBy: null,
            rejectionRequestedAt: null,
            approvalRequestedBy: null,
            approvalRequestedAt: null,
            password: hashedPassword
          }
        });

        const inspections = await finalizeInspectionsForVendor(tx, vendorId, { decision: 'APPROVED' });
        return { vendor: updatedVendor, finalizedInspections: inspections };
      });

      // Audit logs: fire-and-forget, outside transaction
      if (finalizedInspections) {
        writeInspectionAuditLogs(finalizedInspections, { decision: 'APPROVED', adminId, adminName });
      }

      try {
        // Credentials go to the vendor's Contact & Communication → Primary Email
        // (businessEmail). It is the same value used as the login id; fall back to
        // the account email only if businessEmail is somehow missing on old rows.
        const credentialsEmail = vendor.businessEmail || vendor.email;
        await sendVendorApprovalEmail({
          companyName: vendor.companyName,
          ownerName: vendor.ownerName,
          email: credentialsEmail,
          password: temporaryPassword
        });
        console.log(`✅ Approval email sent to ${credentialsEmail}`);
      } catch (emailError) {
        console.error('❌ Failed to send approval email:', emailError);
      }

      const { createNotification: createVendorNotif } = require('./notificationController');
      createVendorNotif({
        userId: vendor.id, role: 'VENDOR', type: 'VENDOR_STATUS_CHANGED',
        title: 'Vendor Application Approved',
        message: `Congratulations! Your vendor application for "${vendor.companyName}" has been approved.`,
      }).catch(() => { });

      // Auto-start any workflow configured to trigger on vendor approval.
      const { triggerWorkflowEvent } = require('../utils/workflowEvents');
      triggerWorkflowEvent('vendor.approved', {
        subjectType: 'VENDOR', subjectId: vendor.id, subjectLabel: vendor.companyName,
        initiatedById: adminId, initiatedByName: adminName,
      });

      res.json({
        message: 'Vendor approved successfully and credentials sent via email',
        vendor: { ...vendor, password: undefined }
      });
    } else {
      // Employee/Admin: approval goes to pending — needs Super Admin confirmation
      const vendor = await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'APPROVAL_PENDING',
          approvalRequestedBy: req.user.id,
          approvalRequestedAt: new Date()
        }
      });

      const { createNotificationForRole } = require('./notificationController');
      createNotificationForRole({
        role: 'ADMIN',
        type: 'VENDOR_APPROVAL_PENDING',
        title: 'Vendor Approval Pending Confirmation',
        message: `Employee requested approval of "${vendor.companyName}". Awaiting Super Admin confirmation.`,
        data: { vendorId: vendor.id }
      }).catch(() => { });

      res.json({
        message: 'Approval request submitted. Awaiting Super Admin confirmation.',
        vendor: { ...vendor, password: undefined }
      });
    }
  } catch (error) {
    console.error('Approve vendor error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Confirm vendor approval (Super Admin only)
const confirmApproval = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const isSuperAdmin = (req.user.roleName || '').toLowerCase().trim() === 'super admin';
    if (!isSuperAdmin) {
      return res.status(403).json({ error: 'Only Super Admin can confirm vendor approvals' });
    }

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (existingVendor.status !== 'APPROVAL_PENDING') {
      return res.status(400).json({ error: 'Vendor is not in approval pending state' });
    }

    const temporaryPassword = generateSecurePassword(12);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 12);
    const adminId = req.user?.id || req.userId;
    const adminName = req.user?.name || req.user?.email;

    const { vendor, finalizedInspections } = await prisma.$transaction(async (tx) => {
      const updatedVendor = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          rejectedAt: null,
          rejectionReason: null,
          approvalRequestedBy: null,
          approvalRequestedAt: null,
          password: hashedPassword
        }
      });

      const inspections = await finalizeInspectionsForVendor(tx, vendorId, { decision: 'APPROVED' });
      return { vendor: updatedVendor, finalizedInspections: inspections };
    });

    if (finalizedInspections) {
      writeInspectionAuditLogs(finalizedInspections, { decision: 'APPROVED', adminId, adminName });
    }

    try {
      // Credentials go to the vendor's Contact & Communication → Primary Email
      // (businessEmail); fall back to the account email only for old rows.
      const credentialsEmail = vendor.businessEmail || vendor.email;
      await sendVendorApprovalEmail({
        companyName: vendor.companyName,
        ownerName: vendor.ownerName,
        email: credentialsEmail,
        password: temporaryPassword
      });
      console.log(`✅ Approval email sent to ${credentialsEmail}`);
    } catch (emailError) {
      console.error('❌ Failed to send approval email:', emailError);
    }

    const { createNotification } = require('./notificationController');
    createNotification({
      userId: vendor.id, role: 'VENDOR', type: 'VENDOR_STATUS_CHANGED',
      title: 'Vendor Application Approved',
      message: `Congratulations! Your vendor application for "${vendor.companyName}" has been approved.`,
    }).catch(() => { });

    if (existingVendor.approvalRequestedBy) {
      createNotification({
        userId: existingVendor.approvalRequestedBy,
        role: 'ADMIN',
        type: 'VENDOR_APPROVAL_CONFIRMED',
        title: 'Vendor Approval Confirmed',
        message: `Your approval of "${vendor.companyName}" has been confirmed by Super Admin.`,
        data: { vendorId: vendor.id }
      }).catch(() => { });
    }

    // Auto-start any workflow configured to trigger on vendor approval.
    const { triggerWorkflowEvent } = require('../utils/workflowEvents');
    triggerWorkflowEvent('vendor.approved', {
      subjectType: 'VENDOR', subjectId: vendor.id, subjectLabel: vendor.companyName,
      initiatedById: adminId, initiatedByName: adminName,
    });

    res.json({
      message: 'Vendor approval confirmed. Credentials sent via email.',
      vendor: { ...vendor, password: undefined }
    });
  } catch (error) {
    console.error('Confirm approval error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Cancel vendor approval (Super Admin only)
const cancelApproval = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const isSuperAdmin = (req.user.roleName || '').toLowerCase().trim() === 'super admin';
    if (!isSuperAdmin) {
      return res.status(403).json({ error: 'Only Super Admin can cancel vendor approvals' });
    }

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (existingVendor.status !== 'APPROVAL_PENDING') {
      return res.status(400).json({ error: 'Vendor is not in approval pending state' });
    }

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'PENDING',
        approvalRequestedBy: null,
        approvalRequestedAt: null
      }
    });

    if (existingVendor.approvalRequestedBy) {
      const { createNotification } = require('./notificationController');
      createNotification({
        userId: existingVendor.approvalRequestedBy,
        role: 'ADMIN',
        type: 'VENDOR_APPROVAL_CANCELLED',
        title: 'Vendor Approval Cancelled',
        message: `Your approval of "${vendor.companyName}" was overturned by Super Admin. Vendor restored to Pending.`,
        data: { vendorId: vendor.id }
      }).catch(() => { });
    }

    res.json({
      message: 'Approval cancelled. Vendor restored to Pending status.',
      vendor: { ...vendor, password: undefined }
    });
  } catch (error) {
    console.error('Cancel approval error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Review a vendor's registration form (staff gate before QC assignment).
// decision: 'QUALIFIED' -> status REVIEWED (proceeds to Assign QC)
//           'REJECT'    -> status REJECTION_PENDING (routes to an authorised
//                          person who holds vendor approve permission for the
//                          final rejection). Requires a reason.
const reviewVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { decision, note, reason } = req.body;

    if (!['QUALIFIED', 'REJECT'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'QUALIFIED' or 'REJECT'" });
    }

    const existingVendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!existingVendor) return res.status(404).json({ error: 'Vendor not found' });

    // A registration can only be reviewed before it enters the QC/approval stages.
    if (!['PENDING', 'UNDER_REVIEW'].includes(existingVendor.status)) {
      return res.status(400).json({ error: `Only a pending registration can be reviewed (current status: ${existingVendor.status}).` });
    }

    const actorId = req.user?.id || req.userId;
    const actorName = req.user?.name || req.user?.email;
    const now = new Date();

    if (decision === 'QUALIFIED') {
      const vendor = await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'REVIEWED',
          reviewedBy: actorId,
          reviewedByName: actorName,
          reviewedAt: now,
          reviewNote: note || null,
        },
      });

      // Tell the team the registration is cleared and ready for QC assignment.
      const { createNotificationForRole } = require('./notificationController');
      createNotificationForRole({
        role: 'ADMIN', type: 'VENDOR_REVIEWED',
        title: 'Vendor Reviewed & Qualified',
        message: `"${vendor.companyName}" passed registration review — ready to assign a QC checker for factory inspection.`,
        data: { vendorId: vendor.id, screen: 'vendors' },
      }).catch(() => {});

      const { triggerWorkflowEvent } = require('../utils/workflowEvents');
      triggerWorkflowEvent('vendor.reviewed', {
        subjectType: 'VENDOR', subjectId: vendor.id, subjectLabel: vendor.companyName,
        initiatedById: actorId, initiatedByName: actorName,
      });

      return res.json({ message: 'Registration reviewed & qualified. Ready for QC assignment.', vendor: { ...vendor, password: undefined } });
    }

    // decision === 'REJECT'
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'REJECTION_PENDING',
        rejectionReason: reason.trim(),
        rejectionRequestedBy: actorId,
        rejectionRequestedAt: now,
        reviewedBy: actorId,
        reviewedByName: actorName,
        reviewedAt: now,
        reviewNote: note || null,
      },
    });

    // Route to the authorised person(s) who can finalise rejections.
    const { createNotificationForRole } = require('./notificationController');
    createNotificationForRole({
      role: 'ADMIN', type: 'VENDOR_REJECTION_PENDING',
      title: 'Vendor Rejection Needs Final Decision',
      message: `${actorName} proposed rejecting "${vendor.companyName}". Reason: ${reason.trim()}`,
      data: { vendorId: vendor.id, screen: 'vendors' },
    }).catch(() => {});

    const { triggerWorkflowEvent } = require('../utils/workflowEvents');
    triggerWorkflowEvent('vendor.review_rejected', {
      subjectType: 'VENDOR', subjectId: vendor.id, subjectLabel: vendor.companyName,
      initiatedById: actorId, initiatedByName: actorName, data: { reason: reason.trim() },
    });

    return res.json({ message: 'Rejection proposed. Sent to an authorised person for the final decision.', vendor: { ...vendor, password: undefined } });
  } catch (error) {
    console.error('Review vendor error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Reject vendor
const rejectVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // Check if user is Super Admin — direct reject
    const isSuperAdmin = (req.user.roleName || '').toLowerCase().trim() === 'super admin';

    if (isSuperAdmin) {
      // Super Admin: direct rejection with inspection finalization
      const adminId = req.user?.id || req.userId;
      const adminName = req.user?.name || req.user?.email;

      const { vendor, finalizedInspections } = await prisma.$transaction(async (tx) => {
        const updatedVendor = await tx.vendor.update({
          where: { id: vendorId },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            rejectionReason: reason,
            rejectionRequestedBy: null,
            rejectionRequestedAt: null,
            approvedAt: null
          }
        });

        const inspections = await finalizeInspectionsForVendor(tx, vendorId, { decision: 'REJECTED' });
        return { vendor: updatedVendor, finalizedInspections: inspections };
      });

      // Audit logs: fire-and-forget, outside transaction
      if (finalizedInspections) {
        writeInspectionAuditLogs(finalizedInspections, { decision: 'REJECTED', adminId, adminName, reason });
      }

      try {
        await sendVendorRejectionEmail({
          companyName: vendor.companyName,
          ownerName: vendor.ownerName,
          email: vendor.email,
          reason: reason
        });
        console.log(`✅ Rejection email sent to ${vendor.email}`);
      } catch (emailError) {
        console.error('❌ Failed to send rejection email:', emailError);
      }

      res.json({
        message: 'Vendor rejected successfully and notification sent via email',
        vendor: { ...vendor, password: undefined }
      });
    } else {
      // Employee/Admin: rejection goes to pending — needs Super Admin confirmation
      const vendor = await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'REJECTION_PENDING',
          rejectionReason: reason,
          rejectionRequestedBy: req.user.id,
          rejectionRequestedAt: new Date()
        }
      });

      // Notify all admins about pending rejection
      const { createNotificationForRole } = require('./notificationController');
      createNotificationForRole({
        role: 'ADMIN',
        type: 'VENDOR_REJECTION_PENDING',
        title: 'Vendor Rejection Pending Approval',
        message: `Employee requested rejection of "${vendor.companyName}". Reason: ${reason}`,
        data: { vendorId: vendor.id }
      }).catch(() => {});

      res.json({
        message: 'Rejection request submitted. Awaiting Super Admin confirmation.',
        vendor: { ...vendor, password: undefined }
      });
    }
  } catch (error) {
    console.error('Reject vendor error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Confirm (finalise) a vendor rejection. Any admin holding vendor approve
// permission may do this (route-gated). For separation of duties, the person
// who proposed the rejection cannot also confirm it — unless they are Super Admin.
const confirmRejection = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (existingVendor.status !== 'REJECTION_PENDING') {
      return res.status(400).json({ error: 'Vendor is not in rejection pending state' });
    }

    const isSuperAdmin = (req.user.roleName || '').toLowerCase().trim() === 'super admin';
    if (!isSuperAdmin && existingVendor.rejectionRequestedBy && existingVendor.rejectionRequestedBy === (req.user?.id || req.userId)) {
      return res.status(403).json({ error: 'The final rejection must be confirmed by a different authorised person than the one who proposed it.' });
    }

    const adminId = req.user?.id || req.userId;
    const adminName = req.user?.name || req.user?.email;

    const { vendor, finalizedInspections } = await prisma.$transaction(async (tx) => {
      const updatedVendor = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          approvedAt: null
        }
      });

      const inspections = await finalizeInspectionsForVendor(tx, vendorId, { decision: 'REJECTED' });
      return { vendor: updatedVendor, finalizedInspections: inspections };
    });

    if (finalizedInspections) {
      writeInspectionAuditLogs(finalizedInspections, { decision: 'REJECTED', adminId, adminName, reason: vendor.rejectionReason });
    }

    // Send rejection email to vendor
    try {
      await sendVendorRejectionEmail({
        companyName: vendor.companyName,
        ownerName: vendor.ownerName,
        email: vendor.email,
        reason: vendor.rejectionReason || 'Application rejected'
      });
      console.log(`✅ Rejection email sent to ${vendor.email}`);
    } catch (emailError) {
      console.error('❌ Failed to send rejection email:', emailError);
    }

    // Notify the employee who requested the rejection
    if (vendor.rejectionRequestedBy) {
      const { createNotification } = require('./notificationController');
      createNotification({
        userId: vendor.rejectionRequestedBy,
        role: 'ADMIN',
        type: 'VENDOR_REJECTION_CONFIRMED',
        title: 'Vendor Rejection Confirmed',
        message: `Your rejection of "${vendor.companyName}" has been confirmed by ${adminName}.`,
        data: { vendorId: vendor.id }
      }).catch(() => { });
    }

    res.json({
      message: 'Vendor rejection confirmed. Email sent to vendor.',
      vendor: { ...vendor, password: undefined }
    });
  } catch (error) {
    console.error('Confirm rejection error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Cancel a pending vendor rejection (dismiss the proposal). Any admin holding
// vendor approve permission may do this (route-gated).
const cancelRejection = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (existingVendor.status !== 'REJECTION_PENDING') {
      return res.status(400).json({ error: 'Vendor is not in rejection pending state' });
    }

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'PENDING',
        rejectionReason: null,
        rejectionRequestedBy: null,
        rejectionRequestedAt: null
      }
    });

    // Notify the employee who requested the rejection
    if (existingVendor.rejectionRequestedBy) {
      const { createNotification } = require('./notificationController');
      createNotification({
        userId: existingVendor.rejectionRequestedBy,
        role: 'ADMIN',
        type: 'VENDOR_REJECTION_CANCELLED',
        title: 'Vendor Rejection Cancelled',
        message: `Your rejection of "${vendor.companyName}" was overturned by Super Admin. Vendor restored to Pending.`,
        data: { vendorId: vendor.id }
      }).catch(() => { });
    }

    res.json({
      message: 'Rejection cancelled. Vendor restored to Pending status.',
      vendor: { ...vendor, password: undefined }
    });
  } catch (error) {
    console.error('Cancel rejection error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Suspend vendor
const suspendVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Suspension reason is required' });
    }

    // Get vendor details first
    const existingVendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!existingVendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const adminId = req.user?.id || req.userId;
    const adminName = req.user?.name || req.user?.email;

    // Vendor status change + inspection finalization must be atomic
    const { vendor, finalizedInspections } = await prisma.$transaction(async (tx) => {
      const updatedVendor = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          rejectionReason: reason,
        },
      });

      const inspections = await finalizeInspectionsForVendor(tx, vendorId, {
        decision: 'SUSPENDED',
      });

      return { vendor: updatedVendor, finalizedInspections: inspections };
    });

    // Audit logs: fire-and-forget, outside transaction
    if (finalizedInspections) {
      writeInspectionAuditLogs(finalizedInspections, { decision: 'SUSPENDED', adminId, adminName, reason });
    }

    // Send suspension email
    try {
      await sendVendorSuspensionEmail({
        companyName: vendor.companyName,
        ownerName: vendor.ownerName,
        email: vendor.email,
        reason: reason
      });

      console.log(`✅ Suspension email sent to ${vendor.email}`);
    } catch (emailError) {
      console.error('❌ Failed to send suspension email:', emailError);
      // Don't fail the suspension process if email fails
    }

    // Notify vendor
    const { createNotification: createSuspendNotif } = require('./notificationController');
    createSuspendNotif({
      userId: vendor.id, role: 'VENDOR', type: 'VENDOR_STATUS_CHANGED',
      title: 'Account Suspended',
      message: `Your vendor account has been suspended.${reason ? ` Reason: ${reason}` : ''}`,
    }).catch(() => { });

    res.json({
      message: 'Vendor suspended successfully and notification sent via email',
      vendor: {
        ...vendor,
        password: undefined
      }
    });

  } catch (error) {
    console.error('Suspend vendor error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Vendor login
const vendorLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Case-insensitive lookup — registration normalizes the email before
    // insert, so we normalize the login attempt the same way.
    const normalizedEmail = email.trim().toLowerCase();
    const vendor = await prisma.vendor.findUnique({
      where: { email: normalizedEmail }
    });

    if (!vendor) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if vendor has a password (approved vendors should have one)
    if (!vendor.password) {
      return res.status(401).json({
        error: 'Account not activated. Please wait for admin approval.',
        status: vendor.status
      });
    }

    if (vendor.status === 'REJECTED') {
      return res.status(403).json({
        error: 'Your vendor application has been rejected',
        reason: vendor.rejectionReason
      });
    }

    if (vendor.status === 'SUSPENDED') {
      return res.status(403).json({
        error: 'Your vendor account has been suspended',
        reason: vendor.rejectionReason
      });
    }

    if (vendor.status === 'PENDING') {
      return res.status(403).json({
        error: 'Your vendor application is still under review. Please wait for approval.'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, vendor.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { lastLoginAt: new Date() }
    });

    const token = jwt.sign(
      { vendorId: vendor.id, type: 'vendor' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      message: 'Login successful',
      vendor: {
        id: vendor.id,
        email: vendor.email,
        companyName: vendor.companyName,
        status: vendor.status,
        ownerName: vendor.ownerName
      },
      token
    });

  } catch (error) {
    console.error('Vendor login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Test email functionality (development only)
const testVendorEmail = async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test endpoint not available in production' });
    }

    const { type = 'approval', email = 'test@example.com' } = req.query;

    const testData = {
      companyName: 'Test Company Ltd',
      ownerName: 'John Doe',
      email: email,
      password: 'TempPass123!',
      reason: 'This is a test rejection/suspension reason for development purposes.'
    };

    let result;
    switch (type) {
      case 'approval':
        result = await sendVendorApprovalEmail(testData);
        break;
      case 'rejection':
        result = await sendVendorRejectionEmail(testData);
        break;
      case 'suspension':
        result = await sendVendorSuspensionEmail(testData);
        break;
      default:
        return res.status(400).json({ error: 'Invalid email type. Use: approval, rejection, or suspension' });
    }

    res.json({
      message: `Test ${type} email sent successfully`,
      result: result
    });

  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({
      error: 'Failed to send test email',
      details: error.message
    });
  }
};

// Assign QC Checker to a Vendor
const assignQc = async (req, res) => {
  try {
    const { vendorId, checkerId } = req.body;

    if (!vendorId || !checkerId) {
      return res.status(400).json({ error: 'vendorId and checkerId are required' });
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId }
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const checker = await prisma.qCChecker.findUnique({
      where: { id: checkerId }
    });

    if (!checker) {
      return res.status(404).json({ error: 'QC Checker not found' });
    }

    // Registration must be reviewed & qualified before a factory inspection is scheduled.
    if (vendor.status === 'PENDING') {
      return res.status(400).json({ error: 'Review the vendor registration first (mark it Reviewed & Qualified) before assigning a QC checker.' });
    }

    // Once a checker is assigned, the vendor moves into the inspection stage.
    const statusUpdate = ['REVIEWED', 'PENDING'].includes(vendor.status) ? 'UNDER_REVIEW' : vendor.status;

    const updatedVendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        assignedQcId: checkerId,
        assignedQcAt: new Date(),
        status: statusUpdate
      },
      include: {
        assignedQc: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    // Also update the checker's assignedVendors count
    await prisma.qCChecker.update({
      where: { id: checkerId },
      data: {
        assignedVendors: {
          increment: 1
        }
      }
    });

    // Notify the QC checker — in-app feed + FCM push
    const { createNotification: createAssignNotif } = require('./notificationController');
    createAssignNotif({
      userId: checkerId, role: 'QC_CHECKER', type: 'VENDOR_ASSIGNED',
      title: 'New Vendor Assigned',
      message: `"${vendor.companyName}" has been assigned to you for inspection.`,
      data: { screen: 'vendors', vendorId }
    }).catch(() => {});

    res.json({
      message: 'QC Checker assigned successfully',
      vendor: updatedVendor
    });

  } catch (error) {
    console.error('Assign QC Checker error:', error);
    res.status(500).json({ error: 'Internal server error while assigning QC Checker' });
  }
};

/**
 * Create or update a vendor's bank details (Admin only).
 *
 * Mirrors the vendor portal's own bank form (vendorSettingsController
 * .upsertVendorBankDetails) so admins capture exactly the same fields.
 *
 * Difference from the vendor-facing endpoint: the vendor is blocked from
 * editing once details are verified ("contact admin for modifications") —
 * this IS that admin path, so verified rows are editable here. Re-saving a
 * verified row resets it to unverified, because the account it was verified
 * against may no longer be the one on file.
 */
const upsertVendorBankDetailsByAdmin = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const {
      bankName,
      accountNumber,
      ifscCode,
      accountType,
      accountHolderName,
      legalEntity,
      branchName,
      branchAddress,
    } = req.body;

    if (!bankName || !accountNumber || !ifscCode || !accountType || !accountHolderName) {
      return res.status(400).json({
        success: false,
        error: 'Bank name, account number, IFSC code, account type, and account holder name are required',
      });
    }

    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (!ifscRegex.test(String(ifscCode).toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Invalid IFSC code format' });
    }

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    const existing = await prisma.vendorBankDetails.findUnique({ where: { vendorId } });

    const data = {
      bankName,
      accountNumber,
      ifscCode: String(ifscCode).toUpperCase(),
      accountType,
      accountHolderName,
      // Admins may edit the legal entity; default to the vendor's company name.
      legalEntity: (legalEntity && String(legalEntity).trim()) || vendor.companyName || null,
      branchName: branchName || null,
      branchAddress: branchAddress || null,
    };

    // Any change to an account-defining field → the previous verification no
    // longer applies. Even after a full approval, editing these restarts the
    // whole penny-drop handshake from PENDING; only after the vendor re-confirms
    // can the admin approve again.
    const accountChanged = existing && (
      existing.accountNumber !== data.accountNumber ||
      existing.ifscCode !== data.ifscCode ||
      existing.accountHolderName !== data.accountHolderName ||
      existing.bankName !== data.bankName ||
      (existing.accountType || '') !== (data.accountType || '')
    );
    const wasVerified = !!(existing && existing.isVerified);
    const resetVerification = accountChanged
      ? {
          isVerified: false,
          verifiedAt: null,
          verifiedBy: null,
          verificationStatus: 'PENDING',
          amountSentAt: null,
          vendorRespondedAt: null,
          verificationNote: null,
          vendorNote: null,
        }
      : {};

    const bankDetails = await prisma.vendorBankDetails.upsert({
      where: { vendorId },
      create: { vendorId, ...data },
      update: {
        ...data,
        ...resetVerification,
      },
    });

    // If previously-verified details were changed, let the vendor know their
    // account must be re-verified (the handshake has restarted).
    if (accountChanged && wasVerified) {
      const { createNotification } = require('./notificationController');
      createNotification({
        userId: vendorId,
        role: 'VENDOR',
        type: 'BANK_REVERIFICATION_REQUIRED',
        title: 'Bank details updated — re-verification needed',
        message: 'Your bank details were updated. They now need to be re-verified: the admin will send a small verification amount again for you to confirm.',
        data: { bankDetailsId: bankDetails.id },
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: accountChanged && wasVerified
        ? 'Bank details updated — verification has been reset and must be repeated.'
        : 'Bank details saved successfully',
      bankDetails,
    });
  } catch (error) {
    console.error('Admin upsert vendor bank details error:', error);
    res.status(500).json({ success: false, error: 'Failed to save bank details' });
  }
};

// Verify vendor bank details (Admin only)
const verifyVendorBankDetails = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const bankDetails = await prisma.vendorBankDetails.findUnique({
      where: { vendorId }
    });

    if (!bankDetails) {
      return res.status(404).json({ error: 'Bank details not found for this vendor' });
    }

    if (bankDetails.isVerified) {
      return res.status(400).json({ error: 'Bank details are already verified' });
    }

    // Final approval only after the vendor has confirmed they received the test
    // amount (the penny-drop handshake).
    if (bankDetails.verificationStatus !== 'RECEIVED') {
      return res.status(400).json({
        error: 'The vendor must confirm they received the verification amount before you can approve.',
      });
    }

    const updatedBankDetails = await prisma.vendorBankDetails.update({
      where: { vendorId },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
        verifiedBy: req.user?.id || req.admin?.id, // Using user/admin id if available in token
        verificationStatus: 'VERIFIED',
      }
    });

    // Tell the vendor their bank details are approved.
    const { createNotification } = require('./notificationController');
    createNotification({
      userId: vendorId,
      role: 'VENDOR',
      type: 'BANK_VERIFIED',
      title: 'Bank details verified',
      message: 'Your bank account has been verified and approved for payouts.',
      data: { bankDetailsId: bankDetails.id },
    }).catch(() => {});

    res.json({
      message: 'Vendor bank details verified successfully',
      bankDetails: updatedBankDetails
    });

  } catch (error) {
    console.error('Verify vendor bank details error:', error);
    res.status(500).json({ error: 'Internal server error while verifying bank details' });
  }
};

// PUT /api/vendors/:vendorId/bank-verification/send — admin marks that a test
// (penny-drop) amount was sent to the vendor's account; vendor is asked to confirm.
const sendBankVerificationAmount = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { note } = req.body || {};

    const bankDetails = await prisma.vendorBankDetails.findUnique({ where: { vendorId } });
    if (!bankDetails) {
      return res.status(404).json({ error: 'Bank details not found for this vendor' });
    }
    if (bankDetails.isVerified) {
      return res.status(400).json({ error: 'Bank details are already verified' });
    }
    if (!['PENDING', 'NOT_RECEIVED', 'AMOUNT_SENT'].includes(bankDetails.verificationStatus || 'PENDING')) {
      return res.status(400).json({ error: 'Cannot send a verification amount in the current state.' });
    }

    const updated = await prisma.vendorBankDetails.update({
      where: { vendorId },
      data: {
        verificationStatus: 'AMOUNT_SENT',
        amountSentAt: new Date(),
        vendorRespondedAt: null,
        verificationNote: note ? String(note).trim().slice(0, 300) : null,
      },
    });

    // Ask the vendor to confirm receipt.
    const { createNotification } = require('./notificationController');
    createNotification({
      userId: vendorId,
      role: 'VENDOR',
      type: 'BANK_VERIFICATION_AMOUNT_SENT',
      title: 'Verification amount sent',
      message: `We've sent a small verification amount to your bank account${updated.verificationNote ? ` (${updated.verificationNote})` : ''}. Please confirm whether you received it in Settings → Bank Details.`,
      data: { bankDetailsId: bankDetails.id },
    }).catch(() => {});

    res.json({ message: 'Verification amount marked as sent', bankDetails: updated });
  } catch (error) {
    console.error('Send bank verification amount error:', error);
    res.status(500).json({ error: 'Internal server error while sending verification amount' });
  }
};


module.exports = {
  registerVendor,
  getVendorProfile,
  updateVendorProfile,
  getAllVendors,
  getVendorById,
  updateVendorById,
  approveVendor,
  confirmApproval,
  cancelApproval,
  reviewVendor,
  rejectVendor,
  confirmRejection,
  cancelRejection,
  suspendVendor,
  vendorLogin,
  testVendorEmail,
  assignQc,
  verifyVendorBankDetails,
  sendBankVerificationAmount,
  upsertVendorBankDetailsByAdmin
};