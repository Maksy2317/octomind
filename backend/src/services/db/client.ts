// Thin typed PostgREST client for Supabase.
// Mirrors the raw-fetch pattern already used in routes/push.ts — no supabase-js,
// no ORM, zero new dependencies.
//
// The backend is a trusted server, so it authenticates with the SERVICE_ROLE
// key (bypasses RLS). The anon key (SUPABASE_KEY) is for the browser and is
// blocked by RLS on writes — using it here caused silent "42501 RLS violation"
// and no rows were persisted. Prefer the service key; fall back to anon so
// reads still work if the service key isn't set yet.

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';

export function isDbConfigured(): boolean {
  return Boolean(SB_URL && SB_KEY);
}

export class DbNotConfiguredError extends Error {
  constructor() {
    super('Supabase is not configured (SUPABASE_URL / SUPABASE_KEY missing)');
    this.name = 'DbNotConfiguredError';
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request<T>(path: string, init: RequestInit & { returnRepresentation?: boolean } = {}): Promise<T> {
  if (!isDbConfigured()) throw new DbNotConfiguredError();

  const { returnRepresentation, headers: extraHeaders, ...rest } = init;
  const h = headers({
    ...(returnRepresentation ? { Prefer: 'return=representation' } : {}),
    ...(extraHeaders as Record<string, string> | undefined),
  });

  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...rest, headers: h });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[DB] ${rest.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  // DELETE / no-representation calls may have an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : (undefined as unknown)) as T;
}

/** SELECT rows. `query` is a raw PostgREST query string (without leading `?`). */
export function select<T>(table: string, query = ''): Promise<T[]> {
  return request<T[]>(`${table}${query ? `?${query}` : ''}`);
}

/** SELECT and return the first row (or null). */
export async function selectOne<T>(table: string, query = ''): Promise<T | null> {
  const rows = await select<T>(table, query ? `${query}&limit=1` : 'limit=1');
  return rows[0] ?? null;
}

/** INSERT one row, returning the created row. */
export async function insertOne<T>(table: string, row: Record<string, unknown>): Promise<T> {
  const rows = await request<T[]>(table, {
    method: 'POST',
    body: JSON.stringify(row),
    returnRepresentation: true,
  });
  return rows[0];
}

/** UPDATE rows matching `query`, returning updated rows. */
export function update<T>(table: string, query: string, patch: Record<string, unknown>): Promise<T[]> {
  return request<T[]>(`${table}?${query}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    returnRepresentation: true,
  });
}

/**
 * UPSERT one row (merge duplicates on a unique constraint), returning the row.
 * `onConflict` is the column PostgREST should resolve conflicts on.
 */
export async function upsertOne<T>(
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
): Promise<T> {
  const rows = await request<T[]>(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    body: JSON.stringify(row),
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
  });
  return rows[0];
}

/** DELETE rows matching `query`. */
export async function remove(table: string, query: string): Promise<void> {
  await request<void>(`${table}?${query}`, { method: 'DELETE' });
}
