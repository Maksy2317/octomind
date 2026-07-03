// Business profile CRUD. Niche-agnostic: `niche` is a free-text field the client
// fills; the AI brain adapts to it. All routes require an x-device-id identity.

import { Router, Request, Response, NextFunction } from 'express';
import { requireIdentity } from '../middleware/identity';
import { getBusinessProfile, saveBusinessProfile } from '../services/db/repos';
import { BusinessProfileInput } from '../services/db/models';

export const profileRouter = Router();

profileRouter.use(requireIdentity);

// Whitelist of writable text fields (prevents clients setting user_id/id/etc).
type TextField =
  | 'business_name' | 'niche' | 'description' | 'target_audience'
  | 'geo' | 'price_segment' | 'usp' | 'goal' | 'tone';
const TEXT_FIELDS: TextField[] = [
  'business_name', 'niche', 'description', 'target_audience',
  'geo', 'price_segment', 'usp', 'goal', 'tone',
];
const MAX_LEN = 4000;

function sanitize(body: unknown): BusinessProfileInput {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: BusinessProfileInput = {};
  for (const key of TEXT_FIELDS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v.slice(0, MAX_LEN);
  }
  if (src.extra && typeof src.extra === 'object' && !Array.isArray(src.extra)) {
    out.extra = src.extra as Record<string, unknown>;
  }
  return out;
}

// GET /api/profile — current profile (or null)
profileRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await getBusinessProfile(req.userId!);
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// POST /api/profile — create or update the profile (upsert-by-user)
profileRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = sanitize(req.body);
    if (Object.keys(input).length === 0) {
      return res.status(400).json({ error: 'No valid profile fields provided' });
    }
    const profile = await saveBusinessProfile(req.userId!, input);
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});
