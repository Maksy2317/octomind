import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireIdentity } from '../middleware/identity';
import { uploadPlanMedia, deleteByPublicUrl, MEDIA_EXT, isStorageConfigured } from '../services/storage';

export const calendarRouter = Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Медіа для контент-плану ──────────────────────────────────────────────────
// memoryStorage, а не диск: Railway стирає файлову систему при кожному деплої,
// тож відзняте відео мусить одразу лягти в Storage і отримати постійний URL.
// Цей же URL знадобиться для автопостингу — Instagram і TikTok забирають медіа
// саме за публічним посиланням.
const planMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_PLAN_MEDIA_MB || '100', 10)) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (MEDIA_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Підтримуємо фото (jpg, png, webp) і відео (mp4, mov, webm)'));
  },
});

// Помилки multer (не той тип, завеликий файл) — це помилка КОРИСТУВАЧА, тож 400.
// Без цієї обгортки вони летіли в загальний обробник і поверталися як 500,
// тобто «щось зламалось» замість зрозумілого пояснення.
function mediaUpload(req: Request, res: Response, next: NextFunction): void {
  planMedia.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const msg = (err as Error).message || 'Не вдалося прочитати файл';
    const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
    res.status(400).json({
      error: tooBig
        ? `Файл завеликий — до ${process.env.MAX_PLAN_MEDIA_MB || '100'} МБ`
        : msg,
    });
  });
}

// Окремий вузький ліміт саме на завантаження. Загальні AI-ліміти (150/год на IP)
// для файлів завеликі: 150 × 100 МБ = 15 ГБ, а на Supabase Free всього 1 ГБ.
// Ключ по IP: device-id клієнт вигадує сам, тож ним ліміт не обійти.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.MEDIA_UPLOAD_MAX_PER_HOUR) || 24,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'up:' + ipKeyGenerator(req.ip || ''),
  message: { error: 'Завантажень за годину досить. Спробуй трохи пізніше.' },
});

// POST /api/calendar/media — віддає { url, kind }
// requireIdentity: анонімне завантаження у власне сховище — це відкритий гаманець.
calendarRouter.post('/media', uploadLimiter, requireIdentity, mediaUpload, async (req: Request, res: Response) => {
  if (!isStorageConfigured()) {
    res.status(503).json({ error: 'Сховище не налаштоване' });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'Файл не надіслано' }); return; }
  const url = await uploadPlanMedia(req.file.buffer, req.file.mimetype);
  if (!url) { res.status(502).json({ error: 'Не вдалося зберегти файл' }); return; }
  res.json({ url, kind: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
});

// DELETE /api/calendar/media — прибрати відчеплений файл зі сховища.
// Викликається, коли користувач знімає медіа з картки або ставить інше.
calendarRouter.delete('/media', requireIdentity, async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const removed = await deleteByPublicUrl(url);
  // 200 навіть якщо не знайшли: для UI важливо лише, що картка вже без медіа.
  res.json({ removed });
});

type CalendarPostType = 'tiktok' | 'reels' | 'stories' | 'carousel' | 'post';

interface CalendarPlanConfig {
  platforms?: string[];
  intensity?: 'light' | 'active' | 'aggressive';
  // legacy per-frequency fields (ignored for volume now; kept for compatibility)
  storiesPerDay?: number;
  tiktokPerWeek?: number;
  reelsPerWeek?: number;
  carouselPerWeek?: number;
  postPerWeek?: number;
  customPerWeek?: number;
  customPlatformName?: string;
  focus?: 'growth' | 'sales' | 'trust' | 'entertainment';
}

interface CalendarPlanRequest {
  monthName: string;
  startDay: number;
  daysInMonth: number;
  remainingDays: number;
  language?: string;
  profileContext?: string | null;
  config?: CalendarPlanConfig;
}

interface CalendarPlanItem {
  day: number;
  type: CalendarPostType;
  time: string;
  note: string;
}

interface TargetPlan {
  platforms: string[];
  storiesPerDay: number;
  stSessionsPerDay: number;
  stBatchSize: number;
  customName: string;
  focusLabel: string;
  counts: Record<CalendarPostType | 'custom', number>;
  total: number;
}

// A wider spread of realistic posting times so a day's posts don't all stack at
// the same hour (the old lists caused every stories row to land at 07:00/12:00/20:00).
const TYPE_TIMES: Record<CalendarPostType, string[]> = {
  tiktok: ['11:00', '15:00', '18:00', '20:00'],
  reels: ['10:00', '13:00', '17:00', '19:00'],
  stories: ['09:00', '13:00', '16:00', '19:00', '21:00'],
  carousel: ['11:00', '14:00', '18:00'],
  post: ['10:00', '13:00', '17:00', '19:00'],
};

// posts-per-week per intensity — realistic for a small business (not 10/day).
const INTENSITY_PER_WEEK: Record<'light' | 'active' | 'aggressive', number> = {
  light: 3,
  active: 5,
  aggressive: 8,
};
const MAX_TOTAL = 40; // hard ceiling so a month never floods with hundreds of posts

const ALLOWED_TYPES = new Set<CalendarPostType>(['tiktok', 'reels', 'stories', 'carousel', 'post']);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function buildTargetPlan(body: CalendarPlanRequest): TargetPlan {
  const cfg = body.config || {};
  const platforms = Array.isArray(cfg.platforms) && cfg.platforms.length
    ? cfg.platforms
    : ['reels', 'stories', 'post'];
  const customName = String(cfg.customPlatformName || 'custom').trim() || 'custom';

  const intensity: 'light' | 'active' | 'aggressive' =
    cfg.intensity === 'light' || cfg.intensity === 'aggressive' ? cfg.intensity : 'active';
  const weeksLeft = Math.max(1, body.remainingDays / 7);
  // Realistic total: posts/week × weeks, capped. NOT stories×days.
  const total = Math.min(MAX_TOTAL, Math.max(1, Math.round(weeksLeft * INTENSITY_PER_WEEK[intensity])));

  const focusLabel = {
    growth: 'зростання охоплення',
    sales: 'продажі',
    trust: 'довіра та авторитет',
    entertainment: 'розваги',
  }[cfg.focus || 'growth'];

  // Spread the total across the active content types with a sensible mix
  // (roughly: reels/tiktok lead, stories & posts fill in). Whatever platforms
  // the user picked share the total proportionally.
  const weightByType: Record<CalendarPostType, number> = {
    reels: 3, tiktok: 3, post: 2, carousel: 2, stories: 2,
  };
  const active = (['reels', 'tiktok', 'post', 'carousel', 'stories'] as CalendarPostType[])
    .filter((t) => platforms.includes(t));
  const activeTypes = active.length ? active : (['reels', 'stories', 'post'] as CalendarPostType[]);
  const weightSum = activeTypes.reduce((s, t) => s + weightByType[t], 0);

  const counts: Record<CalendarPostType | 'custom', number> = {
    tiktok: 0, reels: 0, stories: 0, carousel: 0, post: 0, custom: 0,
  };
  let assigned = 0;
  activeTypes.forEach((t, i) => {
    const n = i === activeTypes.length - 1
      ? total - assigned // last type takes the remainder so the sum is exact
      : Math.round((total * weightByType[t]) / weightSum);
    counts[t] = Math.max(0, n);
    assigned += counts[t];
  });

  return {
    platforms,
    storiesPerDay: 0,
    stSessionsPerDay: 0,
    stBatchSize: 1,
    customName,
    focusLabel,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

function distributeEntries(body: CalendarPlanRequest, target: TargetPlan): CalendarPlanItem[] {
  const entries: CalendarPlanItem[] = [];
  const daysSpan = Math.max(1, body.daysInMonth - body.startDay + 1);

  function addType(type: CalendarPostType, count: number, notePrefix?: string): void {
    const times = TYPE_TIMES[type];
    for (let i = 0; i < count; i += 1) {
      const dayOffset = Math.floor((i * daysSpan) / Math.max(1, count));
      const day = Math.min(body.daysInMonth, body.startDay + dayOffset);
      const time = times[i % times.length];
      entries.push({
        day,
        type,
        time,
        note: notePrefix || '',
      });
    }
  }

  addType('stories', target.counts.stories);
  addType('tiktok', target.counts.tiktok);
  addType('reels', target.counts.reels);
  addType('carousel', target.counts.carousel);
  addType('post', target.counts.post);
  addType('post', target.counts.custom, `${target.customName}: `);

  return entries.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

function fallbackTopic(index: number, focus: string): string {
  const base = [
    'корисна порада для аудиторії',
    'помилка, яку часто роблять клієнти',
    'закулісся робочого процесу',
    'швидкий приклад результату',
    'відповідь на часте питання',
    'міні-історія з практики',
    'порівняння до і після',
    'чекліст для збереження',
    'соціальний доказ або відгук',
    'мʼякий заклик написати в директ',
  ];
  if (focus.includes('продаж')) {
    base.push('перевага пропозиції для клієнта', 'розбір заперечення перед покупкою');
  }
  if (focus.includes('довіра')) {
    base.push('експертний факт без складних термінів', 'цінність бренду через приклад');
  }
  return base[index % base.length];
}

function applyFallbackNotes(entries: CalendarPlanItem[], target: TargetPlan): CalendarPlanItem[] {
  return entries.map((item, index) => {
    const topic = fallbackTopic(index, target.focusLabel);
    if (item.note) {
      return { ...item, note: item.note + topic };
    }
    if (item.type === 'stories') {
      const block = item.time === '07:00' ? 'Ранкова сторіс' : item.time === '12:00' ? 'Денна сторіс' : 'Вечірня сторіс';
      return { ...item, note: `${block} | ${topic}` };
    }
    return { ...item, note: topic };
  });
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    return JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
  }
  throw new Error('No JSON found');
}

function normalizeItems(parsed: unknown, body: CalendarPlanRequest): CalendarPlanItem[] {
  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];

  return rawItems
    .map((item): CalendarPlanItem | null => {
      if (!item || typeof item !== 'object') return null;
      const src = item as Partial<CalendarPlanItem>;
      const day = clampInt(src.day, 0, body.startDay, body.daysInMonth);
      const type = String(src.type || 'post') as CalendarPostType;
      if (!ALLOWED_TYPES.has(type)) return null;
      const time = TYPE_TIMES[type].includes(String(src.time)) ? String(src.time) : TYPE_TIMES[type][0];
      const note = String(src.note || '').trim().slice(0, 140);
      if (!day || !note) return null;
      return { day, type, time, note };
    })
    .filter((item): item is CalendarPlanItem => Boolean(item));
}

function buildPrompt(body: CalendarPlanRequest, target: TargetPlan, skeleton: CalendarPlanItem[]): string {
  const langLabel = body.language === 'ru' ? 'Russian' : body.language === 'en' ? 'English' : 'Ukrainian';
  const profile = body.profileContext ? String(body.profileContext).slice(0, 1200) : 'No saved profile context.';
  const skeletonText = skeleton
    .map((item, index) => `${index + 1}. day=${item.day}, type=${item.type}, time=${item.time}${item.note ? `, prefix="${item.note}"` : ''}`)
    .join('\n');

  return `Create concise social media calendar notes in ${langLabel}.

Month: ${body.monthName}, days ${body.startDay}-${body.daysInMonth}.
Focus: ${target.focusLabel}.
Active platforms: ${target.platforms.join(', ')}.
Profile context:
${profile}

Return ONLY valid JSON, no markdown:
{"items":[{"day":5,"type":"stories","time":"07:00","note":"..."}]}

Rules:
- Preserve every day/type/time from the skeleton exactly.
- Return exactly ${skeleton.length} items.
- note: 4-10 words, practical, niche-relevant, no hashtags.
- For stories use: "Ранкова сторіс | тема", "Денна сторіс | тема", or "Вечірня сторіс | тема".
- For prefixed custom rows keep the prefix in note.

Skeleton:
${skeletonText}`;
}

async function generateWithAI(body: CalendarPlanRequest, target: TargetPlan, skeleton: CalendarPlanItem[]): Promise<CalendarPlanItem[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    temperature: 0.4,
    system: 'You generate compact JSON for a social media calendar. Return JSON only.',
    messages: [{ role: 'user', content: buildPrompt(body, target, skeleton) }],
  });

  const text = response.content
    .filter((part): part is Anthropic.TextBlock => part.type === 'text')
    .map(part => part.text)
    .join('');
  const parsed = extractJson(text);
  return normalizeItems(parsed, body);
}

calendarRouter.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CalendarPlanRequest;
    const startDay = clampInt(body.startDay, 1, 1, 31);
    const daysInMonth = clampInt(body.daysInMonth, 30, 1, 31);
    const safeBody: CalendarPlanRequest = {
      ...body,
      startDay,
      daysInMonth,
      remainingDays: clampInt(body.remainingDays, daysInMonth - startDay + 1, 1, 31),
      monthName: String(body.monthName || 'month'),
    };

    if (safeBody.startDay > safeBody.daysInMonth) {
      res.status(400).json({ error: 'Invalid calendar day range' });
      return;
    }

    const target = buildTargetPlan(safeBody);
    const skeleton = distributeEntries(safeBody, target);
    const fallback = applyFallbackNotes(skeleton, target);

    try {
      const aiItems = await generateWithAI(safeBody, target, skeleton);
      res.json({
        plan: aiItems.length >= Math.max(1, Math.floor(skeleton.length * 0.7)) ? aiItems : fallback,
        fallbackUsed: aiItems.length < Math.max(1, Math.floor(skeleton.length * 0.7)),
        target,
      });
    } catch (err) {
      console.warn('[calendar/generate] AI JSON failed, using fallback:', (err as Error).message);
      res.json({ plan: fallback, fallbackUsed: true, target });
    }
  } catch (err) {
    next(err);
  }
});
