// Trend feed endpoints: viral videos by niche (Apify-backed, cached) + the
// AI breakdown «чому залетів» with an adaptation for the user's business.
// Filters (views/date/duration/lang) are applied client-side over the batch —
// the server's job is the data and the analysis.

import { Router, Request, Response, NextFunction } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile } from '../services/db/models';
import { getTrendFeed, isTrendsConfigured } from '../services/trends';
import { analyzeViralVideo, generateTrendQueries, profileToContext, isMarketingConfigured } from '../services/ai/marketing';

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
  try {
    const force = req.body?.force === true;
    const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'selling';

    let queries: string[] = [query];
    if (intent !== 'raw' && isMarketingConfigured()) {
      try {
        const { ctx } = await resolveCtx(req);
        const expanded = await generateTrendQueries(ctx, query, intent);
        if (Array.isArray(expanded.queries) && expanded.queries.length) {
          queries = expanded.queries.map((q) => String(q).slice(0, 60)).slice(0, 3);
        }
      } catch (e) {
        console.warn('[Trends] Query expansion failed, using raw query:', (e as Error).message?.slice(0, 120));
      }
    }

    const feed = await getTrendFeed(queries, force);
    res.json({ ...feed, queries });
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
