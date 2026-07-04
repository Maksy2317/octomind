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
const ACTOR = 'clockworks~tiktok-scraper';
const CACHE_TTL_MS = Number(process.env.TRENDS_CACHE_TTL_HOURS || 12) * 3_600_000;
const RESULTS_PER_QUERY = Number(process.env.TRENDS_RESULTS_PER_QUERY || 25);

export function isTrendsConfigured(): boolean {
  return Boolean(APIFY_TOKEN);
}

export interface TrendVideo {
  id: string;
  platform: 'tiktok';
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
    if (raw && Array.isArray(raw.videos)) return raw;
  } catch { /* miss */ }
  return null;
}

function writeCache(key: string, videos: TrendVideo[]): void {
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

/**
 * Fetch the trend feed for a search query (niche keywords). Cached on disk.
 * `force` bypasses the cache (used by an explicit refresh, rate-limit upstream).
 */
export async function getTrendFeed(query: string, force = false): Promise<{
  videos: TrendVideo[];
  fetchedAt: number;
  fromCache: boolean;
}> {
  const key = `tiktok:${query.trim().toLowerCase()}`;
  if (!force) {
    const hit = readCache(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return { videos: hit.videos, fetchedAt: hit.fetchedAt, fromCache: true };
    }
  }

  const input = {
    searchQueries: [query],
    resultsPerPage: RESULTS_PER_QUERY,
    searchSection: '/video',
    maxProfilesPerQuery: 1,
  };
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=150`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // A stale cache beats a hard failure — serve it if we have one.
    const stale = readCache(key);
    if (stale) {
      console.warn(`[Trends] Apify ${res.status}, serving stale cache:`, body.slice(0, 150));
      return { videos: stale.videos, fetchedAt: stale.fetchedAt, fromCache: true };
    }
    throw new Error(`Apify ${res.status}: ${body.slice(0, 200)}`);
  }
  const items = (await res.json()) as Array<Record<string, any>>;
  const videos = (Array.isArray(items) ? items : [])
    .map(normalize)
    .filter((v): v is TrendVideo => Boolean(v))
    .sort((a, b) => b.views - a.views);
  writeCache(key, videos);
  return { videos, fetchedAt: Date.now(), fromCache: false };
}
