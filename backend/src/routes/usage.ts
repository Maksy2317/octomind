// GET /api/usage — the client's source of truth for "лишилось X із Y" badges
// and the plan. Requires x-device-id (optionalIdentity); returns a graceful
// "unlimited/unknown" snapshot when the DB isn't configured.

import { Router, Request, Response, NextFunction } from 'express';
import { optionalIdentity } from '../middleware/identity';
import { usageSnapshot, quotaEnforced } from '../services/quota';

export const usageRouter = Router();

usageRouter.use(optionalIdentity);

usageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.userId || !quotaEnforced()) {
      res.json({ enforced: false, plan: 'free', features: {} });
      return;
    }
    const snap = await usageSnapshot(req.userId);
    res.json({ enforced: true, ...snap });
  } catch (err) {
    next(err);
  }
});
