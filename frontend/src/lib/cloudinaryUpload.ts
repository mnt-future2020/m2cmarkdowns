import axiosInstance from './axios';

// Direct browser → DigitalOcean Spaces uploads (via a presigned PUT URL).
//
// Why direct: the API server runs on Vercel serverless, which hard-caps the
// request body at ~4.5 MB. Vendor registration carries many images, so sending
// them through the API (multipart or base64) fails in production. Uploading each
// file straight to Spaces keeps the API request tiny (only URLs).
//
// Spaces has no on-the-fly image transformation (unlike Cloudinary), so we
// downscale + re-encode images to WebP in the browser BEFORE the PUT. The stored
// object is therefore already a sensible delivery size and is served as-is from
// the Spaces CDN — this mirrors the backend's sharp pipeline for base64 uploads.
//
// NOTE: file/function names are kept from the Cloudinary era so the ~20 call
// sites don't change; only the transport swapped.

// Longest edge we keep for delivery — matches the backend sharp cap (MAX_EDGE).
const MAX_EDGE = 2000;
const WEBP_QUALITY = 0.8;

interface PresignResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  folder: string;
}

const getPresign = (folder: string, contentType: string, ext: string): Promise<PresignResponse> =>
  axiosInstance
    .get('/uploads/signature', { params: { folder, contentType, ext } })
    .then((res) => res.data as PresignResponse);

// Downscale + WebP-encode an image blob in the browser. Non-images, GIFs (may be
// animated) and SVGs pass through untouched. Returns the blob to upload plus its
// final content-type and extension.
async function optimizeIfImage(file: File | Blob): Promise<{ blob: Blob; contentType: string; ext: string }> {
  const type = (file as File).type || '';
  const passthrough = () => ({ blob: file, contentType: type || 'application/octet-stream', ext: extFromType(type) });

  if (!type.startsWith('image/') || type === 'image/gif' || type === 'image/svg+xml') return passthrough();
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return passthrough();

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return passthrough();
    ctx.drawImage(bitmap, 0, 0, w, h);
    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY),
    );
    bitmap.close?.();
    if (!webp) return passthrough();
    return { blob: webp, contentType: 'image/webp', ext: '.webp' };
  } catch {
    return passthrough();
  }
}

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
}

// Upload a single File/Blob directly to Spaces using a presigned PUT.
export async function uploadFileToCloudinary(
  file: File | Blob,
  folder: string,
): Promise<CloudinaryUploadResult> {
  const { blob, contentType, ext } = await optimizeIfImage(file);
  const sig = await getPresign(folder, contentType, ext);

  const res = await fetch(sig.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'x-amz-acl': 'public-read' },
    body: blob,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Upload failed${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return { url: sig.publicUrl, publicId: sig.key };
}

// Convert a base64 data URI to a Blob and upload it. Non-data-URI strings
// (already hosted URLs) are returned unchanged.
export async function uploadDataUri(value: string, folder: string): Promise<string> {
  if (typeof value !== 'string' || !value.startsWith('data:')) return value;
  const blob = await (await fetch(value)).blob();
  const { url } = await uploadFileToCloudinary(blob, folder);
  return url;
}

// Deep-walk a JSON-ish value and replace every base64 data URI with its uploaded
// URL. Mirrors the backend's resolveBase64InValue so the two paths produce
// identical stored shapes. Values that are already URLs pass through.
export async function resolveBase64Deep(value: any, folder: string): Promise<any> {
  if (value == null) return value;
  if (typeof value === 'string') return uploadDataUri(value, folder);
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveBase64Deep(v, folder)));
  if (typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await resolveBase64Deep(v, folder)] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function extFromType(type: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  };
  return map[type.toLowerCase()] || '';
}
