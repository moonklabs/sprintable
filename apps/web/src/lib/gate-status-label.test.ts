import { describe, expect, it } from 'vitest';
import { gateStatusLabel } from './gate-status-label';
import koMessages from '../../messages/ko.json';

// story #3806 PR 9(카디르 QA 실측 2026-09-11 — 테스트 갭) — 기존 렌더 테스트 3건은
// approved·rejected 2종만 대조해, held·voided 엔트리를 GATE_STATUS_LABEL_KEYS에서
// 빼도 RED 0이었다(단방향 검사 공허통과 — feedback_one_directional_check_vacuous_
// pass와 동형 함정). 여기서 쓰는 목록은 GATE_STATUS_LABEL_KEYS를 거꾸로 읽지 않고
// 독립적으로 하드코딩(backend Gate.status 실 쓰임 5종, gate-status-label.ts 주석
// 참고) — 매핑에서 엔트리를 빼면 그 값이 raw-fallback으로 떨어져 이 루프가 즉시
// 잡는다(맵을 거울처럼 읽는 루프였다면 엔트리 삭제 자체가 검사 대상에서도 같이
// 빠져 아무 것도 못 잡았을 것).
const KNOWN_GATE_STATUSES = ['pending', 'approved', 'rejected', 'held', 'voided'];

describe('gateStatusLabel — story #3806 PR 9(카디르 QA 실측 2026-09-11)', () => {
  const t = (key: string) => (koMessages.cage as Record<string, string>)[key] ?? key;

  it('⭐등재된 5종 status 전부 원시 문자열과 다른 낱말로 뜬다(엔트리 하나만 빠져도 이 루프가 그 값에서 RED)', () => {
    for (const status of KNOWN_GATE_STATUSES) {
      expect(gateStatusLabel(status, t)).not.toBe(status);
    }
  });

  it('미등재 값(미래 확장·오타 등)은 지어내지 않고 원문 그대로 폴백한다', () => {
    const identity = (key: string) => key;
    expect(gateStatusLabel('some_future_status', identity)).toBe('some_future_status');
  });
});
