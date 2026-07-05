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
      maxOutputTokens: maxTokens,
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
  return text;
}

// ── Unified entry ─────────────────────────────────────────────────────────────
export async function llmCall(
  system: string,
  user: string,
  opts: { images?: LlmImage[]; maxTokens?: number; provider?: Provider } = {},
): Promise<LlmResult> {
  const primary = opts.provider || defaultProvider();
  const images = opts.images || [];
  const maxTokens = opts.maxTokens || 4096;
  const run = (p: Provider) => (p === 'gemini' ? geminiJson : anthropicJson)(system, user, images, maxTokens);

  const t0 = Date.now();
  try {
    const text = await run(primary);
    return { text, provider: primary, model: primary === 'gemini' ? GEMINI_MODEL : ANTHROPIC_MODEL, ms: Date.now() - t0 };
  } catch (e) {
    // Resilience: if the primary provider errors (rate limit, outage, no
    // balance) and the OTHER is configured, fall back to it once. An explicit
    // per-call provider (A/B test) opts out — we want its true result.
    const other: Provider = primary === 'gemini' ? 'anthropic' : 'gemini';
    if (!opts.provider && providerConfigured(other)) {
      console.warn(`[AI] ${primary} failed (${(e as Error).message.slice(0, 100)}) → fallback ${other}`);
      const text = await run(other);
      return { text, provider: other, model: other === 'gemini' ? GEMINI_MODEL : ANTHROPIC_MODEL, ms: Date.now() - t0 };
    }
    throw e;
  }
}
