// GET /api/admin/stats — owner-only dashboard numbers (registrations + activity).
//
// Gated by a shared secret: the caller must send `x-admin-key` equal to the
// ADMIN_KEY env var. If ADMIN_KEY isn't set, the endpoint is disabled (403) so
// it can never leak. All aggregation happens in the Postgres `admin_stats()`
// function (see db/schema.sql), which can read auth.users (real signups).

import { Router, Request, Response, NextFunction } from 'express';
import { isDbConfigured, rpc, select } from '../services/db/client';

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

// GET /api/admin/funnel?days=14 — the activation funnel from the events table.
// Aggregated in Node (early volumes are tiny); one identity = user_id, else
// device_id, so anonymous → signed-up journeys still count once per person.
const FUNNEL_STEPS = [
  'app_open', 'onboarding_done', 'strategy_created', 'material_created',
  'package_done', 'plan_generated', 'post_published',
];
adminRouter.get('/funnel', async (req: Request, res: Response, next: NextFunction) => {
  if (!authorized(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await select<{ event: string; user_id: string | null; device_id: string | null }>(
      'events',
      `select=event,user_id,device_id&created_at=gte.${encodeURIComponent(since)}&limit=50000`,
    );
    const totals: Record<string, number> = {};
    const uniq: Record<string, Set<string>> = {};
    for (const r of rows) {
      totals[r.event] = (totals[r.event] || 0) + 1;
      const who = r.user_id || r.device_id || 'anon';
      (uniq[r.event] ||= new Set()).add(who);
    }
    const events = Object.fromEntries(
      Object.keys(totals).sort().map((e) => [e, { total: totals[e], unique: uniq[e].size }]),
    );
    const funnel = FUNNEL_STEPS.map((step) => ({
      step,
      unique: uniq[step]?.size || 0,
    }));
    res.json({ days, sampled: rows.length, events, funnel });
  } catch (err) {
    next(err);
  }
});
