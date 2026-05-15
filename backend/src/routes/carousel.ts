import { Router, Request, Response, NextFunction } from 'express';
import OpenAI, { toFile } from 'openai';
import { deflateSync } from 'zlib';

export const carouselRouter = Router();

// ── POST /api/carousel/generate ─────────────────────────────────────────────
// GPT-4 generates structured slide content for the carousel.
carouselRouter.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { topic, slidesCount = 6, language = 'uk' } = req.body as {
      topic: string;
      slidesCount?: number;
      language?: string;
    };

    if (!topic) { res.status(400).json({ error: 'topic required' }); return; }
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const langLabel = language === 'uk' ? 'Ukrainian' : language === 'ru' ? 'Russian' : 'English';

    const systemPrompt = `You are a professional social media content creator specializing in Instagram carousels.
Generate carousel slide content in ${langLabel}.

Return ONLY valid JSON with this exact structure:
{
  "carouselTitle": "short catchy title for the whole carousel",
  "slides": [
    {
      "type": "cover",
      "emoji": "🔥",
      "title": "Main carousel title (max 8 words)",
      "subtitle": "Supporting hook text (max 12 words)"
    },
    {
      "type": "point",
      "number": 1,
      "emoji": "✅",
      "title": "Short point title (max 6 words)",
      "text": "Explanation text (max 20 words)"
    },
    ... (more point slides),
    {
      "type": "cta",
      "emoji": "🔔",
      "title": "Call to action title (max 8 words)",
      "text": "Short CTA text (max 15 words)"
    }
  ]
}

Rules:
- First slide: type "cover"
- Last slide: type "cta"
- Middle slides: type "point" with sequential numbers starting from 1
- Total slides = ${slidesCount} (including cover and cta)
- Text must be in ${langLabel}
- Keep text SHORT and PUNCHY — this is a visual carousel
- Use relevant emojis`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create a carousel about: ${topic}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 1200,
    });

    const content = response.choices[0].message.content || '{}';
    const parsed = JSON.parse(content);

    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/dalle ─────────────────────────────────────────────────
// Premium: generate a DALL-E 3 background image for a slide.
// Returns base64 PNG so the frontend can draw it on canvas directly
// (avoids CORS issues with OpenAI's temporary image URLs).
carouselRouter.post('/dalle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, theme = 'dark' } = req.body as {
      description: string;
      theme?: string;
    };

    if (!description) { res.status(400).json({ error: 'description required' }); return; }
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Build a safe, visual prompt — no text in image, abstract artistic style
    const themeStyle: Record<string, string> = {
      dark:   'dark moody cinematic',
      blue:   'deep ocean blue ethereal',
      orange: 'warm sunset energetic',
      green:  'lush nature organic',
      white:  'clean minimal light airy',
      pink:   'vibrant purple magenta artistic',
    };
    const style = themeStyle[theme] || 'dramatic cinematic';

    const prompt = `Abstract ${style} background image. ${description}. No text, no words, no letters. Photographic quality, professional, suitable for Instagram carousel slide background. Square format.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
      quality: 'standard',
    });

    res.json({ b64: response.data?.[0]?.b64_json ?? null });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/segmask ───────────────────────────────────────────────
// Calls remove.bg to get a pixel-perfect person mask.
// Returns base64 PNG where alpha=255 is person, alpha=0 is background.
carouselRouter.post('/segmask', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) { res.status(400).json({ error: 'image required' }); return; }

    const apiKey = process.env.REMOVEBG_API_KEY;
    if (!apiKey) { res.status(503).json({ error: 'REMOVEBG_API_KEY not configured' }); return; }

    const base64 = image.replace(/^data:image\/[^;]+;base64,/, '');

    const params = new URLSearchParams();
    params.append('image_file_b64', base64);
    params.append('size', 'auto');
    params.append('type', 'auto');

    const response = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Remove.bg ${response.status}: ${errText.slice(0, 200)}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    res.json({ maskB64: `data:image/png;base64,${buf.toString('base64')}` });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/analyze-photos ───────────────────────────────────────
// GPT-4 Vision analyzes ALL uploaded photos together and returns:
//   - a unified theme description
//   - a short caption for each photo
//   - a suggested mood/color note
carouselRouter.post('/analyze-photos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { photos, stylePrompt = '', language = 'uk' } = req.body as {
      photos: string[];
      stylePrompt?: string;
      language?: string;
    };

    if (!photos?.length) { res.status(400).json({ error: 'photos required' }); return; }
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const langLabel = language === 'uk' ? 'Ukrainian' : language === 'ru' ? 'Russian' : 'English';

    const imageContent: OpenAI.Chat.ChatCompletionContentPart[] = photos.map(b64 => ({
      type: 'image_url' as const,
      image_url: {
        url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`,
        detail: 'low' as const,
      },
    }));

    const userMsg = `Analyze these ${photos.length} photos and create a unified Instagram carousel in ${langLabel}.
${stylePrompt ? `Style instruction: "${stylePrompt}"` : ''}

Return ONLY this JSON (no markdown):
{
  "theme": "2-3 word visual mood description",
  "overallCaption": "One catchy sentence tying all photos (max 15 words)",
  "captions": ["caption for photo 1 (max 12 words)", "..."],
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5",
  "colorMood": "warm | cool | neutral | vibrant | muted"
}

captions must have exactly ${photos.length} items. All text in ${langLabel}.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: userMsg }, ...imageContent],
      }],
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 0.7,
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    const captions: string[] = result.captions || [];
    while (captions.length < photos.length) captions.push('');

    res.json({
      theme:          result.theme          || 'unified style',
      overallCaption: result.overallCaption || '',
      captions:       captions.slice(0, photos.length),
      hashtags:       result.hashtags       || '',
      colorMood:      result.colorMood      || 'neutral',
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/enhance ───────────────────────────────────────────────
// Premium: gpt-image-1 edits the user's ACTUAL photo (not a replacement).
// Sends the original image + a style prompt to the images.edit endpoint and
// returns the enhanced photo as base64 PNG.
carouselRouter.post('/enhance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image, mask, prompt } = req.body as {
      image: string;
      mask?: string;   // alpha-channel PNG: transparent = editable, opaque = protected
      prompt?: string;
    };

    if (!image)  { res.status(400).json({ error: 'image required' }); return; }
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Convert image base64 → Buffer → File
    const imgBase64 = image.replace(/^data:image\/[^;]+;base64,/, '');
    const imgBuffer = Buffer.from(imgBase64, 'base64');
    const imageFile = await toFile(imgBuffer, 'photo.png', { type: 'image/png' });

    // Convert mask base64 → Buffer → File (if provided)
    let maskFile: Awaited<ReturnType<typeof toFile>> | undefined;
    if (mask) {
      const maskBase64 = mask.replace(/^data:image\/[^;]+;base64,/, '');
      const maskBuffer = Buffer.from(maskBase64, 'base64');
      maskFile = await toFile(maskBuffer, 'mask.png', { type: 'image/png' });
    }

    const styleHint = prompt?.trim() || 'cinematic colour grading and dramatic lighting';

    // ── Detect "remove background people" intent (UA / RU / EN) ────────────────
    const isRemovePeople = /прибер|видал|удал|прибрати.*люд|людей.*фон|фон.*люд|заберіть|remove\s+(back|bg|people)|people.*back/i.test(styleHint);

    // ── Choose prompt based on context ──────────────────────────────────────────
    // KEY RULE: the person mask (opaque = protected, transparent = editable)
    // is always kept when provided. The mask is what guarantees the player's
    // face, body, logos are preserved pixel-perfect — the model CANNOT touch
    // the opaque zone. The AI result is then used directly (no client compositing)
    // so the player is already aligned with the background in the output.
    let enhancePrompt: string;

    if (isRemovePeople && maskFile) {
      // Mask protects the main subject; AI only fills the transparent background.
      // Give it a crystal-clear English task so it fills correctly.
      enhancePrompt =
        `Task: remove ONLY human figures from the background. Nothing else changes. ` +
        `The opaque (white/gray) mask region is the main foreground subject — it is COMPLETELY LOCKED. Do not alter it by even one pixel. ` +
        `In the transparent (editable) background region, follow these rules EXACTLY: ` +
        `1. Find any secondary people, spectators, or bystanders. Remove ONLY those human figures. ` +
        `2. Fill the spot where each removed person stood using ONLY the immediately surrounding surface texture: ` +
        `   grass patch → clone the exact same grass blades, color, and shade from the adjacent area; ` +
        `   concrete → copy same concrete; sand → copy same sand. ` +
        `   The fill MUST be indistinguishable from the surrounding surface — same brightness, hue, saturation. ` +
        `   Do NOT darken or lighten the filled patch. Do NOT generate a smooth/blurred texture — match the actual grain. ` +
        `3. PRESERVE EVERYTHING ELSE ABSOLUTELY UNCHANGED: ` +
        `   • Fences, nets, goal posts, corner flags, barriers — keep all of them exactly as they are. ` +
        `   • Field markings (lines, circles, penalty area) — keep them perfectly intact. ` +
        `   • Grass color, shade, and pattern — do not regenerate or alter. ` +
        `   • Background buildings, stands, vehicles, lights — leave untouched. ` +
        `   • Shadows, lighting direction, sky — no changes. ` +
        `4. Do NOT add any new objects, patterns, or textures that were not already there. ` +
        `5. Do NOT change colors, lighting, perspective, or composition of anything. ` +
        `The ONLY pixels that should differ from the original are the small spots where background people stood.`;
    } else if (isRemovePeople && !maskFile) {
      // "Hide-player" path: the frontend filled the main player zone with a flat
      // color blob, so the AI only sees background people.
      // Task 1: fill the flat-color blob with matching field texture.
      // Task 2: remove ALL remaining background people.
      enhancePrompt =
        `This image contains: (A) a flat-colored blob where the main subject was hidden, ` +
        `and (B) background people (spectators, bystanders) on a sports field. ` +
        `Your two tasks: ` +
        `1. Fill the flat blob (A) seamlessly with the same grass/field texture from the surrounding area — ` +
        `   copy the exact color, shade, and grain of the adjacent grass. ` +
        `2. Remove ALL visible background people (B) completely — ` +
        `   fill each removed person's spot with the matching surface beneath them ` +
        `   (grass → same green grass; concrete → same concrete). ` +
        `ABSOLUTE RULES — do NOT violate these under any circumstances: ` +
        `• Fences, nets, goal posts, poles, corner flags, barriers: ` +
        `  NEVER remove or alter them. They must remain exactly as in the original. ` +
        `• Field lines, circles, penalty areas: keep 100% intact. ` +
        `• Grass color, shade, texture: match the existing field — do NOT regenerate or lighten. ` +
        `• Trees, buildings, vehicles, sky, stands: leave completely unchanged. ` +
        `• Do NOT add new objects, patterns, or change colors/lighting/perspective.`;
    } else if (maskFile) {
      // Generic edit with mask: AI edits only transparent zone
      enhancePrompt =
        `Apply ONLY to the transparent/unmasked background area: ${styleHint}. ` +
        `The masked (opaque) region is the main person — leave it 100% pixel-identical to the original. ` +
        `Do not add text, logos, or watermarks. Keep the overall scene realistic.`;
    } else {
      // No mask, no special intent: generic full-image edit
      enhancePrompt =
        `RULE #1 — PEOPLE: Every person, face, body, skin, clothing, hair must remain 100% unchanged. ` +
        `RULE #2 — BACKGROUND ONLY: Apply "${styleHint}" only to background and non-human elements. ` +
        `RULE #3 — NO TEXT anywhere.`;
    }

    const response = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      ...(maskFile ? { mask: maskFile } : {}),
      prompt: enhancePrompt,
      n: 1,
      size: '1024x1024',
    } as Parameters<typeof openai.images.edit>[0]);

    res.json({ b64: response.data?.[0]?.b64_json ?? null });
  } catch (err) {
    next(err);
  }
});

// ── Shared pure-Node PNG helpers ─────────────────────────────────────────────
const _pngCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
const _pngCrc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ _pngCrcTable[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
};
const _pngU32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const _pngChunk = (type: string, data: Buffer) => {
  const tb = Buffer.from(type, 'ascii');
  const crc = _pngU32(_pngCrc32(Buffer.concat([tb, data])));
  return Buffer.concat([_pngU32(data.length), tb, data, crc]);
};
const _pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ── Grayscale circle mask (for Stability AI): white circles = inpaint ────────
function createCircleMaskPng(
  S: number,
  circles: Array<{ cx: number; cy: number; r: number }>
): Buffer {
  const pixels = Buffer.alloc(S * S, 0); // all black = preserve
  for (const { cx, cy, r } of circles) {
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(S - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(S - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) pixels[y * S + x] = 255;
      }
    }
  }
  const raw = Buffer.alloc(S * (S + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S + 1)] = 0;
    pixels.copy(raw, y * (S + 1) + 1, y * S, (y + 1) * S);
  }
  const ihdr = _pngChunk('IHDR', Buffer.concat([_pngU32(S), _pngU32(S), Buffer.from([8, 0, 0, 0, 0])]));
  const idat = _pngChunk('IDAT', deflateSync(raw));
  return Buffer.concat([_pngSig, ihdr, idat, _pngChunk('IEND', Buffer.alloc(0))]);
}

// ── RGBA circle mask (for gpt-image-1): transparent circles = edit area ──────
// Opaque white (alpha=255) everywhere except inside circles (alpha=0).
// OpenAI images.edit convention: transparent = let AI fill, opaque = preserve.
function createCircleMaskRgbaPng(
  S: number,
  circles: Array<{ cx: number; cy: number; r: number }>
): Buffer {
  const pixels = Buffer.alloc(S * S * 4, 0xff); // all RGBA = [255,255,255,255] = opaque white = preserve
  for (const { cx, cy, r } of circles) {
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(S - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(S - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
          pixels[(y * S + x) * 4 + 3] = 0; // alpha = 0 = transparent = edit this spot
        }
      }
    }
  }
  const rowBytes = S * 4;
  const raw = Buffer.alloc(S * (rowBytes + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (rowBytes + 1)] = 0;
    pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = _pngChunk('IHDR', Buffer.concat([_pngU32(S), _pngU32(S), Buffer.from([8, 6, 0, 0, 0])])); // color type 6 = RGBA
  const idat = _pngChunk('IDAT', deflateSync(raw));
  return Buffer.concat([_pngSig, ihdr, idat, _pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Grayscale rectangle mask (for Stability AI): white rects = inpaint ───────
function createRectMaskPng(
  S: number,
  rects: Array<{ x1: number; y1: number; x2: number; y2: number }>
): Buffer {
  const pixels = Buffer.alloc(S * S, 0); // black = preserve
  for (const { x1, y1, x2, y2 } of rects) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        pixels[y * S + x] = 255; // white = inpaint
      }
    }
  }
  const raw = Buffer.alloc(S * (S + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S + 1)] = 0;
    pixels.copy(raw, y * (S + 1) + 1, y * S, (y + 1) * S);
  }
  const ihdr = _pngChunk('IHDR', Buffer.concat([_pngU32(S), _pngU32(S), Buffer.from([8, 0, 0, 0, 0])]));
  const idat = _pngChunk('IDAT', deflateSync(raw));
  return Buffer.concat([_pngSig, ihdr, idat, _pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Replicate helper: create prediction + poll until done ───────────────────
async function replicateRun(
  model: string,
  input: Record<string, unknown>,
  apiKey: string,
  timeoutMs = 90_000
): Promise<unknown> {
  // Create prediction — use Prefer:wait for synchronous response up to 60s
  const createRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60',
    },
    body: JSON.stringify({ input }),
  });

  if (!createRes.ok) {
    const err = await createRes.text().catch(() => '');
    throw new Error(`Replicate ${createRes.status}: ${err.slice(0, 200)}`);
  }

  let pred = await createRes.json() as {
    id: string; status: string; output: unknown; error?: string;
  };

  // Poll if still running (shouldn't be needed with Prefer:wait but just in case)
  const deadline = Date.now() + timeoutMs;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('Replicate prediction timed out');
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    pred = await pollRes.json() as typeof pred;
  }

  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${pred.status}: ${pred.error ?? ''}`);
  }

  return pred.output;
}

// ── POST /api/carousel/sam-click ─────────────────────────────────────────────
// Runs SAM-2 (Segment Anything) on a user click point and returns a binary mask.
// x/y are normalised [0,1] relative to the image dimensions.
// The mask PNG is returned base64: white = segmented object, black = background.
//
// Used by the frontend "Manual Mask Mode" where the user explicitly clicks
// which people to protect (green) and which to erase (red).
carouselRouter.post('/sam-click', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image, x, y } = req.body as { image: string; x: number; y: number };
    if (!image || x == null || y == null) {
      res.status(400).json({ error: 'image, x, y required' }); return;
    }

    const apiKey = process.env.REPLICATE_API_KEY;
    if (!apiKey) { res.status(503).json({ error: 'REPLICATE_API_KEY not configured' }); return; }

    const imgBase64 = image.replace(/^data:image\/[^;]+;base64,/, '');
    const S = 1024;
    const px = Math.max(1, Math.min(S - 2, Math.round(x * S)));
    const py = Math.max(1, Math.min(S - 2, Math.round(y * S)));

    console.log(`[sam-click] click at x=${x.toFixed(3)} y=${y.toFixed(3)} → px=${px} py=${py}`);

    // Call SAM-2 — Replicate accepts data URIs directly
    const output = await replicateRun(
      'meta/sam-2',
      {
        image: `data:image/png;base64,${imgBase64}`,
        point_coords:    [[px, py]],
        point_labels:    [1],           // 1 = foreground (include this object)
        multimask_output: false,
      },
      apiKey,
      120_000,
    );

    console.log('[sam-click] SAM-2 output:', JSON.stringify(output));

    // Output is an array of mask URLs (or a single URL / object with masks key)
    let maskUrl: string;
    if (Array.isArray(output) && typeof output[0] === 'string') {
      maskUrl = output[0];
    } else if (typeof output === 'string') {
      maskUrl = output;
    } else if (output && typeof (output as Record<string, unknown>).masks !== 'undefined') {
      const masks = (output as Record<string, unknown>).masks;
      maskUrl = Array.isArray(masks) ? masks[0] : String(masks);
    } else {
      throw new Error(`Unexpected SAM-2 output format: ${JSON.stringify(output)?.slice(0, 200)}`);
    }

    // Fetch the mask PNG from Replicate's CDN and return it as base64
    const maskRes = await fetch(maskUrl);
    if (!maskRes.ok) throw new Error(`Mask fetch ${maskRes.status}`);
    const maskBuf = Buffer.from(await maskRes.arrayBuffer());

    res.json({ maskB64: `data:image/png;base64,${maskBuf.toString('base64')}` });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/remove-background-people ──────────────────────────────
// Full pipeline: GPT-4o detects people → SAM-2 pixel masks → Stability AI inpaint
// This preserves fence, cars, grass — only removes person-shaped pixel groups.
carouselRouter.post('/remove-background-people', async (req: Request, res: Response) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) { res.status(400).json({ error: 'image required' }); return; }

    const openaiKey    = process.env.OPENAI_API_KEY;
    const stabilityKey = process.env.STABILITY_API_KEY;
    if (!openaiKey)    { res.status(503).json({ error: 'OPENAI_API_KEY not configured' }); return; }
    if (!stabilityKey) { res.status(503).json({ error: 'STABILITY_API_KEY not configured' }); return; }

    const openai   = new OpenAI({ apiKey: openaiKey });
    const imageUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
    const S        = 1024;

    // ── STEP 1: GPT-4o — detect background people with bounding boxes ────────
    const detectRes = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text:
              'Sports photo. The MAIN SUBJECT is the largest/closest foreground person — ignore them. ' +
              'Are there ANY OTHER people in the background (spectators, crowd, coaches, bystanders)? ' +
              'Return ONLY JSON: {"groups":[{"x1":5,"y1":45,"x2":35,"y2":72},...]} with bounding boxes ' +
              'as % of image. If no background people: {"groups":[]}.',
          },
          {
            type: 'image_url' as const,
            image_url: { url: imageUrl, detail: 'high' as const },
          },
        ],
      }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
      temperature: 0.1,
    });

    // Parse detection result — just need to know if people exist at all
    const detectJson = JSON.parse(detectRes.choices[0].message.content || '{"groups":[]}') as {
      groups?: Array<unknown>;
    };
    const hasPeople = (detectJson.groups?.length ?? 0) > 0;

    console.log('[remove-background-people] hasPeople:', hasPeople, JSON.stringify(detectJson));

    if (!hasPeople) {
      res.json({ b64: null, message: 'no_people_detected' });
      return;
    }

    // ── STEP 2+3: Stability AI search-and-replace — no mask needed ───────────
    // The model finds spectators by text description and replaces them with
    // natural background. No coordinate math, no mask generation.
    const imgBuf = Buffer.from(image.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');

    const form = new FormData();
    form.append('image', new Blob([imgBuf], { type: 'image/png' }), 'image.png');
    form.append('search_prompt',
      'spectators, people, crowd, audience, bystanders, persons sitting or standing in background'
    );
    form.append('prompt',
      'empty background with fence, grass and natural field surroundings, no people'
    );
    form.append('negative_prompt', 'person, people, human, crowd, spectator, audience, man, woman');
    form.append('output_format', 'png');

    const stability = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/search-and-replace',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Accept': 'image/*' },
        body: form,
      }
    );

    if (!stability.ok) {
      const errText = await stability.text().catch(() => '');
      throw new Error(`Stability AI ${stability.status}: ${errText.slice(0, 300)}`);
    }

    const resultBuf = Buffer.from(await stability.arrayBuffer());
    res.json({ b64: resultBuf.toString('base64') });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[remove-background-people] error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/carousel/detect-background-people ─────────────────────────────
// GPT-4o Vision locates background people (bounding boxes as % of image size).
// Used BEFORE inpainting so we only mask the exact spots where people stand —
// preserving fence, cars, grass, and all other background elements.
carouselRouter.post('/detect-background-people', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) { res.status(400).json({ error: 'image required' }); return; }
    if (!process.env.OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return; }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text:
              `You are analyzing a sports photo. Identify people and return JSON.\n\n` +
              `THE MAIN SUBJECT: the single most prominent person in the foreground — ` +
              `the athlete closest to camera, largest in frame, clear focus of photo.\n\n` +
              `BACKGROUND PEOPLE (find every single one, miss nobody):\n` +
              `- Spectators, fans, coaches, bystanders — standing, sitting, lying, crouching\n` +
              `- Partially visible at edges, blurry or far in background\n` +
              `- Only a head, legs, or torso visible\n` +
              `- People lying low on ground\n\n` +
              `Return ONLY this JSON (no markdown):\n` +
              `{"player":{"cx":50,"cy":55,"w":35,"h":80},"people":[{"cx":15,"cy":80,"w":12,"h":20},...]}` +
              `\n- player: bounding box of the MAIN SUBJECT (required, even if alone in photo)` +
              `\n- people: ALL background people — make bboxes GENEROUS (extra margin). Empty array if none.` +
              `\ncx/cy = center %, w/h = size % of image dimensions.`,
          },
          {
            type: 'image_url' as const,
            image_url: {
              url: image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`,
              detail: 'high' as const,
            },
          },
        ],
      }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content || '{"people":[]}');
    res.json({
      people: Array.isArray(result.people) ? result.people : [],
      player: result.player || null,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/inpaint ───────────────────────────────────────────────
// Stability AI ERASE — the correct tool for removing background people.
//
// WHY ERASE instead of INPAINT:
//   /inpaint uses a prompt to GENERATE new content. Even with "copy the grass"
//   prompts it still hallucinates wrong tiled backgrounds when the mask is large.
//
//   /erase does NOT generate — it fills the masked area purely from surrounding
//   pixels (like Photoshop Content-Aware Fill). No prompt = no hallucination.
//   Perfect for removing spectators: fills with whatever fence/grass is adjacent.
//
// Mask convention (Stability AI):  WHITE (255) = erase/fill this area
//                                  BLACK (0)   = preserve this area
carouselRouter.post('/inpaint', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image, mask } = req.body as { image: string; mask: string };

    if (!image || !mask) { res.status(400).json({ error: 'image and mask required' }); return; }

    const apiKey = process.env.STABILITY_API_KEY;
    if (!apiKey) { res.status(503).json({ error: 'STABILITY_API_KEY not configured' }); return; }

    // Convert base64 → Buffer → Blob
    const imgBuf  = Buffer.from(image.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    const maskBuf = Buffer.from(mask.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');

    const form = new FormData();
    form.append('image',  new Blob([imgBuf],  { type: 'image/png' }), 'image.png');
    form.append('mask',   new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
    // grow_mask=5: slightly expand the mask to cover person edges cleanly
    form.append('grow_mask', '5');
    form.append('output_format', 'png');

    // /erase fills from surrounding pixels only — no prompt needed, no hallucination
    const stability = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/erase',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'image/*',
        },
        body: form,
      }
    );

    if (!stability.ok) {
      const errText = await stability.text().catch(() => '');
      throw new Error(`Stability AI ${stability.status}: ${errText.slice(0, 300)}`);
    }

    const buf = Buffer.from(await stability.arrayBuffer());
    res.json({ b64: buf.toString('base64') });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/remove-people ────────────────────────────────────────
// Full server-side pipeline: 2-pass detect→erase so nothing is missed.
//
// WHY 2 PASSES: GPT-4o sometimes misses 1-2 background people in a single call.
// Pass 2 runs detection on the already-erased result — any lingering people are
// now more visible (surrounding people gone) and get caught.
//
// WHY SERVER-SIDE: BodyPix (client) uses segmentationThreshold=0.65 and only
// detects high-confidence foreground people (the main player). Blurry background
// spectators score 0.1–0.4 → never appear in the mask → never erased.
// GPT-4o Vision sees ALL people regardless of size/blur.
//
// Mask: white ellipses (PAD=150) around each detected spectator.
//       Player bbox (from GPT-4o) forces a BLACK safe zone so player is never touched.
carouselRouter.post('/remove-people', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) { res.status(400).json({ error: 'image required' }); return; }

    const stabilityKey = process.env.STABILITY_API_KEY;
    const openaiKey    = process.env.OPENAI_API_KEY;
    if (!stabilityKey) { res.status(503).json({ error: 'STABILITY_API_KEY not configured' }); return; }

    const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

    // ── Helper: build grayscale mask PNG ──────────────────────────────────────
    // Uses filled rectangles (better coverage for groups than ellipses).
    // PAD is kept moderate (90px) so rectangles don't balloon into the player zone.
    // Overlapping rectangles are merged so sitting clusters become one rect.
    //
    // PLAYER PROTECTION (two layers):
    //  1. playerBbox safe zone (PLAYER_PAD=160 extra margin) — hard veto
    //  2. If playerBbox is null, fall back to image-center safe zone so the
    //     main subject is never accidentally included when GPT-4o misses the bbox.
    function buildSpectatorMaskPng(
      people: Array<{ cx: number; cy: number; w: number; h: number }>,
      playerBbox: { cx: number; cy: number; w: number; h: number } | null,
      S: number,
    ): Buffer {
      const PAD        = 90;   // moderate — covers person edges without ballooning
      const PLAYER_PAD = 160;  // generous safe zone around detected player bbox
      // Fallback safe zone used when playerBbox is null (protects center of image)
      const FALLBACK_PLAYER = { cx: 50, cy: 55, w: 45, h: 90 };

      const pb = playerBbox ?? FALLBACK_PLAYER;
      const pcx = (pb.cx / 100) * S;
      const pcy = (pb.cy / 100) * S;
      const phw = ((pb.w  / 100) * S) / 2 + PLAYER_PAD;
      const phh = ((pb.h  / 100) * S) / 2 + PLAYER_PAD;
      const plL = Math.max(0, Math.round(pcx - phw));
      const plR = Math.min(S - 1, Math.round(pcx + phw));
      const plT = Math.max(0, Math.round(pcy - phh));
      const plB = Math.min(S - 1, Math.round(pcy + phh));

      // ── Filter: remove any person whose bbox overlaps heavily with the player ─
      // This catches the case where GPT-4o accidentally includes the player in the
      // "people" list. We remove any person with >40% overlap with playerBbox.
      const playerArea = (plR - plL) * (plB - plT);
      const filteredPeople = people.filter(p => {
        const cx = (p.cx / 100) * S;
        const cy = (p.cy / 100) * S;
        const hw = ((p.w  / 100) * S) / 2 + PAD;
        const hh = ((p.h  / 100) * S) / 2 + PAD;
        const px1 = Math.max(0, Math.floor(cx - hw));
        const py1 = Math.max(0, Math.floor(cy - hh));
        const px2 = Math.min(S - 1, Math.ceil(cx + hw));
        const py2 = Math.min(S - 1, Math.ceil(cy + hh));
        // Intersection with player safe zone
        const ix1 = Math.max(px1, plL), iy1 = Math.max(py1, plT);
        const ix2 = Math.min(px2, plR), iy2 = Math.min(py2, plB);
        if (ix2 <= ix1 || iy2 <= iy1) return true; // no overlap → keep
        const overlapArea = (ix2 - ix1) * (iy2 - iy1);
        const personArea  = (px2 - px1) * (py2 - py1);
        // Drop if person covers >50% of the player safe zone OR player covers >60% of the person
        const overlapFraction = overlapArea / Math.min(personArea, playerArea);
        if (overlapFraction > 0.50) {
          console.log(`[remove-people] filtering out person cx=${p.cx} cy=${p.cy} — overlaps player ${(overlapFraction*100).toFixed(0)}%`);
          return false;
        }
        return true;
      });

      // Convert each surviving person bbox to a padded pixel rectangle
      type R = { x1: number; y1: number; x2: number; y2: number };
      let rects: R[] = filteredPeople.map(p => {
        const cx = (p.cx / 100) * S;
        const cy = (p.cy / 100) * S;
        const hw = ((p.w / 100) * S) / 2 + PAD;
        const hh = ((p.h / 100) * S) / 2 + PAD;
        return {
          x1: Math.max(0, Math.floor(cx - hw)),
          y1: Math.max(0, Math.floor(cy - hh)),
          x2: Math.min(S - 1, Math.ceil(cx + hw)),
          y2: Math.min(S - 1, Math.ceil(cy + hh)),
        };
      });

      // Merge overlapping/touching rectangles → sitting clusters become one rect
      let changed = true;
      while (changed) {
        changed = false;
        const out: R[] = [];
        const used = new Set<number>();
        for (let i = 0; i < rects.length; i++) {
          if (used.has(i)) continue;
          let r = { ...rects[i] };
          for (let j = i + 1; j < rects.length; j++) {
            if (used.has(j)) continue;
            const s = rects[j];
            if (r.x1 <= s.x2 && r.x2 >= s.x1 && r.y1 <= s.y2 && r.y2 >= s.y1) {
              r = { x1: Math.min(r.x1, s.x1), y1: Math.min(r.y1, s.y1), x2: Math.max(r.x2, s.x2), y2: Math.max(r.y2, s.y2) };
              used.add(j);
              changed = true;
            }
          }
          out.push(r);
          used.add(i);
        }
        rects = out;
      }

      // Fill rectangles WHITE (erase zone), ALWAYS skip player safe zone
      const pixels = new Uint8Array(S * S);
      for (const { x1, y1, x2, y2 } of rects) {
        for (let py = y1; py <= y2; py++) {
          for (let px = x1; px <= x2; px++) {
            // Hard veto: player safe zone is NEVER erased
            if (px >= plL && px <= plR && py >= plT && py <= plB) continue;
            pixels[py * S + px] = 255;
          }
        }
      }

      const rowSize = 1 + S;
      const rawRows = Buffer.alloc(rowSize * S);
      for (let y = 0; y < S; y++) {
        rawRows[y * rowSize] = 0;
        for (let x = 0; x < S; x++) rawRows[y * rowSize + 1 + x] = pixels[y * S + x];
      }
      const compressed = deflateSync(rawRows);
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
      ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      return Buffer.concat([_pngSig, _pngChunk('IHDR', ihdr), _pngChunk('IDAT', compressed), _pngChunk('IEND', Buffer.alloc(0))]);
    }

    // ── Helper: GPT-4o detection ──────────────────────────────────────────────
    async function detectSpectators(imgDataUrl: string) {
      if (!openai) return { player: null as any, people: [] as any[] };
      try {
        const r = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text' as const,
                text:
                  `Sports action photo analysis. Find EVERY background person to remove.\n\n` +
                  `MAIN SUBJECT — NEVER include in people list:\n` +
                  `The foreground athlete: largest person in frame, closest to camera, has the ball.\n` +
                  `This person must appear as "player" in the output, NOT in "people".\n\n` +
                  `FIND every other person:\n` +
                  `• Spectators/fans STANDING on sidelines or behind the fence\n` +
                  `• People SITTING on the ground, grass, bleachers — even if small/blurry/crouching\n` +
                  `• Partially visible people (only head, legs, torso showing)\n` +
                  `• Small distant people in background\n\n` +
                  `GROUPING: if 2-3 people form a tight cluster (touching bboxes), use ONE bbox for the group.\n` +
                  `WARNING: never merge background people with the main player into one bbox.\n\n` +
                  `MARGIN: add ~15% extra margin to every background person bbox.\n\n` +
                  `Return ONLY JSON (no markdown):\n` +
                  `{"player":{"cx":50,"cy":60,"w":30,"h":70},"people":[{"cx":20,"cy":85,"w":25,"h":20}]}\n` +
                  `player = main athlete (cx/cy=center%, w/h=size%). Always required.\n` +
                  `people = all background persons. [] if none exist.`,
              },
              {
                type: 'image_url' as const,
                image_url: {
                  url: imgDataUrl.startsWith('data:') ? imgDataUrl : `data:image/png;base64,${imgDataUrl}`,
                  detail: 'high' as const,
                },
              },
            ],
          }],
          response_format: { type: 'json_object' },
          max_tokens: 1000,
          temperature: 0.1,
        });
        const parsed = JSON.parse(r.choices[0].message.content || '{}');
        console.log('[remove-people] detection result:', JSON.stringify(parsed));
        return { player: parsed.player || null, people: Array.isArray(parsed.people) ? parsed.people : [] as any[] };
      } catch (e) {
        console.error('[remove-people] detect error:', e);
        return { player: null as any, people: [] as any[] };
      }
    }

    // ── Helper: Stability Erase ───────────────────────────────────────────────
    async function stabilityErase(imgBuf: Buffer, maskBuf: Buffer): Promise<Buffer> {
      const form = new FormData();
      form.append('image', new Blob([imgBuf],  { type: 'image/png' }), 'image.png');
      form.append('mask',  new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
      form.append('grow_mask', '8');
      form.append('output_format', 'png');
      const resp = await fetch('https://api.stability.ai/v2beta/stable-image/edit/erase', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Accept': 'image/*' },
        body: form,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`Stability erase ${resp.status}: ${txt.slice(0, 200)}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    }

    // ── Pipeline ──────────────────────────────────────────────────────────────
    const imgBase64 = image.replace(/^data:image\/[^;]+;base64,/, '');
    let currentBuf: Buffer = Buffer.from(imgBase64, 'base64') as Buffer;
    const S = 1024;

    // Pass 1 — initial detection + erase
    const pass1 = await detectSpectators(image);
    console.log(`[remove-people] pass1: ${pass1.people.length} spectators detected`);

    if (pass1.people.length === 0) {
      res.json({ b64: currentBuf.toString('base64'), message: 'no background people detected' });
      return;
    }
    currentBuf = (await stabilityErase(currentBuf, buildSpectatorMaskPng(pass1.people, pass1.player, S))) as Buffer;

    // Pass 2 — re-detect on cleaned result; previously-hidden people now more visible
    const pass2DataUrl = `data:image/png;base64,${currentBuf.toString('base64')}`;
    const pass2 = await detectSpectators(pass2DataUrl);
    console.log(`[remove-people] pass2: ${pass2.people.length} remaining spectators`);
    if (pass2.people.length > 0) {
      currentBuf = (await stabilityErase(currentBuf, buildSpectatorMaskPng(pass2.people, pass1.player, S))) as Buffer;
    }

    // Pass 3 — final mop-up: catch anyone still lingering (sitting groups, partials)
    const pass3DataUrl = `data:image/png;base64,${currentBuf.toString('base64')}`;
    const pass3 = await detectSpectators(pass3DataUrl);
    console.log(`[remove-people] pass3: ${pass3.people.length} remaining spectators`);
    if (pass3.people.length > 0) {
      currentBuf = (await stabilityErase(currentBuf, buildSpectatorMaskPng(pass3.people, pass1.player, S))) as Buffer;

      // Pass 4 — search-and-replace semantic sweep for any last remnants
      // Only runs if people are STILL detected after 3 precise erase passes.
      // Uses Stability AI's object-detection-based replacement: finds "spectators"
      // by text description and fills with natural background. Risk: may slightly
      // affect main player if they're near remaining people — acceptable trade-off
      // since passes 1-3 already confirmed people are still present.
      try {
        const sweepForm = new FormData();
        sweepForm.append('image', new Blob([currentBuf], { type: 'image/png' }), 'image.png');
        sweepForm.append('search_prompt',
          'spectators fans audience people sitting standing on sidelines bleachers crowd background'
        );
        sweepForm.append('prompt',
          'clean empty sports field background: natural grass, fence, no people, matching surroundings'
        );
        sweepForm.append('negative_prompt', 'person human crowd spectator audience man woman child');
        sweepForm.append('output_format', 'png');

        const sweepRes = await fetch('https://api.stability.ai/v2beta/stable-image/edit/search-and-replace', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Accept': 'image/*' },
          body: sweepForm,
        });

        if (sweepRes.ok) {
          const sweepBuf = Buffer.from(await sweepRes.arrayBuffer()) as Buffer;
          currentBuf = sweepBuf;
          console.log('[remove-people] pass4 search-and-replace sweep applied');
        } else {
          const errTxt = await sweepRes.text().catch(() => '');
          console.warn(`[remove-people] pass4 sweep failed ${sweepRes.status}: ${errTxt.slice(0, 100)}`);
        }
      } catch (sweepErr) {
        console.warn('[remove-people] pass4 sweep exception:', sweepErr);
      }
    }

    res.json({ b64: currentBuf.toString('base64') });
  } catch (err) {
    next(err);
  }
});
