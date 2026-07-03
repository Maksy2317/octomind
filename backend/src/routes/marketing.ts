// The marketing-brain endpoints: business info → analysis → offer/strategy → text.
// Identity is best-effort (optionalIdentity): the AI path works even before the
// Supabase migration has been run — persistence just switches off. When the DB
// is up, every step logs a row in `generations` (the business-memory data moat).

import { Router, Request, Response, NextFunction } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile, GenerationType } from '../services/db/models';
import {
  analyzeBusiness, generateOfferStrategy, generateMarketingText, generateCampaignStrategy,
  extractBusinessProfile,
  profileToContext, isMarketingConfigured, MARKETING_MODEL,
  BusinessAnalysis, OfferStrategy,
} from '../services/ai/marketing';
import { saveBusinessProfile } from '../services/db/repos';
import { BusinessProfileInput } from '../services/db/models';

export const marketingRouter = Router();

marketingRouter.use(optionalIdentity);

/**
 * Resolve the profile context: prefer the saved profile (when the DB is up),
 * fall back to an inline `profile` object from the request body — so the flow
 * works statelessly before the first save / before the migration.
 */
async function resolveContext(req: Request): Promise<{ ctx: string; profileId: string | null }> {
  if (req.userId) {
    try {
      const saved: BusinessProfile | null = await getBusinessProfile(req.userId);
      if (saved) return { ctx: profileToContext(saved), profileId: saved.id };
    } catch (err) {
      console.warn('[Marketing] Profile lookup failed, using inline profile:', (err as Error).message?.slice(0, 200));
    }
  }
  const inline = req.body?.profile;
  return { ctx: profileToContext(inline || null), profileId: null };
}

/** Persist a generation row when possible; never fail the request over it. */
async function logGeneration(req: Request, data: {
  type: GenerationType;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  profileId: string | null;
}): Promise<void> {
  if (!req.userId) return;
  try {
    await createGeneration({
      userId: req.userId, type: data.type, model: MARKETING_MODEL,
      input: data.input, output: data.output, businessProfileId: data.profileId,
    });
  } catch (err) {
    console.warn('[Marketing] Failed to log generation:', (err as Error).message?.slice(0, 200));
  }
}

function guardConfigured(res: Response): boolean {
  if (!isMarketingConfigured()) {
    res.status(503).json({ error: 'AI не налаштовано (ANTHROPIC_API_KEY відсутній)' });
    return false;
  }
  return true;
}

// POST /api/marketing/analyze
marketingRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const analysis = await analyzeBusiness(ctx);
    await logGeneration(req, {
      type: 'analysis', input: { context: ctx },
      output: analysis as unknown as Record<string, unknown>, profileId,
    });
    res.json({ analysis });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/offer  (offer + strategy; accepts optional prior analysis)
marketingRouter.post('/offer', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const analysis = req.body?.analysis as BusinessAnalysis | undefined;
    const offer = await generateOfferStrategy(ctx, analysis);
    await logGeneration(req, {
      type: 'offer', input: { context: ctx, analysis: analysis ?? null },
      output: offer as unknown as Record<string, unknown>, profileId,
    });
    res.json({ offer });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/onboard  — extract business profile from free text.
// Body: { text: string, known?: {...profile fields} }
marketingRouter.post('/onboard', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 4000) : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'Розкажи трохи про бізнес (text)' });
    return;
  }
  try {
    const known = (req.body?.known && typeof req.body.known === 'object')
      ? req.body.known as BusinessProfileInput : undefined;
    const result = await extractBusinessProfile(text, known);
    // Persist the merged profile when the DB is up (best-effort).
    if (req.userId) {
      const merged = { ...(known || {}), ...result.profile };
      try { await saveBusinessProfile(req.userId, merged); } catch (err) {
        console.warn('[Onboard] profile save skipped:', (err as Error).message?.slice(0, 160));
      }
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/strategy  — goal-first campaign strategy (v2 core).
// Body: { goal: string, details?: string, profile?: {...} }
marketingRouter.post('/strategy', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.slice(0, 400) : '';
  if (!goal.trim()) {
    res.status(400).json({ error: 'Вкажи бізнес-ціль (goal)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const details = typeof req.body?.details === 'string' ? req.body.details.slice(0, 2000) : undefined;
    const strategy = await generateCampaignStrategy(ctx, goal, details);
    await logGeneration(req, {
      type: 'strategy', input: { context: ctx, goal, details: details ?? null },
      output: strategy as unknown as Record<string, unknown>, profileId,
    });
    res.json({ strategy });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/text  (accepts optional prior offer + free-text brief)
marketingRouter.post('/text', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const offer = req.body?.offer as OfferStrategy | undefined;
    const brief = typeof req.body?.brief === 'string' ? req.body.brief.slice(0, 2000) : undefined;
    const text = await generateMarketingText(ctx, offer, brief);
    await logGeneration(req, {
      type: 'text', input: { context: ctx, offer: offer ?? null, brief: brief ?? null },
      output: text as unknown as Record<string, unknown>, profileId,
    });
    res.json({ text });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/run — the whole path in one call: analyze → offer → text.
marketingRouter.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const brief = typeof req.body?.brief === 'string' ? req.body.brief.slice(0, 2000) : undefined;

    const analysis = await analyzeBusiness(ctx);
    const offer = await generateOfferStrategy(ctx, analysis);
    const text = await generateMarketingText(ctx, offer, brief);

    await logGeneration(req, {
      type: 'run', input: { context: ctx, brief: brief ?? null },
      output: { analysis, offer, text } as unknown as Record<string, unknown>, profileId,
    });
    res.json({ analysis, offer, text });
  } catch (err) {
    next(err);
  }
});
