// Row shapes for the Phase 1 tables (see backend/db/schema.sql).

export interface User {
  id: string;
  device_id: string;
  email: string | null;
  created_at: string;
}

export interface BusinessProfile {
  id: string;
  user_id: string;
  business_name: string | null;
  niche: string | null;
  description: string | null;
  target_audience: string | null;
  geo: string | null;
  price_segment: string | null;
  usp: string | null;
  goal: string | null;
  tone: string | null;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Fields a client is allowed to write to a business profile.
export type BusinessProfileInput = Partial<
  Pick<
    BusinessProfile,
    | 'business_name'
    | 'niche'
    | 'description'
    | 'target_audience'
    | 'geo'
    | 'price_segment'
    | 'usp'
    | 'goal'
    | 'tone'
    | 'extra'
  >
>;

export interface Project {
  id: string;
  user_id: string;
  business_profile_id: string | null;
  name: string | null;
  goal: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export type GenerationType = 'analysis' | 'offer' | 'strategy' | 'text' | string;

export interface Generation {
  id: string;
  user_id: string;
  project_id: string | null;
  business_profile_id: string | null;
  type: GenerationType;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  model: string | null;
  created_at: string;
}
