// Діагностика «Розбору контенту»: показує СИРУ відповідь моделі й причину
// зупинки. 14.08.2026 ендпоінт віддавав «AI повернув невалідний формат» на
// звичайному креативі — треба було побачити, чи це обрив на стелі токенів,
// чи модель узагалі відповіла не JSON.
//
//   npx ts-node scripts/audit-debug.ts <шлях-до-jpg>
import 'dotenv/config';
import fs from 'fs';
import { llmCall } from '../src/services/ai/provider';

const LANG =
  'Мова відповіді: українська. Поверни ЛИШЕ валідний JSON (мініфікований, без markdown).';

const SYSTEM =
  'Ти — старший маркетолог, який робить ЧЕСНИЙ аудит контенту клієнта (на зображеннях — його ' +
  'власні пости / профіль / креативи). Не хвали заради ввічливості — знаходь конкретні слабкі місця ' +
  'і давай точні, здійсненні поради, ПРИВʼЯЗАНІ до того, що реально видно на зображеннях. ' +
  LANG +
  ' Схема JSON: {"summary": string, "score": number (0-100), "strengths": string[], ' +
  '"weaknesses": string[], "fixes": [{"what": string, "why": string}]}. ' +
  'weaknesses і fixes — найважливіше: 3-6 пунктів, конкретно про ЦЕЙ контент, не загально.';

async function main() {
  const path = process.argv[2];
  if (!path || !fs.existsSync(path)) {
    console.error('дай шлях до зображення');
    process.exit(1);
  }
  const data = fs.readFileSync(path).toString('base64');
  const images = [{ media_type: 'image/jpeg', data }];

  for (const maxTokens of [2500, 4200]) {
    const t0 = Date.now();
    try {
      const res = await llmCall(SYSTEM, 'Зроби чесний аудит цього креативу.', { images, maxTokens });
      const txt = res.text || '';
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let parses = false;
      try { JSON.parse(txt.trim()); parses = true; } catch { /* ignore */ }
      console.log(`\n=== стеля ${maxTokens} · ${secs}с ===`);
      console.log(`довжина: ${txt.length} символів | парситься цілком: ${parses}`);
      console.log(`ХВІСТ (останні 220): ${JSON.stringify(txt.slice(-220))}`);
      if (!parses) console.log('   → обрив або не-JSON');
    } catch (e) {
      console.log(`\n=== стеля ${maxTokens} === ЗБІЙ: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

main();
