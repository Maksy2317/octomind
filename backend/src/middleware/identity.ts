// Anonymous-first identity middleware.
//
// The client generates a stable device id (stored in localStorage) and sends it
// as the `x-device-id` header. We resolve it to a `users` row (creating one on
// first sight) and attach `req.userId` / `req.deviceId` for downstream handlers.
//
// This is a placeholder for real auth: when email login lands, it can populate
// the same `req.userId` and everything downstream keeps working.

import { Request, Response, NextFunction } from 'express';
import { isDbConfigured } from '../services/db/client';
import { getOrCreateUserByDevice } from '../services/db/repos';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      deviceId?: string;
    }
  }
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Requires a valid `x-device-id` and resolves it to a user id.
 * Responds 400 for a missing/invalid id and 503 if the DB isn't configured.
 */
export async function requireIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  const deviceId = String(req.header('x-device-id') || '').trim();

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: 'Missing or invalid x-device-id header' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Database not configured' });
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
 * Best-effort identity: resolves `x-device-id` to a user when the DB is
 * reachable, but never blocks the request. Lets stateless flows (the marketing
 * brain) work before the Supabase migration has been run — results simply
 * aren't persisted until the DB is up.
 */
export async function optionalIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const deviceId = String(req.header('x-device-id') || '').trim();
  if (!deviceId || !DEVICE_ID_RE.test(deviceId) || !isDbConfigured()) return next();

  try {
    const user = await getOrCreateUserByDevice(deviceId);
    req.userId = user.id;
    req.deviceId = deviceId;
  } catch (err) {
    console.warn('[Identity] DB unavailable, continuing stateless:', (err as Error).message?.slice(0, 200));
  }
  next();
}
