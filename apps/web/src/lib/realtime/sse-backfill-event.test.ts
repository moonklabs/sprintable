// story #4245 — 연결 직후 백필 이벤트 판별(BE events.py 스트림이 백필 행 data에 `is_backfill: true`를 싣는다).
import { describe, expect, it } from 'vitest';
import { isBackfillEvent } from './sse-multiplexer';

describe('isBackfillEvent', () => {
  it('data의 is_backfill === true일 때만 백필', () => {
    expect(isBackfillEvent(JSON.stringify({ gate_id: 'g', is_backfill: true }))).toBe(true);
    expect(isBackfillEvent(JSON.stringify({ gate_id: 'g' }))).toBe(false);
    expect(isBackfillEvent(JSON.stringify({ is_backfill: 'true' }))).toBe(false);
    expect(isBackfillEvent(JSON.stringify({ is_backfill: false }))).toBe(false);
  });
  it('JSON이 아니거나 객체가 아니면 실시간으로 본다(재조회를 놓치지 않는 쪽)', () => {
    expect(isBackfillEvent('not json')).toBe(false);
    expect(isBackfillEvent('null')).toBe(false);
    expect(isBackfillEvent('[]')).toBe(false);
    expect(isBackfillEvent('')).toBe(false);
  });
});
