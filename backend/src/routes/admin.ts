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
// POST /api/admin/digest-run — trigger the weekly digest by hand.
// Body: { dryRun?: boolean } — dryRun collects candidates and renders a preview
// without sending anything (works before Resend is configured).
adminRouter.post('/digest-run', async (req: Request, res: Response, next: NextFunction) => {
  if (!authorized(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  try {
    const { runWeeklyDigest } = await import('../services/digest');
    const dryRun = req.body?.dryRun !== false;   // default SAFE: dry run
    res.json(await runWeeklyDigest(dryRun));
  } catch (err) {
    next(err);
  }
});

// Повний шлях, а не з середини. Раніше воронка починалась з app_open, хоча
// view_landing / click_cta / signup ми вже збираємо — тобто найцінніше
// (скільки людей з лендингу дійшло до реєстрації) було невидиме.
const FUNNEL_STEPS = [
  'view_landing', 'click_cta', 'app_open', 'signup', 'onboarding_done',
  'strategy_created', 'material_created', 'package_done',
  'plan_generated', 'post_published',
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
    const rows = await select<{ event: string; user_id: string | null; device_id: string | null; created_at: string }>(
      'events',
      `select=event,user_id,device_id,created_at&created_at=gte.${encodeURIComponent(since)}&limit=50000`,
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
    // ── Повернення ───────────────────────────────────────────────────────────
    // Головне питання «чи піде проєкт» — не скільки прийшло, а скільки
    // ПОВЕРНУЛОСЬ. Воронка показує лише перший візит: людина може пройти всі
    // пʼять кроків і зникнути назавжди, і воронка виглядатиме бездоганно.
    // Рахуємо з тих самих подій — окремих запитів до бази не треба.
    const daysByWho: Record<string, Set<string>> = {};
    for (const r of rows) {
      const who = r.user_id || r.device_id || 'anon';
      const day = String(r.created_at || '').slice(0, 10);   // UTC-доба
      if (!day) continue;
      (daysByWho[who] ||= new Set()).add(day);
    }
    const people = Object.values(daysByWho);
    const dayNum = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
    let returned = 0, nextDay = 0, weekPlus = 0;
    for (const set of people) {
      const sorted = [...set].sort();
      if (sorted.length > 1) returned++;
      const first = dayNum(sorted[0]);
      if (sorted.some((d) => dayNum(d) === first + 1)) nextDay++;
      if (sorted.some((d) => dayNum(d) - first >= 7)) weekPlus++;
    }
    const retention = {
      people: people.length,
      returned,          // приходили більш ніж в один день
      nextDay,           // повернулись саме наступного дня
      weekPlus,          // ще живі через тиждень і більше
      // Чесне попередження для малих чисел: на десятці людей відсоток —
      // це шум, і будувати на ньому рішення не можна.
      thin: people.length < 20,
    };

    res.json({ days, sampled: rows.length, events, funnel, retention });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/requests — заявки на підписку: скільки людей підняли руку і
// скільки готові платити. Це головна цифра до появи каси: воронка показує
// інтерес, заявки — намір.
adminRouter.get('/requests', async (req: Request, res: Response, next: NextFunction) => {
  if (!authorized(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  try {
    const rows = await select<{
      id: number; created_at: string; plan: string;
      budget: string | null; note: string | null; contact: string;
    }>('upgrade_requests', 'select=id,created_at,plan,budget,note,contact&order=created_at.desc&limit=300');

    const byBudget: Record<string, number> = {};
    const byPlan: Record<string, number> = {};
    const weekAgo = Date.now() - 7 * 86400000;
    let last7 = 0;
    for (const r of rows) {
      const b = r.budget || 'не вказали';
      byBudget[b] = (byBudget[b] || 0) + 1;
      byPlan[r.plan] = (byPlan[r.plan] || 0) + 1;
      if (Date.parse(r.created_at) >= weekAgo) last7++;
    }
    res.json({ total: rows.length, last7, byBudget, byPlan, rows });
  } catch (err) {
    next(err);
  }
});
