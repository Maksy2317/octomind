// POST /api/track — product analytics, self-hosted in Supabase.
//
// The client fires whitelisted events; we resolve identity best-effort (JWT or
// device-id), answer 204 immediately and insert fire-and-forget. Analytics
// must never slow down or break the product: no await before the response, no
// error surfaces to the caller, and a missing `events` table just logs once.

import { Router, Request, Response } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { isDbConfigured, insertOne } from '../services/db/client';

export const trackRouter = Router();

// The funnel vocabulary. Adding an event = add it here and fire octoTrack('...').
const EVENTS = new Set([
  'app_open',
  // Лендінг: без цих двох воронка реклами сліпа — не видно, скільки людей
  // побачили сторінку і яка кнопка веде в застосунок.
  'view_landing', 'click_cta',
  'signup', 'login',
  'onboarding_done',
  'import_success', 'import_fail',
  'strategy_created', 'material_created', 'package_done',
  'prodad_saved',
  'plan_generated', 'post_published',
  'research_done', 'note_saved',
  'paywall_view', 'upgrade_click',
]);

let tableWarned = false;

trackRouter.post('/', optionalIdentity, (req: Request, res: Response) => {
  const event = String(req.body?.event || '');
  if (!EVENTS.has(event)) {
    res.status(400).json({ error: 'unknown event' });
    return;
  }
  let props: unknown = req.body?.props;
  try {
    if (props != null && JSON.stringify(props).length > 2048) props = undefined;
  } catch {
    props = undefined;
  }

  res.status(204).end();

  if (!isDbConfigured()) return;
  const deviceId =
    req.deviceId || String(req.header('x-device-id') || '').slice(0, 128) || null;
  void insertOne('events', {
    event,
    user_id: req.userId ?? null,
    device_id: deviceId,
    props: props ?? null,
  }).catch((e: Error) => {
    if (!tableWarned) {
      tableWarned = true;
      console.warn(
        '[Track] insert failed (events table missing? run db/schema.sql):',
        e.message?.slice(0, 160),
      );
    }
  });
});
