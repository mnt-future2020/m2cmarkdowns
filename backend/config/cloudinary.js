/**
 * Media storage facade — now backed by DigitalOcean Spaces (see config/spaces.js).
 *
 * This file keeps its original name and exported function names on purpose: ~30
 * controllers `require('../config/cloudinary')` and call uploadToCloudinary /
 * deleteFromCloudinary / resolveBase64InValue / resolveProductImageUrls /
 * resolveVariantImageUrls / uploadDataUriIfBase64. Swapping the internals here
 * migrates every one of them to Spaces without touching the controllers.
 *
 * During the handover migration, reads of legacy `res.cloudinary.com` URLs keep
 * working (those objects still exist until the migration script re-homes them);
 * all NEW writes land in Spaces.
 */
const spaces = require('./spaces');

// Upload a raw buffer. `options.folder` + `options.resource_type` mirror the old
// Cloudinary call sites. Returns { secure_url, public_id, ... }.
const uploadToCloudinary = async (fileBuffer, options = {}) => {
  const { folder = 'vendor-documents', resource_type, contentType, filename } = options;
  // resource_type 'image' → optimise; 'raw'/'auto' with a non-image mime → store as-is.
  const optimizeImages = resource_type !== 'raw';
  return spaces.putObject(fileBuffer, {
    folder,
    contentType: contentType || (resource_type === 'image' ? 'image/jpeg' : undefined),
    filename,
    optimizeImages,
  });
};

// Delete by stored id. For Spaces the public_id IS the object key; we also accept
// a full URL and strip it to the key.
const deleteFromCloudinary = async (publicId) => {
  try {
    return await spaces.deleteObject(publicId);
  } catch (error) {
    console.error('Error deleting media from Spaces:', error?.message || error);
    throw error;
  }
};

// If `url` is a base64 data URI, upload it to Spaces and return the public URL.
// Anything else (already-hosted URL, relative path) passes through unchanged.
const uploadDataUriIfBase64 = async (url, options = {}) => {
  if (typeof url !== 'string' || !url.startsWith('data:')) return url;
  // Tolerate optional params between the mime type and the ;base64 marker, e.g.
  // jsPDF's `data:application/pdf;filename=generated.pdf;base64,…`.
  const match = url.match(/^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/);
  if (!match) return url;
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const result = await spaces.putObject(buffer, {
    folder: options.folder || 'products',
    contentType: mime,
    optimizeImages: options.resource_type !== 'raw',
  });
  return result.secure_url;
};

// Resolve an array of product image objects ({ url, ... }).
const resolveProductImageUrls = async (images) => {
  if (!Array.isArray(images)) return images;
  return Promise.all(
    images.map(async (img) => {
      if (!img || typeof img !== 'object') return img;
      const url = await uploadDataUriIfBase64(img.url);
      return { ...img, url };
    }),
  );
};

// Resolve an array of URL strings (any data URIs get uploaded and replaced).
const resolveVariantImageUrls = async (urls, options = {}) => {
  if (!Array.isArray(urls)) return urls;
  return Promise.all(urls.map((u) => uploadDataUriIfBase64(u, options)));
};

// Deep-walk any JSON-ish value and replace every base64 data URI string with its
// uploaded Spaces URL. Handles string, array, plain object.
const resolveBase64InValue = async (value, options = {}) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    return uploadDataUriIfBase64(value, options);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveBase64InValue(v, options)));
  }
  if (typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await resolveBase64InValue(v, options)]),
    );
    return Object.fromEntries(entries);
  }
  return value;
};

module.exports = {
  // Note: `cloudinary` is intentionally NOT exported any more — nothing should
  // depend on the Cloudinary SDK object. uploadController uses spaces.presignPut.
  uploadToCloudinary,
  deleteFromCloudinary,
  uploadDataUriIfBase64,
  resolveProductImageUrls,
  resolveVariantImageUrls,
  resolveBase64InValue,
};
