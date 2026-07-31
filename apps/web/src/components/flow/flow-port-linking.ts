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

export type UndoTitleResolution =
  | { key: 'portUndoTitle' }
  | { key: 'portUndoTitleOther'; name: string }
  | { key: 'portUndoTitleUnknownAuthor' };

/** doc `flow-port-slot-spec` ㉣ v1.1 정정 — 서명의 «누가»를 확認 없이 「내가」로 쓰지 않는다
 * (되돌리기 다이얼로그의 확認 버튼이 「지우기」라, 남의 것을 내 것으로 읽히는 오인이 파괴적
 * 조작 바로 앞에 선다 — 가디언 §H-2 위반). declaredBy와 currentTeamMemberId 둘 다 있어야만
 * 「내가」/「{이름}이」로 확定하고, 어느 한쪽이라도 없거나(레이스로 currentTeamMemberId가 아직
 * 안 실렸거나) memberMap에 이름이 없으면 중립(「사람이 만든 연결입니다」)으로 떨어진다 —
 * 모르는 채 단정하지 않는다. */
export function resolveUndoTitle(
  declaredBy: string | null,
  currentTeamMemberId: string | null | undefined,
  memberMap: Record<string, { name: string }>,
): UndoTitleResolution {
  if (!declaredBy || !currentTeamMemberId) return { key: 'portUndoTitleUnknownAuthor' };
  if (declaredBy === currentTeamMemberId) return { key: 'portUndoTitle' };
  const name = memberMap[declaredBy]?.name;
  return name ? { key: 'portUndoTitleOther', name } : { key: 'portUndoTitleUnknownAuthor' };
}

/** AC16 — 한 쌍에 관계는 하나. 자기 자신도 놓을 수 없는 대상이다(드래그 규격 ㉡). 방향
 * 무관 — 어느 쪽으로든 이미 이어져 있으면 새로 못 잇는다(종류를 바꾸려면 «기존 것을
 * 고치는» 것이지 새로 잇는 게 아니라는 스토리 규격 그대로).
 *
 * ⛔story #2224 AC1 후속(2026-07-31, 유나+까심 가디언 리뷰, PR#2737) — 두 가지를 «미리»
 * 막는다. 놓게 두고 「아직 안 됩니다」로 알리는 방식은 안 된다 — POST는 이미 서버에 남고,
 * 「아직」은 만료일 있는 약속인데 그 조건이 코드에 없으면 문장만 남기 때문이다.
 *
 * ①레인 간(목표↔목표) 잇기 — `laneIdByNodeId`가 두 노드 다 알고 있는데 레인이 다르면
 * false. POST가 나가도 deriveFlowMapLane이 다른 레인 좌표계의 선을 못 그려 "서버엔
 * 생겼는데 화면은 조용한"(㉦-2 "실패인데 선이 서면 안 된다"의 거울상) 결함이 난다.
 * **풀리는 조건**: goal-edges(BE #2726/#2360, 목표↔목표 굵은 선)가 서면 이 검사를 뺀다.
 * `laneIdByNodeId`가 비어 있으면(단일-레인 호출부처럼 레인 정보를 안 넘기면) 통과한다.
 *
 * ②과거(past) 노드 — `pastNodeIds`에 있으면(드래그 시작이든 대상이든) false. 멀티레인의
 * `findEpicIdForStoryId`(flow-multi-lane-canvas.tsx)가 now/upcoming만 검색하고 past를
 * 안 보므로, 과거 노드가 얽히면 어느 레인의 edges에 얹을지 못 찾아 로컬 state가 조용히
 * 안 바뀐다 — 그런데 서버 POST는 성공(ok:true)해 «반짝하고 사라지는» 성공 토스트만 남고
 * 아무 흔적도 없다(까심 QA 지적 — "실패가 조용하다"의 성공판). **풀리는 조건**:
 * `findEpicIdForStoryId`가 `pastItemsByEpic`까지 검색하도록 넓히면 이 제약을 뺄 수 있다. */
export function isValidPortDropTarget(
  dragStartId: string,
  candidateId: string,
  existingEdges: FlowMapEdge[],
  laneIdByNodeId: Map<string, string> = new Map(),
  pastNodeIds: Set<string> = new Set(),
): boolean {
  if (candidateId === dragStartId) return false;
  if (pastNodeIds.has(dragStartId) || pastNodeIds.has(candidateId)) return false;
  const dragStartLane = laneIdByNodeId.get(dragStartId);
  const candidateLane = laneIdByNodeId.get(candidateId);
  if (dragStartLane !== undefined && candidateLane !== undefined && dragStartLane !== candidateLane) return false;
  return !existingEdges.some(
    (e) => (e.fromNodeId === dragStartId && e.toNodeId === candidateId)
      || (e.fromNodeId === candidateId && e.toNodeId === dragStartId),
  );
}
