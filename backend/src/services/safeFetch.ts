// Захищене завантаження URL, який дав користувач.
//
// Причина: у застосунку є три місця, де ми йдемо в мережу за адресою від
// клієнта — розбір посилання на пост, імпорт сайту в профіль і читання палітри
// з og:image. Усі три робили звичайний `fetch(url, { redirect: 'follow' })`.
// Перевірено живою атакою: запит із `url: http://127.0.0.1:9455/internal/secrets`
// змусив сервер прочитати внутрішню адресу й ПОВЕРНУТИ її вміст атакуючому.
// Це класичний SSRF: з інтернету стає доступним усе, що видно з контейнера —
// сусідні сервіси, метадані хостингу (169.254.169.254), локальні порти.
//
// Захист тут, а не в трьох місцях, бо інакше четверте таке місце знову з'явиться
// без захисту.
//
// Чого цей модуль НЕ робить: не закриває DNS rebinding (перевіряємо адресу, а
// з'єднання встановлює вже ОС, яка може отримати іншу). Щоб закрити й це, треба
// конектитись до перевіреного IP із заголовком Host — окрема робота. Тому для
// найчутливішого місця (розбір посилання) додатково стоїть жорсткий список
// дозволених хостів: там довільна адреса не потрібна взагалі.
import dns from 'dns/promises';
import net from 'net';

const MAX_REDIRECTS = 3;

/** Адреси, куди сервер не має ходити за жодних обставин. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;                              // 0.0.0.0/8
    if (p[0] === 10) return true;                             // приватна
    if (p[0] === 127) return true;                            // loopback
    if (p[0] === 169 && p[1] === 254) return true;            // link-local + метадані хостингу
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // приватна
    if (p[0] === 192 && p[1] === 168) return true;             // приватна
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // IETF protocol
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmark
    if (p[0] >= 224) return true;                              // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80')) return true;                     // link-local
    if (/^f[cd]/.test(a)) return true;                         // unique-local fc00::/7
    // IPv4, замаскований під IPv6: ::ffff:127.0.0.1
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // не розпізнали — не пускаємо
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Стеля прочитаного тіла. Сервер може брехати в Content-Length, тому ріжемо потік. */
  maxBytes?: number;
  /** Жорсткий список дозволених хостів — там, де довільна адреса не потрібна. */
  allowHosts?: RegExp;
}

export interface SafeFetchResult {
  body: Buffer;
  contentType: string;
  status: number;
  finalUrl: string;
}

export class BlockedUrlError extends Error {
  status = 400;
  expose = true as const;
  code = 'url_blocked';
  retryable = false;
}

function blocked(message: string): BlockedUrlError {
  return new BlockedUrlError(message);
}

/** Перевірити конкретний крок (початковий URL або хост після редіректу). */
async function assertAllowed(u: URL, allowHosts?: RegExp): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw blocked('Підтримуються лише посилання http(s).');
  }
  // user:pass@host — спосіб заплутати і нас, і проміжні парсери.
  if (u.username || u.password) throw blocked('Посилання з логіном/паролем не приймаємо.');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (allowHosts && !allowHosts.test(host)) {
    throw blocked('Це посилання не з тих мереж, які Octo вміє читати.');
  }
  // Адресу вписали цифрами — перевіряємо одразу, без DNS.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked('Внутрішні адреси недоступні.');
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw blocked('Не вдалось знайти цей домен.');
  }
  if (!addrs.length) throw blocked('Не вдалось знайти цей домен.');
  // ВСІ адреси мусять бути публічними: домен може навмисно віддавати кілька
  // записів, серед яких один внутрішній.
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw blocked('Внутрішні адреси недоступні.');
  }
}

/** Прочитати тіло з жорсткою стелею — не довіряючи Content-Length. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw blocked('Сторінка надто велика.');
  if (!res.body) return Buffer.alloc(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => { /* байдуже */ });
      break; // те, що вже прочитали, зазвичай містить <head> з og-метою
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Завантажити URL від користувача, перевіряючи КОЖЕН крок редіректу.
 * `redirect: 'manual'` тут принципово: інакше перевірка початкової адреси
 * нічого не варта — досить віддати 302 на 127.0.0.1.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 9000;
  const maxBytes = opts.maxBytes ?? 300_000;

  let current: URL;
  try {
    current = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
  } catch {
    throw blocked('Це не схоже на посилання.');
  }

  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertAllowed(current, opts.allowHosts);

    const left = deadline - Date.now();
    if (left <= 0) throw blocked('Сторінка не відповідає.');

    const res = await fetch(current.toString(), {
      headers: opts.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(left),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw blocked('Сторінка перенаправляє в нікуди.');
      let next: URL;
      try { next = new URL(loc, current); } catch { throw blocked('Некоректне перенаправлення.'); }
      current = next;   // наступний виток перевірить його так само суворо
      continue;
    }

    const body = await readCapped(res, maxBytes);
    return {
      body,
      contentType: (res.headers.get('content-type') || '').split(';')[0].trim(),
      status: res.status,
      finalUrl: current.toString(),
    };
  }
  throw blocked('Завелика довжина перенаправлень.');
}

/** Соцмережі, з яких ми читаємо підпис до поста. Довільні адреси тут не потрібні. */
export const SOCIAL_HOSTS = /(^|\.)(tiktok\.com|instagram\.com|instagr\.am|facebook\.com|fb\.watch|youtube\.com|youtu\.be)$/i;
