import { describe, expect, it } from 'vitest';
import { selectUnconfirmedCandidates } from './flow-relation-review';
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
