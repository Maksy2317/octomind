// Перевірка ланцюжка постачальників стрічки трендів на ЖИВИХ даних.
//
// Навіщо окремий скрипт: 13.08.2026 дешевий актор apidojo почав віддавати самі
// {noResults:true} — HTTP 200, датасет не порожній, але реальних роликів нуль.
// Прод стояв на ньому (TRENDS_ACTOR=apidojo) і стрічка мовчки не працювала.
// Цей скрипт відтворює саме той випадок і доводить, що добір clockworks рятує.
//
//   TRENDS_ACTOR=apidojo npx ts-node scripts/trends-check.ts "барбершоп київ"
//
// Запит краще давати НОВИЙ — інакше відповідь прийде з 12-годинного кешу і
// нічого не перевірить.
import 'dotenv/config';
import { getTrendFeed, isTrendsConfigured } from '../src/services/trends';

async function main() {
  if (!isTrendsConfigured()) {
    console.error('APIFY_TOKEN не заданий — перевіряти нічого');
    process.exit(1);
  }
  const query = process.argv[2] || 'барбершоп київ';
  console.log(`актор за env: ${process.env.TRENDS_ACTOR || '(clockworks за замовчуванням)'}`);
  console.log(`запит: «${query}», force=true (в обхід кешу)\n`);

  const t0 = Date.now();
  try {
    const feed = await getTrendFeed(query, true, 'tiktok');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✅ роликів: ${feed.videos.length} за ${secs} с (з кешу: ${feed.fromCache})`);
    for (const v of feed.videos.slice(0, 3)) {
      console.log(`   • ${String(v.text || '').slice(0, 60).replace(/\n/g, ' ')} | ${v.views} переглядів | ${v.url}`);
    }
    // Порожній успіх — саме той мовчазний збій, заради якого все це писалось.
    if (!feed.videos.length) {
      console.error('❌ нуль роликів прийшов як УСПІХ — це та сама діра');
      process.exit(1);
    }
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    console.error(`❌ збій: ${err.code || '?'} (${err.status || '?'}) — ${err.message}`);
    process.exit(1);
  }
}

main();
