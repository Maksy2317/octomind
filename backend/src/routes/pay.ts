// Payments: create a WayForPay checkout, and receive its callback to flip the
// user's plan. orderReference encodes "<userId>__<plan>__<ts>" so the callback
// (which has no session) knows who + what to activate.

import { Router, Request, Response, NextFunction } from 'express';
import { requireIdentity } from '../middleware/identity';
import { setUserPlan } from '../services/db/repos';
import { Plan } from '../services/db/models';
import { buildPurchase, verifyCallback, callbackResponse, amountMatchesPlan, PLAN_PRICES, isLive } from '../services/payments/wayforpay';

export const payRouter = Router();

// GET /api/pay/plans — prices + whether real billing is live (client badge).
payRouter.get('/plans', (_req: Request, res: Response) => {
  res.json({ live: isLive(), plans: PLAN_PRICES });
});

// POST /api/pay/create — returns the form the client auto-submits to WayForPay.
payRouter.post('/create', requireIdentity, (req: Request, res: Response) => {
  const plan: 'pro' | 'business' = req.body?.plan === 'business' ? 'business' : 'pro';
  const userId = req.userId as string;
  const orderReference = `${userId}__${plan}__${Date.now()}`;
  const orderDate = Math.floor(Date.now() / 1000);
  // Reliable public base: PUBLIC_URL env → else the real host this request came in
  // on (trust proxy → correct https host on Railway). Never an empty domain.
  const base = (process.env.PUBLIC_URL || process.env.PUBLIC_API_BASE || '').replace(/\/$/, '')
    || `${req.protocol}://${req.get('host')}`;
  const returnUrl = `${base}/?paid=1`;
  const serviceUrl = `${base}/api/pay/callback`;
  res.json(buildPurchase(plan, orderReference, orderDate, returnUrl, serviceUrl));
});

// POST /api/pay/callback — WayForPay server → verify signature, flip plan on
// approval, and acknowledge. No identity: trust comes from the signature only.
payRouter.post('/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let body: Record<string, unknown> = req.body || {};
    // WayForPay may send the JSON as a raw string, or as a single form key.
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep */ } }
    if (!body.orderReference) {
      const keys = Object.keys(body);
      if (keys.length === 1) { try { body = JSON.parse(keys[0]); } catch { /* keep */ } }
    }
    if (!verifyCallback(body)) {
      res.status(400).json({ error: 'bad signature' });
      return;
    }
    if (String(body.transactionStatus) === 'Approved') {
      const parts = String(body.orderReference).split('__');
      const userId = parts[0];
      const plan = parts[1] as Plan;
      // Тариф беремо з orderReference, але сума мусить збігатись із ціною цього
      // тарифу. Підпис це вже покриває (він охоплює й amount, і orderReference),
      // тож це другий рубіж — на випадок нашої ж помилки у формуванні замовлення.
      if (userId && (plan === 'pro' || plan === 'business')
          && !amountMatchesPlan(plan, body.amount, body.currency)) {
        console.error('[Pay] сума не відповідає тарифу — тариф НЕ видано:',
          plan, body.amount, body.currency);
      } else if (userId && (plan === 'pro' || plan === 'business')) {
        try { await setUserPlan(userId, plan); } catch (e) {
          console.warn('[Pay] setUserPlan failed:', (e as Error).message?.slice(0, 120));
        }
      }
    }
    res.json(callbackResponse(String(body.orderReference || ''), Math.floor(Date.now() / 1000)));
  } catch (err) {
    next(err);
  }
});
