import { describe, expect, it } from 'vitest';
import { buildCursorPageMeta, paginateInMemory, parseCursorPageInput } from './pagination';

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
