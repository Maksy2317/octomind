// Repositories — the only place that knows table names / query strings.
// Everything above this layer works with typed model objects.

import {
  select, selectOne, insertOne, update, remove,
} from './client';
import {
  User, BusinessProfile, BusinessProfileInput, Project, Generation, GenerationType,
} from './models';

// ── users ──────────────────────────────────────────────────────────────────
/**
 * Anonymous-first identity: look up a user by device id, creating one on first
 * sight. A race (two parallel first requests) is resolved by re-reading after a
 * unique-violation insert.
 */
export async function getOrCreateUserByDevice(deviceId: string): Promise<User> {
  const existing = await selectOne<User>('users', `device_id=eq.${encodeURIComponent(deviceId)}`);
  if (existing) return existing;
  try {
    return await insertOne<User>('users', { device_id: deviceId });
  } catch (err) {
    // Likely a concurrent insert hit the unique(device_id) constraint — re-read.
    const row = await selectOne<User>('users', `device_id=eq.${encodeURIComponent(deviceId)}`);
    if (row) return row;
    throw err;
  }
}

// ── business_profile ─────────────────────────────────────────────────────────
/** The user's current (latest) business profile, or null if none saved yet. */
export function getBusinessProfile(userId: string): Promise<BusinessProfile | null> {
  return selectOne<BusinessProfile>(
    'business_profile',
    `user_id=eq.${userId}&order=updated_at.desc`,
  );
}

export function getBusinessProfileById(userId: string, id: string): Promise<BusinessProfile | null> {
  return selectOne<BusinessProfile>('business_profile', `id=eq.${id}&user_id=eq.${userId}`);
}

/**
 * Save the user's business profile: update the existing one if present,
 * otherwise insert. One-profile-per-user for MVP (multi-profile can come later
 * via projects).
 */
export async function saveBusinessProfile(
  userId: string,
  input: BusinessProfileInput,
): Promise<BusinessProfile> {
  const current = await getBusinessProfile(userId);
  if (current) {
    const rows = await update<BusinessProfile>(
      'business_profile',
      `id=eq.${current.id}&user_id=eq.${userId}`,
      input,
    );
    return rows[0];
  }
  return insertOne<BusinessProfile>('business_profile', { ...input, user_id: userId });
}

// ── projects ──────────────────────────────────────────────────────────────────
export function listProjects(userId: string): Promise<Project[]> {
  return select<Project>('projects', `user_id=eq.${userId}&order=created_at.desc`);
}

export function createProject(
  userId: string,
  data: { name?: string; goal?: string; business_profile_id?: string | null },
): Promise<Project> {
  return insertOne<Project>('projects', { ...data, user_id: userId });
}

// ── generations ───────────────────────────────────────────────────────────────
export function createGeneration(data: {
  userId: string;
  type: GenerationType;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  model?: string | null;
  projectId?: string | null;
  businessProfileId?: string | null;
}): Promise<Generation> {
  return insertOne<Generation>('generations', {
    user_id: data.userId,
    type: data.type,
    input: data.input,
    output: data.output,
    model: data.model ?? null,
    project_id: data.projectId ?? null,
    business_profile_id: data.businessProfileId ?? null,
  });
}

export function listGenerations(userId: string, type?: GenerationType): Promise<Generation[]> {
  const typeFilter = type ? `&type=eq.${encodeURIComponent(type)}` : '';
  return select<Generation>(
    'generations',
    `user_id=eq.${userId}${typeFilter}&order=created_at.desc`,
  );
}

export function deleteGeneration(userId: string, id: string): Promise<void> {
  return remove('generations', `id=eq.${id}&user_id=eq.${userId}`);
}
