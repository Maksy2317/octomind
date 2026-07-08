// The marketing-brain endpoints: business info → analysis → offer/strategy → text.
// Identity is best-effort (optionalIdentity): the AI path works even before the
// Supabase migration has been run — persistence just switches off. When the DB
// is up, every step logs a row in `generations` (the business-memory data moat).

import { Router, Request, Response, NextFunction } from 'express';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { optionalIdentity } from '../middleware/identity';
import { meter } from '../middleware/quota';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile, GenerationType } from '../services/db/models';
import {
  analyzeBusiness, generateOfferStrategy, generateMarketingText, generateCampaignStrategy,
  extractBusinessProfile, auditContent, researchNiche, adaptTrend, generateMaterial, editMaterial,
  generateImageBrief, generateBrandKit, scheduleCampaign, weeklyAdvice,
  profileToContext, isMarketingConfigured, MARKETING_MODEL,
  BusinessAnalysis, OfferStrategy, AuditImage,
} from '../services/ai/marketing';
import { saveBusinessProfile } from '../services/db/repos';
import { BusinessProfileInput } from '../services/db/models';
import { uploadImage } from '../services/storage';

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

// POST /api/marketing/audit  — vision audit of the client's own content.
// Body: { images: [{ media_type, data(base64) }], profile? }
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
marketingRouter.post('/audit', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const raw = Array.isArray(req.body?.images) ? req.body.images : [];
  const images: AuditImage[] = raw
    .filter((im: unknown): im is AuditImage =>
      !!im && typeof (im as AuditImage).data === 'string' && ALLOWED_MEDIA.has((im as AuditImage).media_type))
    .slice(0, 6);
  if (!images.length) {
    res.status(400).json({ error: 'Додай хоча б одне зображення (png/jpg/webp)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const audit = await auditContent(ctx, images);
    await logGeneration(req, {
      type: 'audit', input: { context: ctx, images: images.length },
      output: audit as unknown as Record<string, unknown>, profileId,
    });
    res.json({ audit });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/research  — real niche/market research via web search.
marketingRouter.post('/research', meter('research'), async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const research = await researchNiche(ctx);
    await logGeneration(req, {
      type: 'research', input: { context: ctx },
      output: research as unknown as Record<string, unknown>, profileId,
    });
    res.json({ research });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/trend  — reference (link + description [+ images]) → original idea.
marketingRouter.post('/trend', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const link = typeof req.body?.link === 'string' ? req.body.link.slice(0, 500) : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : '';
  const reference = [link && `Посилання: ${link}`, description && `Опис: ${description}`].filter(Boolean).join('\n');
  if (!reference.trim()) {
    res.status(400).json({ error: 'Додай посилання або опис референсу' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const raw = Array.isArray(req.body?.images) ? req.body.images : [];
    const images: AuditImage[] = raw
      .filter((im: unknown): im is AuditImage =>
        !!im && typeof (im as AuditImage).data === 'string' && ALLOWED_MEDIA.has((im as AuditImage).media_type))
      .slice(0, 4);
    const idea = await adaptTrend(ctx, reference, images);
    await logGeneration(req, {
      type: 'trend', input: { reference, images: images.length },
      output: idea as unknown as Record<string, unknown>, profileId,
    });
    res.json({ idea });
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
    const accountType = typeof req.body?.account_type === 'string' ? req.body.account_type
      : (known as Record<string, unknown> | undefined)?.account_type as string | undefined;
    const result = await extractBusinessProfile(text, known, accountType);
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
marketingRouter.post('/strategy', meter('campaign'), async (req: Request, res: Response, next: NextFunction) => {
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

// POST /api/marketing/ab  — same strategy through BOTH providers, side by side.
// Dev/decision tool: compare Ukrainian quality of Haiku vs Gemini Flash.
// Body: { goal, details?, profile? }
marketingRouter.post('/ab', async (req: Request, res: Response, next: NextFunction) => {
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.slice(0, 400) : '';
  if (!goal.trim()) { res.status(400).json({ error: 'Вкажи бізнес-ціль (goal)' }); return; }
  try {
    const { ctx } = await resolveContext(req);
    const details = typeof req.body?.details === 'string' ? req.body.details.slice(0, 2000) : undefined;
    const run = async (provider: 'anthropic' | 'gemini') => {
      const t0 = Date.now();
      try {
        const strategy = await generateCampaignStrategy(ctx, goal, details, provider);
        return { provider, ok: true, ms: Date.now() - t0, strategy };
      } catch (e) {
        return { provider, ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 200) };
      }
    };
    const [anthropic, gemini] = await Promise.all([run('anthropic'), run('gemini')]);
    res.json({ anthropic, gemini });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/material  — generate one proposed material under a strategy.
// Body: { type: string, label: string, strategy?: object, profile? }
marketingRouter.post('/material', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const type = typeof req.body?.type === 'string' ? req.body.type.slice(0, 40) : '';
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : type;
  if (!type.trim()) {
    res.status(400).json({ error: 'Вкажи тип матеріалу (type)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const strategy = req.body?.strategy ?? null;
    const material = await generateMaterial(ctx, strategy, type, label);
    await logGeneration(req, {
      type: 'material:' + type, input: { type, label, strategy },
      output: material as unknown as Record<string, unknown>, profileId,
    });
    res.json({ material });
  } catch (err) {
    next(err);
  }
});

// ── Image rendering with provider fallback ────────────────────────────────────
// Stability first (working key), DALL-E as fallback. Returns image bytes + ext.
async function renderAdImage(prompt: string): Promise<{ buf: Buffer; ext: string }> {
  const stab = process.env.STABILITY_API_KEY;
  if (stab) {
    try {
      const fd = new FormData();
      fd.append('prompt', prompt);
      fd.append('output_format', 'jpeg');   // ~10x smaller files than png
      fd.append('aspect_ratio', '1:1');
      const r = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
        method: 'POST',
        headers: { Authorization: `Bearer ${stab}`, Accept: 'image/*' },
        body: fd,
      });
      if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), ext: 'jpg' };
      console.warn('[Image] Stability failed:', r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.warn('[Image] Stability error:', (e as Error).message);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const img = await openai.images.generate({
      model: 'dall-e-3', prompt, n: 1, size: '1024x1024',
      response_format: 'b64_json', quality: 'standard',
    });
    const b64 = img.data?.[0]?.b64_json;
    if (b64) return { buf: Buffer.from(b64, 'base64'), ext: 'png' };
  }
  throw new Error('Генерація зображень недоступна — перевір STABILITY_API_KEY / OPENAI_API_KEY');
}

// Persist a generated image under uploads/output/gen and return its served URL.
function saveGenImage(buf: Buffer, ext: string): string {
  const outputDir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.resolve(process.cwd(), 'uploads/output');
  const genDir = path.join(outputDir, 'gen');
  fs.mkdirSync(genDir, { recursive: true });
  const name = `img_${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(genDir, name), buf);
  return `/output/gen/${name}`;
}

// Prefer Supabase Storage (survives Railway redeploys) → fall back to local disk.
// The disk copy is ephemeral on Railway, which is why brand logos / images used
// to break after a deploy.
async function persistGenImage(buf: Buffer, ext: string): Promise<string> {
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const remote = await uploadImage(buf, ext, mime);
  return remote || saveGenImage(buf, ext);
}

// POST /api/marketing/brand  — Octo derives a brand identity from the business:
// palette (with reasoning), tone, tagline, and a rendered logo. Saved to the
// profile client-side so every later material inherits the style.
// Body: { profile? }   (logo render is best-effort; kit still returns without it)
marketingRouter.post('/brand', meter('brand'), async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const kit = await generateBrandKit(ctx);

    // Render the logo — best-effort; a failed image must not lose the kit.
    let logo_url: string | null = null;
    if ((process.env.STABILITY_API_KEY || process.env.OPENAI_API_KEY) && kit.logo_prompt) {
      try {
        const { buf, ext } = await renderAdImage(
          kit.logo_prompt + ' Flat minimal vector logo, iconic, centered, no text, no words, no letters.',
        );
        logo_url = await persistGenImage(buf, ext);
      } catch (e) {
        console.warn('[Brand] Logo render failed:', (e as Error).message);
      }
    }

    const brand = { ...kit, logo_url };
    await logGeneration(req, {
      type: 'brand', input: {},
      output: brand as unknown as Record<string, unknown>, profileId,
    });
    res.json({ brand });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/image  — ad image: Claude decides the concept (brief),
// then an image model renders it. Saved under uploads/output/gen/ (survives
// the 48h cleanup sweep, which skips subdirectories). Returns a served URL.
// Body: { label?: string, strategy?: object, profile? }
marketingRouter.post('/image', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  if (!process.env.STABILITY_API_KEY && !process.env.OPENAI_API_KEY) {
    res.status(503).json({ error: 'Генерація зображень не налаштована (потрібен STABILITY_API_KEY або OPENAI_API_KEY)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : 'Рекламне зображення';
    const strategy = req.body?.strategy ?? null;

    // 1. The marketing decision (what to show and why) — Claude.
    const brief = await generateImageBrief(ctx, strategy, label);

    // 2. Render — Stability (primary) → DALL-E (fallback).
    const { buf, ext } = await renderAdImage(
      brief.image_prompt + ' No text, no words, no letters in the image.',
    );

    // 3. Persist — Supabase Storage (survives redeploys) → disk fallback.
    const url = await persistGenImage(buf, ext);

    const material = {
      title: label,
      url,
      concept: brief.concept,
      overlay_text: brief.overlay_text,
      why: brief.why,
    };
    await logGeneration(req, {
      type: 'image', input: { label, strategy },
      output: material as unknown as Record<string, unknown>, profileId,
    });
    res.json({ material });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/weekly  — порада тижня (клієнт кешує на тиждень).
// Body: { state: {campaigns, calendar_next7, has_research, ...}, profile? }
marketingRouter.post('/weekly', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  try {
    const { ctx, profileId } = await resolveContext(req);
    const state = (req.body?.state && typeof req.body.state === 'object') ? req.body.state : {};
    const advice = await weeklyAdvice(ctx, state as Record<string, unknown>);
    await logGeneration(req, {
      type: 'weekly', input: { state } as Record<string, unknown>,
      output: advice as unknown as Record<string, unknown>, profileId,
    });
    res.json(advice);
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/schedule  — «розкласти по днях»: Octo decides when each
// campaign material goes out (day/time/why) for the next week.
// Body: { strategy?: object, materials: [{index,type,title}], profile? }
marketingRouter.post('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const materials = Array.isArray(req.body?.materials) ? req.body.materials.slice(0, 20) : [];
  if (!materials.length) {
    res.status(400).json({ error: 'Нема матеріалів для розкладу — спершу створи їх у кампанії' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const plan = await scheduleCampaign(ctx, req.body?.strategy ?? null, materials);
    await logGeneration(req, {
      type: 'schedule', input: { materials },
      output: plan as unknown as Record<string, unknown>, profileId,
    });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/edit  — revise a material by instruction (dialog editing).
// Body: { material: object, instruction: string, label?: string, profile? }
marketingRouter.post('/edit', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardConfigured(res)) return;
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.slice(0, 1000) : '';
  const material = req.body?.material;
  if (!instruction.trim() || !material || typeof material !== 'object') {
    res.status(400).json({ error: 'Потрібні material (обʼєкт) і instruction (що змінити)' });
    return;
  }
  try {
    const { ctx, profileId } = await resolveContext(req);
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : undefined;
    const revised = await editMaterial(ctx, material, instruction, label);
    await logGeneration(req, {
      type: 'edit', input: { instruction, label: label ?? null },
      output: revised, profileId,
    });
    res.json({ material: revised });
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
