const spaces = require('../config/spaces');

// Folders the client is allowed to request a signed upload for. Restricting the
// folder prevents a leaked signature endpoint from being used to write anywhere
// in the Space. Keep in sync with the folders used by vendorController's
// uploadFiles() calls and the storefront upload sites.
const ALLOWED_FOLDERS = new Set([
  'vendor-logos',
  'vendor-documents',
  'vendor-documents/gst',
  'vendor-documents/pan',
  'vendor-documents/business-cert',
  'vendor-documents/aadhaar',
  'vendor-documents/iec',
  'vendor-owners',
  'vendor-owner-photos',
  'vendor-factories',
  'vendor-certifications',
  'vendor-contact-photos',
  'products',
  'support-tickets',
]);

// GET /api/uploads/signature?folder=<folder>&contentType=<mime>&ext=<.ext>
// Returns a short-lived presigned PUT URL so the browser can upload a file
// directly to DigitalOcean Spaces (bypassing the API server, which on Vercel is
// capped at a 4.5 MB request body). The access secret never leaves the server —
// only the signed URL does. The object is stored public-read and is then served
// from the Spaces CDN at `publicUrl`.
const getUploadSignature = async (req, res) => {
  try {
    if (!spaces.isConfigured()) {
      return res.status(503).json({ success: false, error: 'Media storage is not configured' });
    }
    const requested = typeof req.query.folder === 'string' ? req.query.folder : '';
    const folder = ALLOWED_FOLDERS.has(requested) ? requested : 'vendor-documents';
    const contentType = typeof req.query.contentType === 'string' && req.query.contentType
      ? req.query.contentType
      : 'application/octet-stream';
    const ext = typeof req.query.ext === 'string' ? req.query.ext : undefined;

    const { uploadUrl, key, publicUrl } = await spaces.presignPut({ folder, contentType, ext });

    return res.json({
      success: true,
      provider: 'spaces',
      uploadUrl,   // PUT the raw file bytes here
      key,         // stored object key (== public_id)
      publicUrl,   // final CDN URL to persist
      folder,
    });
  } catch (error) {
    console.error('Failed to create Spaces upload signature:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to create upload signature' });
  }
};

module.exports = { getUploadSignature };
