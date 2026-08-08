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

/** story #2358 AC11 — 「묶음 상한」. 근거: AC1의 "최대 17건"은 백필(#2223) 前 7.7%만 채워진
 * 표 위에서 잰 수라 착수 前엔 규격을 지탱 못 하는 값이었다. 착수 시점 실측(디디, dev DB,
 * 2026-08-07) 재확認 — 백필 후 max_per_node=17·p90=4·total=1277(3.7배 증가, AC13). 최댓값은
 * 안 밀렸지만(고르게 분산) PO 판정으로 상한은 여전히 둔다 — 근거는 "170"이 아니라 향후
 * 백필/꼬리 대비 여유(max 17 + 여유). */
export const RELATION_REVIEW_QUEUE_CAP = 20;

/** story #2358 AC12 — 상한을 넘으면 "지금 보는 갈래에 닿은 것"(=지금 훑는 story 자신의
 * epic)을 우선 노출한다. ⛔기계확신순 금지(reference_semantic_candidates에 confidence
 * 필드조차 없다 — 애초에 그 축으로 정렬할 재료가 없다) — 정렬 기준을 "확신"이 아니라
 * "맥락"으로 두면 사람이 검산이 아니라 추인을 하게 되는 것을 막는다(doc 판정 그대로).
 * cap 을 매개변수로 받는 이유 — AC12 검증은 "지금 max(17) < cap(20)이라 초과 경로가 원천
 * 안 걸림"으로 닫으면 안 되고(#2366 AC9 규율과 같은 급), 테스트가 cap을 일부러 낮춰 실제
 * 초과 상태를 만들어 정렬이 도는지 값으로 재야 한다. */
export function buildReviewQueue(
  candidates: RawReferenceCandidate[],
  currentEpicId: string | null,
  targetEpicById: Record<string, string | null | undefined>,
  cap: number = RELATION_REVIEW_QUEUE_CAP,
): RawReferenceCandidate[] {
  const unconfirmed = selectUnconfirmedCandidates(candidates);
  if (unconfirmed.length <= cap) return unconfirmed;
  const branchRank = (c: RawReferenceCandidate) => (
    currentEpicId !== null && targetEpicById[c.target_id] === currentEpicId ? 0 : 1
  );
  return [...unconfirmed].sort((a, b) => branchRank(a) - branchRank(b)).slice(0, cap);
}
