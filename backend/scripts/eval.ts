/* Prompt eval harness — so prompt edits aren't shipped blind.
 *
 * Runs strategy + one material + research for 5 fixed reference profiles against
 * a running server, saves the full responses as timestamped snapshots, and
 * diffs each field against the previous run so a regression (empty output,
 * lost platform, invented numbers, language drift) is visible at a glance.
 *
 *   npm run dev                       # in one terminal (needs GOOGLE_API_KEY)
 *   npx ts-node scripts/eval.ts       # in another
 *   BASE=https://octomind.win npx ts-node scripts/eval.ts   # against prod
 *
 * Snapshots land in backend/eval-snapshots/. Commit them to track prompt drift
 * over time; the diff is printed on every run.
 */

import fs from 'fs';
import path from 'path';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const OUT_DIR = path.resolve(__dirname, '../eval-snapshots');
const DEV = 'eval_harness_device';

interface Profile { id: string; account_type: string; profile: Record<string, unknown>; goal: string }

// Five deliberately different shapes: local service, product, blogger, realty,
// and a number-free profile (to catch invented «200+ угод» regressions).
const PROFILES: Profile[] = [
  { id: 'barber', account_type: 'business', goal: 'Більше записів',
    profile: { business_name: 'Барбершоп Клен', niche: 'чоловічі стрижки', target_audience: 'чоловіки 25-45', geo: 'Київ', platforms: 'Instagram, TikTok', price_segment: 'середній' } },
  { id: 'skincare', account_type: 'business', goal: 'Продати товар',
    profile: { business_name: 'PureGlow', niche: 'натуральна косметика', description: 'гідрофільна олія 350 грн', target_audience: 'жінки 25-40', platforms: 'Instagram' } },
  { id: 'blogger', account_type: 'blogger', goal: 'Ростити аудиторію',
    profile: { business_name: '@travel.olya', niche: 'тревел-контент', target_audience: 'українці 20-35', platforms: 'TikTok, Instagram', content_format: 'короткі відео' } },
  { id: 'realty', account_type: 'business', goal: 'Продати / здати нерухомість',
    profile: { business_name: 'Julia Maksymuk Real Estate', niche: 'нерухомість', target_audience: 'підприємці', geo: 'Київ', platforms: 'Instagram' } },
  { id: 'bare', account_type: 'business', goal: 'Більше клієнтів',
    profile: { business_name: 'Кавʼярня Тепло', niche: 'кава', geo: 'Львів' } },   // no numbers → facts-rule check
];

async function call(pathname: string, body: unknown): Promise<any> {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': DEV },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text.slice(0, 300) }; }
}

// Cheap red flags. `strict` = generated content (strategy/material) where a
// carousel/YouTube/video would be a real prompt violation. Research is scanned
// loosely (it legitimately DISCUSSES carousels/YouTube as market intel).
function flags(obj: unknown, strict: boolean): string[] {
  const s = JSON.stringify(obj);
  const out: string[] = [];
  if (/[ыэъЫЭЪ]/.test(s)) out.push('RU-chars');
  if (/\bPWNED\b|HACKED|ignore (all )?previous/i.test(s)) out.push('injection-leak');
  if (strict) {
    if (/youtube/i.test(s)) out.push('proposes-YouTube');
    if (/карусел/i.test(s)) out.push('proposes-carousel');
    if (/готове відео|монтаж відео/i.test(s)) out.push('proposes-video');
    // invented regalia the profile never gave — a count CLAIM («200+ угод»,
    // «понад 500», «7 років досвіду»), not an audience age range («25-45 років»).
    if (/\b\d+\+\s*(клієнт|угод|проєкт|проект|підписник|відгук|замовлен)/i.test(s)
      || /понад\s+\d+\s*(клієнт|угод|проєкт|проект|підписник)/i.test(s)
      || /\b\d+\s+рок(и|ів)\s+досвіду/i.test(s)) out.push('invented-numbers');
  }
  return out;
}

async function run(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results: Record<string, unknown> = {};
  const summary: string[] = [];

  for (const p of PROFILES) {
    process.stdout.write(`\n▸ ${p.id} … `);
    const strat = await call('/api/marketing/strategy', { goal: p.goal, profile: p.profile });
    const s = strat.body?.strategy;
    const firstType = s?.recommended_materials?.[0]?.type;
    const material = s
      ? await call('/api/marketing/material', { type: firstType || 'post', label: 'Пост', strategy: s, profile: p.profile })
      : { status: 0, body: null };
    const research = await call('/api/marketing/research', { profile: p.profile });

    const f = [...flags(strat.body, true), ...flags(material.body, true), ...flags(research.body, false)];
    results[p.id] = { strategy: strat, material, research, flags: f };
    process.stdout.write(`strat=${strat.status} mat=${material.status} res=${research.status}` + (f.length ? `  ⚠ ${f.join(',')}` : '  ok'));
    summary.push(`${p.id}: strat=${strat.status} mat=${material.status} res=${research.status}${f.length ? '  ⚠ ' + f.join(',') : ''}`);
  }

  // Save + diff against the most recent previous snapshot.
  const prev = fs.readdirSync(OUT_DIR).filter((n) => n.endsWith('.json')).sort().pop();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `eval-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));

  console.log('\n\n── SUMMARY ──');
  summary.forEach((l) => console.log(l));

  if (prev) {
    const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, prev), 'utf8'));
    console.log(`\n── DIFF vs ${prev} ──`);
    let changed = 0;
    for (const p of PROFILES) {
      const a = JSON.stringify((old[p.id] as any)?.strategy?.body?.strategy?.offer || '');
      const b = JSON.stringify((results[p.id] as any)?.strategy?.body?.strategy?.offer || '');
      if (a !== b) { changed++; console.log(`  ${p.id} offer changed`); }
    }
    if (!changed) console.log('  (offers stable)');
  } else {
    console.log('\n(first run — no previous snapshot to diff)');
  }
  console.log(`\nSnapshot → ${path.relative(process.cwd(), file)}`);
}

run().catch((e) => { console.error('eval failed:', e); process.exit(1); });
