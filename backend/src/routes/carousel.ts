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

// ── POST /api/carousel/remove-background-people ──────────────────────────────
// Full pipeline: GPT-4o detects people → SAM-2 pixel masks → Stability AI inpaint
// This preserves fence, cars, grass — only removes person-shaped pixel groups.
carouselRouter.post('/remove-background-people', async (req: Request, res: Response) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) { res.status(400).json({ error: 'image required' }); return; }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) { res.status(503).json({ error: 'OPENAI_API_KEY not configured' }); return; }

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
              'Sports photo. The MAIN SUBJECT is the largest/closest foreground person — DO NOT include them. ' +
              'Find ALL OTHER people (spectators, coaches, bystanders) in the background. ' +
              'For each person give center and approximate size as % of image dimensions (0-100). ' +
              'Return ONLY JSON: {"people":[{"cx":20,"cy":75,"w":8,"h":12},...]}. ' +
              'If no background people found: {"people":[]}.',
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

    const { people } = JSON.parse(detectRes.choices[0].message.content || '{"people":[]}') as {
      people: Array<{ cx: number; cy: number; w?: number; h?: number }>;
    };

    console.log('[remove-background-people] detected people:', JSON.stringify(people));

    if (!people?.length) {
      res.json({ b64: null, message: 'no_people_detected' });
      return;
    }

    // ── STEP 2: Build circle mask in pure Node.js (no external libs) ─────────
    // Each detected person → white filled circle; radius from GPT-4o size estimate.
    // White = inpaint (remove person), Black = preserve (fence, grass, player).
    const circles = people.map(p => {
      const cx = Math.round((p.cx / 100) * S);
      const cy = Math.round((p.cy / 100) * S);
      // Use the larger of w/h to set radius; clamp to [45, 130]px
      const fromBox = (p.w || 0) > 0 || (p.h || 0) > 0
        ? Math.round((Math.max(p.w ?? 0, p.h ?? 0) / 100) * S * 0.55)
        : 65;
      const r = Math.max(45, Math.min(130, fromBox));
      return { cx, cy, r };
    });

    console.log('[remove-background-people] circles:', JSON.stringify(circles));

    // ── STEP 3: gpt-image-1 inpaint — fill only the transparent person circles ─
    // RGBA mask: transparent circles = "edit these spots", rest = preserve.
    // gpt-image-1 only modifies the transparent areas and leaves everything else
    // pixel-identical — so the main player and fence are guaranteed untouched.
    const imgBuf  = Buffer.from(image.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    const maskBuf = createCircleMaskRgbaPng(S, circles);

    const imageFile = await toFile(imgBuf,  'image.png', { type: 'image/png' });
    const maskFile  = await toFile(maskBuf, 'mask.png',  { type: 'image/png' });

    const editRes = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      mask:  maskFile,
      prompt:
        'The transparent circular areas contain background spectators or bystanders. ' +
        'Remove them completely. ' +
        'Fill each transparent spot by seamlessly extending the fence, grass, or other ' +
        'background surface visible in the pixels immediately surrounding that spot. ' +
        'Match the exact color, texture, and lighting of adjacent areas. ' +
        'Keep everything outside the transparent spots completely unchanged — ' +
        'do not alter the main player, fence, field markings, cars, or grass.',
      n: 1,
      size: '1024x1024',
    } as Parameters<typeof openai.images.edit>[0]);

    const b64 = editRes.data?.[0]?.b64_json;
    if (!b64) throw new Error('gpt-image-1 returned no image');
    res.json({ b64 });

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
              `Look at this sports photo. The MAIN SUBJECT is the largest/most prominent person ` +
              `in the foreground (closest to camera, largest in the frame). Do NOT mark them.\n\n` +
              `Find ALL OTHER people visible anywhere — spectators, coaches, bystanders, ` +
              `anyone sitting or standing in the background.\n\n` +
              `For each background person, estimate their bounding box as percentages (0–100) ` +
              `of image width and height.\n\n` +
              `Return ONLY this JSON (no markdown, no explanation):\n` +
              `{"people":[{"cx":20,"cy":75,"w":10,"h":20},...]}` +
              `\ncx/cy = center of person, w/h = size. If none found: {"people":[]}.`,
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
    res.json({ people: Array.isArray(result.people) ? result.people : [] });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carousel/inpaint ───────────────────────────────────────────────
// Stability AI inpainting — used specifically for removing background people.
// Much more reliable than gpt-image-1 for precise object removal because it's
// a dedicated inpainting model, not a generative one.
//
// Mask convention (Stability AI):  WHITE (255) = inpaint this area
//                                  BLACK (0)   = preserve this area
// Frontend sends: original image + inverted segMask (background=white, player=black)
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
    // Prompt = describe what the INPAINTED (background) area should look like
    form.append('prompt',
      'Fill this area by seamlessly continuing the existing background from the surrounding pixels. ' +
      'If there is a fence or net visible around this spot, extend that same fence or net through here. ' +
      'If there is grass, copy the exact shade, grain, and color of the adjacent grass. ' +
      'If there is concrete or a road, match the same surface. ' +
      'Only erase the human figure — replace it with whatever background surface would naturally be there. ' +
      'Do not add new objects. Do not change colors or lighting. Keep perspective identical.'
    );
    form.append('negative_prompt',
      'person, people, human, man, woman, child, crowd, spectator, fan, athlete, ' +
      'body, face, legs, arms, clothing, empty field, blank space, uniform texture'
    );
    form.append('output_format', 'png');

    const stability = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/inpaint',
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
