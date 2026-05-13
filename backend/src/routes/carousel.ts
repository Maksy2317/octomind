import { Router, Request, Response, NextFunction } from 'express';
import OpenAI, { toFile } from 'openai';

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
    // For this task the mask is counter-productive: giving the AI a large
    // transparent background zone lets it redesign the whole scene (change the
    // field, add new people, etc.).  Instead we skip the mask and give the model
    // a very precise English prompt so it changes ONLY the secondary people.
    const isRemovePeople = /прибер|видал|удал|прибрати.*люд|людей.*фон|фон.*люд|заберіть|remove\s+(back|bg|people)|people.*back/i.test(styleHint);

    let effectiveMask = maskFile;
    let enhancePrompt: string;

    if (isRemovePeople) {
      // Drop the mask — the model needs to see the FULL scene to distinguish
      // foreground subject from background figures.
      effectiveMask = undefined;
      enhancePrompt =
        `You are editing a sports or portrait photo. ` +
        `MAIN TASK: Remove ONLY the secondary/background people from the scene. ` +
        `STRICTLY PRESERVE (do NOT change): ` +
        `the main foreground athlete/person (exact face, body, clothing, position), ` +
        `the entire playing field / grass surface (same color, same markings, same wear), ` +
        `every fence, wall, building, vehicle, and all environmental elements — ` +
        `they must look IDENTICAL to the original. ` +
        `WHERE background people stood: fill seamlessly with whatever surface was behind them ` +
        `(grass → grass, concrete → concrete, stands → stands). ` +
        `Do NOT add new objects. Do NOT change colors or lighting. Do NOT add text. ` +
        `ONLY erase the secondary background humans and fill their spots with the matching environment.`;
    } else if (effectiveMask) {
      // With mask: AI edits only the transparent background zone
      enhancePrompt =
        `Apply ONLY to the transparent/unmasked background area: ${styleHint}. ` +
        `The masked (opaque) region is the main person — leave it 100% unchanged. ` +
        `Do not add text, logos or watermarks. Keep the overall scene realistic.`;
    } else {
      // No mask, generic edit
      enhancePrompt =
        `RULE #1 — PEOPLE: Every person, face, body, skin, clothing, hair must remain 100% unchanged. ` +
        `RULE #2 — BACKGROUND ONLY: Apply "${styleHint}" only to background and non-human elements. ` +
        `RULE #3 — NO TEXT anywhere.`;
    }

    const response = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      ...(effectiveMask ? { mask: effectiveMask } : {}),
      prompt: enhancePrompt,
      n: 1,
      size: '1024x1024',
    } as Parameters<typeof openai.images.edit>[0]);

    res.json({ b64: response.data?.[0]?.b64_json ?? null });
  } catch (err) {
    next(err);
  }
});
