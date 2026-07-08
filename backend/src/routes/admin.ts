// GET /api/admin/stats — owner-only dashboard numbers (registrations + activity).
//
// Gated by a shared secret: the caller must send `x-admin-key` equal to the
// ADMIN_KEY env var. If ADMIN_KEY isn't set, the endpoint is disabled (403) so
// it can never leak. All aggregation happens in the Postgres `admin_stats()`
// function (see db/schema.sql), which can read auth.users (real signups).

import { Router, Request, Response, NextFunction } from 'express';
import { isDbConfigured, rpc } from '../services/db/client';

export const adminRouter = Router();

function authorized(req: Request): boolean {
  const key = process.env.ADMIN_KEY;
  if (!key) return false; // disabled until a key is configured
  return String(req.header('x-admin-key') || '') === key;
}

adminRouter.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  if (!authorized(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  try {
    // admin_stats() returns a single json object.
    const stats = await rpc<Record<string, unknown>>('admin_stats');
    res.json(stats);
  } catch (err) {
    next(err);
  }
});
