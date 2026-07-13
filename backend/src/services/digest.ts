// Weekly digest: "твій план на тиждень" straight to the inbox.
//
// Every Monday morning each signed-up user whose content plan has posts in the
// coming 7 days gets one email listing them by day, with a link back into the
// app. No plan → no email (never spam an empty digest).
//
// Data flow: Supabase auth admin API lists users (service key), user_data rows
// keyed planner_<ws> hold each user's schedule (the same JSON the client syncs).

import { sendEmail, emailConfigured } from './email';

interface PlannerPost {
  date?: string;   // YYYY-MM-DD
  time?: string;
  idea?: string;
  status?: string;
  contentType?: string;
}

interface DigestCandidate {
  email: string;
  posts: Array<PlannerPost & { date: string }>;
}

const DOW = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function sb(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  return url && key ? { url, key } : null;
}

/** Collect users + their upcoming (7d, not-yet-posted) planner posts. */
export async function collectDigestCandidates(): Promise<DigestCandidate[]> {
  const cfg = sb();
  if (!cfg) return [];

  // 1. All signed-up users (needs the service key — admin API).
  const uRes = await fetch(`${cfg.url}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!uRes.ok) throw new Error(`auth admin ${uRes.status}: ${(await uRes.text()).slice(0, 160)}`);
  const uData = (await uRes.json()) as { users?: Array<{ id: string; email?: string }> };
  const users = (uData.users || []).filter((u) => u.email);

  // 2. Everyone's planner rows in one query.
  const dRes = await fetch(
    `${cfg.url}/rest/v1/user_data?select=user_id,key,value&key=like.planner_*&limit=5000`,
    { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
  );
  if (!dRes.ok) throw new Error(`user_data ${dRes.status}: ${(await dRes.text()).slice(0, 160)}`);
  const rows = (await dRes.json()) as Array<{ user_id: string; key: string; value: unknown }>;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const until = new Date(today); until.setDate(today.getDate() + 7);
  const isoOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromIso = isoOf(today);
  const toIso = isoOf(until);

  const byUser = new Map<string, DigestCandidate['posts']>();
  for (const row of rows) {
    if (!Array.isArray(row.value)) continue;
    const upcoming = (row.value as PlannerPost[])
      .filter((p) => p && typeof p.date === 'string' && p.date >= fromIso && p.date < toIso && p.status !== 'posted')
      .map((p) => ({ ...p, date: p.date as string }));
    if (!upcoming.length) continue;
    const list = byUser.get(row.user_id) || [];
    byUser.set(row.user_id, list.concat(upcoming));
  }

  const out: DigestCandidate[] = [];
  for (const u of users) {
    const posts = byUser.get(u.id);
    if (!posts?.length) continue;
    posts.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    out.push({ email: u.email as string, posts });
  }
  return out;
}

export function digestHtml(posts: DigestCandidate['posts']): string {
  const base = (process.env.PUBLIC_URL || 'https://octomind.win').replace(/\/$/, '');
  const rows = posts.slice(0, 20).map((p) => {
    const d = new Date(p.date + 'T00:00:00');
    const day = `${DOW[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `<tr>
      <td style="padding:8px 12px;color:#8b7bff;font-weight:700;white-space:nowrap;">${day}</td>
      <td style="padding:8px 12px;color:#555;white-space:nowrap;">${p.time || ''}</td>
      <td style="padding:8px 12px;color:#1a1a2e;">${String(p.idea || 'Публікація').slice(0, 80)}</td>
    </tr>`;
  }).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <h2 style="color:#1a1a2e;margin:0 0 4px;">🐙 Твій контент-тиждень</h2>
    <p style="color:#555;margin:0 0 16px;">Octo нагадує: ось що заплановано на найближчі 7 днів.</p>
    <table style="border-collapse:collapse;width:100%;background:#f7f7fc;border-radius:12px;overflow:hidden;">${rows}</table>
    <p style="margin:20px 0;">
      <a href="${base}/app?go=calendar&source=digest" style="display:inline-block;background:#6C63FF;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px;">Відкрити контент-план →</a>
    </p>
    <p style="color:#999;font-size:12px;">Публікуй за планом — і познач опубліковане в застосунку, щоб Octo бачив прогрес.</p>
  </div>`;
}

export interface DigestRunResult {
  candidates: number;
  sent: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
  previewHtml?: string;
}

/** Run the digest. dryRun=true collects and renders but sends nothing. */
export async function runWeeklyDigest(dryRun: boolean): Promise<DigestRunResult> {
  const res: DigestRunResult = { candidates: 0, sent: 0, skipped: 0, errors: [], dryRun };
  const candidates = await collectDigestCandidates();
  res.candidates = candidates.length;
  if (candidates.length) res.previewHtml = digestHtml(candidates[0].posts);
  if (dryRun) return res;
  if (!emailConfigured()) {
    res.errors.push('email not configured — set RESEND_API_KEY and EMAIL_FROM');
    return res;
  }
  for (const c of candidates) {
    try {
      await sendEmail(c.email, '🐙 Твій контент-план на тиждень — OctoMind', digestHtml(c.posts));
      res.sent++;
    } catch (e) {
      res.errors.push(`${c.email}: ${(e as Error).message.slice(0, 120)}`);
      res.skipped++;
    }
    await new Promise((ok) => setTimeout(ok, 600));   // be polite to Resend rate limits
  }
  return res;
}
