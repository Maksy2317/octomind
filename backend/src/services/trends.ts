// Trend feed data source — viral TikTok videos via Apify (clockworks/tiktok-scraper).
//
// Architecture note (the "hybrid"): the routes only ever see getTrendFeed() and
// its normalized TrendVideo shape. Swapping/adding providers (Instagram actor,
// another vendor) changes THIS file only — the UI and routes stay put.
//
// Cost control: results are cached on disk per query for CACHE_TTL_MS, so one
// niche costs one Apify run per half-day no matter how many users browse it.
// The cache lives under uploads/output/trends/ — the hourly cleanup sweep skips
// subdirectories, so cached feeds survive it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
// TikTok search actor is switchable without a deploy: TRENDS_ACTOR=apidojo on
// Railway flips to the ~30x cheaper actor ($0.30/1000 vs ~$10/1000 measured).
// Default stays clockworks (battle-tested) until the August live-data check.
const USE_APIDOJO = process.env.TRENDS_ACTOR === 'apidojo';
const ACTOR = 'clockworks~tiktok-scraper';
const APIDOJO_ACTOR = 'apidojo~tiktok-scraper';
// Instagram source (official actor, ~$1.90/1000): built from documented output
// schema, NOT yet run against live data (credits exhausted) — enable with
// TRENDS_IG_ENABLED=1 after a real-data field check in August.
const IG_ACTOR = 'apify~instagram-hashtag-scraper';

export function isInstagramEnabled(): boolean {
  return process.env.TRENDS_IG_ENABLED === '1';
}
const CACHE_TTL_MS = Number(process.env.TRENDS_CACHE_TTL_HOURS || 12) * 3_600_000;
const RESULTS_PER_QUERY = Number(process.env.TRENDS_RESULTS_PER_QUERY || 25);

export function isTrendsConfigured(): boolean {
  return Boolean(APIFY_TOKEN);
}

// ── Чесні збої джерела даних ─────────────────────────────────────────────────
// Apify відповідає сирим JSON у тілі: {"error":{"type":"monthly-usage-hard-
// limit-exceeded",...}}. Раніше цей рядок ішов прямо в throw і доїжджав до
// користувача як «Apify 403: {"error":…}» — людина бачила наш внутрішній збій
// замість зрозумілого речення. Тепер кожен збій класифікується ТУТ: назовні йде
// статус, код і людський текст, а сире тіло лишається в логах.
export interface SourceFailure extends Error {
  status: number;
  code: 'trends_source_out' | 'trends_source_down' | 'trends_busy';
  expose: true;      // errorHandler віддає це повідомлення як є
  retryable: boolean;
}

function failure(status: number, code: SourceFailure['code'], message: string, retryable: boolean): SourceFailure {
  const e = new Error(message) as SourceFailure;
  e.status = status;
  e.code = code;
  e.expose = true;
  e.retryable = retryable;
  return e;
}

// Коли кредити скінчились, кожен наступний запит все одно чекав ~150 с таймауту
// актора, щоб отримати те саме 403. Запобіжник: пів години відповідаємо одразу —
// користувач не сидить над спінером заради гарантованого провалу, і його квота
// на цю дію не списується (meter рахує лише 2xx).
const OUT_COOLDOWN_MS = 30 * 60_000;
let sourceOutUntil = 0;

// Окремий запобіжник саме на дешевий актор: він може бути живим (HTTP 200), але
// віддавати самі {noResults:true}. Це не збій акаунта, тому sourceOutUntil тут
// не годиться — вимикати треба лише цього постачальника, а не всю стрічку.
const APIDOJO_DUD_MS = 6 * 3_600_000;
let apidojoDudUntil = 0;

function isApidojoDud(): boolean {
  return Date.now() < apidojoDudUntil;
}

export function sourceOut(): SourceFailure {
  return failure(503, 'trends_source_out',
    'Свіжа добірка роликів зараз недоступна — оновлюємо джерело даних. Заглянь трохи пізніше, все повернеться.', false);
}

/** Знаємо, що джерело мертве — не витрачаємо 150 с на гарантований провал. */
export function isSourceCoolingDown(): boolean {
  return Date.now() < sourceOutUntil;
}

/** Розкласти збій Apify на щось, що можна показати людині. */
function apifyFailure(status: number, body: string): SourceFailure {
  const raw = body.slice(0, 300);
  // Кредити / ліміт акаунта: це НАШ рахунок, а не помилка користувача. Тому не
  // пропонуємо «спробуй ще раз» — повторний клік нічого не змінить.
  if (status === 402 || /hard.?limit|usage.*exceed|monthly|not enough|insufficient|credit|payment|feature-disabled/i.test(raw)) {
    sourceOutUntil = Date.now() + OUT_COOLDOWN_MS;
    console.error(`[Trends] ДЖЕРЕЛО ВИЧЕРПАНО (Apify ${status}) — треба поповнити кредити:`, raw);
    return sourceOut();
  }
  if (status === 401 || status === 403) {
    sourceOutUntil = Date.now() + OUT_COOLDOWN_MS;
    console.error(`[Trends] Apify відмовив у доступі (${status}) — перевір APIFY_TOKEN:`, raw);
    return sourceOut();
  }
  if (status === 429) {
    console.warn('[Trends] Apify 429 (rate limit):', raw);
    return failure(429, 'trends_busy', 'Джерело даних зараз перевантажене. Спробуй за хвилину.', true);
  }
  // 404 тут = не знайдено АКТОРА (немає профілю → 200 з порожнім списком), тобто
  // наша помилка конфігурації, а не чужий нік. Не радимо «перевір нік».
  console.error(`[Trends] Apify ${status}:`, raw);
  return failure(502, 'trends_source_down',
    'Не вдалось дотягнутись до TikTok. Спробуй ще раз за пару хвилин.', true);
}

export interface TrendVideo {
  id: string;
  platform: 'tiktok' | 'instagram';
  url: string;            // canonical watch URL
  text: string;           // caption
  lang: string | null;    // textLanguage from TikTok
  views: number;
  likes: number;
  comments: number;
  shares: number;
  created: string | null; // ISO date
  duration: number | null;// seconds
  author: string | null;  // @handle
  author_name: string | null;
  cover: string | null;   // thumbnail URL (TikTok CDN, short-lived)
  hashtags: string[];
}

function cacheDir(): string {
  const outputDir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.resolve(process.cwd(), 'uploads/output');
  const dir = path.join(outputDir, 'trends');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return path.join(cacheDir(), `feed_${hash}.json`);
}

function readCache(key: string): { fetchedAt: number; videos: TrendVideo[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    // ПОРОЖНІЙ кеш — це не дані, а слід невдалого скрейпу. Раніше він повертався
    // як валідний хіт, і стрічка 12 годин мовчки показувала порожній екран:
    // сервер віддавав HTTP 200 + videos:[] + fromCache:true, тобто «успіх, але
    // нічого немає». Для користувача це виглядало як «пошук не працює».
    if (raw && Array.isArray(raw.videos) && raw.videos.length > 0) return raw;
  } catch { /* miss */ }
  return null;
}

function writeCache(key: string, videos: TrendVideo[]): void {
  // Не зберігаємо порожнечу: інакше один невдалий скрейп отруює кеш на 12 годин
  // для ВСІХ, хто шукає ту саму нішу.
  if (!videos.length) return;
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify({ fetchedAt: Date.now(), videos }));
  } catch (e) {
    console.warn('[Trends] Cache write failed:', (e as Error).message);
  }
}

/** Normalize a raw scraper item into our stable shape. */
function normalize(v: Record<string, any>): TrendVideo | null {
  const id = String(v.id || '');
  const url = String(v.webVideoUrl || '');
  if (!id || !url) return null;
  const meta = v.videoMeta || {};
  const author = v.authorMeta || {};
  return {
    id,
    platform: 'tiktok',
    url,
    text: String(v.text || ''),
    lang: v.textLanguage ? String(v.textLanguage) : null,
    views: Number(v.playCount) || 0,
    likes: Number(v.diggCount) || 0,
    comments: Number(v.commentCount) || 0,
    shares: Number(v.shareCount) || 0,
    created: v.createTimeISO ? String(v.createTimeISO) : null,
    duration: meta.duration != null ? Number(meta.duration) : null,
    author: author.name ? String(author.name) : null,
    author_name: author.nickName ? String(author.nickName) : null,
    cover: meta.coverUrl ? String(meta.coverUrl) : null,
    hashtags: Array.isArray(v.hashtags)
      ? v.hashtags.map((h: any) => String(h?.name || '')).filter(Boolean).slice(0, 8)
      : [],
  };
}

// ── Tiny generic KV cache (same dir) ─────────────────────────────────────────
// Used to pin the AI-expanded search queries for 24h: Claude's output varies
// run-to-run, and every new query set = new cache key = a fresh PAID scrape.
// Pinning the expansion keeps cache keys stable and the Apify bill flat.
export function kvGet<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath('kv:' + key), 'utf8'));
    if (raw && Date.now() - raw.fetchedAt < maxAgeMs) return raw.value as T;
  } catch { /* miss */ }
  return null;
}

export function kvSet(key: string, value: unknown): void {
  try {
    fs.writeFileSync(cachePath('kv:' + key), JSON.stringify({ fetchedAt: Date.now(), value }));
  } catch (e) {
    console.warn('[Trends] KV write failed:', (e as Error).message);
  }
}

/** Author stats extracted from the profile scrape (for the page audit). */
export interface PageAuthor {
  handle: string;
  name: string | null;
  followers: number;
  total_likes: number;
  bio: string | null;
}

/**
 * Fetch a TikTok profile's latest videos (the user's OWN page) for the
 * content audit. Same actor, `profiles` input instead of search. Cached.
 */
export async function getProfileVideos(handle: string, force = false): Promise<{
  videos: TrendVideo[];
  author: PageAuthor | null;
  fetchedAt: number;
  fromCache: boolean;
}> {
  const clean = handle.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '').split(/[/?]/)[0];
  if (!clean) throw new Error('Порожній нік');
  const key = `tiktok-profile:${clean.toLowerCase()}`;
  if (!force) {
    const hit = readCache(key) as any;
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return { videos: hit.videos, author: hit.author ?? null, fetchedAt: hit.fetchedAt, fromCache: true };
    }
  }

  // Джерело в даунтаймі — краще старий кеш або одразу чесна відмова.
  if (isSourceCoolingDown()) {
    const stale = readCache(key) as any;
    if (stale) return { videos: stale.videos, author: stale.author ?? null, fetchedAt: stale.fetchedAt, fromCache: true };
    throw sourceOut();
  }

  const input = { profiles: [clean], resultsPerPage: 20, profileSorting: 'latest' };
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=150`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const stale = readCache(key) as any;
    if (stale) return { videos: stale.videos, author: stale.author ?? null, fetchedAt: stale.fetchedAt, fromCache: true };
    throw apifyFailure(res.status, body);
  }
  const items = (await res.json()) as Array<Record<string, any>>;
  const videos = (Array.isArray(items) ? items : [])
    .map(normalize)
    .filter((v): v is TrendVideo => Boolean(v))
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  const am = (Array.isArray(items) && items[0]?.authorMeta) || {};
  const author: PageAuthor | null = videos.length ? {
    handle: clean,
    name: am.nickName ? String(am.nickName) : null,
    followers: Number(am.fans) || 0,
    total_likes: Number(am.heart) || 0,
    bio: am.signature ? String(am.signature).slice(0, 300) : null,
  } : null;
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify({ fetchedAt: Date.now(), videos, author }));
  } catch { /* non-fatal */ }
  return { videos, author, fetchedAt: Date.now(), fromCache: false };
}

/** Normalize an apidojo/tiktok-scraper item (documented output schema). */
function normalizeApidojo(v: Record<string, any>): TrendVideo | null {
  const id = String(v.id || '');
  const url = String(v.postPage || '');
  if (!id || !url) return null;
  const vid = v.video || {};
  const ch = v.channel || {};
  return {
    id,
    platform: 'tiktok',
    url,
    text: String(v.title || ''),
    lang: null,
    views: Number(v.views) || 0,
    likes: Number(v.likes) || 0,
    comments: Number(v.comments) || 0,
    shares: Number(v.shares) || 0,
    created: v.uploadedAtFormatted ? String(v.uploadedAtFormatted) : null,
    duration: vid.duration != null ? Math.round(Number(vid.duration)) : null,
    author: ch.username ? String(ch.username) : null,
    author_name: ch.name ? String(ch.name) : null,
    cover: vid.cover ? String(vid.cover) : null,
    hashtags: [],
  };
}

/** Normalize an Instagram hashtag-scraper item (documented output schema). */
function normalizeIG(v: Record<string, any>): TrendVideo | null {
  const id = String(v.id || v.shortCode || '');
  const url = String(v.url || '');
  if (!id || !url) return null;
  return {
    id,
    platform: 'instagram',
    url,
    text: String(v.caption || ''),
    lang: null,
    views: Number(v.videoPlayCount) || Number(v.videoViewCount) || 0,
    likes: Math.max(0, Number(v.likesCount) || 0),   // -1 means hidden
    comments: Number(v.commentsCount) || 0,
    shares: 0,                                        // IG не віддає шери
    created: v.timestamp ? String(v.timestamp) : null,
    duration: v.videoDuration != null ? Math.round(Number(v.videoDuration)) : null,
    author: v.ownerUsername ? String(v.ownerUsername) : null,
    author_name: v.ownerFullName ? String(v.ownerFullName) : null,
    cover: v.displayUrl ? String(v.displayUrl) : null,
    hashtags: Array.isArray(v.hashtags) ? v.hashtags.map(String).slice(0, 8) : [],
  };
}

// ── Один крок скрейпу ────────────────────────────────────────────────────────
// Кожен постачальник — свій актор, свій формат вводу і свій нормалізатор. Три
// різні `USE_APIDOJO ? … : …` в одному тілі функції раніше легко розʼїжджались
// між собою (актор один, а нормалізатор інший — і на виході тиша). Тепер вибір
// робиться один раз, за назвою кроку.
type ScrapeStep = 'apidojo' | 'clockworks' | 'instagram';

function stepActor(step: ScrapeStep): string {
  if (step === 'instagram') return IG_ACTOR;
  return step === 'apidojo' ? APIDOJO_ACTOR : ACTOR;
}

function stepInput(step: ScrapeStep, list: string[], perQuery: number): Record<string, unknown> {
  if (step === 'instagram') {
    return {
      hashtags: list.map((q) => q.replace(/^#/, '').replace(/\s+/g, '')),
      resultsType: 'reels',
      resultsLimit: perQuery,
    };
  }
  if (step === 'apidojo') {
    return { keywords: list, maxItems: perQuery * list.length, sortType: 'RELEVANCE' };
  }
  return {
    searchQueries: list,
    // Keep total volume (and cost) roughly constant however many queries run.
    resultsPerPage: perQuery,
    searchSection: '/video',
    maxProfilesPerQuery: 1,
  };
}

/** Один запуск актора → нормалізовані ролики. Порожній масив = актор не знайшов. */
async function scrapeWith(step: ScrapeStep, list: string[], perQuery: number): Promise<TrendVideo[]> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${stepActor(step)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=150`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stepInput(step, list, perQuery)),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw apifyFailure(res.status, body);
  }
  const items = (await res.json()) as Array<Record<string, any>>;
  const normalizer = step === 'instagram' ? normalizeIG : (step === 'apidojo' ? normalizeApidojo : normalize);
  const seen = new Set<string>();
  return (Array.isArray(items) ? items : [])
    .map(normalizer)
    .filter((v): v is TrendVideo => Boolean(v))
    // several queries can surface the same video — dedup by id
    .filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
    .sort((a, b) => b.views - a.views);
}

/**
 * Fetch the trend feed for one or more search queries (the scraper accepts
 * several natively — one run, one bill). Cached on disk per platform+query-set.
 * `force` bypasses the cache (used by an explicit refresh, rate-limit upstream).
 */
export async function getTrendFeed(
  queries: string | string[],
  force = false,
  platform: 'tiktok' | 'instagram' = 'tiktok',
): Promise<{
  videos: TrendVideo[];
  fetchedAt: number;
  fromCache: boolean;
}> {
  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!list.length) throw new Error('No search queries');
  const key = `${platform}:${list.map((q) => q.toLowerCase()).sort().join('|')}`;
  if (!force) {
    const hit = readCache(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return { videos: hit.videos, fetchedAt: hit.fetchedAt, fromCache: true };
    }
  }

  // Джерело в даунтаймі — віддаємо навіть протермінований кеш, а якщо його немає,
  // чесно відмовляємо одразу, замість 150 с очікування того самого 403.
  if (isSourceCoolingDown()) {
    const stale = readCache(key);
    if (stale) return { videos: stale.videos, fetchedAt: stale.fetchedAt, fromCache: true };
    throw sourceOut();
  }

  const perQuery = Math.max(10, Math.ceil(RESULTS_PER_QUERY / list.length));

  // Порядок спроб. apidojo у ~30 разів дешевший, але його пошук періодично
  // повертає самі {noResults:true} — перевірено на живих даних 13.08.2026: нуль
  // реальних роликів і українською, і англійською, у всіх режимах сортування,
  // з location і без. Тому дешевий актор більше НЕ єдиний: якщо він порожній,
  // одразу добираємо перевіреним clockworks. Людина отримує стрічку, а не
  // чесну відмову через збій постачальника, про якого вона не знає.
  const plan: ScrapeStep[] = platform === 'instagram'
    ? ['instagram']
    : (USE_APIDOJO && !isApidojoDud() ? ['apidojo', 'clockworks'] : ['clockworks']);

  let videos: TrendVideo[] = [];
  let lastErr: SourceFailure | null = null;
  for (const step of plan) {
    try {
      videos = await scrapeWith(step, list, perQuery);
    } catch (e) {
      lastErr = e as SourceFailure;
      videos = [];
      // Вичерпані кредити / поганий токен — це рівень АКАУНТА, а не актора.
      // Наступний актор упреться в те саме, тож не витрачаємо на нього час.
      if (lastErr?.code === 'trends_source_out') break;
    }
    if (videos.length) break;
    if (step === 'apidojo') {
      // Дешевий актор зараз пустий — наступні 6 годин ідемо одразу в робочий,
      // не палячи час користувача на гарантований нуль. Через 6 год спробуємо
      // знову: коли він оживе, ціна сама повернеться до $0.30/1000.
      apidojoDudUntil = Date.now() + APIDOJO_DUD_MS;
      console.error('[Trends] apidojo віддав 0 роликів — перемикаюсь на clockworks на 6 год');
    }
  }

  if (!videos.length) {
    // Протермінований кеш кращий за відмову — краще вчорашня добірка, ніж порожній екран.
    const stale = readCache(key);
    if (stale) {
      console.warn('[Trends] живий скрейп не вдався — віддаю протермінований кеш');
      return { videos: stale.videos, fetchedAt: stale.fetchedAt, fromCache: true };
    }
    if (lastErr) throw lastErr;
    // Нуль роликів після ЖИВОГО скрейпу — це не «нічого не знайшлось», а збій:
    // пошук TikTok по реальній ніші порожнім не буває. Раніше цей нуль ішов у
    // клієнт як успіх, і людина бачила порожній екран без жодного пояснення —
    // саме це виглядало як «пошук не працює».
    console.error('[Trends] жоден актор не повернув роликів');
    throw failure(503, 'trends_source_down',
      'Не вдалось зібрати ролики. Джерело даних зараз не віддає результатів — спробуй трохи пізніше.', true);
  }

  writeCache(key, videos);
  return { videos, fetchedAt: Date.now(), fromCache: false };
}
