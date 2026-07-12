import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { videoRouter } from './routes/video';
import { chatRouter } from './routes/chat';
import { subtitlesRouter } from './routes/subtitles';
import { carouselRouter } from './routes/carousel';
import { calendarRouter } from './routes/calendar';
import { pushRouter, sendPushToAll, fireScheduledReminders, loadSubscriptionsFromDB } from './routes/push';
import { profileRouter } from './routes/profile';
import { marketingRouter } from './routes/marketing';
import { trendsRouter } from './routes/trends';
import { adsRouter } from './routes/ads';
import { usageRouter } from './routes/usage';
import { adminRouter } from './routes/admin';
import { payRouter } from './routes/pay';
import { ensureBucket } from './services/storage';
import { errorHandler } from './middleware/errorHandler';
import { cleanupOldFiles } from './services/cleanup';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind Railway's proxy — needed for express-rate-limit to read the real client IP.
app.set('trust proxy', 1);

// Ensure output directory exists
const outputDir = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.resolve(process.cwd(), 'uploads/output');
fs.mkdirSync(outputDir, { recursive: true });

const uploadDirEarly = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadDirEarly, { recursive: true });

// ── Security headers ─────────────────────────────────────────────────────────
// crossOriginResourcePolicy is relaxed so the app can load served video files
// from /uploads and /output cross-origin.
//
// CSP: the frontend (web-demo.html, octomind-brain.html) is single-file HTML
// with inline <script> — helmet's default `script-src 'self'` blocks ALL of it
// (buttons dead, no JS runs). Allow inline scripts/handlers; keep the rest of
// the defaults. `upgrade-insecure-requests` is dropped so plain-http localhost
// dev isn't force-upgraded to https.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'font-src': ["'self'", 'https:', 'data:'],
      'form-action': ["'self'", 'https://secure.wayforpay.com'],
      'frame-ancestors': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:', 'data:'],
      'object-src': ["'none'"],
      // jsdelivr: TF.js/BodyPix are lazy-loaded from there on first photo-cutout
      // use (the eager tags this rule used to silently block are gone).
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", 'https:', "'unsafe-inline'"],
      'connect-src': ["'self'", 'https:'],
      // Trend feed embeds the official TikTok/Instagram players (iframes).
      'frame-src': ["'self'", 'https://www.tiktok.com', 'https://www.instagram.com'],
    },
  },
}));

// ── CORS: same-origin always allowed + ALLOWED_ORIGINS whitelist ─────────────
// The backend serves the frontend itself (web-demo.html и др.), so requests
// from the very host we're running on must always pass — locally AND on
// Railway, without listing every domain in env. The whitelist covers genuinely
// cross-origin clients (Expo dev server etc). Requests with no Origin (native
// apps, curl) also pass.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors<express.Request>((req, callback) => {
  const origin = req.header('Origin');
  const selfOrigin = `${req.protocol}://${req.get('host')}`;   // trust proxy → korrect https on Railway
  const allowed = !origin || origin === selfOrigin || allowedOrigins.includes(origin);
  if (!allowed) console.warn(`[CORS] Blocked origin: ${origin} (self: ${selfOrigin})`);
  callback(null, { origin: allowed, credentials: true });
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
// Protects the API (incl. paid AI endpoints) from abuse / accidental floods.
const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 min
  max: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
app.use('/api', apiLimiter);

// Body-size limit — configurable; large enough for base64 photos, capped to
// avoid memory-exhaustion via oversized JSON payloads.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '20mb';
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

// Serve processed videos
app.use('/output', express.static(path.resolve(outputDir)));

// Serve original uploads so the frontend can use the un-rendered video as a clean
// preview canvas (no baked-in ASS text). Files are UUID-named so enumeration is hard.
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadDir));

app.use('/api/video', videoRouter);
app.use('/api/chat', chatRouter);
app.use('/api/subtitles', subtitlesRouter);
app.use('/api/carousel', carouselRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/push', pushRouter);
app.use('/api/profile', profileRouter);
app.use('/api/marketing', marketingRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/ads', adsRouter);
app.use('/api/usage', usageRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pay', payRouter);

// Ensure the public Storage bucket exists so generated ad images persist across
// Railway redeploys (the disk is ephemeral). Idempotent, fail-open.
void ensureBucket();

// ── Seed the trends cache ─────────────────────────────────────────────────────
// Railway's filesystem is ephemeral: every deploy wipes uploads/, and with it
// the scraped trend feeds. Seed files (committed snapshots) restore the cache
// on boot, so cached niches keep working even with zero Apify credits — the
// scrape path 403s and getTrendFeed falls back to these as stale cache.
try {
  const seedDir = path.resolve(process.cwd(), 'seed/trends');
  const trendsDir = path.join(outputDir, 'trends');
  if (fs.existsSync(seedDir)) {
    fs.mkdirSync(trendsDir, { recursive: true });
    let copied = 0;
    for (const f of fs.readdirSync(seedDir)) {
      const dest = path.join(trendsDir, f);
      if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(seedDir, f), dest); copied++; }
    }
    if (copied) console.log(`[Seed] Trends cache seeded: ${copied} files`);
  }
} catch (e) {
  console.warn('[Seed] Trends seeding failed:', (e as Error).message);
}

// ── Per-post scheduled reminders (every minute) ──────────────────────────────
cron.schedule('* * * * *', async () => {
  try { await fireScheduledReminders(); } catch (e) { console.error('[CRON] fireScheduledReminders failed:', e); }
}, { timezone: 'UTC' });

// ── Daily reminder push (08:00 Kyiv time = 05:00 UTC) ────────────────────────
cron.schedule('0 5 * * *', async () => {
  const today = new Date();
  const dd = String(today.getUTCDate()).padStart(2, '0');
  const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
  console.log(`[CRON] Sending daily reminders for ${dd}.${mm}`);
  try {
    const result = await sendPushToAll({
      title: '🐙 OctoMind — публікації сьогодні',
      body: `Перевір контент-план на ${dd}.${mm} — є заплановані пости з нагадуванням!`,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      url: '/?screen=calendar',
      tag: 'daily-reminder',
    });
    console.log(`[CRON] Push result:`, result);
  } catch (e) {
    console.error('[CRON] Push failed:', e);
  }
}, { timezone: 'UTC' });

// ── Cleanup of stale uploads/outputs (older than 48h) ────────────────────────
const FILE_MAX_AGE_MS = Number(process.env.FILE_MAX_AGE_HOURS || 48) * 3_600_000;
function runCleanup() {
  try {
    cleanupOldFiles([uploadDirEarly, outputDir], FILE_MAX_AGE_MS);
  } catch (e) {
    // cleanupOldFiles already swallows per-file errors; this is a last-resort guard.
    console.error('[CRON] Cleanup sweep failed:', e);
  }
}
// Run hourly; also once at startup.
cron.schedule('0 * * * *', runCleanup, { timezone: 'UTC' });
runCleanup();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Which build is actually running. Lets a phone answer "did my deploy land?"
// instead of guessing at a stale cache.
const BUILD_SHA = (process.env.RAILWAY_GIT_COMMIT_SHA || 'dev').slice(0, 7);
const BOOTED_AT = new Date().toISOString();
app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sha: BUILD_SHA, bootedAt: BOOTED_AT });
});

// Serve frontend (mobile folder)
// HTML files must never be cached — always fetch fresh from server
const frontendDir = path.resolve(__dirname, '../../mobile');

// The app owns the root, as it always has. The marketing landing lives at
// /landing while its design is still in flux; it already deep-links into
// /app?go=<screen>, so swapping it onto `/` later is a one-line change.
// Declared before express.static, which would otherwise resolve /app against
// the React-Native `mobile/app` directory.
// Stamp the shell with the build it was served from. The page can then compare
// itself against /api/version and say plainly whether this tab is stale.
//
// Caching: the shell is 1.1MB, and `no-store` made every visit re-download it —
// the single biggest cost of opening the app on mobile. `no-cache` + ETag keeps
// the freshness guarantee (the browser revalidates on every visit) but turns
// the unchanged case into a 304 with no body. The ETag folds in the file mtime
// so local dev (BUILD_SHA='dev') still invalidates on edit.
function sendHtml(res: express.Response, file: string): void {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const full = path.join(frontendDir, file);
    const etag = `"${BUILD_SHA}-${Math.floor(fs.statSync(full).mtimeMs)}"`;
    res.setHeader('ETag', etag);
    const req = res.req;
    if (req && req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const html = fs.readFileSync(full, 'utf8');
    res.send(html.replace(/__BUILD_SHA__/g, BUILD_SHA));
  } catch {
    res.sendFile(path.join(frontendDir, file));
  }
}
app.get('/landing', (_req, res) => sendHtml(res, 'landing.html'));
app.get('/app', (_req, res) => sendHtml(res, 'web-demo.html'));

app.use(express.static(frontendDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
// Everything else — including `/` — is the app shell, stamped with its build.
app.get('*', (_req, res) => sendHtml(res, 'web-demo.html'));

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AI Marketer Backend running on http://0.0.0.0:${PORT}`);
  console.log(`AI Provider: ${process.env.AI_PROVIDER || 'mock'}`);
  // Load persisted push subscriptions from Supabase
  await loadSubscriptionsFromDB();
});

export default app;
