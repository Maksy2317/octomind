// AI Product Ads (Phase C1): photo → analysis → concepts → static creatives.
//
// Identity preservation (the spec's hard rule): the generated background NEVER
// contains the product — the ORIGINAL cutout is composited on top client-side
// (canvas), so logo/packaging/label stay pixel-exact. The composite comes back
// through /save for a permanent URL.
//
// Video endpoints land in Phase C2 (queue + scene generation + ffmpeg).

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { optionalIdentity } from '../middleware/identity';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile } from '../services/db/models';
import {
  analyseProductImages, generateAdConcepts, generateAdBackground, generateAdPackTexts,
  profileToContext, isMarketingConfigured, AuditImage,
} from '../services/ai/marketing';

export const adsRouter = Router();

adsRouter.use(optionalIdentity);

const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

function guardAI(res: Response): boolean {
  if (!isMarketingConfigured()) {
    res.status(503).json({ error: 'AI не налаштований (ANTHROPIC_API_KEY відсутній)' });
    return false;
  }
  return true;
}

async function resolveCtx(req: Request): Promise<{ ctx: string; profileId: string | null }> {
  if (req.userId) {
    try {
      const saved: BusinessProfile | null = await getBusinessProfile(req.userId);
      if (saved) return { ctx: profileToContext(saved), profileId: saved.id };
    } catch { /* inline fallback */ }
  }
  return { ctx: profileToContext(req.body?.profile || null), profileId: null };
}

function pickImages(body: any, max = 5): AuditImage[] {
  const raw = Array.isArray(body?.images) ? body.images : (body?.image ? [body.image] : []);
  return raw
    .filter((im: any) => im && typeof im.data === 'string' && ALLOWED_MEDIA.has(im.media_type))
    .slice(0, max)
    .map((im: any) => ({ media_type: im.media_type, data: im.data.replace(/^data:[^,]+,/, '') }));
}

function genDir(): string {
  const outputDir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.resolve(process.cwd(), 'uploads/output');
  const dir = path.join(outputDir, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveImage(buf: Buffer, ext: string): string {
  const name = `ad_${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(genDir(), name), buf);
  return `/output/gen/${name}`;
}

async function logGen(req: Request, type: string, input: unknown, output: unknown, profileId: string | null) {
  if (!req.userId) return;
  try {
    await createGeneration({
      userId: req.userId, businessProfileId: profileId, type,
      input: input as Record<string, unknown>, output: output as Record<string, unknown>,
    });
  } catch { /* non-fatal */ }
}

// POST /api/ads/analyze  — { images: [{media_type, data}] } → { analysis }
adsRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  const images = pickImages(req.body);
  if (!images.length) { res.status(400).json({ error: 'Додай хоча б одне фото товару (JPG/PNG/WEBP)' }); return; }
  try {
    const analysis = await analyseProductImages(images);
    const { profileId } = await resolveCtx(req);
    await logGen(req, 'ad_analyze', { images: images.length }, analysis, profileId);
    res.json({ analysis });
  } catch (err) { next(err); }
});

// POST /api/ads/cutout  — { image: {media_type,data} } → { url } (transparent PNG)
// Stability remove-background keeps the ORIGINAL pixels — logo/label untouched.
adsRouter.post('/cutout', async (req: Request, res: Response, next: NextFunction) => {
  if (!process.env.STABILITY_API_KEY) {
    res.status(503).json({ error: 'Вирізання фону не налаштоване (STABILITY_API_KEY відсутній)' });
    return;
  }
  const images = pickImages(req.body, 1);
  if (!images.length) { res.status(400).json({ error: 'Додай фото товару' }); return; }
  try {
    const fd = new FormData();
    const bytes = Buffer.from(images[0].data, 'base64');
    fd.append('image', new Blob([new Uint8Array(bytes)], { type: images[0].media_type }), 'product.png');
    fd.append('output_format', 'png');
    const r = await fetch('https://api.stability.ai/v2beta/stable-image/edit/remove-background', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' },
      body: fd,
    });
    if (!r.ok) throw new Error(`Stability ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const url = saveImage(Buffer.from(await r.arrayBuffer()), 'png');
    res.json({ url });
  } catch (err) { next(err); }
});

// POST /api/ads/concepts — { product, goal, platform, ratio, style, format, profile? }
adsRouter.post('/concepts', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  const product = req.body?.product;
  if (!product || typeof product !== 'object') { res.status(400).json({ error: 'Нема даних товару' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const opts = {
      goal: String(req.body?.goal || 'Збільшити продажі').slice(0, 80),
      platform: String(req.body?.platform || 'Instagram').slice(0, 40),
      ratio: String(req.body?.ratio || '1:1').slice(0, 10),
      style: String(req.body?.style || 'Premium').slice(0, 40),
      format: String(req.body?.format || 'static').slice(0, 20),
    };
    const out = await generateAdConcepts(ctx, product, opts);
    await logGen(req, 'ad_concepts', { product, ...opts }, out, profileId);
    res.json(out);
  } catch (err) { next(err); }
});

// POST /api/ads/background — { product, concept, style, ratio, variant?, profile? }
// Claude writes the empty-scene brief → Stability renders it → served URL.
adsRouter.post('/background', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  if (!process.env.STABILITY_API_KEY) {
    res.status(503).json({ error: 'Генерація зображень не налаштована (STABILITY_API_KEY відсутній)' });
    return;
  }
  const { product, concept } = req.body || {};
  if (!product || !concept) { res.status(400).json({ error: 'Потрібні product і concept' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const ratio = ['1:1', '9:16', '4:5', '16:9'].includes(req.body?.ratio) ? req.body.ratio : '1:1';
    const brief = await generateAdBackground(ctx, product, concept, {
      style: String(req.body?.style || 'Premium').slice(0, 40),
      ratio,
      variant: typeof req.body?.variant === 'string' ? req.body.variant.slice(0, 120) : undefined,
    });
    const fd = new FormData();
    fd.append('prompt', brief.image_prompt + ' Empty scene, no product, no text, no words, no letters.');
    fd.append('output_format', 'jpeg');
    fd.append('aspect_ratio', ratio === '4:5' ? '4:5' : ratio);
    const r = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' },
      body: fd,
    });
    if (!r.ok) throw new Error(`Stability ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const url = saveImage(Buffer.from(await r.arrayBuffer()), 'jpg');
    const out = { url, product_zone: brief.product_zone || 'center', overlay_text: brief.overlay_text, why: brief.why };
    await logGen(req, 'ad_background', { concept: (concept as any).name }, out, profileId);
    res.json(out);
  } catch (err) { next(err); }
});

// POST /api/ads/texts — { product, concept, goal, platform, profile? }
adsRouter.post('/texts', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  const { product, concept } = req.body || {};
  if (!product || !concept) { res.status(400).json({ error: 'Потрібні product і concept' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const texts = await generateAdPackTexts(ctx, product, concept, {
      goal: String(req.body?.goal || 'Збільшити продажі').slice(0, 80),
      platform: String(req.body?.platform || 'Instagram').slice(0, 40),
    });
    await logGen(req, 'ad_texts', { concept: (concept as any).name }, texts, profileId);
    res.json({ texts });
  } catch (err) { next(err); }
});

// POST /api/ads/save — { data_base64 } → { url }
// Persists the client-side canvas composite (bg + original cutout + text).
adsRouter.post('/save', async (req: Request, res: Response, next: NextFunction) => {
  const data = typeof req.body?.data_base64 === 'string' ? req.body.data_base64.replace(/^data:[^,]+,/, '') : '';
  if (!data || data.length > 12_000_000) { res.status(400).json({ error: 'Нема зображення або воно завелике' }); return; }
  try {
    const url = saveImage(Buffer.from(data, 'base64'), 'png');
    res.json({ url });
  } catch (err) { next(err); }
});
