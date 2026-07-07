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
import { meter } from '../middleware/quota';
import { uploadImage } from '../services/storage';
import { getBusinessProfile, createGeneration } from '../services/db/repos';
import { BusinessProfile } from '../services/db/models';
import {
  analyseProductImages, generateAdConcepts, generateAdBackground, generateAdPackTexts,
  generateVideoStoryboard, generateAdShootPlan,
  profileToContext, isMarketingConfigured, AuditImage,
} from '../services/ai/marketing';
import { assembleVideo, isFfmpegReady, VideoScene, Motion } from '../services/ads/adVideo';

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

// Persist an image: Supabase Storage first (survives Railway redeploys),
// local disk as a fallback for dev / when Storage is unavailable.
async function saveImage(buf: Buffer, ext: string, mime?: string): Promise<string> {
  const remote = await uploadImage(buf, ext, mime);
  if (remote) return remote;
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
    const url = await saveImage(Buffer.from(await r.arrayBuffer()), 'png');
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
  // direct_prompt path: caller already has the scene prompt (storyboard) — skip
  // the Gemini brief and render it straight (saves a call + latency per scene).
  const directPrompt = typeof req.body?.direct_prompt === 'string' ? req.body.direct_prompt.slice(0, 600) : '';
  const { product, concept } = req.body || {};
  if (!directPrompt && (!product || !concept)) { res.status(400).json({ error: 'Потрібні product і concept' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const ratio = ['1:1', '9:16', '4:5', '16:9'].includes(req.body?.ratio) ? req.body.ratio : '1:1';
    const brief = directPrompt
      ? { image_prompt: directPrompt, product_zone: (['center', 'left', 'right'].includes(req.body?.product_zone) ? req.body.product_zone : 'center') as 'center' | 'left' | 'right', overlay_text: '', why: '' }
      : await generateAdBackground(ctx, product, concept, {
        style: String(req.body?.style || 'Premium').slice(0, 40),
        ratio,
        variant: typeof req.body?.variant === 'string' ? req.body.variant.slice(0, 120) : undefined,
      });
    const fd = new FormData();
    fd.append('prompt', brief.image_prompt + ' Empty scene, no product, no text, no words, no letters.');
    // hard "no competitors in frame" rule — the shoot plan supplies category words
    const negative = typeof req.body?.negative === 'string' ? req.body.negative.slice(0, 300) : '';
    fd.append('negative_prompt', (negative ? negative + ', ' : '') + 'text, words, letters, watermark, logo');
    fd.append('output_format', 'jpeg');
    fd.append('aspect_ratio', ratio === '4:5' ? '4:5' : ratio);
    const r = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' },
      body: fd,
    });
    if (!r.ok) throw new Error(`Stability ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const url = await saveImage(Buffer.from(await r.arrayBuffer()), 'jpg');
    const out = { url, product_zone: brief.product_zone || 'center', overlay_text: brief.overlay_text, why: brief.why };
    await logGen(req, 'ad_background', { concept: (concept as any)?.name ?? null, direct: Boolean(directPrompt) }, out, profileId);
    res.json(out);
  } catch (err) { next(err); }
});

// POST /api/ads/shoot-plan — { product, concept, style, ratio, profile? }
// The "AI thinks first" step: a photographer's plan of 2 scenes (studio +
// lifestyle), category-aware, no competing objects. Rendered via /background
// with direct_prompt afterwards.
adsRouter.post('/shoot-plan', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  const { product, concept } = req.body || {};
  if (!product || !concept) { res.status(400).json({ error: 'Потрібні product і concept' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const plan = await generateAdShootPlan(ctx, product, concept, {
      style: String(req.body?.style || 'Premium').slice(0, 40),
      ratio: String(req.body?.ratio || '1:1').slice(0, 10),
      sceneWish: typeof req.body?.scene_wish === 'string' ? req.body.scene_wish.trim().slice(0, 300) : undefined,
    });
    await logGen(req, 'ad_shoot_plan', { concept: (concept as any)?.name ?? null }, plan, profileId);
    res.json({ plan });
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

// POST /api/ads/storyboard — { product, concept, style, ratio, seconds, scenes, profile? }
adsRouter.post('/storyboard', async (req: Request, res: Response, next: NextFunction) => {
  if (!guardAI(res)) return;
  const { product, concept } = req.body || {};
  if (!product || !concept) { res.status(400).json({ error: 'Потрібні product і concept' }); return; }
  try {
    const { ctx, profileId } = await resolveCtx(req);
    const total = Math.min(30, Math.max(6, Number(req.body?.seconds) || 10));
    const nScenes = Math.min(5, Math.max(2, Number(req.body?.scenes) || (total <= 6 ? 3 : total <= 10 ? 4 : 5)));
    const board = await generateVideoStoryboard(ctx, product, concept, {
      style: String(req.body?.style || 'Dynamic').slice(0, 40),
      ratio: String(req.body?.ratio || '9:16').slice(0, 10),
      totalSeconds: total, scenes: nScenes,
    });
    await logGen(req, 'ad_storyboard', { seconds: total }, board, profileId);
    res.json({ storyboard: board });
  } catch (err) { next(err); }
});

// POST /api/ads/video — assemble scene stills into an mp4 (ffmpeg, no AI model).
// Body: { scenes: [{ image_base64, seconds, motion }], ratio, music? }
adsRouter.post('/video', async (req: Request, res: Response, next: NextFunction) => {
  if (!isFfmpegReady()) { res.status(503).json({ error: 'Відео-рушій недоступний (ffmpeg)' }); return; }
  const rawScenes = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
  if (!rawScenes.length) { res.status(400).json({ error: 'Нема сцен для збірки' }); return; }

  const ratio = ['9:16', '1:1', '4:5', '16:9'].includes(req.body?.ratio) ? req.body.ratio : '9:16';
  const dims: Record<string, [number, number]> = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
  const [width, height] = dims[ratio];

  const genPath = genDir();
  const tmp = path.join(genPath, `vtmp_${randomUUID()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const validMotion = new Set<Motion>(['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'none']);
  try {
    const scenes: VideoScene[] = [];
    for (let i = 0; i < Math.min(8, rawScenes.length); i++) {
      const s = rawScenes[i] || {};
      const data = typeof s.image_base64 === 'string' ? s.image_base64.replace(/^data:[^,]+,/, '') : '';
      if (!data) continue;
      const p = path.join(tmp, `s${i}.png`);
      fs.writeFileSync(p, Buffer.from(data, 'base64'));
      scenes.push({
        image: p,
        duration: Math.min(8, Math.max(1.5, Number(s.seconds) || 3)),
        motion: (validMotion.has(s.motion) ? s.motion : 'zoom_in') as Motion,
      });
    }
    if (!scenes.length) { res.status(400).json({ error: 'Сцени без зображень' }); return; }

    const name = `vid_${randomUUID()}.mp4`;
    const out = path.join(genPath, name);
    await assembleVideo({ scenes, width, height, fps: 25, fade: 0.5, audio: null, out });

    const { profileId } = await resolveCtx(req);
    await logGen(req, 'ad_video', { scenes: scenes.length, ratio }, { url: `/output/gen/${name}` }, profileId);
    res.json({ url: `/output/gen/${name}` });
  } catch (err) {
    next(err);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// POST /api/ads/render-scene — TRUE AI product photography (no compositing).
// Gemini image model takes the ORIGINAL product photo + a scene description and
// re-renders a complete new photograph of that exact product in the scene:
// real lighting, shadows, floor contact, perspective, reflections.
// Body: { image: {media_type, data}, prompt, ratio? } → { url }
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

adsRouter.post('/render-scene', meter('image'), async (req: Request, res: Response, next: NextFunction) => {
  const gKey = process.env.GOOGLE_API_KEY;
  if (!gKey) { res.status(503).json({ error: 'Рендер сцен не налаштований (GOOGLE_API_KEY відсутній)' }); return; }
  const images = pickImages(req.body, 2);
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 1500) : '';
  if (!images.length || !prompt) { res.status(400).json({ error: 'Потрібні фото товару (image) і опис сцени (prompt)' }); return; }
  try {
    const ratio = ['1:1', '9:16', '4:5', '16:9'].includes(req.body?.ratio) ? req.body.ratio : '1:1';
    const ratioHint = ratio === '9:16' ? 'Vertical 9:16 portrait format.'
      : ratio === '16:9' ? 'Wide 16:9 landscape format.'
      : ratio === '4:5' ? 'Vertical 4:5 portrait format.' : 'Square 1:1 format.';
    const body = {
      contents: [{
        role: 'user',
        parts: [
          ...images.map((im) => ({ inline_data: { mime_type: im.media_type, data: im.data } })),
          { text: prompt + ' ' + ratioHint },
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'] },
    };
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${gKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!r.ok) throw new Error(`Gemini image ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p: any) => p.inlineData || p.inline_data);
    if (!imgPart) throw new Error('Модель не повернула зображення' + (data?.candidates?.[0]?.finishReason ? ` (${data.candidates[0].finishReason})` : ''));
    const payload = imgPart.inlineData || imgPart.inline_data;
    const ext = /png/i.test(payload.mimeType || payload.mime_type || '') ? 'png' : 'jpg';
    const url = await saveImage(Buffer.from(payload.data, 'base64'), ext);

    const { profileId } = await resolveCtx(req);
    await logGen(req, 'ad_scene_render', { prompt: prompt.slice(0, 200), ratio }, { url }, profileId);
    res.json({ url });
  } catch (err) { next(err); }
});

// POST /api/ads/save — { data_base64 } → { url }
// Persists the client-side canvas composite (bg + original cutout + text).
adsRouter.post('/save', async (req: Request, res: Response, next: NextFunction) => {
  const data = typeof req.body?.data_base64 === 'string' ? req.body.data_base64.replace(/^data:[^,]+,/, '') : '';
  if (!data || data.length > 12_000_000) { res.status(400).json({ error: 'Нема зображення або воно завелике' }); return; }
  try {
    const url = await saveImage(Buffer.from(data, 'base64'), 'png');
    res.json({ url });
  } catch (err) { next(err); }
});
