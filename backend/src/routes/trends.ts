// Trend feed endpoints: viral videos by niche (Apify-backed, cached) + the
// AI breakdown «чому залетів» with an adaptation for the user's business.
// Filters (views/date/duration/lang) are applied client-side over the batch —
// the server's job is the data and the analysis.

import { Router, Request, Response, NextFunction } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { meter } from '../middleware/quota';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile } from '../services/db/models';
import { getTrendFeed, getProfileVideos, isTrendsConfigured, isInstagramEnabled, isSourceCoolingDown, sourceOut, kvGet, kvSet } from '../services/trends';
import { analyzeViralVideo, generateTrendQueries, auditOwnPage, fitTrendsToCreator, profileToContext, isMarketingConfigured } from '../services/ai/marketing';

export const trendsRouter = Router();

// Авто-розбір тягне ролики через Apify, а розбір за скрінами — ні. Тож коли
// джерело лежить, це не тупик: одразу ведемо людину в робочий шлях.
const AUDIT_OUT_MESSAGE = 'Авто-розбір за ніком зараз недоступний — оновлюємо джерело даних. '
  + 'Скористайся «розбором за скрінами» нижче: Octo розбере пости так само точно. 👇';

trendsRouter.use(optionalIdentity);

async function resolveCtx(req: Request): Promise<{ ctx: string; profileId: string | null }> {
  if (req.userId) {
    try {
      const saved: BusinessProfile | null = await getBusinessProfile(req.userId);
      if (saved) return { ctx: profileToContext(saved), profileId: saved.id };
    } catch { /* fall back to inline */ }
  }
  return { ctx: profileToContext(req.body?.profile || null), profileId: null };
}

// POST /api/trends/feed  — { query: string, intent?: 'selling'|'expert'|'fun'|'raw', force?, profile? }
// The marketing move happens BEFORE the scrape: a raw niche word in TikTok
// search returns whatever is loudest (memes). So unless intent is 'raw',
// Octo first crafts 3 targeted queries for the user's intent, then scrapes
// them all in one actor run. Falls back to the raw word if the AI step fails.
trendsRouter.post('/feed', meter('trend_feed'), async (req: Request, res: Response, next: NextFunction) => {
  if (!isTrendsConfigured()) {
    // Назовні — те саме, що й при вичерпаних кредитах: для користувача це один
    // і той самий факт («зараз не працює»), а причина — рядок у логах для нас.
    console.error('[Trends] APIFY_TOKEN відсутній — стрічка трендів вимкнена');
    const off = sourceOut();
    res.status(503).json({ error: off.message, code: off.code, retryable: false });
    return;
  }
  const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 120) : '';
  if (!query) {
    res.status(400).json({ error: 'Вкажи нішу або ключові слова (query)' });
    return;
  }
  const platform: 'tiktok' | 'instagram' = req.body?.platform === 'instagram' ? 'instagram' : 'tiktok';
  if (platform === 'instagram' && !isInstagramEnabled()) {
    // Зібрано за документованою схемою актора, але на живих даних ще не звірено
    // (кредити). Вмикати TRENDS_IG_ENABLED=1 ПІСЛЯ звірки полів.
    // Дату навмисно не називаємо: обіцянка «на початку серпня» вже протермінувалась
    // і перетворилась на неправду в інтерфейсі. Краще без дати, ніж прострочена.
    res.status(503).json({
      error: 'Instagram-джерело ще готуємо — щойно запрацює, зʼявиться тут. Поки що обери TikTok.',
      code: 'ig_not_ready',
      retryable: false,
    });
    return;
  }
  try {
    const force = req.body?.force === true;
    const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'selling';

    let queries: string[] = [query];
    if (intent !== 'raw' && isMarketingConfigured()) {
      // Pin the expansion for 24h: same niche+intent → same queries → same
      // scrape-cache key. Without this every search re-rolls the queries and
      // pays for a fresh scrape.
      const expKey = `exp:${platform}:${intent}:${query.toLowerCase()}`;
      const pinned = kvGet<string[]>(expKey, 24 * 3_600_000);
      if (pinned && pinned.length) {
        queries = pinned;
      } else {
        try {
          const { ctx } = await resolveCtx(req);
          const expanded = await generateTrendQueries(ctx, query, intent, platform);
          if (Array.isArray(expanded.queries) && expanded.queries.length) {
            queries = expanded.queries.map((q) => String(q).slice(0, 60)).slice(0, 3);
            kvSet(expKey, queries);
          }
        } catch (e) {
          console.warn('[Trends] Query expansion failed, using raw query:', (e as Error).message?.slice(0, 120));
        }
      }
    }

    const feed = await getTrendFeed(queries, force, platform);
    res.json({ ...feed, queries, platform });
  } catch (err) {
    next(err);
  }
});

// POST /api/trends/my-feed — стрічка трендів ПІД КОНКРЕТНИЙ АКАУНТ.
// Body: { handle, query?, intent?, profile?, force? }
//
// Звичайна стрічка — це пошук у TikTok: людина бачить чужі ролики і сама
// здогадується, що з них узяти. Тут ланцюг інший: спершу читаємо СТОРІНКУ
// автора (що в нього вже працює), потім із цього будуємо пошукові запити,
// і вже знайдене оцінюємо його ж очима — чи потягне він таке зняти.
//
// Три кеші, бо кожен крок коштує грошей: портрет автора живе 7 днів,
// запити 24 години, сама стрічка — у getTrendFeed.
trendsRouter.post('/my-feed', meter('trend_feed'), async (req: Request, res: Response, next: NextFunction) => {
  if (!isTrendsConfigured() || isSourceCoolingDown()) {
    if (!isTrendsConfigured()) console.error('[Trends] APIFY_TOKEN відсутній — персональна стрічка вимкнена');
    const off = sourceOut();
    res.status(503).json({ error: off.message, code: off.code, retryable: false });
    return;
  }
  if (!isMarketingConfigured()) {
    res.status(503).json({ error: 'Octo зараз не може думати — AI тимчасово недоступний. Спробуй за кілька хвилин.', retryable: true });
    return;
  }
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().slice(0, 120) : '';
  if (!handle) {
    res.status(400).json({ error: 'Вкажи свій @нік у TikTok — інакше немає з чим звіряти тренди' });
    return;
  }

  try {
    const { ctx, profileId } = await resolveCtx(req);
    const force = req.body?.force === true;

    // ── 1. Портрет автора ────────────────────────────────────────────────────
    const styleKey = `style:${handle.toLowerCase()}`;
    let style = force ? null : kvGet<{ ctx: string; summary: string; author: unknown }>(styleKey, 7 * 24 * 3_600_000);
    if (!style) {
      const page = await getProfileVideos(handle, force);
      if (!page.videos.length) {
        res.status(404).json({ error: 'Не знайшов роликів на цій сторінці — перевір нік (як у TikTok, без пробілів)' });
        return;
      }
      const slim = page.videos.map((v) => ({
        text: v.text.slice(0, 200), views: v.views, likes: v.likes, comments: v.comments,
        shares: v.shares, created: v.created, duration: v.duration, hashtags: v.hashtags,
      }));
      const audit = await auditOwnPage(ctx, page.author as unknown as Record<string, unknown>, slim);
      // Стислий портрет: у промпт оцінювача йде саме він, а не весь розбір —
      // інакше половина контексту витрачається на текст, який там не потрібен.
      const durations = page.videos.map((v) => Number(v.duration) || 0).filter(Boolean);
      const avgDur = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
      const ctxStr = [
        `Нік: @${handle.replace(/^@/, '')}`,
        `Коротко: ${audit.summary || '—'}`,
        `Що вже працює: ${(audit.what_works || []).join(' | ') || '—'}`,
        `Що не заходить: ${(audit.weak_spots || []).join(' | ') || '—'}`,
        avgDur ? `Звична тривалість ролика: ~${avgDur} сек` : '',
        `Роликів у вибірці: ${page.videos.length}`,
      ].filter(Boolean).join('\n');
      style = { ctx: ctxStr, summary: audit.summary || '', author: page.author };
      kvSet(styleKey, style as unknown as Record<string, unknown>);
    }

    // ── 2. Що шукати ─────────────────────────────────────────────────────────
    const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'selling';
    const topic = (typeof req.body?.query === 'string' && req.body.query.trim())
      ? req.body.query.trim().slice(0, 120)
      : String((req.body?.profile || {}).niche || '').slice(0, 120);
    if (!topic) {
      res.status(400).json({ error: 'Заповни нішу в профілі бізнесу або вкажи, що шукати' });
      return;
    }
    let queries: string[] = [topic];
    const expKey = `myexp:${handle.toLowerCase()}:${intent}:${topic.toLowerCase()}`;
    const pinned = force ? null : kvGet<string[]>(expKey, 24 * 3_600_000);
    if (pinned && pinned.length) {
      queries = pinned;
    } else {
      try {
        // Портрет автора йде в контекст запитів: шукаємо не «щось про нішу»,
        // а те, що близьке до форматів, які в цієї людини вже працюють.
        const expanded = await generateTrendQueries(`${ctx}\n\nЩо вже працює на сторінці клієнта:\n${style.ctx}`, topic, intent, 'tiktok');
        if (Array.isArray(expanded.queries) && expanded.queries.length) {
          queries = expanded.queries.map((q) => String(q).slice(0, 60)).slice(0, 3);
          kvSet(expKey, queries);
        }
      } catch (e) {
        console.warn('[Trends] my-feed: розширення запитів не вдалось:', (e as Error).message?.slice(0, 120));
      }
    }

    // ── 3. Стрічка ───────────────────────────────────────────────────────────
    const feed = await getTrendFeed(queries, force, 'tiktok');
    const videos = (feed.videos || []) as unknown as Array<Record<string, unknown>>;
    if (!videos.length) {
      res.json({ ...feed, queries, platform: 'tiktok', style: { summary: style.summary }, fitted: false });
      return;
    }

    // ── 4. Оцінка під автора ─────────────────────────────────────────────────
    let fitted = false;
    try {
      const slim = videos.slice(0, 24).map((v, i) => ({
        i,
        text: String(v.text || '').slice(0, 180),
        views: Number(v.views) || 0,
        duration: v.duration == null ? null : Number(v.duration),
      }));
      const { items } = await fitTrendsToCreator(style.ctx, ctx, slim);
      const byIdx: Record<number, { fit: number; idea: string }> = {};
      (items || []).forEach((it) => {
        const i = Number(it.i);
        if (Number.isFinite(i)) {
          byIdx[i] = { fit: Math.max(1, Math.min(5, Number(it.fit) || 1)), idea: String(it.idea || '').slice(0, 400) };
        }
      });
      videos.forEach((v, i) => {
        if (byIdx[i]) { v.fit = byIdx[i].fit; v.idea = byIdx[i].idea; }
      });
      fitted = Object.keys(byIdx).length > 0;
    } catch (e) {
      // Стрічка без оцінок — це просто стара стрічка. Гірше, ніж могло бути,
      // але не поламано; клієнт покаже її як звичайну і скаже про це чесно.
      console.warn('[Trends] my-feed: оцінка під автора не вдалась:', (e as Error).message?.slice(0, 160));
    }

    if (req.userId) {
      try {
        await createGeneration({
          userId: req.userId, businessProfileId: profileId, type: 'trend_my_feed',
          input: { handle, topic, queries } as unknown as Record<string, unknown>,
          output: { count: videos.length, fitted } as unknown as Record<string, unknown>,
        });
      } catch { /* non-fatal */ }
    }

    res.json({ ...feed, videos, queries, platform: 'tiktok', style: { summary: style.summary }, fitted });
  } catch (err) {
    if ((err as { code?: string }).code === 'trends_source_out') {
      const off = sourceOut();
      res.status(503).json({ error: off.message, code: off.code, retryable: false });
      return;
    }
    next(err);
  }
});

// POST /api/trends/page-audit  — { handle: "@нік" | url, profile? }
// The user's OWN page: scrape latest videos with real metrics → honest AI
// breakdown (what works for THEM, what flops, what to make next).
trendsRouter.post('/page-audit', meter('analysis'), async (req: Request, res: Response, next: NextFunction) => {
  // Тут у людини є повноцінна альтернатива — розбір за скрінами просто нижче на
  // екрані. Тому кажемо не лише «не працює», а й куди йти замість цього.
  if (!isTrendsConfigured() || isSourceCoolingDown()) {
    if (!isTrendsConfigured()) console.error('[Trends] APIFY_TOKEN відсутній — авто-розбір сторінки вимкнений');
    res.status(503).json({ error: AUDIT_OUT_MESSAGE, code: 'trends_source_out', retryable: false });
    return;
  }
  if (!isMarketingConfigured()) {
    console.error('[Trends] AI-провайдер не налаштований (GOOGLE_API_KEY / ANTHROPIC_API_KEY)');
    res.status(503).json({ error: 'Octo зараз не може думати — AI тимчасово недоступний. Спробуй за кілька хвилин.', retryable: true });
    return;
  }
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().slice(0, 120) : '';
  if (!handle) {
    res.status(400).json({ error: 'Вкажи @нік сторінки TikTok' });
    return;
  }
  try {
    const page = await getProfileVideos(handle);
    if (!page.videos.length) {
      res.status(404).json({ error: 'Не знайшов роликів на цій сторінці — перевір нік (без пробілів, як у TikTok)' });
      return;
    }
    // Analyse what actually works for THEM (cadence, best posting hours, a
    // data-informed recommended frequency) → drives the content planner.
    const insights = computeInsights(page.videos);
    const { ctx, profileId } = await resolveCtx(req);
    // Same 12h server cache: one page audit per handle+business per half-day.
    const auditKey = `pa:${handle.toLowerCase()}:${String((req.body?.profile || {}).business_name || '')}`;
    const cachedAudit = kvGet<Record<string, unknown>>(auditKey, 12 * 3_600_000);
    if (cachedAudit) {
      res.json({ audit: cachedAudit, author: page.author, videos: page.videos, insights, fromCache: true });
      return;
    }
    // Strip to analysis-relevant fields (CDN urls just waste tokens).
    const slim = page.videos.map((v) => ({
      text: v.text.slice(0, 200), views: v.views, likes: v.likes, comments: v.comments,
      shares: v.shares, created: v.created, duration: v.duration, hashtags: v.hashtags,
    }));
    const audit = await auditOwnPage(ctx, page.author as unknown as Record<string, unknown>, slim);
    kvSet(auditKey, audit as unknown as Record<string, unknown>);
    if (req.userId) {
      try {
        await createGeneration({
          userId: req.userId,
          businessProfileId: profileId,
          type: 'page_audit',
          input: { handle, author: page.author } as unknown as Record<string, unknown>,
          output: audit as unknown as Record<string, unknown>,
        });
      } catch { /* non-fatal */ }
    }
    res.json({ audit, author: page.author, videos: page.videos, insights, fromCache: page.fromCache });
  } catch (err) {
    // Кредити могли скінчитись саме на цьому запиті — тоді загальний текст
    // «оновлюємо джерело» не підказує вихід, а він тут є.
    if ((err as { code?: string }).code === 'trends_source_out') {
      res.status(503).json({ error: AUDIT_OUT_MESSAGE, code: 'trends_source_out', retryable: false });
      return;
    }
    next(err);
  }
});

// Data-driven planner insights from the scraped page: real cadence, the hours
// their BEST posts went out, and a recommended frequency grounded in that.
interface PageInsights {
  postsPerDay: number; postsPerWeek: number; sampled: number;
  recommendedPerDay: number; bestTimes: string[]; reason: string;
}
function computeInsights(videos: Array<{ created: string | null; views?: number }>): PageInsights | null {
  const dated = videos
    .map((v) => ({ t: v.created ? new Date(v.created).getTime() : NaN, views: Number(v.views) || 0 }))
    .filter((v) => Number.isFinite(v.t))
    .sort((a, b) => a.t - b.t);
  if (dated.length < 3) return null;

  const spanDays = Math.max(1, (dated[dated.length - 1].t - dated[0].t) / 86_400_000);
  const perDay = dated.length / spanDays;

  // Best posting hours: hours of the top ~40% posts by views (min 3).
  const ranked = dated.slice().sort((a, b) => b.views - a.views);
  const topN = Math.max(3, Math.ceil(ranked.length * 0.4));
  const hourCount: Record<number, number> = {};
  ranked.slice(0, topN).forEach((v) => { const h = new Date(v.t).getHours(); hourCount[h] = (hourCount[h] || 0) + 1; });
  const bestHours = Object.keys(hourCount)
    .map((h) => ({ h: Number(h), n: hourCount[Number(h)] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => `${String(x.h).padStart(2, '0')}:00`);

  // Recommended cadence: grounded in current cadence, nudged toward growth
  // (a business under ~3/day should post more; above that, hold & focus).
  const cur = Math.round(perDay * 10) / 10;
  let rec: number;
  if (cur < 0.7) rec = 1;
  else if (cur < 1.5) rec = 2;
  else if (cur < 2.5) rec = 3;
  else rec = Math.min(4, Math.round(cur));

  const timesStr = bestHours.length ? bestHours.join(', ') : '18:00–20:00';
  const reason = `Проаналізовано ${dated.length} останніх постів. Найкраще заходили публікації о ${timesStr}. Зараз ти постиш ~${cur}/день — ${cur < 2 ? 'цього замало для росту' : 'непогано'}, ціль ${rec}/день у ці години.`;

  return {
    postsPerDay: cur,
    postsPerWeek: Math.round(perDay * 7),
    sampled: dated.length,
    recommendedPerDay: rec,
    bestTimes: bestHours,
    reason,
  };
}

// POST /api/trends/analyze  — { video: TrendVideo-ish, profile? }
// The marketing move: explain WHY it went viral and adapt the idea for THIS business.
trendsRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  if (!isMarketingConfigured()) {
    res.status(503).json({ error: 'AI не налаштований (ANTHROPIC_API_KEY відсутній)' });
    return;
  }
  const video = req.body?.video;
  if (!video || typeof video !== 'object') {
    res.status(400).json({ error: 'Потрібні метадані ролика (video)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    // Strip to the fields the model needs — no point paying for CDN URLs.
    const v = video as Record<string, unknown>;
    const meta = {
      text: v.text, lang: v.lang, views: v.views, likes: v.likes,
      comments: v.comments, shares: v.shares, duration: v.duration,
      created: v.created, author: v.author, hashtags: v.hashtags,
    };
    // Server-side 24h cache: the same video for the same business costs ONE
    // Claude call no matter how many devices/reloads ask (клієнтський кеш у
    // localStorage губиться між браузерами — цей ні).
    const cacheKey = `an:${String(v.id || v.url || '')}:${String((req.body?.profile || {}).business_name || '')}`;
    const hit = kvGet<Record<string, unknown>>(cacheKey, 24 * 3_600_000);
    if (hit) { res.json({ analysis: hit, fromCache: true }); return; }
    const analysis = await analyzeViralVideo(ctx, meta);
    kvSet(cacheKey, analysis);
    // Best-effort persistence (same pattern as marketing routes).
    if (req.userId) {
      try {
        await createGeneration({
          userId: req.userId,
          businessProfileId: profileId,
          type: 'trend_analysis',
          input: meta as Record<string, unknown>,
          output: analysis as unknown as Record<string, unknown>,
        });
      } catch { /* non-fatal */ }
    }
    res.json({ analysis });
  } catch (err) {
    next(err);
  }
});
