import { describe, expect, it } from 'vitest';
import { buildCursorPageMeta, parseCursorPageInput } from './pagination';

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
