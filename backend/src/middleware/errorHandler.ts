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

  const status = (err as any).status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
}
