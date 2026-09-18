import { describe, expect, it } from 'vitest';
import { METRIC_KEYS, PENDING_SELECTOR_KEYS, SELECTABLE_METRIC_KEYS } from './types';

// story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — METRIC_KEYS(BE↔FE 드리프트
// 가드 CHANNEL_DECLARED_METRICS의 원소 타입 축)와 SELECTABLE_METRIC_KEYS(화면 선택기가
// 실제로 렌더하는 부분집합)가 갈라질 수 있게 된 뒤(opens/delivered는 선택기에 아직
// 안 연다) — 새 METRIC_KEYS를 추가했는데 SELECTABLE_METRIC_KEYS에도 PENDING_SELECTOR_
// KEYS(의도적 보류 명시 목록)에도 안 넣으면 "묵시 누락"이라 이 테스트가 RED로 잡는다.
describe('METRIC_KEYS ⊇ SELECTABLE_METRIC_KEYS ∪ PENDING_SELECTOR_KEYS — 묵시 누락 가드', () => {
  it('SELECTABLE_METRIC_KEYS와 PENDING_SELECTOR_KEYS를 합치면 METRIC_KEYS와 정확히 같다', () => {
    const union = new Set([...SELECTABLE_METRIC_KEYS, ...PENDING_SELECTOR_KEYS]);
    expect(union.size).toBe(METRIC_KEYS.length);
    for (const key of METRIC_KEYS) {
      expect(union.has(key)).toBe(true);
    }
  });

  it('SELECTABLE_METRIC_KEYS와 PENDING_SELECTOR_KEYS는 겹치지 않는다(한 키가 두 자리에 동시 등재되면 의도 불명확)', () => {
    for (const key of PENDING_SELECTOR_KEYS) {
      expect(SELECTABLE_METRIC_KEYS).not.toContain(key);
    }
  });

  it('지금 시점 보류 목록은 opens·delivered 2개뿐이다(PR4가 열면 이 배열에서 빠지고 이 단언도 같이 갱신)', () => {
    expect(PENDING_SELECTOR_KEYS).toEqual(['opens', 'delivered']);
  });
});
