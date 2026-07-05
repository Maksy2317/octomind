// Trend feed endpoints: viral videos by niche (Apify-backed, cached) + the
// AI breakdown «чому залетів» with an adaptation for the user's business.
// Filters (views/date/duration/lang) are applied client-side over the batch —
// the server's job is the data and the analysis.

import { Router, Request, Response, NextFunction } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile } from '../services/db/models';
import { getTrendFeed, getProfileVideos, isTrendsConfigured, isInstagramEnabled, kvGet, kvSet } from '../services/trends';
import { analyzeViralVideo, generateTrendQueries, auditOwnPage, profileToContext, isMarketingConfigured } from '../services/ai/marketing';

export const trendsRouter = Router();

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
trendsRouter.post('/feed', async (req: Request, res: Response, next: NextFunction) => {
  if (!isTrendsConfigured()) {
    res.status(503).json({ error: 'Стрічка трендів не налаштована (APIFY_TOKEN відсутній)' });
    return;
  }
  const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 120) : '';
  if (!query) {
    res.status(400).json({ error: 'Вкажи нішу або ключові слова (query)' });
    return;
  }
  const platform: 'tiktok' | 'instagram' = req.body?.platform === 'instagram' ? 'instagram' : 'tiktok';
  if (platform === 'instagram' && !isInstagramEnabled()) {
    // Built against the documented actor schema but not yet verified on live
    // data (credits). Flip TRENDS_IG_ENABLED=1 after the August field check.
    res.status(503).json({ error: 'Instagram-джерело вже готове й увімкнеться на початку серпня 🚀 Поки що обери TikTok.' });
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

// POST /api/trends/page-audit  — { handle: "@нік" | url, profile? }
// The user's OWN page: scrape latest videos with real metrics → honest AI
// breakdown (what works for THEM, what flops, what to make next).
trendsRouter.post('/page-audit', async (req: Request, res: Response, next: NextFunction) => {
  if (!isTrendsConfigured()) {
    res.status(503).json({ error: 'Аналіз сторінки не налаштований (APIFY_TOKEN відсутній)' });
    return;
  }
  if (!isMarketingConfigured()) {
    res.status(503).json({ error: 'AI не налаштований (ANTHROPIC_API_KEY відсутній)' });
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
    const { ctx, profileId } = await resolveCtx(req);
    // Strip to analysis-relevant fields (CDN urls just waste tokens).
    const slim = page.videos.map((v) => ({
      text: v.text.slice(0, 200), views: v.views, likes: v.likes, comments: v.comments,
      shares: v.shares, created: v.created, duration: v.duration, hashtags: v.hashtags,
    }));
    const audit = await auditOwnPage(ctx, page.author as unknown as Record<string, unknown>, slim);
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
    res.json({ audit, author: page.author, videos: page.videos, fromCache: page.fromCache });
  } catch (err) {
    next(err);
  }
});

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
    const analysis = await analyzeViralVideo(ctx, meta);
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
