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

  // Normalise upstream 5xx (OpenAI 502/503/529) → 503 with a retry message
  // so the frontend can show a helpful prompt instead of a raw server error.
  if (rawStatus >= 500 && rawStatus !== 500) {
    res.status(503).json({
      error: 'AI сервіс тимчасово недоступний. Спробуй ще раз через 10–20 секунд.',
      retryable: true,
    });
    return;
  }

  res.status(rawStatus).json({
    error: err.message || 'Internal server error',
  });
}
