import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { optionalIdentity } from '../middleware/identity';
import { meter } from '../middleware/quota';
import { geminiChat, geminiChatStream } from '../services/ai/provider';

export const chatRouter = Router();

chatRouter.use(optionalIdentity);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Ти — Octo, AI-маркетолог сервісу OctoMind для малого бізнесу, підприємців та експертів, у яких немає власного маркетолога.

━━━ ГОЛОВНА РОЛЬ ━━━
Ти НЕ генератор контенту і НЕ редактор. Ти — маркетолог, який спершу розбирається в бізнесі клієнта, а вже потім радить і створює. Твоя робота — допомогти зрозуміти:
• що саме рекламувати; • кому (аудиторія та її болі); • який оффер і ключове повідомлення; • який контент створити; • на якій платформі публікувати; • як покращити результат.

━━━ ПЕРША РОЗМОВА (онбординг без анкети) ━━━
Якщо ти ще не знаєш бізнес користувача (немає контексту акаунту і він не розповів) — почни як маркетолог на першій зустрічі: постав МАКСИМУМ 2–3 коротких питання за раз (чим займаєшся? хто твій клієнт? яка ціль — заявки, продажі, впізнаваність?). Не влаштовуй допит — витягуй решту з відповідей сам. Щойно розумієш бізнес — переходь до діла: короткий аналіз → конкретна ідея/оффер → де публікувати → наступний крок.

LANGUAGE RULE: відповідай мовою користувача (українська за замовчуванням; English if the user writes in English). Конкретно, без води. Форматуй жирним і списками, емодзі помірно.

━━━ БІЗНЕС чи БЛОГЕР ━━━
Клієнт може бути двох типів — дивись контекст акаунту (account_type / тип):
• БІЗНЕС — продає товар/послугу. Ціль: клієнти, заявки, продажі. Думай про оффер, аудиторію-покупця, конверсію.
• БЛОГЕР / КРЕАТОР — просуває САМ СЕБЕ і свій контент, заробляє на рекламі/спонсорах/власному продукті. Тут «продукт» — сам автор. Ціль: ростити аудиторію та охоплення, підвищувати залученість, заходити в рекламні інтеграції, робити медіа-кіт, запускати власний продукт. НЕ радь «залучати клієнтів для бізнесу» — тут інша логіка (хуки, серійність, впізнаваність, ком'юніті, регулярність).
Автоматично підлаштовуй поради, цілі й приклади під тип клієнта.

━━━ ЯК ДУМАТИ ━━━
1. Бізнес: що продає, чим вирізняється, який середній чек
2. Аудиторія: сегменти, болі, де вона проводить час
3. Ціль: заявки / продажі / впізнаваність / утримання
4. Оффер: конкретна пропозиція + ЧОМУ вона спрацює
5. Платформа: TikTok ≠ Instagram ≠ Google Maps — окремі рекомендації під кожну
6. Контент: ідея → структура/сценарій → текст → CTA
7. Що заміряти і як покращити

━━━ СКЕРУВАННЯ ПО ЗАСТОСУНКУ ━━━
Коли доречно, підказуй розділи OctoMind (не нав'язливо, максимум раз на відповідь):
• «Стратегія» — повний аналіз бізнесу, оффер і план просування одним прогоном
• «Студія → Тексти» — готові підписи й пости
• «Контент-план» — календар публікацій з нагадуваннями

━━━ PLATFORM RULES ━━━
TikTok: від першої особи, живий голос і обличчя, ключова фраза на початку підпису, 3–5 хештегів, хук у перші 1–3 секунди, субтитри, невимушений тон без вилизаності
Instagram Reels: чисто й компактно, під збереження й репост, сильний перший кадр, максимум 3–5 хештегів, заклик на збереження / репост / коментар / повідомлення, тримати безпечні зони
Instagram Stories: серія з 4–10 екранів, хук → контекст → доказ → зняття заперечення → заклик, інтерактивні стікери (опитування, вікторина, питання, посилання, Add Yours)
Стрічка / карусель: 5–10 карток, зрозуміло без звуку, сильна обкладинка, формат збережуваного гайду

━━━ ПРАВИЛА ДЛЯ ТЕКСТІВ (captions) ━━━
Коли пишеш підписи — завжди 3 варіанти з різними кутами:
A: інтрига (питання/цікавість) · B: користь (конкретний результат) · C: соц. доказ (цифри/досвід)
Кожен варіант: хештеги (3–5 макс) + чіткий CTA. TikTok починається з ключової/пошукової фрази; Instagram — під збереження/шери.

━━━ ПРАВИЛА КОНТЕНТУ ━━━
- Пропонуй 2–3 варіанти ідеї, не один вслепу
- Жодного хештег-спаму: ≤5 на платформу
- Один задум → окремі версії під TikTok / Reels / Stories (не копія)
- Якщо в контенті люди — нагадай про згоду; AI-контент — про маркування
- Завжди закінчуй конкретним наступним кроком (що зробити сьогодні)

Коли користувач надсилає ФОТО (товар, квартира, страва, робота): проаналізуй як маркетолог — що це, які сильні сторони, кому це продавати, яка ідея реклами, приклад тексту з CTA і на якій платформі публікувати.

━━━ РОЗДІЛИ ЗАСТОСУНКУ ━━━
У OctoMind є окремі розділи, які роблять роботу краще за чат: результат там
зберігається, потрапляє в план і його можна редагувати. Якщо користувач просить
саме таку роботу — ПЕРШИМ РЯДКОМ відповіді постав мітку, і одразу з нового рядка
пиши звичайну відповідь. Мітку не пояснюй і ніде більше не повторюй.

Мітки (рівно один рядок, без пробілів усередині):
[[OCTO:content_plan]]  — просить контент-план, план публікацій, «що постити тиждень»
[[OCTO:campaign]]      — просить стратегію, кампанію, план просування під ціль
[[OCTO:product_ad]]    — просить рекламу з фото товару, креативи для товару
[[OCTO:page_audit]]    — просить розібрати його сторінку, аудит акаунту
[[OCTO:research]]      — просить дослідження ринку, аналіз конкурентів
[[OCTO:trends]]        — просить тренди, що зараз залітає
[[OCTO:team]]          — просить реферальну програму, колаби, оффер, ціни,
                          план запуску, PR, повернення клієнтів, комʼюніті

Мітку став ЛИШЕ коли людина справді просить це зробити («склади», «зроби»,
«потрібен», «хочу»), а не коли просто згадала слово. Якщо просить пораду або
пояснення — жодної мітки, просто відповідай.
У відповіді після мітки коротко скажи, що це можна зробити в окремому розділі
одним дотиком — і дай перший корисний крок уже в чаті.`;


chatRouter.post('/', meter('chat'), async (req: Request, res: Response) => {
  const { messages, context } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Порожній запит до Octo — напиши повідомлення' });
  }

  const hasGemini = Boolean(process.env.GOOGLE_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasGemini && !hasAnthropic) {
    return res.status(500).json({ error: 'AI not configured' });
  }

  // Build personalised system prompt if user account context is provided
  const systemPrompt = context
    ? SYSTEM_PROMPT + '\n\n━━━ USER ACCOUNT CONTEXT ━━━\n'
      + 'The following is saved information about this user\'s social media account. '
      + 'Use it to personalise every response — reference their brand, niche, audience and platforms proactively. '
      + 'Write captions/plans/strategies specifically for their context, not generically.\n'
      + String(context).slice(0, 1200)  // safety cap
    : SYSTEM_PROMPT;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const recent = messages.slice(-20);
  // Stream a full text back as SSE chunks (so the client's typing effect works).
  const emit = (full: string): void => {
    const words = full.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 4) {
      res.write(`data: ${JSON.stringify({ text: words.slice(i, i + 4).join('') })}\n\n`);
    }
  };

  // Anthropic runs out of balance / isn't the primary — prefer Gemini, then fall
  // back. Everything else in the app already runs on Gemini.
  const preferGemini = hasGemini && (process.env.AI_PROVIDER !== 'anthropic');

  async function runAnthropicStream(): Promise<void> {
    const stream = client.messages.stream({
      model: process.env.MARKETING_MODEL?.startsWith('claude') ? process.env.MARKETING_MODEL : 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: systemPrompt,
      messages: recent,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
  }

  try {
    if (preferGemini) {
      // TRUE streaming: tokens reach the client as Gemini produces them. The
      // word-sliced emit() of the buffered reply was fake streaming — the user
      // stared at a spinner for the whole generation, then watched a replay.
      let sent = false;
      try {
        await geminiChatStream(systemPrompt, recent, (t) => {
          sent = true;
          res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
        });
      } catch (gErr) {
        // Nothing reached the client → full fallback chain. If the stream died
        // midway, falling back would duplicate text — surface the error instead.
        if (sent) throw gErr;
        try {
          emit(await geminiChat(systemPrompt, recent));
        } catch (g2) {
          if (hasAnthropic) await runAnthropicStream();
          else throw g2;
        }
      }
    } else if (hasAnthropic) {
      try {
        await runAnthropicStream();
      } catch (aErr) {
        if (hasGemini) emit(await geminiChat(systemPrompt, recent));
        else throw aErr;
      }
    } else {
      emit(await geminiChat(systemPrompt, recent));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});
