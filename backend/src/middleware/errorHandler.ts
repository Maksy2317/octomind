import { Request, Response, NextFunction } from 'express';
import multer from 'multer';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('[Error]', err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `File too large. Max size: ${process.env.MAX_FILE_SIZE_MB || 200}MB`,
      });
      return;
    }
  }

  const rawStatus = (err as any).status || (err as any).statusCode || 500;

  // Помилки, які САМІ знають, що сказати людині (SourceFailure у trends.ts):
  // віддаємо їх текст як є. Без цієї гілки загальний 5xx-обробник нижче підмінив
  // би чесне «оновлюємо джерело даних» на «AI сервіс недоступний, спробуй за
  // 20 секунд» — неправду одразу в двох місцях: це не AI, і повтор не допоможе.
  if ((err as any).expose) {
    res.status(rawStatus).json({
      error: err.message,
      code: (err as any).code,
      retryable: (err as any).retryable === true,
    });
    return;
  }

  // Normalise upstream 5xx (OpenAI 502/503/529) → 503 with a retry message
  // so the frontend can show a helpful prompt instead of a raw server error.
  if (rawStatus >= 500 && rawStatus !== 500) {
    res.status(503).json({
      error: 'AI сервіс тимчасово недоступний. Спробуй ще раз через 10–20 секунд.',
      retryable: true,
    });
    return;
  }

  // ЗАСЛІН: сире повідомлення від зовнішнього API не має права дійти до людини.
  // Реальний випадок, зловлений на прогоні: Gemini впав на MAX_TOKENS, пішов
  // фолбек на Anthropic, а там нульовий баланс — і користувач отримав англійський
  // текст «Your credit balance is too low… go to Plans & Billing», тобто наші
  // платіжні проблеми. Гілка «обидва провайдери впали» це покриває, але шляхи з
  // явно закріпленим провайдером (напр. дослідження) її обходять. Замість гонитви
  // за кожним шляхом фільтруємо на виході — і нові шляхи вже захищені за
  // замовчуванням.
  const raw = err.message || '';
  const looksUpstream = /^\s*\d{3}\s*[{[]/.test(raw)          // «400 {"type":"error"…»
    || /"type"\s*:\s*"(error|invalid_request_error)"/i.test(raw)
    || /credit balance|Plans & Billing|billing|quota exceeded|api[_ -]?key|unauthorized|permission_denied/i.test(raw)
    || /RESOURCE_EXHAUSTED|MAX_TOKENS|SAFETY|candidates\[0\]/i.test(raw);

  if (looksUpstream) {
    // Причина лишається в логах цілою — саме там вона й потрібна нам.
    console.error('[Error] сире повідомлення провайдера приховане від користувача:', raw.slice(0, 400));
    res.status(503).json({
      error: 'Octo зараз не може згенерувати відповідь. Спробуй ще раз за хвилину.',
      retryable: true,
    });
    return;
  }

  res.status(rawStatus).json({
    error: raw || 'Internal server error',
  });
}
