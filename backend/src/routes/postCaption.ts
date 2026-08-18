// Витяг підпису з публічного поста Instagram / TikTok — для фічі «Мій стиль».
//
// Раніше цей маршрут жив усередині carousel.ts (1254 рядки, 12 маршрутів), з
// яких у продукт іде РІВНО цей один. Решта — залишки нереалізованої каруселі,
// що ходили в Replicate, Stability і OpenAI. Вони були закриті перевіркою під
// час запиту, але вартувати мертвий код гірше, ніж його не мати: одна
// необережна правка маршрутизації — і будь-хто витрачає наші гроші.
import { Router, Request, Response, NextFunction } from 'express';
import { safeFetch, SOCIAL_HOSTS } from '../services/safeFetch';

export const postCaptionRouter = Router();


// ── POST /api/carousel/fetch-post-caption ────────────────────────────────────
// Given a public Instagram or TikTok post URL, fetches the page and returns
// the caption text extracted from og:description meta tag.
// Used by Caption AI "My Style" to auto-pull captions from post links.
postCaptionRouter.post('/fetch-post-caption', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.body as { url: string };
    if (!url) { res.status(400).json({ error: 'url required' }); return; }

    let parsedUrl: URL;
    try { parsedUrl = new URL(url); }
    catch { res.status(400).json({ error: 'Invalid URL' }); return; }

    const host = parsedUrl.hostname.replace('www.', '');
    const platform = host.includes('tiktok') ? 'tiktok'
                   : host.includes('instagram') ? 'instagram'
                   : 'unknown';

    // TikTok: official oEmbed API (no auth needed)
    if (platform === 'tiktok') {
      try {
        const oe = await fetch(
          `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (oe.ok) {
          const data = await oe.json() as Record<string, string>;
          if (data.title) {
            res.json({ caption: data.title, author: data.author_name ?? null, platform });
            return;
          }
        }
      } catch { /* fall through to HTML scrape */ }
    }

    // Instagram (+ TikTok fallback): scrape og:description from page HTML
    // Через safeFetch: раніше тут був fetch(url, { redirect: 'follow' }) з
    // довільною адресою — сервер читав внутрішні адреси й віддавав їх вміст
    // назад (перевірено живою атакою на 127.0.0.1). Сюди потрібні лише соцмережі,
    // тому окрім блокування приватних адрес стоїть жорсткий список хостів.
    const fetched = await safeFetch(url, {
      allowHosts: SOCIAL_HOSTS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = fetched.body.toString('utf8');

    const ogDesc = (
      html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i) ??
      html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:description["']/i)
    )?.[1];

    const ogTitle = (
      html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ??
      html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:title["']/i)
    )?.[1];

    const decode = (s?: string) =>
      s?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, ' ').trim() ?? null;

    const caption = decode(ogDesc);
    if (!caption) {
      res.status(404).json({
        error: 'Не вдалося отримати підпис. Переконайся що пост публічний, або вкинь текст вручну.',
      });
      return;
    }

    res.json({ caption, author: decode(ogTitle), platform });
  } catch (err) {
    next(err);
  }
});
