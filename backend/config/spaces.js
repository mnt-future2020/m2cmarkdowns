/**
 * DigitalOcean Spaces storage — the single integration point for media.
 *
 * Spaces is S3-compatible, so we drive it with the AWS SDK v3 pointed at the
 * Spaces regional endpoint. This module is the ONLY place that talks to the
 * object store; config/cloudinary.js re-exports these helpers under their old
 * names so the ~30 controllers that upload media never had to change.
 *
 * Env (all DO_SPACES_*):
 *   DO_SPACES_KEY / DO_SPACES_SECRET   access key pair
 *   DO_SPACES_REGION                   e.g. "blr1", "nyc3"
 *   DO_SPACES_BUCKET                   the Space (bucket) name
 *   DO_SPACES_ENDPOINT                 e.g. https://blr1.digitaloceanspaces.com
 *   DO_SPACES_CDN                      public base for reads, e.g.
 *                                      https://<bucket>.blr1.cdn.digitaloceanspaces.com
 *                                      (falls back to the origin URL if unset)
 *
 * Images are optimised at upload with sharp (resize + WebP) — Spaces has no
 * on-the-fly transformation, so we bake a sensible delivery variant at write
 * time and serve it straight from the Spaces CDN.
 *
 * No migration of old Cloudinary assets is done: new uploads land here, while
 * any media already on Cloudinary keeps loading from Cloudinary (dual-source).
 */
const crypto = require('crypto');
const path = require('path');
const sharp = require('sharp');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.DO_SPACES_REGION || 'blr1';
const BUCKET = process.env.DO_SPACES_BUCKET || '';

// The S3 client endpoint must be the REGION host only (e.g.
// https://sgp1.digitaloceanspaces.com) — the SDK prepends the bucket itself in
// virtual-hosted style. People often paste the bucket-specific URL by mistake,
// so strip a leading "<bucket>." label if present.
function normalizeEndpoint(raw) {
  const fallback = `https://${REGION}.digitaloceanspaces.com`;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    let host = u.hostname;
    if (BUCKET && host.startsWith(`${BUCKET}.`)) host = host.slice(BUCKET.length + 1);
    return `${u.protocol}//${host}`;
  } catch {
    return fallback;
  }
}
const ENDPOINT = normalizeEndpoint(process.env.DO_SPACES_ENDPOINT);
// Public read base. Prefer the configured CDN; otherwise serve from the origin
// (bucket as a subdomain of the region endpoint).
const CDN_BASE = (process.env.DO_SPACES_CDN
  || ENDPOINT.replace('https://', `https://${BUCKET}.`))
  .replace(/\/+$/, '');

const isConfigured = () => Boolean(BUCKET && process.env.DO_SPACES_KEY && process.env.DO_SPACES_SECRET);

// Lazy singleton so a missing config doesn't crash at require-time (e.g. in
// tooling that imports a controller without needing uploads).
let _client = null;
const client = () => {
  if (_client) return _client;
  _client = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: false, // Spaces uses virtual-hosted style (bucket.endpoint)
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET,
    },
  });
  return _client;
};

// Build the public URL for a stored object key.
const publicUrl = (key) => `${CDN_BASE}/${String(key).replace(/^\/+/, '')}`;

// A random, collision-free object key inside a folder, preserving extension.
const makeKey = (folder, ext) => {
  const clean = String(folder || 'uploads').replace(/^\/+|\/+$/g, '');
  const id = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  return ext ? `${clean}/${id}${ext.startsWith('.') ? ext : `.${ext}`}` : `${clean}/${id}`;
};

// Images we optimise; everything else (PDF, etc.) is stored as-is.
const IMAGE_MIME = /^image\/(jpe?g|png|webp|gif|avif|tiff|bmp)$/i;
// Max delivered edge — large originals are downscaled once at upload. Matches
// the biggest responsive variant the storefront ever requests.
const MAX_EDGE = 2000;

/**
 * Upload a buffer to Spaces and return { secure_url, public_id, ... } — the
 * shape the old Cloudinary helper returned, so callers are unchanged. For raster
 * images we re-encode to WebP at a sane quality and cap the longest edge.
 */
async function putObject(buffer, { folder = 'uploads', contentType, filename, optimizeImages = true } = {}) {
  if (!isConfigured()) throw new Error('DigitalOcean Spaces is not configured (DO_SPACES_* env vars missing)');

  let body = buffer;
  let mime = contentType || 'application/octet-stream';
  let ext = filename ? path.extname(filename) : '';

  if (optimizeImages && IMAGE_MIME.test(mime) && mime !== 'image/gif') {
    // GIFs may be animated — leave them untouched; re-encode the rest to WebP.
    try {
      body = await sharp(buffer)
        .rotate() // honour EXIF orientation
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      mime = 'image/webp';
      ext = '.webp';
    } catch (e) {
      // Not a decodable image after all — fall back to storing the original.
      console.warn('[spaces] image optimise failed, storing original:', e?.message || e);
    }
  }
  if (!ext) ext = extFromMime(mime);

  const key = makeKey(folder, ext);
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: mime,
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    secure_url: publicUrl(key),
    url: publicUrl(key),
    public_id: key,          // for Spaces the key IS the public id
    bucket: BUCKET,
    resource_type: IMAGE_MIME.test(mime) ? 'image' : 'raw',
    bytes: body.length,
  };
}

// Delete an object by its key (public_id).
async function deleteObject(key) {
  if (!key) return;
  if (!isConfigured()) return;
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: stripToKey(key) }));
}

// Server-side copy within the Space (object key → object key). General utility
// for any internal re-homing of assets.
async function copyObject(sourceKey, destKey) {
  await client().send(new CopyObjectCommand({
    Bucket: BUCKET,
    CopySource: `/${BUCKET}/${stripToKey(sourceKey)}`,
    Key: stripToKey(destKey),
    ACL: 'public-read',
  }));
  return publicUrl(destKey);
}

async function objectExists(key) {
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: stripToKey(key) }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Presigned PUT for direct browser → Spaces uploads (bypasses the Vercel 4.5 MB
 * body cap). The browser PUTs the raw file to `uploadUrl`; the stored object is
 * then publicly readable at `publicUrl`. NOTE: a presigned PUT stores the bytes
 * as sent — no server-side sharp optimisation — so the client should downscale
 * large images before upload, or route them through the API for optimisation.
 */
async function presignPut({ folder = 'uploads', contentType = 'application/octet-stream', ext }) {
  if (!isConfigured()) throw new Error('DigitalOcean Spaces is not configured');
  const key = makeKey(folder, ext || extFromMime(contentType));
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  });
  const uploadUrl = await getSignedUrl(client(), command, { expiresIn: 300 });
  return { uploadUrl, key, publicUrl: publicUrl(key) };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/avif': '.avif', 'application/pdf': '.pdf',
  };
  return map[String(mime).toLowerCase()] || '';
}

// Accept either a bare key or a full Spaces URL and return the object key.
function stripToKey(keyOrUrl) {
  const s = String(keyOrUrl || '');
  if (!/^https?:\/\//.test(s)) return s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    return u.pathname.replace(/^\/+/, '');
  } catch {
    return s;
  }
}

module.exports = {
  isConfigured,
  publicUrl,
  makeKey,
  putObject,
  deleteObject,
  copyObject,
  objectExists,
  presignPut,
  stripToKey,
  BUCKET,
  CDN_BASE,
};
