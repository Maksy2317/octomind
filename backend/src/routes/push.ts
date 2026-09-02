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
  // Підписка власника: саме на неї йдуть сповіщення про заявки. Прапорець у
  // тій самій таблиці, бо окрема таблиця заради одного булеана — зайве.
  isOwner?:     boolean;
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
      is_owner?:    boolean;
    }>;

    subscriptions.length = 0;
    for (const row of rows) {
      subscriptions.push({
        subscription: row.subscription,
        userId:       row.user_id,
        createdAt:    row.created_at,
        isOwner:      row.is_owner === true,
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
        is_owner:     sub.isOwner === true,
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
    // Клієнт переприсилає підписку на кожному завантаженні сторінки. Якщо тут
    // просто перезаписати запис, прапорець власника мовчки згасне — і заявки
    // перестануть приходити рівно тоді, коли власник відкриє застосунок.
    entry.isOwner = subscriptions[exists].isOwner === true;
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

// ── Сповіщення власнику ──────────────────────────────────────────────────────
// Заявка на Pro лягала в базу мовчки: ніхто не дізнавався про неї, поки не
// відкриє адмін-екран. Перші заявки — найцінніші контакти, і відповідати на
// них треба того ж дня, поки людина ще памʼятає продукт.
export async function sendPushToOwner(payload: object): Promise<{ sent: number; failed: number }> {
  const owners = subscriptions.filter((s) => s.isOwner === true);
  if (!owners.length) {
    console.warn('[Push] заявка є, але жодна підписка не позначена як власникова — сповіщення нікому слати');
    return { sent: 0, failed: 0 };
  }
  let sent = 0; let failed = 0;
  for (const sub of owners) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
      sent++;
    } catch (err) {
      failed++;
      const code = (err as { statusCode?: number }).statusCode;
      console.warn('[Push] власнику не доставлено:', code);
      if (code === 410 || code === 404) {
        const idx = subscriptions.findIndex((x) => x.subscription.endpoint === sub.subscription.endpoint);
        if (idx >= 0) subscriptions.splice(idx, 1);
        deleteSubFromDB(sub.subscription.endpoint);
      }
    }
  }
  return { sent, failed };
}

// POST /api/push/owner — позначити ЦЕЙ пристрій як власників.
// Body: { endpoint, on?: boolean }. Захищено тим самим ключем, що й адмінка:
// інакше будь-хто підписав би себе на чужі заявки з контактами людей.
pushRouter.post('/owner', async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || String(req.header('x-admin-key') || '') !== adminKey) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const endpoint = String(req.body?.endpoint || '');
  const on = req.body?.on !== false;
  if (!endpoint) { res.status(400).json({ error: 'endpoint required' }); return; }
  const sub = subscriptions.find((x) => x.subscription.endpoint === endpoint);
  if (!sub) {
    res.status(404).json({ error: 'Спершу увімкни сповіщення на цьому пристрої' });
    return;
  }
  sub.isOwner = on;
  await saveSubToDB(sub);
  res.json({ ok: true, owner: on, owners: subscriptions.filter((x) => x.isOwner).length });
});

// GET /api/push/owner — чи слухає хтось заявки взагалі.
pushRouter.get('/owner', (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || String(req.header('x-admin-key') || '') !== adminKey) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.json({ owners: subscriptions.filter((x) => x.isOwner).length });
});

// ── POST /api/push/test ───────────────────────────────────────────────────────
// POST /api/push/self-test — надіслати сповіщення ЛИШЕ на власну підписку.
// Потрібне, щоб людина могла перевірити сповіщення сама, з телефона, без
// адмін-ключа й консолі. Надіслати можна тільки на endpoint, який ти вже
// маєш (його видає push-сервіс браузера і він не вгадується), і лише якщо
// така підписка в нас зареєстрована.
pushRouter.post('/self-test', async (req: Request, res: Response) => {
  const endpoint = String(req.body?.endpoint || '');
  if (!endpoint) { res.status(400).json({ error: 'endpoint required' }); return; }
  const sub = subscriptions.find((x) => x.subscription.endpoint === endpoint);
  if (!sub) { res.status(404).json({ error: 'Підписки не знайдено — увімкни сповіщення ще раз' }); return; }
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify({
      title: '🐙 Перевірка',
      body:  'Сповіщення працюють — нагадування про пости приходитимуть так само.',
      icon:  '/icons/icon.svg',
      badge: '/icons/icon.svg',
      url:   '/app?screen=calendar',
    }));
    res.json({ ok: true });
  } catch (err) {
    // Кажемо правду: доставка не вдалась, а не «надіслано».
    const code = (err as { statusCode?: number }).statusCode;
    res.status(502).json({
      error: code === 410 || code === 404
        ? 'Підписка застаріла — вимкни й увімкни сповіщення заново'
        : 'Сервіс сповіщень не прийняв повідомлення',
    });
  }
});

// Розсилка ВСІМ підписникам — і донедавна без жодної перевірки. Поки
// VAPID-ключів не було, виклик просто падав, тож діра спала. Щойни ключі
// зʼявились у env (19.08.2026), будь-хто з інтернету міг слати сповіщення
// на пристрої всіх наших клієнтів. Тепер — лише власник, тим самим ключем,
// що й адмін-статистика. Без ADMIN_KEY ендпоінт вимкнений повністю.
pushRouter.post('/test', async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || String(req.header('x-admin-key') || '') !== adminKey) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const result = await sendPushToAll({
    title: '🐙 OctoMind — тест',
    body:  'Push-сповіщення працюють! Твої нагадування активовані.',
    icon:  '/icons/icon.svg',
    badge: '/icons/icon.svg',
    url:   '/app?screen=calendar',
  });
  res.json(result);
});
