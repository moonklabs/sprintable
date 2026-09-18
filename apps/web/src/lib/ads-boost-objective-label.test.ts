import { describe, expect, it } from 'vitest';
import { adsBoostObjectiveLabel } from './ads-boost-objective-label';

// story #3806(Phase3·3-2 PR5, 정정1 — 페드루 PO 리뷰 2026-09-11 13:00Z 실측) — 봉인
// 목표 표시가 원시 enum("POST_ENGAGEMENT" 등)을 그대로 찍던 결함의 회귀 가드.
describe('adsBoostObjectiveLabel — story #3806 정정1', () => {
  const t = (key: string) => {
    const map: Record<string, string> = {
      boostObjective_POST_ENGAGEMENT: '참여',
      boostObjective_REACH: '도달',
      boostObjective_LINK_CLICKS: '트래픽',
    };
    return map[key] ?? key;
  };

  it('⭐등재된 세 값 전부 사람 낱말로 뜬다(원시 enum 노출 방지)', () => {
    expect(adsBoostObjectiveLabel('POST_ENGAGEMENT', t)).toBe('참여');
    expect(adsBoostObjectiveLabel('REACH', t)).toBe('도달');
    expect(adsBoostObjectiveLabel('LINK_CLICKS', t)).toBe('트래픽');
  });

  it('미등재 값·null·undefined는 지어내지 않고 원시값/빈 문자열로 폴백한다', () => {
    expect(adsBoostObjectiveLabel('SOME_FUTURE_OBJECTIVE', t)).toBe('SOME_FUTURE_OBJECTIVE');
    expect(adsBoostObjectiveLabel(null, t)).toBe('');
    expect(adsBoostObjectiveLabel(undefined, t)).toBe('');
  });
});
