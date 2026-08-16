import { Router, Request, Response } from 'express';
import webpush from 'web-push';

export const pushRouter = Router();

// ── VAPID setup ──────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  // Контакт для сервісів пушів (Google/Mozilla): за ним вони звертаються, якщо з
  // нашими сповіщеннями проблема. Тут стояв hello@octomind.app — домен .app нам
  // не належить, тобто адреса була мертва.
  webpush.setVapidDetails('mailto:octomind.support@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Supabase (push_subscriptions table) ──────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';

const sbH = () => ({
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type':  'application/json',
});

// ── In-memory cache (populated from DB on startup) ───────────────────────────
type PushSub = {
  subscription: webpush.PushSubscription;
  userId?:      string;
  createdAt:    string;
};
const subscriptions: PushSub[] = [];

// ── Load subscriptions from Supabase into memory ─────────────────────────────
export async function loadSubscriptionsFromDB(): Promise<void> {
  if (!SB_URL || !SB_KEY) {
    console.log('[Push] Supabase not configured — using in-memory only');
    return;
  }
  try {
    const res = await fetch(`${SB_URL}/rest/v1/push_subscriptions?select=*`, {
      headers: sbH(),
    });
    if (!res.ok) {
      console.warn('[Push] DB load failed:', res.status, await res.text());
      return;
    }
    const rows = await res.json() as Array<{
      endpoint:     string;
      subscription: webpush.PushSubscription;
      user_id?:     string;
      created_at:   string;
    }>;

    subscriptions.length = 0;
    for (const row of rows) {
      subscriptions.push({
        subscription: row.subscription,
        userId:       row.user_id,
        createdAt:    row.created_at,
      });
    }
    console.log(`[Push] Loaded ${subscriptions.length} subscription(s) from Supabase`);
  } catch (e) {
    console.warn('[Push] Failed to load subscriptions from DB:', e);
  }
}

// ── Persist one subscription ──────────────────────────────────────────────────
async function saveSubToDB(sub: PushSub): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/push_subscriptions`, {
      method:  'POST',
      headers: { ...sbH(), 'Prefer': 'resolution=merge-duplicates' },
      body:    JSON.stringify({
        endpoint:     sub.subscription.endpoint,
        subscription: sub.subscription,
        user_id:      sub.userId || null,
        created_at:   sub.createdAt,
      }),
    });
  } catch (e) {
    console.warn('[Push] Failed to save sub to DB:', e);
  }
}

// ── Remove one subscription ───────────────────────────────────────────────────
async function deleteSubFromDB(endpoint: string): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(
      `${SB_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
      { method: 'DELETE', headers: sbH() }
    );
  } catch (e) {
    console.warn('[Push] Failed to delete sub from DB:', e);
  }
}

// ── Scheduled reminders (in-memory — re-synced by client on page load) ───────
type ScheduledReminder = {
  endpoint:     string;
  subscription: webpush.PushSubscription;
  id:           string;
  utcTimestamp: number;   // ms — exact moment to fire
  type:         string;   // reels / tiktok / stories / carousel / post / custom
  note:         string;
  displayTime:  string;   // "15:00" for notification body
  fired:        boolean;
};
const scheduledReminders: ScheduledReminder[] = [];

// ── GET /api/push/vapid-public-key ───────────────────────────────────────────
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
pushRouter.post('/subscribe', async (req: Request, res: Response) => {
  const { subscription, userId } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Не вдалося ввімкнути сповіщення — спробуй ще раз' });
  }
  const entry: PushSub = {
    subscription,
    userId,
    createdAt: new Date().toISOString(),
  };
  const exists = subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  if (exists >= 0) {
    subscriptions[exists] = entry;
  } else {
    subscriptions.push(entry);
  }
  // Persist to Supabase (non-blocking)
  saveSubToDB(entry);
  res.json({ ok: true, total: subscriptions.length });
});

// ── POST /api/push/unsubscribe ────────────────────────────────────────────────
pushRouter.post('/unsubscribe', (req: Request, res: Response) => {
  const { endpoint } = req.body;
  const idx = subscriptions.findIndex(s => s.subscription.endpoint === endpoint);
  if (idx >= 0) subscriptions.splice(idx, 1);
  // Remove scheduled reminders for this endpoint
  for (let i = scheduledReminders.length - 1; i >= 0; i--) {
    if (scheduledReminders[i].endpoint === endpoint) scheduledReminders.splice(i, 1);
  }
  // Remove from DB (non-blocking)
  deleteSubFromDB(endpoint);
  res.json({ ok: true });
});

// ── POST /api/push/schedule ───────────────────────────────────────────────────
// Frontend calls this on every page load and on every bell toggle.
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
    if (!r.utcTimestamp || r.utcTimestamp <= now) continue;
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

  console.log(`[Push] Scheduled ${added} reminder(s) for ...${endpoint.slice(-20)}`);
  res.json({ ok: true, scheduled: added });
});

// ── Exported: check & fire due reminders (called by cron in index.ts) ────────
export async function fireScheduledReminders(): Promise<void> {
  const now    = Date.now();
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
        url:   '/app?screen=calendar',
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
      if (err.statusCode === 410 || err.statusCode === 404) {
        toRemove.push(sub.subscription.endpoint);
      }
      failed++;
    }
  }
  // Remove stale subscriptions
  for (const ep of toRemove) {
    const idx = subscriptions.findIndex(s => s.subscription.endpoint === ep);
    if (idx >= 0) subscriptions.splice(idx, 1);
    deleteSubFromDB(ep);
  }
  return { sent, failed };
}

// ── POST /api/push/test ───────────────────────────────────────────────────────
pushRouter.post('/test', async (_req: Request, res: Response) => {
  const result = await sendPushToAll({
    title: '🐙 OctoMind — тест',
    body:  'Push-сповіщення працюють! Твої нагадування активовані.',
    icon:  '/icons/icon.svg',
    badge: '/icons/icon.svg',
    url:   '/app?screen=calendar',
  });
  res.json(result);
});
