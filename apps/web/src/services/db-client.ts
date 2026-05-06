/**
 * Minimal structural type for the Supabase-compatible DB client used by service
 * functions. Services receive this from API route handlers or pass `undefined`
 * in OSS mode. The full Supabase SDK type is not imported to keep the web app
 * free of that direct dependency.
 */

export type DbQueryResult<T = unknown> = Promise<{ data: T | null; error: DbError | null; count?: number | null }>;

export interface DbError {
  code?: string;
  message?: string;
}

// Minimal query builder — enough to satisfy TypeScript without importing the full SDK.
export interface DbQueryBuilder {
  select(columns?: string, options?: Record<string, unknown>): this;
  insert(data: unknown): this;
  update(data: unknown): this;
  upsert(data: unknown, options?: Record<string, unknown>): this;
  delete(): this;
  eq(column: string, value: unknown): this;
  neq(column: string, value: unknown): this;
  is(column: string, value: unknown): this;
  in(column: string, values: unknown[]): this;
  like(column: string, value: string): this;
  ilike(column: string, value: string): this;
  lt(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  gt(column: string, value: unknown): this;
  gte(column: string, value: unknown): this;
  or(filter: string): this;
  not(column: string, operator: string, value: unknown): this;
  contains(column: string, value: unknown): this;
  order(column: string, options?: Record<string, unknown>): this;
  limit(count: number): this;
  range(from: number, to: number): this;
  maybeSingle(): DbQueryResult;
  single(): DbQueryResult;
  then<R>(
    onfulfilled: (value: { data: unknown; error: DbError | null; count?: number | null }) => R,
    onrejected?: (reason: unknown) => R,
  ): Promise<R>;
}

export interface DbClient {
  from(table: string): DbQueryBuilder;
  rpc(name: string, params?: Record<string, unknown>): DbQueryBuilder;
  channel(name: string): unknown;
  removeChannel(channel: unknown): Promise<void>;
}
