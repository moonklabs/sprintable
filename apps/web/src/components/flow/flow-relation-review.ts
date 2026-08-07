import type { RawReferenceCandidate } from './derive-flow-map';

/** doc `flow-port-slot-spec` §㉥ — 「확認하기」 훑기의 대상은 relation_kind=null(«종
 * 미정») · status=estimated(«아직 사람이 안 본») 둘 다인 후보뿐이다. similar_case 등
 * 3종은 이 함수가 다루지 않는다(#2356 별건 — #2354 패널의 "한 줄 더"). `GET
 * /api/stories/{id}/reference-candidates`가 이미 source=이 story인 것만 내므로
 * (list_candidates_for_source) 노드별 필터링이 따로 필요 없다 — 받은 배열 전체가 이미
 * 「이 노드의」 후보다. */
export function selectUnconfirmedCandidates(candidates: RawReferenceCandidate[]): RawReferenceCandidate[] {
  return candidates.filter((c) => c.relation_kind === null && c.status === 'estimated');
}
