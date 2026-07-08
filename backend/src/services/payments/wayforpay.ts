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

/** Verify the signature WayForPay sends on the service (webhook) callback. */
export function verifyCallback(body: Record<string, unknown>): boolean {
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
  return expected === String(body.merchantSignature ?? '');
}

/** The JSON WayForPay expects back from the callback to acknowledge receipt. */
export function callbackResponse(orderReference: string, time: number): Record<string, unknown> {
  const status = 'accept';
  return { orderReference, status, time, signature: hmacMd5([orderReference, status, time]) };
}
