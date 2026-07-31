import {
  parseReferenceCandidateEdges, type FlowMapEdge, type RawReferenceCandidate,
} from './derive-flow-map';

/** doc `flow-port-slot-spec` ㉢ — 포트가 실제로 만드는 3종(§0-1: cited_as_evidence·
 * similar_case·explicitly_unrelated은 만들어도 안 그려지므로 제외). `null`=「종류는
 * 나중에 정하겠습니다」(declare만, relation-kind는 안 부른다 — AC6). */
export type PortLinkKind = 'spawned' | 'followed' | 'superseded';

export const PORT_LINK_KINDS: PortLinkKind[] = ['spawned', 'followed', 'superseded'];

export interface DeclareLinkCallParams {
  /** POST를 쏠 대상 story id(URL path의 {id}) — 드래그 방향과 항상 같지는 않다(아래 참고). */
  apiSourceId: string;
  targetId: string;
  relationKind: PortLinkKind | null;
}

/**
 * story #2353 — 사람이 노드A(드래그 시작)에서 노드B(놓은 곳)로 끌었을 때, 실제 API 호출에
 * 쓸 {apiSourceId, targetId}를 계산한다.
 *
 * ⛔이 매핑이 대칭이 아니다 — derive-flow-map.ts의 기존(이미 서 있는, 이 스토리가 새로
 * 만들지 않는) 방향 규칙 때문이다:
 *   spawned   — "source가 target을 낳았다" → 그대로(fromNodeId=source=드래그 시작)
 *   followed  — "source가 target을 따른다" → target이 먼저(뒤집음)
 *   superseded— "source가 target을 대체했다" → target이 «옛것»(뒤집음)
 * 사람은 항상 "먼저 누른 노드(A) → 나중에 놓은 노드(B)"의 시간/인과 순서로 끈다 — 그린
 * 화살표가 «항상 A→B»로 보이려면, followed/superseded는 API 호출의 source를 B로(그래서
 * "B가 A를 따른다/대체했다"는 자연스러운 문장이 되고, 뒤집기를 거쳐 화면엔 A→B로 그려진다),
 * spawned는 A 그대로 보내야 한다. 이 함수가 그 계산을 «한 곳»에서만 한다(#2223 문서의
 * "뒤집기는 이 함수 한 곳에서만 한다"와 같은 원칙).
 */
export function resolveDeclareLinkCall(
  dragStartId: string,
  dragEndId: string,
  relationKind: PortLinkKind | null,
): DeclareLinkCallParams {
  if (relationKind === 'followed' || relationKind === 'superseded') {
    return { apiSourceId: dragEndId, targetId: dragStartId, relationKind };
  }
  return { apiSourceId: dragStartId, targetId: dragEndId, relationKind };
}

/** BE 응답(POST .../reference-candidates)을 로컬 FlowMapEdge로 바꾼다 — 방향 뒤집기 로직을
 * 새로 안 짜고 `parseReferenceCandidateEdges`(이미 검증된 그 함수) 하나에 그대로 태워
 * 재사용한다(같은 자로 both 렌더 경로가 재는 것 — 갈릴 수 없다, story #2354/#2720과 같은
 * 원칙). */
export function declareResponseToEdge(
  apiSourceId: string,
  response: { target_id: string; relation_kind: string | null; status: string },
): FlowMapEdge {
  const raw: RawReferenceCandidate = {
    id: 'local', // parseReferenceCandidateEdges는 id를 안 씀 — FlowMapEdge에 id 필드가 없다.
    source_id: apiSourceId,
    target_id: response.target_id,
    relation_kind: response.relation_kind as RawReferenceCandidate['relation_kind'],
    status: response.status as RawReferenceCandidate['status'],
  };
  const [edge] = parseReferenceCandidateEdges([raw]);
  return edge!;
}

/** AC16 — 한 쌍에 관계는 하나. 자기 자신도 놓을 수 없는 대상이다(드래그 규격 ㉡). 방향
 * 무관 — 어느 쪽으로든 이미 이어져 있으면 새로 못 잇는다(종류를 바꾸려면 «기존 것을
 * 고치는» 것이지 새로 잇는 게 아니라는 스토리 규격 그대로). */
export function isValidPortDropTarget(
  dragStartId: string,
  candidateId: string,
  existingEdges: FlowMapEdge[],
): boolean {
  if (candidateId === dragStartId) return false;
  return !existingEdges.some(
    (e) => (e.fromNodeId === dragStartId && e.toNodeId === candidateId)
      || (e.fromNodeId === candidateId && e.toNodeId === dragStartId),
  );
}
