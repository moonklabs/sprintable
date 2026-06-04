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

/**
 * 백엔드가 cursor/limit를 지원하지 않고 전체 목록을 정렬 없이 반환하는 경우(에픽 GET /api/v2/epics)
 * 라우트에서 결정적으로 정렬한 뒤 cursor를 적용해 한 페이지를 잘라낸다.
 *
 * - 정렬: cursorField 내림차순, 동률(타이) 시 id 내림차순 — 백엔드 ORDER BY 부재로 인한
 *   비결정적 순서/타이를 안정화한다.
 * - cursor: `${cursorField}|${id}` 복합 키. created_at 동률에서도 중복/누락 없이 다음 페이지로 전진한다.
 *   client는 이 값을 불투명(opaque) 문자열로 그대로 되돌려준다.
 */
export function paginateInMemory<T extends { id: string }, K extends keyof T & string>(
  rows: T[] | null | undefined,
  limit: number,
  cursorField: K,
  cursor?: string | null,
): { page: T[]; meta: CursorPageMeta } {
  const keyVal = (r: T) => String(r[cursorField] ?? '');
  const sorted = [...(rows ?? [])].sort((a, b) => {
    const ka = keyVal(a), kb = keyVal(b);
    if (ka !== kb) return ka < kb ? 1 : -1;            // cursorField desc
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;     // id desc 타이브레이크
  });

  let afterCursor = sorted;
  if (cursor) {
    const sep = cursor.indexOf('|');
    const cKey = sep >= 0 ? cursor.slice(0, sep) : cursor;
    const cId = sep >= 0 ? cursor.slice(sep + 1) : '';
    afterCursor = sorted.filter((r) => {
      const k = keyVal(r);
      return k !== cKey ? k < cKey : r.id < cId;       // cursor 항목 "이후"만
    });
  }

  const hasMore = afterCursor.length > limit;
  const page = hasMore ? afterCursor.slice(0, limit) : afterCursor;
  const tail = page.at(-1);

  return {
    page,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore && tail ? `${keyVal(tail)}|${tail.id}` : null,
    },
  };
}
