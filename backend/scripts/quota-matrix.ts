// Матриця енфорсменту квот: коли ми маємо право блокувати людину.
//
// Головне правило: НЕ блокувати того, кому ніде заплатити. 13.08.2026 прод
// стояв із QUOTA_ENFORCE=1 при порожніх бойових ключах WayForPay, тож
// free-користувач упирався в «Відкрий Pro», який вів на публічний тестовий
// мерчант із документації. Цей файл тримає правило прибитим.
//
//   npx ts-node scripts/quota-matrix.ts
//
// Тонкість, на якій я спіткнувся: `isDbConfigured()` читає SUPABASE_* у
// КОНСТАНТИ при завантаженні модуля, а не при виклику. Тому наявність БД не
// можна перемкнути всередині процесу — рядки з db=false ганяються в окремому
// дочірньому процесі (MATRIX_NO_DB=1).
import { spawnSync } from 'child_process';

const NO_DB = process.env.MATRIX_NO_DB === '1';

if (!NO_DB) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sb_secret_test';
} else {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_KEY;
}

// require, а не import: import піднімається вгору файлу і виконався б ДО
// правок process.env вище.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { quotaEnforced } = require('../src/services/quota') as { quotaEnforced: () => boolean };

type Row = { enforce?: string; live: boolean; want: boolean; why: string };

const WITH_DB: Row[] = [
  { live: false, want: false, why: 'дефолт без білінгу — не блокуємо' },
  { live: true,  want: true,  why: 'дефолт із білінгом — блокуємо' },
  { enforce: '1', live: false, want: false, why: 'КЛЮЧОВЕ: «1» більше не обходить білінг' },
  { enforce: '1', live: true,  want: true,  why: '«1» із білінгом — блокуємо' },
  { enforce: '0', live: true,  want: false, why: '«0» вимикає завжди' },
  { enforce: 'force', live: false, want: true, why: 'свідомий тест — блокуємо без білінгу' },
];

const NO_DB_ROWS: Row[] = [
  { live: true, want: false, why: 'без БД лічильника немає' },
  { enforce: 'force', live: false, want: false, why: 'force без БД усе одно нічим рахувати' },
];

function apply(r: Row) {
  if (r.enforce === undefined) delete process.env.QUOTA_ENFORCE;
  else process.env.QUOTA_ENFORCE = r.enforce;
  if (r.live) {
    process.env.WAYFORPAY_MERCHANT_ACCOUNT = 'octomind_real';
    process.env.WAYFORPAY_SECRET = 'real_secret';
  } else {
    delete process.env.WAYFORPAY_MERCHANT_ACCOUNT;
    delete process.env.WAYFORPAY_SECRET;
  }
}

let bad = 0;
const rows = NO_DB ? NO_DB_ROWS : WITH_DB;
console.log(NO_DB ? '— без Supabase —' : '— із Supabase —');
for (const r of rows) {
  apply(r);
  const got = quotaEnforced();
  const ok = got === r.want;
  if (!ok) bad++;
  const env = `QUOTA_ENFORCE=${r.enforce ?? '—'} live=${r.live}`;
  console.log(`${ok ? '✅' : '❌'} ${env.padEnd(34)} → ${String(got).padEnd(5)} (треба ${r.want})  ${r.why}`);
}

if (!NO_DB) {
  const child = spawnSync(process.argv[0], [process.argv[1]], {
    env: { ...process.env, MATRIX_NO_DB: '1' },
    encoding: 'utf-8',
  });
  process.stdout.write('\n' + (child.stdout || ''));
  if (child.status) bad++;
}

console.log(bad ? `\n❌ ${bad} правил зламано` : '\n✅ усі правила тримаються');
process.exit(bad ? 1 : 0);
