const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface CursorPageInput {
  limit?: number | null;
  cursor?: string | null;
}

export interface CursorPageMeta {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  [key: string]: unknown;
}

export function parseCursorPageInput(input?: CursorPageInput, defaults?: { defaultLimit?: number; maxLimit?: number }) {
  const defaultLimit = defaults?.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = defaults?.maxLimit ?? MAX_LIMIT;
  const rawLimit = Number(input?.limit ?? defaultLimit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.trunc(rawLimit), maxLimit))
    : defaultLimit;

  return {
    limit,
    cursor: input?.cursor?.trim() ? input.cursor.trim() : null,
  };
}

export function buildCursorPageMeta<T extends object, K extends keyof T & string>(
  rows: T[] | null | undefined,
  limit: number,
  cursorField: K,
): { page: T[]; meta: CursorPageMeta } {
  const items = rows ?? [];
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const tail = page.at(-1);

  return {
    page,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore && tail ? String(tail[cursorField] ?? '') || null : null,
    },
  };
}
