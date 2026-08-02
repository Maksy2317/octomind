// WayForPay integration (Ukrainian card payments + monthly recurring).
//
// Sandbox by default: WayForPay's public test merchant is used until real
// WAYFORPAY_MERCHANT_ACCOUNT / WAYFORPAY_SECRET env vars are set. No real money
// moves in test mode. Signatures are HMAC-MD5 of ';'-joined fields, per their docs.

import crypto from 'crypto';

// Public sandbox credentials from WayForPay docs (test only).
const MERCHANT = process.env.WAYFORPAY_MERCHANT_ACCOUNT || 'test_merch_n1';
const SECRET = process.env.WAYFORPAY_SECRET || 'flk3409refn54t54t*FNJRET';
const DOMAIN = process.env.WAYFORPAY_DOMAIN || 'octomind-production.up.railway.app';

export function isLive(): boolean {
  return Boolean(process.env.WAYFORPAY_MERCHANT_ACCOUNT && process.env.WAYFORPAY_SECRET);
}

export interface PlanPrice { amount: number; currency: string; label: string }
export const PLAN_PRICES: Record<'pro' | 'business', PlanPrice> = {
  pro:      { amount: Number(process.env.PRICE_PRO || 12),      currency: process.env.PAY_CURRENCY || 'USD', label: 'OctoMind Pro' },
  business: { amount: Number(process.env.PRICE_BUSINESS || 29), currency: process.env.PAY_CURRENCY || 'USD', label: 'OctoMind Business' },
};

function hmacMd5(fields: Array<string | number>): string {
  return crypto.createHmac('md5', SECRET).update(fields.join(';'), 'utf8').digest('hex');
}

export interface Purchase { url: string; fields: Record<string, unknown> }

/** Build the POST form the client submits to WayForPay to start a payment. */
export function buildPurchase(
  plan: 'pro' | 'business',
  orderReference: string,
  orderDate: number,
  returnUrl: string,
  serviceUrl: string,
): Purchase {
  const p = PLAN_PRICES[plan];
  const productName = `${p.label} — місячна підписка`;
  const amount = p.amount;
  const currency = p.currency;
  // Signature order per WayForPay docs (Purchase).
  const signature = hmacMd5([
    MERCHANT, DOMAIN, orderReference, orderDate, amount, currency,
    productName, 1, amount,
  ]);
  return {
    url: 'https://secure.wayforpay.com/pay',
    fields: {
      merchantAccount: MERCHANT,
      merchantDomainName: DOMAIN,
      merchantSignature: signature,
      merchantAuthType: 'SimpleSignature',
      orderReference,
      orderDate,
      amount,
      currency,
      productName: [productName],
      productCount: [1],
      productPrice: [amount],
      // Monthly recurring subscription.
      regularMode: 'monthly',
      regularAmount: amount,
      regularBehavior: 'preset',
      regularCount: 12,
      returnUrl,
      serviceUrl,
      language: 'UA',
    },
  };
}

/**
 * Перевірити підпис, який WayForPay надсилає у вебхуці.
 *
 * КЛЮЧОВЕ: якщо справжнього секрету немає, ми НЕ перевіряємо нічого, а
 * відмовляємо. Раніше SECRET падав на публічний тестовий ключ із документації
 * WayForPay — тобто підпис міг порахувати будь-хто. Перевірено живою атакою:
 * підроблений вебхук «Approved, amount=1 UAH, plan=business» пройшов, і в базі
 * зʼявився тариф business. Достатньо було ввімкнути енфорсмент квот раніше, ніж
 * прописати справжній секрет, — і платний доступ роздавався б безкоштовно.
 */
export function verifyCallback(body: Record<string, unknown>): boolean {
  if (!isLive()) {
    console.error('[Pay] вебхук відкинуто: WAYFORPAY_MERCHANT_ACCOUNT/SECRET не задані — '
      + 'перевіряти підпис тестовим ключем із документації не можна');
    return false;
  }
  const expected = hmacMd5([
    String(body.merchantAccount ?? ''),
    String(body.orderReference ?? ''),
    String(body.amount ?? ''),
    String(body.currency ?? ''),
    String(body.authCode ?? ''),
    String(body.cardPan ?? ''),
    String(body.transactionStatus ?? ''),
    String(body.reasonCode ?? ''),
  ]);
  const got = String(body.merchantSignature ?? '');
  // Порівняння без залежності від часу: різниця в мілісекундах теоретично
  // дозволяє підбирати підпис побайтово.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Чи відповідає сплачена сума тарифу з orderReference. */
export function amountMatchesPlan(plan: 'pro' | 'business', amount: unknown, currency: unknown): boolean {
  const p = PLAN_PRICES[plan];
  if (!p) return false;
  if (String(currency || '').toUpperCase() !== String(p.currency).toUpperCase()) return false;
  // Порівнюємо в копійках: WayForPay може прислати '299' або '299.00'.
  return Math.round(Number(amount) * 100) === Math.round(Number(p.amount) * 100);
}

/** The JSON WayForPay expects back from the callback to acknowledge receipt. */
export function callbackResponse(orderReference: string, time: number): Record<string, unknown> {
  const status = 'accept';
  return { orderReference, status, time, signature: hmacMd5([orderReference, status, time]) };
}
