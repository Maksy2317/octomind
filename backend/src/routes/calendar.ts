import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';

export const calendarRouter = Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type CalendarPostType = 'tiktok' | 'reels' | 'stories' | 'carousel' | 'post';

interface CalendarPlanConfig {
  platforms?: string[];
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

const TYPE_TIMES: Record<CalendarPostType, string[]> = {
  tiktok: ['15:00', '18:00'],
  reels: ['12:00', '15:00', '18:00'],
  stories: ['07:00', '12:00', '20:00'],
  carousel: ['12:00', '15:00'],
  post: ['12:00', '15:00'],
};

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
    : ['tiktok', 'reels', 'stories'];

  const storiesPerDay = clampInt(cfg.storiesPerDay, 5, 0, 20);
  const tiktokPerWeek = clampInt(cfg.tiktokPerWeek, 5, 0, 30);
  const reelsPerWeek = clampInt(cfg.reelsPerWeek, 3, 0, 30);
  const carouselPerWeek = clampInt(cfg.carouselPerWeek, 2, 0, 20);
  const postPerWeek = clampInt(cfg.postPerWeek, 2, 0, 20);
  const customPerWeek = clampInt(cfg.customPerWeek, 3, 0, 20);
  const customName = String(cfg.customPlatformName || 'custom').trim() || 'custom';
  const stSessionsPerDay = storiesPerDay;
  const stBatchSize = 1;
  const weeksLeft = Math.max(1, body.remainingDays / 7);
  const focusLabel = {
    growth: 'зростання охоплення',
    sales: 'продажі',
    trust: 'довіра та авторитет',
    entertainment: 'розваги',
  }[cfg.focus || 'growth'];

  const counts = {
    tiktok: platforms.includes('tiktok') ? Math.round(weeksLeft * tiktokPerWeek) : 0,
    reels: platforms.includes('reels') ? Math.round(weeksLeft * reelsPerWeek) : 0,
    stories: platforms.includes('stories') ? body.remainingDays * storiesPerDay : 0,
    carousel: platforms.includes('carousel') ? Math.round(weeksLeft * carouselPerWeek) : 0,
    post: platforms.includes('post') ? Math.round(weeksLeft * postPerWeek) : 0,
    custom: platforms.includes('custom') ? Math.round(weeksLeft * customPerWeek) : 0,
  };

  return {
    platforms,
    storiesPerDay,
    stSessionsPerDay,
    stBatchSize,
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
