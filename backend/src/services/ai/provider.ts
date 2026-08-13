// Provider abstraction: one text/vision call routed to Anthropic OR Google.
//
// Why: Gemini Flash is ~8x cheaper than Haiku for our structured-JSON tasks.
// This layer lets us swap providers (or A/B them) with an env var, without
// touching any of the marketing functions — they keep calling llmJson/llmVision.
//
// AI_PROVIDER=anthropic (default) | gemini
//   MARKETING_MODEL  — Anthropic model id (default claude-haiku-4-5)
//   GEMINI_MODEL     — Gemini model id (default gemini-2.5-flash)
// A single call can also override the provider (used by the A/B endpoint).

import Anthropic from '@anthropic-ai/sdk';

export type Provider = 'anthropic' | 'gemini';
export interface LlmImage { media_type: string; data: string }
export interface LlmResult { text: string; provider: Provider; model: string; ms: number }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const ANTHROPIC_MODEL = process.env.MARKETING_MODEL || 'claude-haiku-4-5';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export function defaultProvider(): Provider {
  return process.env.AI_PROVIDER === 'gemini' ? 'gemini' : 'anthropic';
}

export function providerConfigured(p: Provider): boolean {
  return p === 'gemini' ? Boolean(process.env.GOOGLE_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);
}

export function isAnyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.GOOGLE_API_KEY);
}

function textOfAnthropic(res: Anthropic.Message): string {
  return res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('\n');
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function anthropicJson(system: string, user: string, images: LlmImage[], maxTokens: number): Promise<string> {
  const content: Anthropic.MessageParam['content'] = [
    ...images.map((im) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: im.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: im.data },
    })),
    { type: 'text' as const, text: user },
  ];
  const res = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
  });
  return textOfAnthropic(res);
}

// ── Gemini (REST, no SDK — one endpoint, same shape for text+vision) ──────────
async function geminiJson(system: string, user: string, images: LlmImage[], maxTokens: number): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not configured');
  const parts: Array<Record<string, unknown>> = [
    ...images.map((im) => ({ inline_data: { mime_type: im.media_type, data: im.data } })),
    { text: user },
  ];
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      // Headroom: our maxTokens were tuned for Haiku; Gemini can be more verbose
      // in Ukrainian and occasionally truncated JSON mid-object (→ parse error).
      // Output tokens on Flash are cheap ($0.60/M), so give a generous floor.
      maxOutputTokens: Math.max(maxTokens, 2048),
      temperature: 0.7,
      responseMimeType: 'application/json',   // Gemini returns clean JSON
      // Gemini 2.5 Flash "thinks" by default — reasoning tokens eat the output
      // budget (truncated JSON) AND are billed. Off: faster, cheaper, fits
      // maxTokens. Our structured tasks don't need chain-of-thought.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json() as any;
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned empty response' + (cand?.finishReason ? ` (${cand.finishReason})` : ''));
  // Truncated mid-JSON → surface it so parseWithRetry retries instead of
  // trying to parse an incomplete object.
  if (cand?.finishReason === 'MAX_TOKENS') throw new Error('Gemini output truncated (MAX_TOKENS)');
  return text;
}

// ── Gemini chat (free-text, multi-turn, vision) — for /api/chat ────────────────
// Accepts Anthropic-shaped messages ([{role, content}] where content is a string
// or an array of text/image blocks) and returns a plain-text reply. No JSON mime.

// Anthropic-shaped chat messages → Gemini `contents` (text + inline images).
function toGeminiContents(messages: Array<{ role?: string; content: unknown }>): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts: Array<Record<string, unknown>>;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map((b: any) => {
        if ((b?.type === 'image') && b?.source?.data) {
          return { inline_data: { mime_type: b.source.media_type || 'image/jpeg', data: b.source.data } };
        }
        return { text: String(b?.text || '') };
      });
    } else {
      parts = [{ text: '' }];
    }
    return { role, parts };
  });
}

// TRUE token streaming for the chat: streamGenerateContent over SSE, each text
// delta handed to `onText` the moment Gemini produces it. The buffered
// geminiChat below stays as the fallback (and for one-string callers).
export async function geminiChatStream(
  system: string,
  messages: Array<{ role?: string; content: unknown }>,
  onText: (t: string) => void,
): Promise<void> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not configured');
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok || !r.body) throw new Error(`Gemini stream ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const decoder = new TextDecoder();
  let buf = '';
  let emitted = false;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload) as any;
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p: any) => p.text || '').join('');
        if (text) { emitted = true; onText(text); }
      } catch { /* partial or keepalive line — ignore */ }
    }
  }
  if (!emitted) throw new Error('Gemini stream returned no text');
}

export async function geminiChat(
  system: string,
  messages: Array<{ role?: string; content: unknown }>,
): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not configured');
  const contents = toGeminiContents(messages);
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json() as any;
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned empty chat response' + (cand?.finishReason ? ` (${cand.finishReason})` : ''));
  return text;
}

// ── Gemini grounded (real Google Search) — for market research ─────────────────
// Grounds the answer with live Google Search results and returns the model text
// plus the sources it used (each with a human-readable title + its URL). Can't
// combine with responseMimeType:json, so the caller parses JSON from the text.
export interface GroundingSource { title: string; url: string }
export async function geminiGrounded(system: string, user: string): Promise<{ text: string; sources: GroundingSource[] }> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not configured');
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    tools: [{ google_search: {} }],
    // 3072 не вистачало: модель обривалась на MAX_TOKENS і повертала ПОРОЖНЄ,
    // через що дослідження падало й ішло на фолбек. Розгорнутий бриф із
    // цитатами джерел просто не влазив у цю стелю.
    generationConfig: { maxOutputTokens: 8192, temperature: 0.6 },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`Gemini grounded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json() as any;
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p.text || '').join('');
  if (!text) throw new Error('Gemini grounded returned empty' + (cand?.finishReason ? ` (${cand.finishReason})` : ''));
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];
  for (const c of chunks) {
    const w = c?.web || {};
    const url: string = w.uri || w.url || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Google gives a readable title (usually the site/page name) for each chunk;
    // fall back to the URL host, never the ugly vertex redirect host.
    let title = String(w.title || '').trim();
    if (!title) { try { const h = new URL(url).hostname.replace(/^www\./, ''); title = h.includes('vertexaisearch') ? 'Джерело' : h; } catch { title = 'Джерело'; } }
    sources.push({ title, url });
    if (sources.length >= 8) break;
  }
  return { text, sources };
}

// ── Unified entry ─────────────────────────────────────────────────────────────
export async function llmCall(
  system: string,
  user: string,
  opts: { images?: LlmImage[]; maxTokens?: number; provider?: Provider } = {},
): Promise<LlmResult> {
  const primary = opts.provider || defaultProvider();
  const images = opts.images || [];
  const maxTokens = opts.maxTokens || 6000;   // див. коментар у jsonCall
  const run = (p: Provider) => (p === 'gemini' ? geminiJson : anthropicJson)(system, user, images, maxTokens);

  const t0 = Date.now();
  const done = (text: string, p: Provider): LlmResult =>
    ({ text, provider: p, model: p === 'gemini' ? GEMINI_MODEL : ANTHROPIC_MODEL, ms: Date.now() - t0 });

  // Перехідні збої, які лікуються повтором: 429 (ліміт) і 503 «model is
  // currently experiencing high load». Раніше ретраїлись лише 429 — тож у
  // години пік Gemini 503 одразу падав на Anthropic, а там порожній баланс,
  // і користувач бачив сирий JSON «credit balance is too low».
  const transient = (e: unknown) => /429|503|overloaded|high load|UNAVAILABLE|resource.?exhausted/i.test((e as Error).message || '');

  try {
    try {
      return done(await run(primary), primary);
    } catch (e1) {
      if (transient(e1)) {
        await new Promise((r) => setTimeout(r, 4000));
        return done(await run(primary), primary);
      }
      throw e1;
    }
  } catch (e) {
    // Resilience: if the primary provider errors (rate limit, outage, no
    // balance) and the OTHER is configured, fall back to it once. An explicit
    // per-call provider (A/B test) opts out — we want its true result.
    const other: Provider = primary === 'gemini' ? 'anthropic' : 'gemini';
    if (!opts.provider && providerConfigured(other)) {
      console.warn(`[AI] ${primary} failed (${(e as Error).message.slice(0, 100)}) → fallback ${other}`);
      try {
        return done(await run(other), other);
      } catch (e2) {
        // Обидва лягли. Ключове: НЕ підміняти справжню причину помилкою
        // фолбека (раніше «Gemini 503» ховався за «Anthropic credit balance»),
        // і не показувати користувачу сирий JSON — 503 підхопить errorHandler.
        console.error(
          `[AI] BOTH providers failed. ${primary}: ${(e as Error).message.slice(0, 140)} | ${other}: ${(e2 as Error).message.slice(0, 140)}`,
        );
        const busy = new Error('Octo зараз перевантажений — спробуй ще раз за хвилину.');
        (busy as Error & { status: number }).status = 503;
        throw busy;
      }
    }
    if (transient(e)) {
      const busy = new Error('Octo зараз перевантажений — спробуй ще раз за хвилину.');
      (busy as Error & { status: number }).status = 503;
      throw busy;
    }
    // Сюди доходять шляхи з ЯВНО закріпленим провайдером (напр. дослідження
    // жорстко на gemini) — фолбека для них немає за задумом. Але сирий текст
    // провайдера все одно не має права піти назовні: саме так користувач одного
    // разу побачив англійське «credit balance is too low… Plans & Billing».
    console.error(`[AI] ${primary} failed (без фолбека): ${(e as Error).message?.slice(0, 200)}`);
    const failed = new Error('Octo зараз не може згенерувати відповідь. Спробуй ще раз за хвилину.');
    (failed as Error & { status: number }).status = 503;
    throw failed;
  }
}
