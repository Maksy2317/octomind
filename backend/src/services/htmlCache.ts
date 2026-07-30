// Віддача HTML-оболонок стисненою.
//
// Що з'ясувалось при замірі, а не з припущень: Railway на своєму краю ВЖЕ стискає
// gzip (1 064 КБ → 273 КБ), тож класичний express-`compression` тут нічого б не
// дав. Але brotli край Railway НЕ підтримує: на `Accept-Encoding: br` він віддає
// повний мегабайт. А brotli на цьому файлі дає 203 КБ — на 26% менше за gzip,
// тобто ~70 КБ економії на кожному холодному відкритті з мобільного інтернету.
//
// Чому в пам'яті, а не middleware на кожен запит: brotli максимальної якості
// стискає цей файл 923 мс. На запит таке робити не можна. Файли статичні між
// деплоями, тож стискаємо один раз і тримаємо готові буфери.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export type Encoding = 'br' | 'gzip' | 'identity';

interface Entry {
  mtimeMs: number;
  identity: Buffer;
  gzip?: Buffer;
  br?: Buffer;
}

const cache = new Map<string, Entry>();

function build(full: string, buildSha: string): Entry {
  const raw = fs.readFileSync(full, 'utf8').replace(/__BUILD_SHA__/g, buildSha);
  return { mtimeMs: Math.floor(fs.statSync(full).mtimeMs), identity: Buffer.from(raw, 'utf8') };
}

/** Свіжий запис для файлу; перезбирається, якщо файл змінився (важливо в dev). */
function entryFor(full: string, buildSha: string): Entry {
  const hit = cache.get(full);
  const mtimeMs = Math.floor(fs.statSync(full).mtimeMs);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const fresh = build(full, buildSha);
  cache.set(full, fresh);
  // Новий запис приходить без стиснених буферів, тож поки вони не готові, віддамо
  // identity. Без цього рядка редагування HTML тихо вимикало стиснення до
  // перезапуску процесу — саме на це я й наступив, поки чистив мертвий код.
  setTimeout(() => compress(full), 0);
  return fresh;
}

/**
 * Стиснути запис на місці. level 9 / quality 11 — файл стискається один раз,
 * тож економимо байти, а не такти. Повертає false, якщо робити було нічого.
 */
function compress(full: string): boolean {
  const entry = cache.get(full);
  if (!entry || entry.br) return false;
  try {
    entry.gzip = zlib.gzipSync(entry.identity, { level: 9 });
    entry.br = zlib.brotliCompressSync(entry.identity, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.identity.length,
      },
    });
    return true;
  } catch (e) {
    // Не критично: без буферів віддамо identity, а край Railway дожме gzip.
    console.warn('[HTML] не вдалось стиснути', path.basename(full), (e as Error).message);
    return false;
  }
}

/**
 * Найкраще кодування, яке приймає клієнт. Порядок за виграшом: brotli краще за
 * gzip, gzip краще за нічого. `identity` — коли клієнт не заявив жодного або
 * потрібний буфер ще не готовий.
 */
export function pickEncoding(acceptEncoding: string | undefined, entry: Entry): Encoding {
  const a = (acceptEncoding || '').toLowerCase();
  if (entry.br && /\bbr\b/.test(a)) return 'br';
  if (entry.gzip && /\bgzip\b/.test(a)) return 'gzip';
  return 'identity';
}

export interface Prepared {
  body: Buffer;
  encoding: Encoding;
  /** ETag з кодуванням у складі: різні кодування — різні тіла, отже різні теги. */
  etag: string;
}

export function prepare(full: string, buildSha: string, acceptEncoding: string | undefined): Prepared {
  const entry = entryFor(full, buildSha);
  const encoding = pickEncoding(acceptEncoding, entry);
  const body = encoding === 'br' ? entry.br! : encoding === 'gzip' ? entry.gzip! : entry.identity;
  return { body, encoding, etag: `"${buildSha}-${entry.mtimeMs}-${encoding}"` };
}

/**
 * Стиснути наперед, не блокуючи старт. Викликається після app.listen: поки
 * пройде перший запит, буфери зазвичай уже готові, а якщо ні — віддамо
 * identity, і наступний запит уже отримає стиснене.
 */
export function warmUp(frontendDir: string, files: string[], buildSha: string): void {
  const queue = files.map((f) => path.join(frontendDir, f)).filter((p) => fs.existsSync(p));
  const step = (): void => {
    const full = queue.shift();
    if (!full) {
      console.log('[HTML] попереднє стиснення завершено');
      return;
    }
    const entry = entryFor(full, buildSha);
    if (compress(full) && entry.gzip && entry.br) {
      const kb = (n: number) => `${Math.round(n / 1024)} КБ`;
      console.log(`[HTML] ${path.basename(full)}: ${kb(entry.identity.length)} → gzip ${kb(entry.gzip.length)}, br ${kb(entry.br.length)}`);
    }
    // Наступний файл окремим тіком, щоб не тримати цикл подій ~1 с підряд.
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
