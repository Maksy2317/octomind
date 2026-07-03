// The "marketing brain" — niche-agnostic reasoning over a business profile.
//
// Product stance: OctoMind sells a marketing DECISION (what to advertise, to
// whom, what offer, where), not just generated content. So every step leads
// with reasoning ("почему"), and the generation is secondary.
//
// Reuses the same Anthropic client pattern as routes/chat.ts. Model defaults to
// Opus 4.8 (the audit flagged Haiku as wrong for this kind of reasoning);
// override with MARKETING_MODEL. Outputs are strict JSON, parsed tolerantly the
// same way routes/carousel.ts does.

import Anthropic from '@anthropic-ai/sdk';
import { BusinessProfile } from '../db/models';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Haiku 4.5 by default — cheapest + fastest, and plenty deep for this structured
// JSON reasoning. Bump to a stronger model via MARKETING_MODEL (e.g. claude-sonnet-5
// for deeper analysis, claude-opus-4-8 for max quality) without code changes.
export const MARKETING_MODEL = process.env.MARKETING_MODEL || 'claude-haiku-4-5';

export function isMarketingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Render the saved business profile into a compact, prompt-friendly block. */
export function profileToContext(p: BusinessProfile | null | Record<string, unknown>): string {
  if (!p) return '(бізнес-профіль ще не заповнено)';
  const src = p as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['Назва', src.business_name],
    ['Ніша', src.niche],
    ['Опис', src.description],
    ['Цільова аудиторія', src.target_audience],
    ['Географія', src.geo],
    ['Ціновий сегмент', src.price_segment],
    ['УТП', src.usp],
    ['Ціль', src.goal],
    ['Тон', src.tone],
  ];
  const lines = fields
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`);
  const extra = src.extra && typeof src.extra === 'object' && Object.keys(src.extra as object).length
    ? `\n- Дод. поля: ${JSON.stringify(src.extra)}`
    : '';
  return (lines.length ? lines.join('\n') : '(профіль порожній)') + extra;
}

/** Extract a JSON object from a model response that may be fenced or prefixed. */
function parseJsonLoose<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('AI did not return JSON');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

/** One structured call to Claude that returns a parsed JSON object. */
async function jsonCall<T>(system: string, user: string, maxTokens = 4096): Promise<T> {
  if (!isMarketingConfigured()) throw new Error('AI not configured');
  const res = await client.messages.create({
    model: MARKETING_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseJsonLoose<T>(text);
}

const LANG_RULE =
  'Мова відповіді: українська за замовчуванням; якщо бізнес-профіль заповнено англійською — відповідай англійською. ' +
  'Пиши конкретно і по суті, як практикуючий маркетолог, без загальних фраз. ' +
  'Поверни ЛИШЕ валідний JSON без пояснень і markdown.';

// ── 1. Analysis ───────────────────────────────────────────────────────────────

export interface BusinessAnalysis {
  summary: string;                 // короткое резюме бизнеса
  target_segments: string[];       // 2-4 сегмента ЦА
  pains: string[];                 // боли/потребности клиента
  differentiators: string[];       // чем можно выделиться
  channels: string[];              // где искать клиентов (площадки)
  risks: string[];                 // риски/слабые места
  opportunities: string[];         // точки роста
}

export function analyzeBusiness(profileCtx: string): Promise<BusinessAnalysis> {
  const system =
    'Ти — старший маркетолог-стратег. За даними про бізнес робиш тверезий аналіз: ' +
    'хто клієнт, які в нього болі, чим бізнес може виділитися, де шукати клієнтів. ' +
    'Працюєш для БУДЬ-ЯКОЇ ніші — адаптуйся під ту, що вказана. ' +
    LANG_RULE +
    ' Схема JSON: {"summary": string, "target_segments": string[], "pains": string[], ' +
    '"differentiators": string[], "channels": string[], "risks": string[], "opportunities": string[]}.';
  const user = `Дані про бізнес:\n${profileCtx}\n\nЗроби маркетинговий аналіз.`;
  return jsonCall<BusinessAnalysis>(system, user);
}

// ── 2. Offer + strategy (coupled — the core "brain" output) ───────────────────

export interface OfferStrategy {
  offer: {
    headline: string;              // сам оффер одной фразой
    details: string;               // что входит / условия
    why: string;                   // ПОЧЕМУ этот оффер сработает для этого бизнеса
  };
  strategy: {
    positioning: string;           // как позиционироваться
    primary_channel: string;       // главная площадка + почему
    funnel: string[];              // шаги воронки: как клиент придёт к покупке
    content_angles: string[];      // 3-5 углов/тем контента
    call_to_action: string;        // целевое действие
    why: string;                   // обоснование стратегии
  };
}

export function generateOfferStrategy(
  profileCtx: string,
  analysis?: BusinessAnalysis,
): Promise<OfferStrategy> {
  const system =
    'Ти — маркетолог-стратег. На основі бізнесу (і аналізу, якщо є) формулюєш ОФЕР ' +
    'і стратегію просування. Головна цінність — не текст, а РІШЕННЯ: що рекламувати, кому, ' +
    'який офер і де, і головне — ЧОМУ саме так. Ніша будь-яка — адаптуйся. ' +
    LANG_RULE +
    ' Схема JSON: {"offer": {"headline": string, "details": string, "why": string}, ' +
    '"strategy": {"positioning": string, "primary_channel": string, "funnel": string[], ' +
    '"content_angles": string[], "call_to_action": string, "why": string}}.';
  const user =
    `Дані про бізнес:\n${profileCtx}` +
    (analysis ? `\n\nАналіз:\n${JSON.stringify(analysis)}` : '') +
    '\n\nСформулюй офер і стратегію з обґрунтуванням.';
  return jsonCall<OfferStrategy>(system, user);
}

// ── 3. Marketing text ─────────────────────────────────────────────────────────

export interface MarketingText {
  variants: Array<{
    angle: string;                 // угол: curiosity / utility / social proof / ...
    text: string;                  // готовый текст поста/объявления
    caption: string;               // короткая подпись
    hashtags: string[];
  }>;
  cta: string;
}

export function generateMarketingText(
  profileCtx: string,
  offer?: OfferStrategy,
  brief?: string,
): Promise<MarketingText> {
  const system =
    'Ти — копірайтер-маркетолог. Пишеш готові рекламні тексти під бізнес і офер. ' +
    'Даєш 3 варіанти з різними кутами (інтрига / користь / соц. доказ). ' +
    'Ніша будь-яка — адаптуйся під контекст. ' +
    LANG_RULE +
    ' Схема JSON: {"variants": [{"angle": string, "text": string, "caption": string, ' +
    '"hashtags": string[]}], "cta": string}.';
  const user =
    `Дані про бізнес:\n${profileCtx}` +
    (offer ? `\n\nОфер і стратегія:\n${JSON.stringify(offer)}` : '') +
    (brief ? `\n\nДод. побажання: ${brief}` : '') +
    '\n\nНапиши рекламні тексти (3 варіанти).';
  return jsonCall<MarketingText>(system, user);
}
