// Persistent image storage via Supabase Storage.
//
// Railway's filesystem is EPHEMERAL — anything written to disk is wiped on every
// redeploy, so generated ad images saved there turn into broken links. This
// uploads them to a public Supabase Storage bucket instead, returning a stable
// URL that survives deploys.
//
// Fail-open: if Storage isn't configured or an upload fails, we return null and
// the caller falls back to local disk (fine for dev / short-lived).

import { randomUUID } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const BUCKET = process.env.STORAGE_BUCKET || 'generated';

export function isStorageConfigured(): boolean {
  return Boolean(SB_URL && SB_KEY);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}

let bucketReady = false;

/** Create the public bucket if it doesn't exist (idempotent, safe to call on boot). */
export async function ensureBucket(): Promise<void> {
  if (!isStorageConfigured() || bucketReady) return;
  try {
    const res = await fetch(`${SB_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    // 200 = created; 400/409 = already exists — both are success for us.
    if (res.ok || res.status === 400 || res.status === 409) {
      bucketReady = true;
    } else {
      console.warn('[Storage] bucket create failed', res.status, (await res.text()).slice(0, 120));
    }
  } catch (err) {
    console.warn('[Storage] ensureBucket error', (err as Error).message?.slice(0, 120));
  }
}

/**
 * Upload any buffer and return its permanent public URL.
 * Returns null on any failure so the caller can fall back to local disk.
 */
export async function uploadBuffer(
  buf: Buffer,
  ext: string,
  contentType: string,
  prefix = 'gen',
  cacheSeconds = 31536000,
): Promise<string | null> {
  if (!isStorageConfigured()) return null;
  try {
    if (!bucketReady) await ensureBucket();
    if (!bucketReady) return null;
    const objectPath = `${prefix}/${randomUUID()}.${ext}`;
    const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': contentType, 'cache-control': String(cacheSeconds), 'x-upsert': 'true' }),
      body: new Uint8Array(buf),
    });
    if (!res.ok) {
      console.warn('[Storage] upload failed', res.status, (await res.text()).slice(0, 120));
      return null;
    }
    return `${SB_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  } catch (err) {
    console.warn('[Storage] upload error', (err as Error).message?.slice(0, 120));
    return null;
  }
}

export async function uploadImage(buf: Buffer, ext: string, mime?: string): Promise<string | null> {
  const contentType = mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  return uploadBuffer(buf, ext, contentType, 'gen');
}

/**
 * User-shot photo/video attached to a content-plan item.
 *
 * Lives in Storage rather than on disk on purpose: Railway wipes the filesystem
 * on every redeploy, and — more importantly — Instagram and TikTok fetch media
 * BY PUBLIC URL when publishing, so this same URL is what autoposting will need.
 */
export async function uploadPlanMedia(buf: Buffer, mime: string): Promise<string | null> {
  const ext = MEDIA_EXT[mime];
  if (!ext) return null;
  // Годинний кеш, а не рік: це медіа користувач замінює й видаляє, і при
  // річному кеші CDN ще довго віддавав би вже видалений файл.
  return uploadBuffer(buf, ext, mime, 'plan', 3600);
}

export const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};

/**
 * Delete a previously uploaded object by its public URL.
 *
 * Без цього відчеплене від картки відео лежало у сховищі назавжди — на Free
 * тарифі це 1 ГБ, який заповнюється швидше, ніж здається. Приймаємо саме URL,
 * бо клієнт іншого й не знає. Fail-open: не вийшло — не ламаємо UX.
 */
export async function deleteByPublicUrl(url: string): Promise<boolean> {
  if (!isStorageConfigured() || !url) return false;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const at = url.indexOf(marker);
  if (at < 0) return false;                       // чужий/сторонній URL — не наше діло
  const objectPath = url.slice(at + marker.length).split('?')[0];
  // Дозволяємо лише наші префікси — щоб підробленим URL не можна було
  // попросити видалити щось інше з бакета.
  if (!/^(plan|gen)\/[A-Za-z0-9._-]+$/.test(objectPath)) return false;
  try {
    const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.warn('[Storage] delete error', (err as Error).message?.slice(0, 120));
    return false;
  }
}
