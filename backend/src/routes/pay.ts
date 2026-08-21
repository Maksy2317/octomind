// Payments: create a WayForPay checkout, and receive its callback to flip the
// user's plan. orderReference encodes "<userId>__<plan>__<ts>" so the callback
// (which has no session) knows who + what to activate.

import { Router, Request, Response, NextFunction } from 'express';
import { requireIdentity } from '../middleware/identity';
import { setUserPlan } from '../services/db/repos';
import { Plan } from '../services/db/models';
import { buildPurchase, verifyCallback, callbackResponse, amountMatchesPlan, PLAN_PRICES, isLive } from '../services/payments/wayforpay';
import { insertOne, selectOne, update } from '../services/db/client';

export const payRouter = Router();

// GET /api/pay/plans — prices + whether real billing is live (client badge).
payRouter.get('/plans', (_req: Request, res: Response) => {
  res.json({ live: isLive(), plans: PLAN_PRICES });
});

// POST /api/pay/create — returns the form the client auto-submits to WayForPay.
payRouter.post('/create', requireIdentity, (req: Request, res: Response) => {
  // Без бойових ключів WayForPay ця відповідь вела людину на ПУБЛІЧНИЙ
  // тестовий мерчант із документації (`test_merch_n1`) — тобто на сторінку
  // оплати, яка нічого нам не зарахує. Правило тримає код, а не дисципліна:
  // щойно ключі зʼявляться в env, оплата вмикається сама.
  if (!isLive()) {
    res.status(503).json({
      error: 'Оплата картками ще вмикається. Напиши нам — підключимо Pro вручну: octomind.support@gmail.com',
      code: 'billing_not_live',
    });
    return;
  }
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

// POST /api/pay/request — «Хочу Pro», поки каси немає.
//
// Каси немає не через код, а через відсутність ФОП. Поки її немає, єдиний
// чесний спосіб зрозуміти, чи готові платити — рахувати ПІДНЯТІ РУКИ, а не
// кліки. Клік по тарифу нічого не означає: людина могла просто дивитись ціну.
// Заявка з контактом і сумою означає рівно те, що написано.
payRouter.post('/request', requireIdentity, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clean = (v: unknown, max: number) =>
      String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

    const plan: 'pro' | 'business' = req.body?.plan === 'business' ? 'business' : 'pro';
    const contact = clean(req.body?.contact, 160);
    if (contact.length < 4) {
      res.status(400).json({ error: 'Лишіть пошту або телеграм — інакше ми не зможемо відповісти.' });
      return;
    }
    const row = {
      user_id: req.userId,
      device_id: req.deviceId || null,
      plan,
      contact,
      budget: clean(req.body?.budget, 40) || null,
      note: clean(req.body?.note, 600) || null,
    };

    // Одна людина — одна заявка. Без цього повторний дотик роздуває саме ту
    // цифру, заради якої все й робиться: десять заявок від трьох людей
    // виглядали б як десять зацікавлених.
    const existing = await selectOne<{ id: number }>(
      'upgrade_requests',
      `select=id&user_id=eq.${encodeURIComponent(String(req.userId))}&limit=1`,
    );
    if (existing) await update('upgrade_requests', `id=eq.${existing.id}`, row);
    else await insertOne('upgrade_requests', row);

    res.json({ ok: true, updated: !!existing });
  } catch (err) {
    next(err);
  }
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
