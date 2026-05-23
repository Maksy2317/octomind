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

// ── In-memory subscription store ─────────────────────────────────────────────
type PushSub = {
  subscription: webpush.PushSubscription;
  userId?: string;
  createdAt: string;
};
const subscriptions: PushSub[] = [];

// ── Scheduled reminders ───────────────────────────────────────────────────────
type ScheduledReminder = {
  endpoint: string;
  subscription: webpush.PushSubscription;
  id: string;
  utcTimestamp: number; // ms — exact moment to fire
  type: string;         // reels / tiktok / stories / carousel / post / custom
  note: string;
  displayTime: string;  // "15:00" for notification body
  fired: boolean;
};
const scheduledReminders: ScheduledReminder[] = [];

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
  // Also remove all scheduled reminders for this endpoint
  for (let i = scheduledReminders.length - 1; i >= 0; i--) {
    if (scheduledReminders[i].endpoint === endpoint) scheduledReminders.splice(i, 1);
  }
  res.json({ ok: true });
});

// ── POST /api/push/schedule ───────────────────────────────────────────────────
// Frontend calls this whenever a reminder is toggled.
// Replaces all reminders for this subscription endpoint.
pushRouter.post('/schedule', (req: Request, res: Response) => {
  const { endpoint, reminders } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

  // Find subscription for this endpoint
  const subEntry = subscriptions.find(s => s.subscription.endpoint === endpoint);
  if (!subEntry) return res.status(400).json({ error: 'Subscription not found. Subscribe to push first.' });

  // Remove all old reminders for this endpoint
  for (let i = scheduledReminders.length - 1; i >= 0; i--) {
    if (scheduledReminders[i].endpoint === endpoint) scheduledReminders.splice(i, 1);
  }

  // Add new reminders (only future ones)
  const now = Date.now();
  let added = 0;
  for (const r of (reminders || [])) {
    if (!r.utcTimestamp || r.utcTimestamp <= now) continue; // skip past
    scheduledReminders.push({
      endpoint,
      subscription: subEntry.subscription,
      id:           String(r.id || Math.random().toString(36).slice(2)),
      utcTimestamp: Number(r.utcTimestamp),
      type:         String(r.type || 'post'),
      note:         String(r.note || ''),
      displayTime:  String(r.displayTime || ''),
      fired:        false,
    });
    added++;
  }

  console.log(`[Push] Scheduled ${added} reminders for endpoint ...${endpoint.slice(-20)}`);
  res.json({ ok: true, scheduled: added });
});

// ── Exported: check & fire due reminders (called by cron in index.ts) ────────
export async function fireScheduledReminders(): Promise<void> {
  const now = Date.now();
  const WINDOW = 35_000; // ±35 s window (cron fires every minute)

  const due = scheduledReminders.filter(
    r => !r.fired && Math.abs(r.utcTimestamp - now) <= WINDOW
  );

  const TYPE_NAMES: Record<string, string> = {
    tiktok: 'TikTok', reels: 'Reels', stories: 'Stories',
    carousel: 'Карусель', post: 'Пост',
  };

  for (const r of due) {
    r.fired = true;
    const typeName = TYPE_NAMES[r.type] || r.type;
    const body = r.note
      ? `${r.displayTime} — ${r.note}`
      : `Запланований ${typeName} о ${r.displayTime}`;

    try {
      await webpush.sendNotification(r.subscription, JSON.stringify({
        title: `🐙 Час постити ${typeName}!`,
        body,
        icon:  '/icons/icon.svg',
        badge: '/icons/icon.svg',
        url:   '/?screen=calendar',
        tag:   `reminder-${r.id}`,
      }));
      console.log(`[Push] Fired reminder ${r.id}: ${typeName} at ${r.displayTime}`);
    } catch (err: any) {
      console.warn(`[Push] Reminder ${r.id} failed:`, err.statusCode || err.message);
    }
  }

  // Clean up fired reminders older than 2 hours
  const cutoff = now - 7_200_000;
  for (let i = scheduledReminders.length - 1; i >= 0; i--) {
    if (scheduledReminders[i].fired && scheduledReminders[i].utcTimestamp < cutoff) {
      scheduledReminders.splice(i, 1);
    }
  }
}

// ── Internal helper: send push to all ────────────────────────────────────────
export async function sendPushToAll(payload: object): Promise<{ sent: number; failed: number }> {
  let sent = 0; let failed = 0;
  const toRemove: string[] = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
      sent++;
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) toRemove.push(sub.subscription.endpoint);
      failed++;
    }
  }
  toRemove.forEach(ep => {
    const idx = subscriptions.findIndex(s => s.subscription.endpoint === ep);
    if (idx >= 0) subscriptions.splice(idx, 1);
  });
  return { sent, failed };
}

// ── POST /api/push/test ───────────────────────────────────────────────────────
pushRouter.post('/test', async (_req: Request, res: Response) => {
  const result = await sendPushToAll({
    title: '🐙 OctoMind — тест',
    body:  'Push-сповіщення працюють! Твої нагадування активовані.',
    icon:  '/icons/icon.svg',
    badge: '/icons/icon.svg',
    url:   '/?screen=calendar',
  });
  res.json(result);
});
