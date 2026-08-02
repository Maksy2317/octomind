// Identity middleware: JWT-first, device-id fallback.
//
// Logged-in clients send their Supabase access token as `Authorization:
// Bearer <jwt>`; we validate it against Supabase Auth and resolve the user to
// a stable `users` row keyed `auth_<uid>` — the same row on every device, so
// quotas and the paid plan follow the ACCOUNT, not the browser tab.
//
// Anonymous clients keep the old path: a self-generated `x-device-id` header
// resolved to a device-keyed row. That id is trivially spoofable, which is
// exactly why it must never be the identity behind paid limits — it only
// scopes the free anonymous trial (belt: the AI rate limiter in index.ts).

import { Request, Response, NextFunction } from 'express';
import { isDbConfigured } from '../services/db/client';
import { getOrCreateUserByDevice } from '../services/db/repos';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      deviceId?: string;
      authUid?: string;
    }
  }
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Акаунтні рядки живуть у ТОМУ САМОМУ полі `users.device_id`, лише з префіксом
// `auth_<uid>` (див. resolveAuthUser). А `auth_` та `-` дозволені у DEVICE_ID_RE,
// тому клієнт міг надіслати `x-device-id: auth_<чужий-uid>` БЕЗ ЖОДНОГО ТОКЕНА
// й потрапити в акаунтний рядок жертви: читати й перезаписувати її профіль
// бізнесу, бачити історію генерацій і успадкувати її платний тариф. Перевірено
// живою атакою — профіль створювався і читався.
//
// Префікс тепер зарезервований: його може поставити лише сервер після перевірки
// JWT. Не змінюємо сам ключ на щось на кшталт `auth:<uid>` (що було б
// структурно надійніше) саме тому, що це осиротило б рядки всіх, хто вже
// залогінений, разом із їхніми тарифами й профілями.
const RESERVED_PREFIX_RE = /^auth[_-]/i;

/** Чи можна довіряти цьому рядку як device-id, що прийшов від клієнта. */
function validDeviceId(id: string): boolean {
  return DEVICE_ID_RE.test(id) && !RESERVED_PREFIX_RE.test(id);
}

// ── Supabase JWT validation (cached) ─────────────────────────────────────────
// One network round-trip per token per 10 minutes; everything else is a Map
// hit. Fail-open to the device path: a Supabase hiccup must not lock the app.
const AUTH_CACHE = new Map<string, { uid: string; until: number }>();
const AUTH_TTL_MS = 10 * 60_000;
const AUTH_CACHE_MAX = 5000;

export async function resolveAuthUid(req: Request): Promise<string | null> {
  const h = String(req.header('authorization') || '');
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  // Cheap pre-filter: a Supabase access token is a 3-part JWT.
  if (!token || token === 'guest' || token.split('.').length !== 3) return null;

  const now = Date.now();
  const hit = AUTH_CACHE.get(token);
  if (hit && hit.until > now) return hit.uid;

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!base || !key) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${base}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = (await r.json()) as { id?: string };
    if (!data?.id) return null;
    if (AUTH_CACHE.size >= AUTH_CACHE_MAX) AUTH_CACHE.clear();
    AUTH_CACHE.set(token, { uid: data.id, until: now + AUTH_TTL_MS });
    return data.id;
  } catch {
    return null;
  }
}

/** Resolve the strongest identity available: auth uid → users row, else null. */
async function resolveAuthUser(req: Request): Promise<boolean> {
  const uid = await resolveAuthUid(req);
  if (!uid) return false;
  const user = await getOrCreateUserByDevice('auth_' + uid);
  req.userId = user.id;
  req.authUid = uid;
  req.deviceId = String(req.header('x-device-id') || '').trim() || undefined;
  return true;
}

/**
 * Requires an identity: a valid Supabase JWT (preferred) or `x-device-id`.
 * Responds 400 when neither is present and 503 if the DB isn't configured.
 */
export async function requireIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  try {
    // JWT first: the account identity, stable across devices and unspoofable.
    if (await resolveAuthUser(req)) return next();
  } catch (err) {
    return next(err);
  }

  const deviceId = String(req.header('x-device-id') || '').trim();
  if (!deviceId || !validDeviceId(deviceId)) {
    res.status(400).json({ error: 'Missing or invalid x-device-id header' });
    return;
  }

  try {
    const user = await getOrCreateUserByDevice(deviceId);
    req.userId = user.id;
    req.deviceId = deviceId;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Best-effort identity: JWT when present, else `x-device-id`, and never blocks
 * the request. Lets stateless flows (the marketing brain) work before the
 * Supabase migration has been run — results simply aren't persisted until the
 * DB is up.
 */
export async function optionalIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!isDbConfigured()) return next();

  try {
    if (await resolveAuthUser(req)) return next();
  } catch (err) {
    console.warn('[Identity] auth resolve failed, falling back to device:', (err as Error).message?.slice(0, 200));
  }

  const deviceId = String(req.header('x-device-id') || '').trim();
  if (!deviceId || !validDeviceId(deviceId)) return next();

  try {
    const user = await getOrCreateUserByDevice(deviceId);
    req.userId = user.id;
    req.deviceId = deviceId;
  } catch (err) {
    console.warn('[Identity] DB unavailable, continuing stateless:', (err as Error).message?.slice(0, 200));
  }
  next();
}
