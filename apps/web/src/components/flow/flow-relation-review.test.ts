import { describe, expect, it } from 'vitest';
import { selectUnconfirmedCandidates, buildReviewQueue, RELATION_REVIEW_QUEUE_CAP } from './flow-relation-review';
import type { RawReferenceCandidate } from './derive-flow-map';

function makeCandidate(overrides: Partial<RawReferenceCandidate> = {}): RawReferenceCandidate {
  return {
    id: 'c1', source_id: 's1', target_id: 't1', relation_kind: null, status: 'estimated',
    ...overrides,
  };
}

describe('selectUnconfirmedCandidates — 훑기 큐의 대상 필터(doc flow-port-slot-spec §㉥)', () => {
  it('relation_kind=null·status=estimated인 후보만 남긴다', () => {
    const candidates = [
      makeCandidate({ id: 'a', relation_kind: null, status: 'estimated' }),
      makeCandidate({ id: 'b', relation_kind: 'spawned', status: 'estimated' }),
      makeCandidate({ id: 'c', relation_kind: null, status: 'declared' }),
      makeCandidate({ id: 'd', relation_kind: 'similar_case', status: 'estimated' }),
    ];
    expect(selectUnconfirmedCandidates(candidates).map((c) => c.id)).toEqual(['a']);
  });

  it('cited_as_evidence·similar_case·explicitly_unrelated은 relation_kind가 null이 아니므로 자동으로 빠진다', () => {
    const candidates = [
      makeCandidate({ id: 'a', relation_kind: 'cited_as_evidence', status: 'estimated' }),
      makeCandidate({ id: 'b', relation_kind: 'explicitly_unrelated', status: 'estimated' }),
    ];
    expect(selectUnconfirmedCandidates(candidates)).toEqual([]);
  });

  it('빈 배열이면 빈 배열을 낸다', () => {
    expect(selectUnconfirmedCandidates([])).toEqual([]);
  });

  // 회귀 가드 — status 조건이 실수로 빠지면 이미 declared인 것까지 훑기 큐에 다시 뜬다
  // (일괄 확定 재발과 같은 급의 결함 — 처리한 것이 안 사라지는 것으로 보인다).
  it('뮤테이션 가드 — status===estimated 조건이 없으면 declared도 새는지 확인', () => {
    const candidates = [makeCandidate({ id: 'a', relation_kind: null, status: 'declared' })];
    expect(selectUnconfirmedCandidates(candidates)).toEqual([]);
  });
});

describe('buildReviewQueue — 묶음 상한·정렬(AC11·12, 2026-08-07 착수 시 재측정 후 신설)', () => {
  it('returns the unconfirmed set unchanged (no reorder) when count is at or below the cap', () => {
    const candidates = [
      makeCandidate({ id: 'a', target_id: 'other' }),
      makeCandidate({ id: 'b', target_id: 'same-epic' }),
    ];
    const epicById = { other: 'epic-B', 'same-epic': 'epic-A' };
    expect(buildReviewQueue(candidates, 'epic-A', epicById, 2).map((c) => c.id)).toEqual(['a', 'b']);
  });

  // AC12 핵심 — 상한을 «실제로» 넘겨서 잰다(cap=1 < 후보 2건). "cap(기본 20) > 실측
  // max(17)라 이 경로가 원천 안 걸린다"로 닫으면 안 된다는 규율(#2366 AC9와 동급)을 여기서
  // 지킨다 — 기본값이 아니라 주입된 작은 cap으로 초과 상태를 강제한다.
  it('when exceeding the cap, same-epic ("지금 보는 갈래") targets sort first, then the queue is truncated to the cap', () => {
    const candidates = [
      makeCandidate({ id: 'other-first', target_id: 'other' }), // 다른 갈래인데 배열상 먼저 옴
      makeCandidate({ id: 'same-epic', target_id: 'same-epic' }),
    ];
    const epicById = { other: 'epic-B', 'same-epic': 'epic-A' };
    const result = buildReviewQueue(candidates, 'epic-A', epicById, 1);
    expect(result.map((c) => c.id)).toEqual(['same-epic']); // 같은 갈래가 우선, 상한 1로 잘림
  });

  it('does not crash when currentEpicId is null (no epic context) — everything ties, original order wins (stable sort)', () => {
    const candidates = [
      makeCandidate({ id: 'a', target_id: 't-a' }),
      makeCandidate({ id: 'b', target_id: 't-b' }),
    ];
    expect(buildReviewQueue(candidates, null, {}, 1).map((c) => c.id)).toEqual(['a']);
  });

  it('defaults to RELATION_REVIEW_QUEUE_CAP(20) when no cap is passed', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => makeCandidate({ id: `c${i}`, target_id: `t${i}` }));
    expect(buildReviewQueue(candidates, null, {})).toHaveLength(RELATION_REVIEW_QUEUE_CAP);
  });
});
