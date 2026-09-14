import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCursorPageMeta, buildHeaderCursorPageMeta, paginateInMemory, parseCursorMeta, parseCursorPageInput } from './pagination';

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

// story #3857(PO CHANGES①, 2026-09-14 09:01Z) — BE 4곳(agent_runs·standups·sprints·
// retros)이 X-Next-Cursor를 페이지가 비어 있지 않으면 항상 낸다(존재=「더 있음」의
// 증거가 아님). 첫 페이지(cursor 미지정)는 X-Total-Count가 정확해 exact 비교가
// 가능하고, cursor 페이지(또는 total 미수신)는 기존 보수 규칙(꽉 찬 페이지+커서)으로
// 남는다 — 두 분기가 실제로 다른 값을 낼 때만 이 판정이 의미 있다(테스트 2).
describe('buildHeaderCursorPageMeta(story #3857 PO CHANGES①)', () => {
  it('첫 페이지(cursor 無)·totalCount 초과분 있음 → hasMore=true', () => {
    const meta = buildHeaderCursorPageMeta({
      dataLength: 50,
      requestedLimit: 50,
      hasCursorParam: false,
      nextCursorHeader: '2026-09-14T08:00:00Z',
      totalCountHeader: 312,
    });
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toBe('2026-09-14T08:00:00Z');
  });

  it('첫 페이지(cursor 無)·꽉 찬 페이지가 곧 totalCount 전체 → hasMore=false(구 length===limit 규칙이면 오탐 true였을 자리)', () => {
    // BE는 이 경우에도 페이지가 비어 있지 않으므로 X-Next-Cursor를 싣는다(agent_runs.py:127류) —
    // 옛 conservative 규칙(length===limit && nextCursor!==null)이면 이 케이스가 hasMore=true로
    // 잘못 떨어진다. exact-total 분기가 이 오탐을 막는다.
    const meta = buildHeaderCursorPageMeta({
      dataLength: 50,
      requestedLimit: 50,
      hasCursorParam: false,
      nextCursorHeader: '2026-09-14T08:00:00Z', // BE가 비어있지 않아 여전히 실어 보냄
      totalCountHeader: 50, // 그런데 전체가 정확히 50 — 더 없음
    });
    expect(meta.hasMore).toBe(false);
    expect(meta.nextCursor).toBeNull(); // 더 없다고 판정했으니 커서를 실어 보내지 않는다
  });

  it('cursor 페이지(2쪽 이후)는 totalCount가 있어도 exact 비교를 쓰지 않고 보수 규칙(꽉 참+커서)을 쓴다', () => {
    const meta = buildHeaderCursorPageMeta({
      dataLength: 50,
      requestedLimit: 50,
      hasCursorParam: true, // PO CHANGES①의 명시 범위 — exact 분기는 첫 페이지만
      nextCursorHeader: '2026-09-14T09:00:00Z',
      totalCountHeader: 50, // 첫 페이지 케이스와 동일 total이지만 cursor가 있어 분기가 다르다
    });
    expect(meta.hasMore).toBe(true); // 보수 규칙 — 꽉 찼고 커서가 있으니 「더 있을 수 있음」
  });

  it('totalCount 미수신(null)이면 cursor 유무와 무관하게 보수 규칙으로 낙하한다', () => {
    const meta = buildHeaderCursorPageMeta({
      dataLength: 50,
      requestedLimit: 50,
      hasCursorParam: false,
      nextCursorHeader: '2026-09-14T08:00:00Z',
      totalCountHeader: null,
    });
    expect(meta.hasMore).toBe(true); // exact 비교 불가 → 보수 규칙(꽉 참+커서)
  });
});
