// Видимість помилок у проді.
//
// До цього єдиним слідом падіння був console.error у логах Railway — тобто про
// поломку ми дізнавались лише якщо хтось саме в цей момент дивився в консоль.
// Чотири cron-задачі (нагадування щохвилини, щоденний пуш, тижневий дайджест,
// чистка файлів) ловили свої помилки й тихо писали в консоль: така могла місяць
// не працювати без жодного сигналу. Тепер неочікувана помилка летить у Sentry.
//
// МУСИТЬ імпортуватись ПЕРШИМ рядком index.ts: Sentry патчить http/express на
// старті, і якщо ці модулі вже завантажені, контекст запиту не причепиться.
//
// Без SENTRY_DSN модуль повністю інертний — жодного мережевого виклику й
// накладних витрат, тож локальна розробка нічого не надсилає нікуди.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

const DSN = process.env.SENTRY_DSN || '';

export function isMonitoringEnabled(): boolean {
  return Boolean(DSN);
}

// У цьому застосунку тіло запиту — це бізнес-профіль людини, тексти її постів,
// промпти й нік у TikTok. Такому не місце у зовнішньому сервісі навіть у звіті
// про помилку. Лишаємо рівно те, що потрібно для діагностики: метод і шлях.
function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.data;          // тіло POST — головне джерело даних людини
    delete event.request.cookies;
    delete event.request.headers;       // тут x-device-id, авторизація, User-Agent
    delete event.request.query_string;  // у query теж бувають ніки й запити
  }
  delete event.user;
  delete event.server_name;             // ім'я контейнера Railway нічого не дає
  return event;
}

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || 'development',
    // Railway підставляє SHA коміта — так у Sentry видно, який деплой зламався.
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Нам потрібні ПОМИЛКИ, а не профайлінг. Трейси з'їдають ліміт безкоштовного
    // тарифу (5k подій/міс) і нічого тут не додають.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrub,
    // Прибираємо Console-інтеграцію. За замовчуванням Sentry чіпляє КОЖЕН рядок
    // console як «хлібну крихту» і відправляє разом із подією — тобто вичищене
    // вище тіло запиту приїхало б назад через наші ж логи. А там буває чимало:
    // сирі відповіді Apify, повідомлення AI-провайдера (які інколи відлунюють
    // фрагмент промпта), рядок errorHandler з текстом будь-якої помилки.
    // Стек виклику й маршрут для діагностики достатні, а вміст логів лишається
    // на Railway — там, де він і має бути.
    integrations: (defaults) => defaults.filter((i) => i.name !== 'Console'),
  });
  console.log('[Sentry] моніторинг помилок увімкнено');
}

/**
 * Помилка у фоновій задачі (cron, воркер) — там немає запиту, тому express-хендлер
 * її не побачить. Завжди пише в консоль; у Sentry — лише якщо DSN налаштований.
 */
export function captureError(err: unknown, job: string): void {
  console.error(`[${job}]`, err instanceof Error ? err.stack || err.message : err);
  if (!DSN) return;
  Sentry.withScope((scope) => {
    scope.setTag('job', job);
    scope.setLevel('error');
    Sentry.captureException(err);
  });
}

/**
 * Чи варто повідомляти про цю помилку запиту.
 *
 * Пропускаємо все, що ми вже класифікували самі (флаг `expose` — див.
 * SourceFailure у services/trends.ts) і всі 4xx: закінчена квота, невалідний
 * ввід і вичерпані кредити Apify — це очікувані стани з людським текстом, вони
 * вже пишуться в лог адресно. Якби вони летіли в Sentry, 5k безкоштовних подій
 * витратились би на шум, а справжнє падіння потонуло б у ньому.
 */
export function shouldReportRequestError(err: unknown): boolean {
  const e = err as { expose?: boolean; status?: number; statusCode?: number };
  if (e?.expose) return false;
  const status = e?.status || e?.statusCode || 500;
  return status >= 500;
}

/**
 * Причепити збирач помилок запитів. Ставити ПІСЛЯ всіх роутів і ПЕРЕД нашим
 * errorHandler: Sentry лише реєструє помилку й передає її далі по ланцюжку, тож
 * відповідь користувачу все одно формує errorHandler.
 * Без DSN — no-op, застосунок працює як раніше.
 */
export function setupExpressErrorHandler(app: { use: (mw: unknown) => unknown }): void {
  if (!DSN) return;
  Sentry.setupExpressErrorHandler(app, { shouldHandleError: shouldReportRequestError });
}

export { Sentry };
