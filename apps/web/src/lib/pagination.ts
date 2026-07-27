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

/**
 * story #2231 AC4 — 클라이언트가 커서 페이지네이션 meta를 읽는 공용 진입점.
 *
 * 규약 A(#2231)는 두 가지 합법적인 표기로 온다: BE가 직접 내는 응답은 snake_case
 * (has_more/next_cursor, 예: comments — #2230 이후), FE 프록시가 buildCursorPageMeta로
 * 직접 지어내는 응답은 camelCase(hasMore/nextCursor, 예: docs/goals/stories/tasks). 둘 다
 * "규약 A 안"이라 정상 — 이 함수가 어느 쪽이든 받아 하나로 정규화한다.
 *
 * ⛔진짜 문제는 **둘 다 없는 경우**(meta 자체가 없거나, 다른 규약(B/C)이거나, #2230 이전의
 * 이중포장처럼 meta가 통째로 유실된 경우)를 `json.meta?.nextCursor ?? null` 같은 옵셔널
 * 체이닝이 "다음 페이지 없음"과 구분 없이 조용히 삼켰다는 것 — 오늘 그 병의 정확한 모양이다.
 * 이 함수는 그 경우를 삼키지 않는다: 화면은 "더 보기 없음"으로 안전하게 낙하시키되(부분실패로
 * 전면 에러를 만들지 않는 house style 유지), console.error로 시끄럽게 드러낸다.
 */
export function parseCursorMeta(meta: unknown, source: string): CursorPageMeta {
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    const hasCamel = typeof m['hasMore'] === 'boolean';
    const hasSnake = typeof m['has_more'] === 'boolean';
    if (hasCamel || hasSnake) {
      const hasMore = (hasCamel ? m['hasMore'] : m['has_more']) as boolean;
      const nextCursorRaw = hasCamel ? m['nextCursor'] : m['next_cursor'];
      const nextCursor = typeof nextCursorRaw === 'string' ? nextCursorRaw : null;
      const limit = typeof m['limit'] === 'number' ? m['limit'] : 0;
      return { ...m, limit, hasMore, nextCursor };
    }
  }
  console.error(
    `[pagination] ${source}: cursor page meta가 규약 A(hasMore/has_more) 형태가 아니다 — ` +
    `"더 보기 없음"으로 낙하하지만 실제로는 더 있을 수 있다(story #2231 AC4). meta=`,
    meta,
  );
  return { limit: 0, hasMore: false, nextCursor: null };
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
