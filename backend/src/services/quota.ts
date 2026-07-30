// Server-side tariff limits.
//
// The client's localStorage counters are display-only and trivially bypassed.
// This is the source of truth: every metered action is checked here before the
// expensive AI work runs, and recorded on success. Counts come from the
// `usage_events` table for the current period (calendar day or month).
//
// Fail-open by design: if the DB isn't configured or a count query fails, the
// action is allowed. Enforcement is a cost guardrail, not a security boundary —
// never break the product because Supabase hiccuped.

import { isDbConfigured } from './db/client';
import { getUserPlan, countUsageSince, recordUsageEvent } from './db/repos';
import { Plan } from './db/models';
import { isLive } from './payments/wayforpay';

export type Feature =
  | 'campaign' | 'content_plan' | 'post_tools' | 'image' | 'chat'
  | 'trend_feed' | 'analysis' | 'research' | 'brand' | 'skill';

type Period = 'day' | 'month';
type Rule = { n: number; per: Period } | null; // null = unlimited

// Ліміти дзеркалять екран «Тарифи». `null` = без ліміту на цьому тарифі.
//
// Принцип: ЩЕДРО на текст, ЖОРСТКО на дороге. Текстова генерація на Gemini
// Flash коштує копійки, а от Apify-розбір сторінки $0.03-0.12, зображення
// (Stability) $0.03, дослідження з web-пошуком $0.07. Тому саме ці три
// стримують безкоштовний тариф, а не «аха-моменти».
//
// Раніше тут було чотири дефекти, через які вмикати енфорсмент було шкідливо:
//  1. Контент-план ділив кредит із кампанією (free 1/міс), тож безкоштовний
//     користувач мав ОДИН на вибір — або кампанія, або план. Для трафіку з
//     реклами це вбивало тріал: людина не доходила до головного циклу.
//  2. `analysis` був інвертований: free 1/ДЕНЬ (~30/міс) проти pro 10/міс —
//     платник отримував утричі МЕНШЕ за безкоштовного.
//  3. Той самий `analysis` накривав і дорогий Apify-розбір, і копійчані
//     «покращити пост» та «мій стиль», тож дешеве було затиснуте як дороге.
//  4. Через це ж free-розбір сторінки 1/день = до $3.60/міс на КОЖНОГО
//     безкоштовного користувача. Тепер найгірший випадок Free ≈ $0.50/міс.
const LIMITS: Record<Feature, Record<Plan, Rule>> = {
  // ціль → стратегія → матеріали (одна кампанія = один зачот)
  campaign:    { free: { n: 1,  per: 'month' }, pro: { n: 10, per: 'month' }, business: { n: 30,  per: 'month' } },
  // тижневий план знімальних брифів — окремий лічильник, НЕ кредит кампанії
  content_plan:{ free: { n: 2,  per: 'month' }, pro: { n: 30, per: 'month' }, business: null },
  // «покращити пост» + «мій стиль»: чиста текстова генерація, майже безкоштовна
  post_tools:  { free: { n: 5,  per: 'month' }, pro: null,                    business: null },
  // будь-яка AI-генерація зображення (реклама товару / банер)
  image:       { free: { n: 3,  per: 'month' }, pro: { n: 30, per: 'month' }, business: { n: 100, per: 'month' } },
  // Ask Octo
  chat:        { free: { n: 10, per: 'month' }, pro: null,                    business: null },
  // стрічка трендів (скрейп, але кеш спільний на всіх користувачів per ніша)
  trend_feed:  { free: { n: 3,  per: 'day'   }, pro: null,                    business: null },
  // розбір своєї сторінки (@нік → Apify) — найдорожча дія на юзера
  analysis:    { free: { n: 1,  per: 'month' }, pro: { n: 20, per: 'month' }, business: null },
  // дослідження ринку (web-search)
  research:    { free: { n: 1,  per: 'month' }, pro: { n: 20, per: 'month' }, business: null },
  // бренд-кіт
  brand:       { free: { n: 1,  per: 'month' }, pro: null,                    business: null },
  // «Команда Octo» — один скіл-фахівець (легка текстова генерація)
  skill:       { free: { n: 3,  per: 'month' }, pro: null,                    business: null },
};

function periodStartIso(per: Period): string {
  const d = new Date();
  if (per === 'day') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export interface QuotaStatus {
  feature: Feature;
  plan: Plan;
  allowed: boolean;
  unlimited: boolean;
  limit: number;   // -1 for unlimited
  used: number;
  remaining: number; // Infinity-safe: large number for unlimited
  per: Period | null;
}

/** Check whether `userId` may perform `feature` right now (does NOT record). */
export async function checkQuota(userId: string, feature: Feature): Promise<QuotaStatus> {
  const plan = await getUserPlan(userId).catch(() => 'free' as Plan);
  const rule = LIMITS[feature][plan];
  if (!rule) {
    return { feature, plan, allowed: true, unlimited: true, limit: -1, used: 0, remaining: 1e9, per: null };
  }
  let used = 0;
  try {
    used = await countUsageSince(userId, feature, periodStartIso(rule.per));
  } catch {
    // Fail-open: can't count → allow, treat as 0 used.
    return { feature, plan, allowed: true, unlimited: false, limit: rule.n, used: 0, remaining: rule.n, per: rule.per };
  }
  const remaining = Math.max(0, rule.n - used);
  return { feature, plan, allowed: used < rule.n, unlimited: false, limit: rule.n, used, remaining, per: rule.per };
}

/** Record one successful metered action (best-effort — never throws). */
export async function recordUsage(userId: string, feature: Feature): Promise<void> {
  try {
    await recordUsageEvent(userId, feature);
  } catch (err) {
    console.warn('[Quota] failed to record usage', feature, (err as Error).message?.slice(0, 120));
  }
}

/** Full usage snapshot for the client (badges + upgrade prompts). */
export async function usageSnapshot(userId: string): Promise<{ plan: Plan; features: Record<Feature, QuotaStatus> }> {
  const plan = await getUserPlan(userId).catch(() => 'free' as Plan);
  const features = {} as Record<Feature, QuotaStatus>;
  await Promise.all((Object.keys(LIMITS) as Feature[]).map(async (f) => {
    features[f] = await checkQuota(userId, f);
  }));
  return { plan, features };
}

export function quotaEnforced(): boolean {
  // Only enforce plan limits once REAL billing is live — never block a user who
  // can't yet pay. Sandbox / no WayForPay keys → everything is free.
  // Override with QUOTA_ENFORCE=1 to force-on for testing.
  if (process.env.QUOTA_ENFORCE === '1') return isDbConfigured();
  if (process.env.QUOTA_ENFORCE === '0') return false;
  return isDbConfigured() && isLive();
}
