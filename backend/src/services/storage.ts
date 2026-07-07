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
 * Upload an image buffer and return its permanent public URL.
 * Returns null on any failure so the caller can fall back to local disk.
 */
export async function uploadImage(buf: Buffer, ext: string, mime?: string): Promise<string | null> {
  if (!isStorageConfigured()) return null;
  try {
    if (!bucketReady) await ensureBucket();
    if (!bucketReady) return null;
    const contentType = mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    const objectPath = `gen/${randomUUID()}.${ext}`;
    const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': contentType, 'cache-control': '31536000', 'x-upsert': 'true' }),
      body: buf,
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
