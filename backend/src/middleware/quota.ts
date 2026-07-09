// Quota middleware: gate a metered endpoint behind the user's plan limits.
//
// Usage in a route:  router.post('/strategy', meter('campaign'), handler)
// (place AFTER an identity middleware that sets req.userId).
//
// Behaviour:
//  - No userId (no device-id / DB off)  → allow, don't record (fail-open).
//  - Over limit                          → 402 { code:'quota_exceeded', ... }.
//  - Under limit                         → allow; record ONE usage event iff the
//    handler responds 2xx (so failed generations don't burn quota).

import { Request, Response, NextFunction } from 'express';
import { checkQuota, recordUsage, quotaEnforced, Feature } from '../services/quota';

// Pre-launch universal unlock: the client's Premium-test toggle sends this
// header so testers (and early users, before payment exists) aren't blocked by
// quotas. Disable by setting PREMIUM_TEST_OPEN=0 once real monetization lands.
function premiumTestBypass(req: Request): boolean {
  if (process.env.PREMIUM_TEST_OPEN === '0') return false;
  return String(req.header('x-octo-premium-test') || '') === '1';
}

export function meter(feature: Feature) {
  return async function meterMw(req: Request, res: Response, next: NextFunction): Promise<void> {
    // No enforcement until real billing is live — don't block users who can't pay.
    if (!quotaEnforced()) return next();
    if (premiumTestBypass(req)) return next();
    const userId = req.userId;
    if (!userId) return next(); // stateless / DB off → don't enforce

    let status;
    try {
      status = await checkQuota(userId, feature);
    } catch {
      return next(); // fail-open
    }

    if (!status.allowed) {
      res.status(402).json({
        error: upgradeMessage(feature),
        code: 'quota_exceeded',
        feature,
        plan: status.plan,
        limit: status.limit,
        used: status.used,
        per: status.per,
      });
      return;
    }

    // Record only on a successful response — one event per request.
    let recorded = false;
    res.on('finish', () => {
      if (!recorded && res.statusCode >= 200 && res.statusCode < 300) {
        recorded = true;
        void recordUsage(userId, feature);
      }
    });
    next();
  };
}

function upgradeMessage(feature: Feature): string {
  const label: Record<Feature, string> = {
    campaign:   'кампаній',
    image:      'AI-зображень',
    chat:       'запитів до Octo',
    trend_feed: 'переглядів трендів',
    analysis:   'розборів сторінки',
    research:   'досліджень ринку',
    brand:      'бренд-стилів',
  };
  return `Ліміт ${label[feature]} на цьому тарифі вичерпано. Відкрий Pro, щоб продовжити.`;
}
