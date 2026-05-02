/**
 * Minimal structural type for the Supabase client used in SaaS-only code paths.
 * OSS 빌드에서는 실제 Supabase 클라이언트가 주입되지 않으므로 구조적 타입으로 정의한다.
 *
 * `data` 필드는 Supabase 쿼리 결과를 담는 런타임 객체를 표현한다.
 * SaaS 코드 경로에서 실제 Supabase SDK 반환값과 구조적으로 호환되므로,
 * 호출처에서 구체적 타입으로 캐스팅해 사용한다.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbData = any;

/**
 * Minimal structural type for Supabase/Postgrest errors.
 * Mirrors the shape of PostgrestError so callers can access `.code` and `.message`
 * without importing from the Supabase SDK directly.
 */
export type DbError = { code?: string; message?: string; details?: string; hint?: string } | null;

/** Minimal structural type for a Supabase Realtime channel handle. */
export type RealtimeChannelLike = {
  on: (event: string, filter: unknown, callback: (payload: { new: unknown; old: unknown }) => void) => RealtimeChannelLike;
  subscribe: (callback?: (status: string) => void) => RealtimeChannelLike;
};

type QueryBuilder = {
  select: (...args: unknown[]) => QueryBuilder;
  insert: (data: unknown, opts?: unknown) => QueryBuilder;
  update: (data: unknown) => QueryBuilder;
  upsert: (data: unknown, opts?: unknown) => QueryBuilder;
  delete: () => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  neq: (col: string, val: unknown) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  is: (col: string, val: unknown) => QueryBuilder;
  like: (col: string, val: string) => QueryBuilder;
  ilike: (col: string, val: string) => QueryBuilder;
  gte: (col: string, val: unknown) => QueryBuilder;
  lte: (col: string, val: unknown) => QueryBuilder;
  gt: (col: string, val: unknown) => QueryBuilder;
  lt: (col: string, val: unknown) => QueryBuilder;
  order: (col: string, opts?: unknown) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  range: (from: number, to: number) => QueryBuilder;
  single: () => Promise<{ data: DbData; error: DbError }>;
  maybeSingle: () => Promise<{ data: DbData; error: DbError }>;
  not: (col: string, op: string, val: unknown) => QueryBuilder;
  filter: (col: string, op: string, val: unknown) => QueryBuilder;
  or: (filter: string, opts?: unknown) => QueryBuilder;
  contains: (col: string, val: unknown) => QueryBuilder;
  throwOnError: () => QueryBuilder;
  then: Promise<{ data: DbData; error: DbError; count?: number | null }>['then'];
};

export type SupabaseClient = {
  from: (table: string) => QueryBuilder;
  rpc: (fn: string, args?: Record<string, unknown>) => QueryBuilder;
  channel: (name: string) => RealtimeChannelLike;
  removeChannel: (channel: RealtimeChannelLike) => Promise<unknown>;
  auth: {
    getUser: () => Promise<{ data: { user: { id: string; email?: string } | null }; error: unknown }>;
    getSession: () => Promise<{ data: { session: unknown }; error: unknown }>;
  };
};
