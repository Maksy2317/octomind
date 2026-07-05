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
import { BusinessProfile, BusinessProfileInput } from '../db/models';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Haiku 4.5 by default — cheapest + fastest, and plenty deep for this structured
// JSON reasoning. Bump to a stronger model via MARKETING_MODEL (e.g. claude-sonnet-5
// for deeper analysis, claude-opus-4-8 for max quality) without code changes.
export const MARKETING_MODEL = process.env.MARKETING_MODEL || 'claude-haiku-4-5';

export function isMarketingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Flatten a saved brand kit into one prompt-friendly line (colors + tone). */
function brandToLine(brand: unknown): string {
  if (!brand || typeof brand !== 'object') return '';
  const b = brand as Record<string, unknown>;
  const parts: string[] = [];
  const pal = Array.isArray(b.palette) ? (b.palette as Array<Record<string, unknown>>) : [];
  if (pal.length) {
    parts.push('кольори ' + pal.map((c) => `${c.hex}${c.name ? ' (' + c.name + ')' : ''}`).join(', '));
  }
  if (b.tagline) parts.push(`слоган «${b.tagline}»`);
  if (b.tone) parts.push(`тон: ${b.tone}`);
  return parts.join('; ');
}

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
    ['Дослідження ринку', src.market_research],
    ['Бренд-стиль', brandToLine(src.brand)],
    ['Що вже працює на сторінці клієнта', src.page_style],
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
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    // Repair the most common model issues: raw control chars (literal newlines/
    // tabs inside string values are invalid JSON) and trailing commas.
    const repaired = slice
      .replace(/[\u0000-\u001F]+/g, ' ')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(repaired) as T;
  }
}

const textOf = (res: Anthropic.Message): string =>
  res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');

/** Parse JSON from a text-producing call, retrying once on malformed output. */
async function parseWithRetry<T>(make: () => Promise<string>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await make();
    try {
      return parseJsonLoose<T>(text);
    } catch (e) {
      if (attempt === 1) {
        console.warn('[AI] JSON parse failed twice:', (e as Error).message, '| head:', text.slice(0, 200));
        throw new Error('AI повернув невалідний формат. Спробуй ще раз.');
      }
    }
  }
  throw new Error('AI повернув невалідний формат. Спробуй ще раз.'); // unreachable
}

/** One structured call to Claude that returns a parsed JSON object. */
async function jsonCall<T>(system: string, user: string, maxTokens = 4096): Promise<T> {
  if (!isMarketingConfigured()) throw new Error('AI not configured');
  return parseWithRetry<T>(async () => {
    const res = await client.messages.create({
      model: MARKETING_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return textOf(res);
  });
}

export interface AuditImage { media_type: string; data: string }

/** Vision variant — same JSON discipline, with images attached to the user turn. */
async function jsonCallVision<T>(system: string, user: string, images: AuditImage[], maxTokens = 2500): Promise<T> {
  if (!isMarketingConfigured()) throw new Error('AI not configured');
  return parseWithRetry<T>(async () => {
    // Typed loosely: the 0.27 SDK doesn't export ContentBlockParam.
    const content: Anthropic.MessageParam['content'] = [
      ...images.map((im) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: im.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: im.data },
      })),
      { type: 'text' as const, text: user },
    ];
    const res = await client.messages.create({
      model: MARKETING_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    });
    return textOf(res);
  });
}

const LANG_RULE =
  'Мова відповіді: українська за замовчуванням; якщо бізнес-профіль заповнено англійською — відповідай англійською. ' +
  'Пиши конкретно і по суті, як практикуючий маркетолог, без загальних фраз. ' +
  'Поверни ЛИШЕ валідний JSON (мініфікований, без markdown, без тексту до/після). ' +
  'Усередині рядкових значень екрануй лапки та переноси рядків за правилами JSON; не став переносів рядків усередині значень.';

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

// ── Web-search-enabled call (server-side tool) ────────────────────────────────
// SDK 0.27 doesn't type the web_search tool, so we cast. The server runs the
// search loop and returns the final text; we read text blocks and parse JSON.
// NOTE: single-shot (no pause_turn continuation) — revisit if research truncates.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

async function jsonCallSearch<T>(system: string, user: string, maxTokens = 3000): Promise<T> {
  if (!isMarketingConfigured()) throw new Error('AI not configured');
  return parseWithRetry<T>(async () => {
    const res = await client.messages.create({
      model: MARKETING_MODEL,
      max_tokens: maxTokens,
      system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [WEB_SEARCH_TOOL] as any,
      messages: [{ role: 'user', content: user }],
    });
    return textOf(res);
  });
}

// ── Niche/market research (real, via web search) ──────────────────────────────
// Runs once (e.g. after onboarding) so the marketer is "in the know" about the
// current market before building any strategy.
export interface MarketResearch {
  summary: string;
  trends: string[];            // що зараз у тренді в ніші
  what_works: string[];        // формати/підходи, що працюють
  hooks: string[];             // приклади хуків
  competitor_notes: string[];  // що роблять конкуренти
  sources: string[];           // джерела/посилання
}

export function researchNiche(profileCtx: string): Promise<MarketResearch> {
  const system =
    'Ти — маркетолог-дослідник. ОБОВ’ЯЗКОВО скористайся веб-пошуком, щоб знайти СВІЖУ, реальну ' +
    'інформацію про ринок і нішу цього бізнесу: що зараз працює в контенті ніші, тренди TikTok/Instagram, ' +
    'підходи конкурентів, типові офери й ціни, сезонні приводи. Спирайся на знайдене, не вигадуй. ' +
    LANG_RULE +
    ' Схема JSON: {"summary": string, "trends": string[], "what_works": string[], "hooks": string[], ' +
    '"competitor_notes": string[], "sources": string[]}.';
  const user =
    `Бізнес:\n${profileCtx}\n\nДослідь ринок і нішу цього бізнесу. Знайди, що реально працює ЗАРАЗ.`;
  return jsonCallSearch<MarketResearch>(system, user);
}

// ── Trend adapter (reference → original idea, NOT a copy) ──────────────────────
export interface TrendIdea {
  idea: string;        // ідея ролика під бізнес
  hook: string;        // хук (перші 2 сек)
  script: string[];    // кроки сценарію
  caption: string;
  cta: string;
  why: string;         // чому спрацює під цей бізнес
}

export function adaptTrend(profileCtx: string, reference: string, images?: AuditImage[]): Promise<TrendIdea> {
  const system =
    'Ти — контент-мейкер і маркетолог. Клієнт дав РЕФЕРЕНС (тренд / приклад відео). ' +
    'Твоя задача — НЕ копіювати його, а зробити ОРИГІНАЛЬНУ ідею ролика під бізнес клієнта, ' +
    'надихнувшись референсом (структура/енергія/формат), але зі своїм змістом. ' +
    LANG_RULE +
    ' Схема JSON: {"idea": string, "hook": string, "script": string[], "caption": string, "cta": string, "why": string}.';
  const user =
    `Бізнес:\n${profileCtx}\n\nРеференс (тренд/приклад): ${reference}\n\n` +
    'Зроби оригінальний сценарій ролика під цей бізнес за мотивами референсу (не копію).';
  return (images && images.length)
    ? jsonCallVision<TrendIdea>(system, user, images)
    : jsonCall<TrendIdea>(system, user, 2500);
}

// ── Onboarding: extract a business profile from free conversation ─────────────
// The "Understand" phase. User talks freely about their business; we pull out
// structured profile fields we're confident about, and ask ONE follow-up for the
// most important gap. Hybrid onboarding: conversational in, structured out.

export interface ProfileExtraction {
  profile: BusinessProfileInput;   // only fields we're confident about
  enough: boolean;                 // do we know enough to start campaigns?
  follow_up: string;               // one short friendly question, or '' if enough
}

export function extractBusinessProfile(
  userText: string,
  known?: BusinessProfileInput,
): Promise<ProfileExtraction> {
  const system =
    'Ти — AI-маркетолог, який знайомиться з бізнесом клієнта. З того, що людина розповіла ' +
    '(вільним текстом), витягни те, у чому ти ВПЕВНЕНИЙ, у структуру профілю. Не вигадуй — ' +
    'якщо поля немає в тексті, не заповнюй його. Мінімум, щоб почати роботу: ніша + що продають. ' +
    'Якщо цього ще немає — постав ОДНЕ коротке дружнє питання про найважливіший пробіл. ' +
    'Якщо вже достатньо — follow_up порожній. ' +
    LANG_RULE +
    ' Схема JSON: {"profile": {"business_name"?: string, "niche"?: string, "description"?: string, ' +
    '"target_audience"?: string, "geo"?: string, "price_segment"?: string, "usp"?: string, ' +
    '"goal"?: string, "tone"?: string}, "enough": boolean, "follow_up": string}.';
  const user =
    (known && Object.keys(known).length ? `Вже відомо: ${JSON.stringify(known)}\n\n` : '') +
    `Людина розповіла:\n${userText}\n\nОнови профіль.`;
  return jsonCall<ProfileExtraction>(system, user, 1500);
}

// ── Content audit (Claude Vision — analyse the client's OWN content) ──────────
// User uploads screenshots of their profile / posts. We give an honest, specific
// audit of THEIR content tied to their business: what works, what's weak, and
// concrete fixes. This is the "we actually help you" moment.

export interface ContentAudit {
  summary: string;                            // загальне враження
  score: number;                              // 0-100 (умовна оцінка контенту)
  strengths: string[];                        // що працює
  weaknesses: string[];                       // конкретні слабкі місця
  fixes: Array<{ what: string; why: string }>; // що виправити і чому
}

export function auditContent(profileCtx: string, images: AuditImage[]): Promise<ContentAudit> {
  const system =
    'Ти — старший маркетолог, який робить ЧЕСНИЙ аудит контенту клієнта (на зображеннях — його ' +
    'власні пости / профіль / креативи). Не хвали заради ввічливості — знаходь конкретні слабкі місця ' +
    'і давай точні, здійсненні поради, ПРИВ’ЯЗАНІ до того, що реально видно на зображеннях. ' +
    'Оцінюй під бізнес клієнта. ' +
    LANG_RULE +
    ' Схема JSON: {"summary": string, "score": number (0-100), "strengths": string[], ' +
    '"weaknesses": string[], "fixes": [{"what": string, "why": string}]}. ' +
    'weaknesses і fixes — найважливіше: 3-6 пунктів, конкретно про ЦЕЙ контент, не загально.';
  const user =
    `Дані про бізнес:\n${profileCtx}\n\nНа зображеннях — контент цього клієнта. ` +
    'Зроби чесний аудит: що працює, що слабко, що саме виправити.';
  return jsonCallVision<ContentAudit>(system, user, images);
}

// ── Campaign strategy (goal-first — the v2 concept) ───────────────────────────
// Input is a BUSINESS GOAL (not a file type) + optional details. Output is the
// exact strategy shape from the product spec: goal → audience → problem →
// benefits → offer → key message → CTA, plus the material set the AI proposes.

export interface CampaignStrategy {
  goal: string;                 // уточнена ціль кампанії
  audience: string;             // цільова аудиторія
  problem: string;              // основна проблема клієнта
  benefits: string[];           // переваги продукту/послуги
  offer: string;                // оффер
  key_message: string;          // ключове рекламне повідомлення
  cta: string;                  // призив до дії
  recommended_materials: Array<{ type: string; label: string; why: string }>;
}

export function generateCampaignStrategy(
  profileCtx: string,
  goal: string,
  details?: string,
): Promise<CampaignStrategy> {
  const system =
    'Ти — AI-маркетолог. Користувач ставить БІЗНЕС-ЦІЛЬ (не «зроби файл»). ' +
    'Твоя робота — до будь-якої генерації показати чітку маркетингову стратегію під цю ціль, ' +
    'а потім самому запропонувати, які матеріали створити (користувач не має думати про формати). ' +
    'Ніша будь-яка — адаптуйся. ' +
    LANG_RULE +
    ' Схема JSON: {"goal": string, "audience": string, "problem": string, "benefits": string[], ' +
    '"offer": string, "key_message": string, "cta": string, ' +
    '"recommended_materials": [{"type": string (одне з: ad_text|caption|headlines|stories|carousel|image|video|post|content_plan), ' +
    '"label": string (людською мовою), "why": string (навіщо саме це під цю ціль)}]}. ' +
    'Пропонуй 3-6 матеріалів, релевантних саме цій цілі й ніші.';
  const user =
    `Дані про бізнес:\n${profileCtx}\n\nБізнес-ціль користувача: ${goal}` +
    (details ? `\nДеталі: ${details}` : '') +
    '\n\nЗроби стратегію під цю ціль і запропонуй набір матеріалів.';
  return jsonCall<CampaignStrategy>(system, user, 3000);
}

// ── Material generation (the proposed pack, one item at a time) ───────────────
// Generic shape that renders for any text-based material type.
export interface GeneratedMaterial {
  title: string;
  summary?: string;
  items: Array<{ label?: string; text: string }>;
  cta?: string;
  hashtags?: string[];
}

const MATERIAL_GUIDE: Record<string, string> = {
  post:         'готовий пост для стрічки (Instagram/Facebook): один сильний текст. items=[{text: пост}].',
  ad_text:      'рекламний текст для таргету/оголошення: 2 варіанти. items=[{label:"Варіант A", text}, ...].',
  caption:      'підпис під фото/Reels: 3 варіанти різних кутів. items=[{label:кут, text}].',
  headlines:    '5-7 заголовків/хуків для A/B-тесту. items=[{text: заголовок}, ...].',
  stories:      'сценарій Stories: 5-7 екранів послідовно. items=[{label:"Екран 1", text}, ...].',
  reels:        'сценарій Reels: хук + кроки + фінал. items=[{label:"Хук (0-2с)", text}, {label:"Крок", text}, ...].',
  tiktok:       'сценарій TikTok: хук + кроки. items=[{label, text}, ...].',
  content_plan: 'контент-план на тиждень: 5-7 днів. items=[{label:"Пн", text: тема + формат}, ...].',
};

export function generateMaterial(
  profileCtx: string,
  strategy: unknown,
  type: string,
  label: string,
): Promise<GeneratedMaterial> {
  const guide = MATERIAL_GUIDE[type] || 'готовий матеріал під опис. items=[{text}].';
  const system =
    'Ти — маркетолог-копірайтер. Створюєш ОДИН конкретний матеріал під стратегію кампанії, ' +
    `тип: «${label}». Що зробити: ${guide} Додай hashtags і cta, де доречно. ` +
    LANG_RULE +
    ' Схема JSON: {"title": string, "summary": string, "items": [{"label": string, "text": string}], ' +
    '"cta": string, "hashtags": string[]}.';
  const user =
    `Бізнес:\n${profileCtx}\n\nСтратегія:\n${JSON.stringify(strategy)}\n\n` +
    `Зроби матеріал: ${label} (${type}).`;
  return jsonCall<GeneratedMaterial>(system, user, 2500);
}

// ── Own-page audit (real metrics, not screenshots) ────────────────────────────
// The user's OWN latest videos with views/likes/dates go in; out comes an
// honest read: what works for THEM specifically, what flops, and what to make
// next. This is the data-driven upgrade of the screenshot audit.
export interface PageAudit {
  summary: string;          // 2-3 речення чесного висновку
  score: number;            // 0-100 — наскільки контент працює на бізнес-ціль
  what_works: string[];     // патерни, які реально заходять (з цифр)
  weak_spots: string[];     // що просідає і чому
  top_videos: Array<{ text: string; views: number; why: string }>;  // до 3
  fixes: Array<{ what: string; why: string }>;
  next_ideas: Array<{ idea: string; hook: string }>;  // 3 ідеї в стилі того, що працює
}

export function auditOwnPage(
  profileCtx: string,
  author: Record<string, unknown> | null,
  videos: Array<Record<string, unknown>>,
): Promise<PageAudit> {
  const system =
    'Ти — аналітик контенту й маркетолог. Тобі дають ОСТАННІ ролики сторінки бізнесу з реальними метриками ' +
    '(перегляди, лайки, коментарі, шери, дати, тривалість). Зроби чесний розбір САМЕ ЦІЄЇ сторінки: ' +
    'знайди патерни у цифрах (які формати/теми/хуки заходять, які провалюються, стабільність виходу постів), ' +
    'без загальних порад — усе з доказами з даних. score: 0-100, чесно. ' +
    'next_ideas — 3 ідеї наступних роликів, що підсилюють те, що ВЖЕ працює в цієї сторінки. ' +
    LANG_RULE +
    ' Пиши стисло: кожен пункт 1-2 речення. ' +
    'Схема JSON: {"summary":str,"score":num,"what_works":[str],"weak_spots":[str],' +
    '"top_videos":[{"text":str,"views":num,"why":str}],"fixes":[{"what":str,"why":str}],' +
    '"next_ideas":[{"idea":str,"hook":str}]}. Максимум 4 what_works, 3 weak_spots, 3 top_videos, 3 fixes, 3 next_ideas.';
  const user =
    `Бізнес:\n${profileCtx}\n\n` +
    (author ? `Сторінка: ${JSON.stringify(author)}\n\n` : '') +
    `Останні ролики (${videos.length}):\n${JSON.stringify(videos.slice(0, 15))}\n\nЗроби розбір.`;
  return jsonCall<PageAudit>(system, user, 3500);
}

// ── Trend search queries (the marketer decides WHAT to search) ────────────────
// A raw niche word fed into TikTok search returns whatever is loudest — usually
// memes. Octo instead crafts targeted queries for the user's INTENT (how do
// peers sell / expert content / fun), so the feed matches what they came for.
const TREND_INTENTS: Record<string, string> = {
  selling: 'відео, де представники цієї ніші ПРОДАЮТЬ: презентації товару/послуги/обʼєкта, огляди й тури, до/після, кейси клієнтів, оффери, заклики записатись/купити',
  expert: 'експертний контент ніші: поради, лайфхаки, розбори помилок, «що треба знати перед...», відповіді на питання клієнтів',
  fun: 'розважальний і мемний контент ніші: гумор, скетчі, тренди, ситуації з клієнтами',
};

export function generateTrendQueries(
  profileCtx: string,
  topic: string,
  intent: string,
  platform: 'tiktok' | 'instagram' = 'tiktok',
): Promise<{ queries: string[] }> {
  const goal = TREND_INTENTS[intent] || TREND_INTENTS.selling;
  // Instagram search is hashtag-based (Meta's keyword search is weak) —
  // so for IG Octo crafts hashtags instead of search phrases.
  const what = platform === 'instagram'
    ? 'Придумай 3 популярні хештеги для пошуку Reels в Instagram (одне слово без пробілів кожен, без символу #). '
    : 'Придумай 3 короткі пошукові запити для пошуку відео в TikTok. ';
  const system =
    'Ти — SMM-дослідник. ' + what +
    `Мета: знайти ${goal}. ` +
    'ВАЖЛИВО: запити мають бути про ВКАЗАНУ НІШУ/ТЕМУ (це те, що користувач явно попросив). ' +
    'Контекст бізнесу використовуй лише як підказку про географію, мову і стиль контенту, який уже працює у клієнта ' +
    '(якщо в контексті є «Що вже працює на сторінці клієнта» — один із запитів можеш націлити на схожий формат) — НЕ підміняй ним тему. ' +
    'Запити — мовою, якою такий контент реально публікують (для укр/рос ринку можеш дати запити обома мовами; для широких тем — англійською теж). ' +
    '2-4 слова кожен, БЕЗ хештегів і лапок. Поверни ЛИШЕ JSON: {"queries":["...","...","..."]}.';
  const user = `НІША/ТЕМА (шукаємо саме про це): ${topic}\n\nКонтекст бізнесу (лише гео/мова):\n${profileCtx}`;
  return jsonCall<{ queries: string[] }>(system, user, 300);
}

// ── Viral video analysis (trend feed: «чому залетів» + adaptation) ────────────
// Input is the video's metadata (caption, metrics, duration, hashtags) — we
// never download the video itself. The breakdown explains the mechanics
// (hook/format/CTA) and, given the business profile, adapts the idea for THEM.
export interface ViralAnalysis {
  why_viral: string[];       // 3-5 причин, чому ролик залетів
  hook: string;              // як працює перший кадр/фраза
  format: string;            // формат ролика (до/після, гумор, туторіал...)
  cta: string;               // що глядача просять зробити (явно чи ні)
  score_notes: string;       // що кажуть цифри (лайки/перегляди/шери)
  adapt: {                   // адаптація під бізнес користувача
    idea: string;
    hook: string;
    script: string[];        // 3-6 кроків-кадрів
    caption: string;
    why_fits: string;
  };
}

export function analyzeViralVideo(
  profileCtx: string,
  video: Record<string, unknown>,
): Promise<ViralAnalysis> {
  const system =
    'Ти — аналітик вірусного контенту й маркетолог. Тобі дають метадані ролика ' +
    '(опис, перегляди, лайки, коментарі, шери, тривалість, хештеги). Розбери, ЧОМУ він залетів — ' +
    'механіка хука, формат, утримання, CTA — і зроби АДАПТАЦІЮ ідеї під бізнес клієнта ' +
    '(оригінальну, не копію; інший бізнес — інша подача). Пиши конкретно, без води. ' +
    LANG_RULE +
    ' Схема JSON: {"why_viral":[str],"hook":str,"format":str,"cta":str,"score_notes":str,' +
    '"adapt":{"idea":str,"hook":str,"script":[str],"caption":str,"why_fits":str}}.';
  const user =
    `Бізнес клієнта:\n${profileCtx}\n\nМетадані ролика:\n${JSON.stringify(video)}\n\nРозбери і адаптуй.`;
  return jsonCall<ViralAnalysis>(system, user, 2000);
}

// ── Brand kit (identity is a marketing decision, not a color picker) ──────────
// Octo derives a coherent visual identity FROM the business — palette with a
// stated role & reasoning, a tone of voice, a tagline, and a logo concept the
// image model can render. Per the constitution: a decision with "чому", not a
// shelf of swatches to fiddle with.
export interface BrandColor { hex: string; name: string; role: string; why: string; }
export interface BrandKit {
  palette: BrandColor[];   // 3-4 кольори: основний, акцент, фон, текст
  tone: string;            // тон голосу бренду
  tagline: string;         // короткий слоган
  logo_concept: string;    // опис лого людською мовою
  logo_prompt: string;     // англ. промпт для image-моделі (емблема, БЕЗ тексту)
  personality: string[];   // 3-4 слова-характеристики бренду
}

export function generateBrandKit(profileCtx: string): Promise<BrandKit> {
  const system =
    'Ти — бренд-дизайнер. На основі бізнесу побудуй цілісний бренд-стиль. ' +
    'Палітра — 3-4 кольори (основний, акцент, фон, текст) у HEX, з роллю та поясненням «чому саме він». ' +
    'Кольори мають пасувати ніші, аудиторії та емоції бренду (не рандомні). ' +
    'logo_prompt — англійською: проста векторна емблема/іконка (flat vector logo, minimal, iconic), ' +
    'БЕЗ тексту й літер, на нейтральному фоні, у дусі палітри. ' +
    LANG_RULE +
    ' Схема JSON: {"palette":[{"hex":"#RRGGBB","name":str,"role":str,"why":str}],' +
    '"tone":str,"tagline":str,"logo_concept":str,"logo_prompt":str,"personality":[str]}.';
  const user = `Бізнес:\n${profileCtx}\n\nЗроби бренд-стиль.`;
  return jsonCall<BrandKit>(system, user, 1500);
}

// ── Ad image brief (the marketing decision BEHIND the image) ──────────────────
// Per the constitution: the image is a consequence of a decision. Claude first
// decides WHAT the banner should communicate, then we hand the visual prompt
// to the image model. Overlay text is returned separately (image models are
// bad at text), so the client gets copy to place on top.
export interface ImageBrief {
  concept: string;       // що показуємо і чому (людською мовою)
  image_prompt: string;  // англомовний промпт для image-моделі, БЕЗ тексту в кадрі
  overlay_text: string;  // короткий текст, який варто накласти поверх
  why: string;           // чому цей візуал спрацює під ціль
}

export function generateImageBrief(
  profileCtx: string,
  strategy: unknown,
  label: string,
): Promise<ImageBrief> {
  const system =
    'Ти — арт-директор і маркетолог. Придумай рекламний банер/зображення під стратегію кампанії. ' +
    'Спочатку РІШЕННЯ: що саме показати, щоб влучити в аудиторію та оффер. ' +
    'image_prompt — англійською, фотореалістичний або стильний, детальний, і ОБОВ’ЯЗКОВО "no text, no words, no letters" ' +
    '(текст поверх додасть клієнт). overlay_text — 3-7 слів мовою бізнесу. ' +
    LANG_RULE +
    ' Схема JSON: {"concept": string, "image_prompt": string, "overlay_text": string, "why": string}.';
  const user =
    `Бізнес:\n${profileCtx}\n\nСтратегія:\n${JSON.stringify(strategy)}\n\nМатеріал: ${label}. Зроби бриф на зображення.`;
  return jsonCall<ImageBrief>(system, user, 1200);
}

// ── Campaign → calendar schedule (the Launch step of the cycle) ───────────────
// Octo decides WHEN each ready material should go out and why — order,
// weekday, time — based on the strategy and platform habits. The client gets
// a ready week, not a pile of files.
export interface CampaignSchedule {
  summary: string;   // 1-2 речення: логіка розкладу
  schedule: Array<{
    material_index: number;  // індекс у переданому списку матеріалів
    day_offset: number;      // 1 = завтра, 2 = післязавтра... (максимум 10)
    time: string;            // "HH:MM" за місцевим часом аудиторії
    note: string;            // коротка примітка для календаря
    why: string;             // чому цей матеріал саме в цей день/час
  }>;
}

export function scheduleCampaign(
  profileCtx: string,
  strategy: unknown,
  materials: Array<{ index: number; type: string; title: string }>,
): Promise<CampaignSchedule> {
  const system =
    'Ти — SMM-стратег. Тобі дають готові матеріали кампанії. Розклади їх по днях на найближчий тиждень ' +
    '(day_offset: 1-7, де 1 — завтра): що виходить першим і чому, у який день тижня і час такий контент ' +
    'працює найкраще (враховуй тип: Stories щодня вдень, продажні пости в пік, Reels увечері/вихідні). ' +
    'Кожен матеріал — рівно один раз. time у форматі "HH:MM". ' +
    LANG_RULE +
    ' Схема JSON: {"summary":str,"schedule":[{"material_index":num,"day_offset":num,"time":"HH:MM","note":str,"why":str}]}.';
  const user =
    `Бізнес:\n${profileCtx}\n\nСтратегія:\n${JSON.stringify(strategy)}\n\n` +
    `Матеріали:\n${JSON.stringify(materials)}\n\nРозклади їх.`;
  return jsonCall<CampaignSchedule>(system, user, 1500);
}

// ── Material editing via dialog (Rule 3: no manual editors — words only) ──────
// Takes the CURRENT material JSON + the client's instruction, returns the same
// JSON shape with revised content. Shape-preserving so any material type works.
export function editMaterial(
  profileCtx: string,
  material: unknown,
  instruction: string,
  label?: string,
): Promise<Record<string, unknown>> {
  const system =
    'Ти — маркетолог-редактор. Клієнт дає готовий матеріал (JSON) і побажання, що змінити. ' +
    'Переріб ВМІСТ матеріалу згідно з побажанням, але поверни JSON ТОЧНО тієї ж структури ' +
    '(ті самі ключі й типи, та сама кількість полів верхнього рівня; масиви можуть змінити довжину, якщо це логічно). ' +
    'Не додавай нових ключів, не коментуй. ' +
    LANG_RULE;
  const user =
    `Бізнес:\n${profileCtx}\n\n` +
    (label ? `Матеріал: ${label}\n` : '') +
    `Поточний матеріал (JSON):\n${JSON.stringify(material)}\n\n` +
    `Побажання клієнта: ${instruction}\n\nПоверни оновлений JSON.`;
  return jsonCall<Record<string, unknown>>(system, user, 3000);
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
