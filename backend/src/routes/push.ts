import { Router, Request, Response } from 'express';
import webpush from 'web-push';

export const pushRouter = Router();

// ── VAPID setup ──────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(
    'mailto:hello@octomind.app',
    VAPID_PUBLIC,
    VAPID_PRIVATE
  );
}

// ── In-memory subscription store (survives restarts via simple array)
//    For production: replace with DB (Postgres / Redis)
type PushSub = {
  subscription: webpush.PushSubscription;
  userId?: string;
  createdAt: string;
};
const subscriptions: PushSub[] = [];

// ── GET /api/push/vapid-public-key ───────────────────────────────────────────
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
pushRouter.post('/subscribe', (req: Request, res: Response) => {
  const { subscription, userId } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  // Deduplicate by endpoint
  const exists = subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  if (exists >= 0) {
    subscriptions[exists] = { subscription, userId, createdAt: new Date().toISOString() };
  } else {
    subscriptions.push({ subscription, userId, createdAt: new Date().toISOString() });
  }

  res.json({ ok: true, total: subscriptions.length });
});

// ── POST /api/push/unsubscribe ────────────────────────────────────────────────
pushRouter.post('/unsubscribe', (req: Request, res: Response) => {
  const { endpoint } = req.body;
  const idx = subscriptions.findIndex(s => s.subscription.endpoint === endpoint);
  if (idx >= 0) subscriptions.splice(idx, 1);
  res.json({ ok: true });
});

// ── Internal helper: send push to all or specific user ───────────────────────
export async function sendPushToAll(payload: object): Promise<{ sent: number; failed: number }> {
  let sent = 0; let failed = 0;
  const toRemove: string[] = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
      sent++;
    } catch (err: any) {
      // 410 Gone = subscription expired/removed
      if (err.statusCode === 410 || err.statusCode === 404) {
        toRemove.push(sub.subscription.endpoint);
      }
      failed++;
    }
  }

  // Clean up dead subscriptions
  toRemove.forEach(ep => {
    const idx = subscriptions.findIndex(s => s.subscription.endpoint === ep);
    if (idx >= 0) subscriptions.splice(idx, 1);
  });

  return { sent, failed };
}

// ── POST /api/push/test  (dev helper) ────────────────────────────────────────
pushRouter.post('/test', async (_req: Request, res: Response) => {
  const result = await sendPushToAll({
    title: '🐙 OctoMind — тест',
    body: 'Push-сповіщення працюють! Твої нагадування активовані.',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    url: '/?screen=calendar',
  });
  res.json(result);
});
