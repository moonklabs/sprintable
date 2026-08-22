import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCursorPageMeta, paginateInMemory, parseCursorMeta, parseCursorPageInput } from './pagination';

describe('parseCursorMeta (#2231 AC4 — 규약 A 하나만 전제, 규약 밖이면 조용히 삼키지 않는다)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('camelCase(hasMore/nextCursor) — FE가 buildCursorPageMeta로 직접 지은 응답', () => {
    const meta = parseCursorMeta({ limit: 20, hasMore: true, nextCursor: 'abc' }, 'test:camel');
    expect(meta).toEqual({ limit: 20, hasMore: true, nextCursor: 'abc', malformed: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('snake_case(has_more/next_cursor) — BE가 직접 내는 규약 A 응답(예: comments)', () => {
    const meta = parseCursorMeta({ limit: 20, has_more: true, next_cursor: 'xyz' }, 'test:snake');
    expect(meta).toEqual({ limit: 20, hasMore: true, nextCursor: 'xyz', has_more: true, next_cursor: 'xyz', malformed: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('마지막 페이지(hasMore:false) — nextCursor는 문자열이 아니어도(null) 조용히 통과', () => {
    const meta = parseCursorMeta({ limit: 20, has_more: false, next_cursor: null }, 'test:last-page');
    expect(meta).toEqual({ limit: 20, hasMore: false, nextCursor: null, has_more: false, next_cursor: null, malformed: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('⛔양성대조 — meta가 아예 없으면(undefined) 조용히 hasMore:false로 낙하하지 않고 console.error로 드러낸다', () => {
    const meta = parseCursorMeta(undefined, 'test:missing-meta');
    expect(meta).toEqual({ limit: 0, hasMore: false, nextCursor: null, malformed: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('test:missing-meta');
  });

  it('⛔양성대조 — 오늘 실제로 걸린 자리(agent-runs 이중포장): meta가 이중포장된 전체 봉투이면(hasMore/has_more 둘 다 없음) 드러난다', () => {
    // apiSuccess(await _r.json())가 BE의 {data,error,meta}를 통째로 다시 data에 얹으면
    // 바깥 meta는 항상 null이다 — 이 경우를 재현.
    const meta = parseCursorMeta(null, 'test:double-wrapped');
    expect(meta.hasMore).toBe(false);
    expect(meta.nextCursor).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('규약 밖 형태(예: offset+limit 래퍼, 규약 C)도 드러난다', () => {
    const meta = parseCursorMeta({ items: [], total: 5, offset: 0, limit: 20 }, 'test:convention-c');
    expect(meta.hasMore).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('pagination helpers', () => {
  it('clamps limit and normalizes cursor input', () => {
    expect(parseCursorPageInput({ limit: 999, cursor: '  abc  ' }, { defaultLimit: 20, maxLimit: 50 })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
  });

  it('returns page metadata from limit + 1 rows', () => {
    const { page, meta } = buildCursorPageMeta([
      { created_at: '3' },
      { created_at: '2' },
      { created_at: '1' },
    ], 2, 'created_at');

    expect(page).toEqual([{ created_at: '3' }, { created_at: '2' }]);
    expect(meta).toEqual({ limit: 2, hasMore: true, nextCursor: '2' });
  });
});

describe('paginateInMemory (epics: 백엔드 정렬/cursor 미지원)', () => {
  // 백엔드가 무작위 순서로 반환하는 상황을 모사 (created_at 동률 포함)
  const rows = [
    { id: 'e', created_at: '2026-01-03T00:00:00Z' },
    { id: 'a', created_at: '2026-01-05T00:00:00Z' },
    { id: 'c', created_at: '2026-01-04T00:00:00Z' }, // c, d 동률
    { id: 'd', created_at: '2026-01-04T00:00:00Z' },
    { id: 'b', created_at: '2026-01-05T00:00:00Z' }, // a, b 동률
    { id: 'f', created_at: '2026-01-02T00:00:00Z' },
  ];

  it('첫 페이지는 created_at desc + id desc 로 결정적 정렬한다', () => {
    const { page, meta } = paginateInMemory(rows, 2, 'created_at');
    expect(page.map((r) => r.id)).toEqual(['b', 'a']); // 05/b, 05/a
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toBe('2026-01-05T00:00:00Z|a');
  });

  it('cursor 전진 시 동률 항목을 중복/누락 없이 이어붙인다', () => {
    const all: string[] = [];
    let cursor: string | null = null;
    // 더보기 반복 시뮬레이션
    for (let i = 0; i < 10; i++) {
      const { page, meta } = paginateInMemory(rows, 2, 'created_at', cursor);
      all.push(...page.map((r) => r.id));
      if (!meta.hasMore) break;
      cursor = meta.nextCursor;
    }
    // 각 에픽이 정확히 1회, 전체가 정렬 순서대로 (AC1: 중복 0)
    expect(all).toEqual(['b', 'a', 'd', 'c', 'e', 'f']);
    expect(new Set(all).size).toBe(rows.length);
  });

  it('마지막 페이지는 hasMore=false, nextCursor=null', () => {
    const { meta } = paginateInMemory(rows.slice(0, 2), 5, 'created_at');
    expect(meta.hasMore).toBe(false);
    expect(meta.nextCursor).toBeNull();
  });
});
