import { describe, expect, it } from 'vitest';
import { findHardcodedAriaLabels, scanRepository } from './verify-no-hardcoded-aria-label';

describe('findHardcodedAriaLabels — 단위(패턴 자체)', () => {
  it('aria-label={`Move ${item} up`} 를 잡는다', () => {
    const hits = findHardcodedAriaLabels('<Button aria-label={`Move ${item} up`}>↑</Button>');
    expect(hits.length).toBe(1);
  });

  it('t(...) 호출은 안 잡는다(양성대조)', () => {
    const hits = findHardcodedAriaLabels("<Button aria-label={t('moveItemUpAction', { item })}>↑</Button>");
    expect(hits.length).toBe(0);
  });

  it('한국어 하드코딩 문자열은 이 스캔의 관심사가 아니다(§17-20은 t(...) 축, 이 가드는 «영문» 축만)', () => {
    const hits = findHardcodedAriaLabels('<Button aria-label={`위로 이동`}>↑</Button>');
    expect(hits.length).toBe(0);
  });
});

describe('story #3557 회귀가드 — 전수 스캔 0건', () => {
  // story #3902 — 부하 시 vitest 기본 5000ms를 넘길 수 있는 실 전수 스캔(측정: 동시부하
  // 재현 5회 = 97·88·228·68·102ms 중 최댓값 228ms → ×3 ≈ 684ms → 1000ms로 반올림).
  it('새 FAIL은 없다(#3557이 알려진 3곳을 전부 고친 뒤의 clean-slate)', () => {
    expect(scanRepository()).toEqual([]);
  }, 1000);
});
