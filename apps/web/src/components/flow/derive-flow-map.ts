import type { EpicFlowNodeItem } from './derive-flow';

// L3 갈래 지도 — 유나 목업(`be8709a4`, "갈래 L3 — 좌표 규칙 판A/판B/판C") 실측 그대로.
// 좌표 상수(아티팩트 CSS 그대로, 2026-07-30 확認 — "그림이 정본", 채팅으로 옮긴 숫자는 안 씀):
export const FLOW_MAP_GRID_STEP = 110; // 세로 그리드 간격(px) = 깊이 한 칸
export const FLOW_MAP_NOW_LINE_X = 292; // "지금" 세로선 left(px)
export const FLOW_MAP_DEPTH0_X = FLOW_MAP_NOW_LINE_X + FLOW_MAP_GRID_STEP; // 깊이 0 열 시작(402px)

// ③④ 판C(2026-07-30) — 열마다 상위 3 + 「+N건」 점선 카드, 과거 묶음 카드. ⑥(포트·슬롯의
// 실제 저장 배선)은 #2221(부산물형 3종 간선 — 낳음/잇따름/대체) 착수 전까지 보류한다(PO
// 정정 2026-07-30 — 기존 `dependencies`(blocks/depends_on, 계획형)에 쓰면 "사람이 미리
// 선언해야" 하는 그 성질을 그대로 물려받아 org 6주 0건이 재현된다). 포트 «그림» 자체는
// #2221이 착지하면 그대로 재사용한다 — 저장 배선만 그때 바뀐다.
export const FLOW_MAP_TOP_N = 3; // 열마다 카드로 그리는 상위 건수 — 나머지는 "+N건" 카드

// PO 판정(2026-07-30, 실측 후속) — 목표(에픽)당 스토리 «중앙값 7»(대부분 접을 필요가
// 없다)· «최대 141»(그 하나는 반드시 접혀야 한다)을 재고 나온 조건. 이전엔 3개 넘으면
// 무조건 접었는데 그러면 "4개짜리 열"도 "+1건"으로 접혀 사람이 볼 수 있는 것까지 숨긴다
// (대부분 열이 이 크기라 무조건 접기는 실질적으로 늘 접는 것과 같았다). 이 임계값을
// 넘을 때만 접는다 — 넘지 않으면 전부(FLOW_MAP_TOP_N보다 많아도) 그대로 보인다.
export const FLOW_MAP_FOLD_THRESHOLD = 5;

/** 유나양 규격(2026-07-30, PO 전달) — 관계 종류 4종(축1). `null` = "종 미정"(아직 종이
 * 안 지정된 «제안» 간선 — #2223 산문 추출은 항상 이 상태로 들어온다). 종 미정은 별도
 * 넷째 «모양»을 갖지 않는다(화살촉 자체를 없앰) — 모르는 것을 아는 척 그리지 않는다는
 * 원칙(유나양 지적: 넷째 모양을 주면 「미정」이 하나의 확定된 종류처럼 보인다). */
export type FlowMapEdgeKind = 'spawn' | 'then' | 'supersede' | null;

export interface FlowMapEdge {
  fromNodeId: string;
  toNodeId: string;
  /** 종(낳음/잇따름/대체/미정) — 축1. */
  kind: FlowMapEdgeKind;
  /** 확認 상태(축2, 축1과 직교) — true=사람이 1클릭으로 확定, false=산문에서 뽑힌 제안
   * (#2223 본문 "자동 확定 금지" 원칙). 확認 여부와 무관하게 종은 가질 수 있다(예: 확認된
   * "낳음"도 있고 제안 상태의 "낳음"도 있다) — 두 축은 서로를 제약하지 않는다. */
  confirmed: boolean;
  /** story #2353(AC7·AC8) — 되돌리기(`DELETE .../reference-candidates/{id}`)의 재료.
   * reference-candidate 표에서 온 간선만 갖는다(계획형 dependencies는 다른 표라 없음 —
   * 그쪽은 되돌릴 UI가 아직 이 스토리 범위 밖이다). */
  candidateId?: string;
  /** 「누가」— 지워지지 않는 서명(AC8). estimated(미확認) 간선은 항상 null. */
  declaredBy?: string | null;
  /** 「언제」 — ISO 문자열, declaredBy와 같은 사정. */
  declaredAt?: string | null;
}

/** `GET /api/dependencies/graph` 원시 응답 엣지 하나 — `backend/app/services/dependency_graph.py
 * get_graph()`가 내는 그대로({id, from_id, to_id, dep_type}). */
export interface RawDependencyEdge {
  id: string;
  from_id: string;
  to_id: string;
  dep_type: string;
}

/** 선생님 지시(2026-07-30, P0) — "edges=[]를 항상 넘긴다"(하드코딩)와 "실제로 받았는데
 * 0건"(정직한 빈 값)은 다른 사실이다. 이 함수가 그 구분을 만드는 자리 — 기존 계획형
 * `dependencies`(blocks/depends_on)를 실제로 fetch해 FlowMapEdge로 정규화한다.
 *
 * 방향 규칙(PO 확定 2026-07-30, computeNodeDepth와 동일 방향): `blocks(A→B)`="A가 B를
 * 막는다"=A가 먼저 → fromNodeId=A·toNodeId=B(그대로). `depends_on(A→B)`="A가 B에 의존"=B가
 * 먼저 → «뒤집어» fromNodeId=B·toNodeId=A. 이 뒤집기는 이 함수 «한 곳»에서만 한다(여러 곳에
 * 흩으면 언젠가 한쪽이 그 정규화를 빠뜨린다).
 *
 * ⛔#2223(부산물형 3종 간선 — 낳음/잇따름/대체)은 아직 실 엔드포인트가 없다(디디 실측은
 * "산문에서 뽑히는 제안선" 단계, 2026-07-30) — 이 함수는 오늘 실존하는 «계획형»만 다룬다.
 * #2223이 착지하면 별도 파서가 추가되는 것이지 이 함수를 확장하는 게 아니다(계획형·부산물형은
 * 서로 다른 의미 축이라 한 함수에서 섞으면 방향 규칙이 꼬인다).
 *
 * kind/confirmed(2026-07-30, 유나양 4×2 규격 후속): 계획형 `dependencies`는 사람이 UI로
 * 직접 만든 선언이라 confirmed=true가 항상 맞다(제안 단계가 없는 시스템) — 다만
 * 낳음/잇따름/대체 «어느 것도 아니라» kind=null(종 미정)로 둔다. */
export function parseDependencyGraphEdges(raw: RawDependencyEdge[]): FlowMapEdge[] {
  return raw.map((e) => (
    e.dep_type === 'depends_on'
      ? { fromNodeId: e.to_id, toNodeId: e.from_id, kind: null, confirmed: true }
      : { fromNodeId: e.from_id, toNodeId: e.to_id, kind: null, confirmed: true }
  ));
}

/** `GET /api/v2/{stories,goals}/{id}/reference-candidates` 원시 응답 하나(#2328 C-11,
 * `backend/app/models/reference_semantic_candidate.py`) — BE는 화면 모양에 맞춰 걸러주지
 * 않고 원시 어휘 그대로 낸다(PO 확定 2026-07-30 — "서버가 걸러버리면 나중에 다른 화면이
 * 그것을 못 쓴다", cited_as_evidence/similar_case는 노드 상세 참조 목록의 재료라 여기서
 * 버리면 그 화면이 죽는다). `relation_kind` 6종 중 3종(cited_as_evidence/similar_case/
 * explicitly_unrelated)은 이 함수가 걸러 낸다(아래 참고) — 어댑터 책임이지 서버 책임이 아니다. */
export interface RawReferenceCandidate {
  id: string;
  source_id: string;
  target_id: string;
  relation_kind: 'spawned' | 'cited_as_evidence' | 'similar_case' | 'followed' | 'explicitly_unrelated' | 'superseded' | null;
  status: 'estimated' | 'declared';
  /** story #2353(AC7·AC8) — 되돌리기 팝오버의 "누가·언제" 재료. BE는 이미 낸다(goals.py/
   * stories.py의 GET .../reference-candidates 둘 다) — FE가 지금까지 안 읽었을 뿐이다. */
  declared_by?: string | null;
  declared_at?: string | null;
}

/** 오르테가군 확定(2026-07-30, #2223 판정) — 6종 중 «시간 방향이 있는» 넷만 간선으로 그린다.
 * cited_as_evidence(근거인용)·similar_case(동종사례)는 대칭/비방향 관계라 "다음 흐름"
 * 화살표가 아니다(버리는 게 아니라 «노드 상세 참조 목록»으로 가는 별도 화면의 재료 —
 * 이 함수의 반환값에는 안 실린다는 뜻일 뿐). explicitly_unrelated는 애초에 "«선을 안 긋기
 * 위한»" 표시(자동분류 규칙이 "직교/무관" 키워드로 판정한 것) — 점선으로라도 그리면
 * "무관인데 선이 있다"는 모순이 된다.
 *
 * 방향 규칙(오르테가군 확定, 2026-07-30 — 이름이 "source가 무엇을 했나"로 적혀 있다는 것이
 * 근거): `spawned` = source가 target을 «낳았다» → source가 먼저(그대로). `followed` =
 * source가 target을 «따른다» → target이 먼저(뒤집음, `parseDependencyGraphEdges`의
 * depends_on 뒤집기와 같은 자리·같은 이유). `superseded` = source가 target을 «대체했다» →
 * target이 «옛것»(뒤집음). 이 뒤집기도 이 함수 «한 곳»에서만 한다.
 *
 * status: estimated(추정, AC3)=confirmed:false(제안) · declared(선언됨, AC5, 사람이
 * 1클릭)=confirmed:true(확定) — #2223 본문 "자동 확定 금지"와 그대로 대응. */
export function parseReferenceCandidateEdges(raw: RawReferenceCandidate[]): FlowMapEdge[] {
  const edges: FlowMapEdge[] = [];
  for (const c of raw) {
    const confirmed = c.status === 'declared';
    // story #2353(AC7·AC8) — candidateId/declaredBy/declaredAt은 방향 뒤집기와 무관하게
    // 그 candidate 행 자체의 속성이라 항상 c.id/c.declared_by/c.declared_at 그대로 싣는다
    // (fromNodeId/toNodeId만 종류별로 뒤집힌다, 위 docblock).
    const signature = { candidateId: c.id, declaredBy: c.declared_by ?? null, declaredAt: c.declared_at ?? null };
    if (c.relation_kind === 'spawned') {
      edges.push({ fromNodeId: c.source_id, toNodeId: c.target_id, kind: 'spawn', confirmed, ...signature });
    } else if (c.relation_kind === 'followed') {
      edges.push({ fromNodeId: c.target_id, toNodeId: c.source_id, kind: 'then', confirmed, ...signature });
    } else if (c.relation_kind === 'superseded') {
      edges.push({ fromNodeId: c.target_id, toNodeId: c.source_id, kind: 'supersede', confirmed, ...signature });
    } else if (c.relation_kind === null) {
      edges.push({ fromNodeId: c.source_id, toNodeId: c.target_id, kind: null, confirmed, ...signature });
    }
    // cited_as_evidence · similar_case · explicitly_unrelated — 의도적으로 드롭(위 docblock).
  }
  return edges;
}

/** 노드 하나의 «의존 깊이» — 들어오는 간선이 없으면 0(시작점), 있으면 «선행 노드 깊이 중
 * 최댓값+1». edges가 항상 빈 배열인 오늘(#2221 미착지)은 이 재귀가 «자연히» 전부 0을 내는
 * 것이라 — `if (edges.length === 0) return 0` 같은 특수분기를 두지 않는다(PO 지시
 * 2026-07-30, "판B는 판A 규칙의 퇴화된 특수 경우이지 다른 그림이 아니다"). 간선이 생기는 날
 * 이 함수는 코드 변경 없이 여러 열을 만들어낸다. */
export function computeNodeDepth(nodeId: string, edges: FlowMapEdge[], seen: Set<string> = new Set()): number {
  if (seen.has(nodeId)) return 0; // 순환 방어(그래프가 순환이면 더 못 감 — 0으로 끊는다)
  const incoming = edges.filter((e) => e.toNodeId === nodeId);
  if (incoming.length === 0) return 0;
  const nextSeen = new Set(seen).add(nodeId);
  return 1 + Math.max(...incoming.map((e) => computeNodeDepth(e.fromNodeId, edges, nextSeen)));
}

// 유나양 규격(2026-07-30, 묶음-간선 후속) — 과거 묶음 카드("완료 N·묶음")를 «노드 하나»처럼
// 취급하는 가상 id. BE past:{total}엔 개별 스토리 id가 없다(스키마 자체 없음, 의도적) — 그래도
// 그 스토리를 향한/그 스토리발 간선은 실재하므로, 그 «id 하나»에 전부 몰아 그린다(잃지 않는다).
export const PAST_BUNDLE_NODE_ID = '__past-bundle__';

/** 과거 묶음 카드에 실리는 3줄 중 2·3줄의 재료(1줄 "완료 N"은 기존 pastTotal 그대로).
 * ⛔"안에서 이어진 것"(internalCount)은 «그릴 수 없는» 것(양끝 다 묶음 안 — 카드에서 나와
 * 카드로 돌아가는 고리라 그릴 좌표가 없다)의 «수»다 — 안 보이는 게 아니라 안 그려지되
 * 세어진다("안 그리는 것과 없는 것은 다르다", 오늘 이 세션의 규율 그대로).
 * "여기서 나온 다음"(outgoingCount)은 과거가 fromNodeId인(=source가 과거) 간선 중 target이
 * 살아있는(now/queue에 그려지는) 것만 — 선생님 원 물음("후속 작업이 어떻게 준비되고
 * 연결되어있는지")의 직접적인 답이라 별도로 센다. */
export interface FlowMapBundleStats {
  total: number;
  internalCount: number;
  outgoingCount: number;
}

export type FlowMapNodeKind = 'now' | 'queue' | 'past';

export interface FlowMapNode {
  id: string;
  storyNumber: number;
  title: string;
  status: string;
  kind: FlowMapNodeKind;
  /** queue 노드만 유의미(now는 지금선 바로 옆 고정 열). */
  depth: number;
}

export interface FlowMapOverflow {
  /** 판C — 열 하나(같은 depth)에 TOP_N을 넘는 카드가 있을 때 나머지 건수. */
  depth: number;
  hiddenCount: number;
}

export interface FlowMapLane {
  epicId: string;
  title: string;
  pastTotal: number;
  nowNodes: FlowMapNode[];
  /** depth별로 상위 FLOW_MAP_TOP_N만 담은 큐 노드 — 나머지는 overflows에 건수로 잡힌다
   * (판C, 카드 없이 사라지지 않고 "+N건"으로 보이는 것이 핵심 — 눈에 안 보이는 결핍 금지). */
  queueNodesByDepth: Map<number, FlowMapNode[]>;
  overflows: FlowMapOverflow[];
  /** 선생님 지적(2026-07-30) — "edges=[]를 항상 넘기는" 하드코딩과 "실제로 받았는데 0건"은
   * 다른 사실이다. 렌더 레이어(FlowMapCanvas)가 실제로 선을 그릴 수 있도록, «양쪽 끝이 모두
   * 화면에 그려지는 노드»(now/queue 개별 카드 «또는» 과거 묶음 카드)인 간선만 여기 보존한다
   * — 과거 묶음에 닿은 간선은 그 끝점의 id가 `PAST_BUNDLE_NODE_ID`로 치환돼 있다(유나양
   * 규격 2026-07-30, "묶음이 선을 통과시키게"). TOP_N에 잘린(과거는 아니지만 개별 카드가
   * 없는) 노드로 가는 선만 여기서 제외된다 — "숨은 노드로 가는 유령 선"을 만들지 않는다. */
  edges: FlowMapEdge[];
  /** 과거 묶음 카드 3줄 중 2·3줄의 재료 — 위 FlowMapBundleStats 참고. */
  pastBundle: FlowMapBundleStats;
  /** 유나양 규격(아티팩트 a125909a, "펼친 상태") — 묶음 카드를 누르면 이 배열이 채워지고
   * 카드는 사라져 개별 노드로 갈라진다("이것이 곧 줌인"). 비어 있으면 접힌 상태(오늘 기본).
   * BE `past:{total}`엔 개별 항목이 없어 호출부가 별도 fetch(`GET /api/stories?epic_id=&
   * status=done`, project_id는 빼야 함 — board 7일/10건 분기를 피하는 자리)로 채워 넘긴다. */
  pastNodes: FlowMapNode[];
}

/** 정렬 규칙(판C) — "막힘 › 다음 지정됨 › 나머지". "다음 지정됨"에 대응하는 실 데이터
 * 필드가 아직 없어(#2221 미착지·다음-지정 mutation 자체 미확認) 오늘은 "막힘 › 나머지"
 * 2단만 실제로 갈린다 — 3단 전부를 구현한 척하지 않는다(정직). */
function queueSortKey(node: FlowMapNode): number {
  return node.status === 'blocked' ? 0 : 1;
}

/** BE epic-flow-nodes 응답(한 에픽) → L3 지도 레인 하나. edges는 항상 호출부가 실제 배열로
 * 넘긴다(#2221 미착지인 오늘은 빈 배열 — 하드코딩 아니라 "아직 그 계약이 없다"는 사실). */
export function deriveFlowMapLane(
  epicId: string,
  title: string,
  pastTotal: number,
  nowItems: EpicFlowNodeItem[],
  upcomingItems: EpicFlowNodeItem[],
  edges: FlowMapEdge[] = [],
  pastItems: EpicFlowNodeItem[] = [],
): FlowMapLane {
  const nowNodes: FlowMapNode[] = nowItems.map((item) => ({
    id: item.id,
    storyNumber: item.story_number,
    title: item.title,
    status: item.status,
    kind: 'now',
    depth: 0,
  }));

  const byDepth = new Map<number, FlowMapNode[]>();
  for (const item of upcomingItems) {
    const depth = computeNodeDepth(item.id, edges);
    const node: FlowMapNode = {
      id: item.id,
      storyNumber: item.story_number,
      title: item.title,
      status: item.status,
      kind: 'queue',
      depth,
    };
    const list = byDepth.get(depth) ?? [];
    list.push(node);
    byDepth.set(depth, list);
  }

  const queueNodesByDepth = new Map<number, FlowMapNode[]>();
  const overflows: FlowMapOverflow[] = [];
  for (const [depth, nodes] of byDepth) {
    const sorted = [...nodes].sort((a, b) => queueSortKey(a) - queueSortKey(b));
    if (sorted.length > FLOW_MAP_FOLD_THRESHOLD) {
      queueNodesByDepth.set(depth, sorted.slice(0, FLOW_MAP_TOP_N));
      overflows.push({ depth, hiddenCount: sorted.length - FLOW_MAP_TOP_N });
    } else {
      queueNodesByDepth.set(depth, sorted); // 임계값 이하 — 전부 보인다, 접지 않는다.
    }
  }

  // 유나양 규격(아티팩트 a125909a, "펼친 상태") — 묶음 카드를 누르면(호출부가 pastItems를
  // 채워 넘기면) 과거 스토리도 개별 좌표를 갖는다. depth 개념이 없어(과거는 "이전에 끝난"
  // 것이라 의존 깊이를 다시 셀 이유가 없다) 항상 depth 0.
  const pastNodes: FlowMapNode[] = pastItems.map((item) => ({
    id: item.id,
    storyNumber: item.story_number,
    title: item.title,
    status: item.status,
    kind: 'past',
    depth: 0,
  }));
  const isPastExpanded = pastNodes.length > 0;

  const renderedIds = new Set<string>(nowNodes.map((n) => n.id));
  for (const nodes of queueNodesByDepth.values()) {
    for (const n of nodes) renderedIds.add(n.id);
  }
  for (const n of pastNodes) renderedIds.add(n.id);

  // 유나양 규격(2026-07-30, "묶음이 선을 통과시키게") — «살아있는»(now/upcoming 어느 쪽으로든
  // BE가 실제로 준) id의 전체 집합. renderedIds(TOP_N에 잘린 것 제외)보다 좁다 — 잘린 것과
  // 과거는 다른 사정이라 가른다: 잘린 건 "그릴 좌표가 없어 오늘은 못 그림"(기존 그대로,
  // 이 판에서 손 안 댐), 과거는 "카드 자체가 없어 «묶음»으로 몰아 그림"(펼치면 개별 좌표).
  const aliveIds = new Set<string>([...nowItems, ...upcomingItems].map((i) => i.id));

  // pastTotal=0이면 now+upcoming이 이 에픽의 전부라는 뜻 — 그 경우 aliveIds 밖의 id는
  // "과거"가 아니라 «이 에픽 소속이 아니거나 실재하지 않는» 참조다(묶을 카드 자체가 없다).
  // 그런 참조까지 묶음으로 몰면 존재하지 않는 카드로 선이 향하는 유령이 된다 — pastTotal>0
  // «이고 아직 안 펼쳤을» 때만 "aliveIds 밖=과거"로 해석한다. 펼친 뒤엔 pastNodes가 이미
  // renderedIds에 들어 있어 이 분기 자체가 필요 없다(양끝 다 개별 좌표로 바로 그려진다).
  const hasPastBundle = pastTotal > 0 && !isPastExpanded;

  const renderableEdges: FlowMapEdge[] = [];
  let internalCount = 0;
  let outgoingCount = 0;
  for (const e of edges) {
    const fromRendered = renderedIds.has(e.fromNodeId);
    const toRendered = renderedIds.has(e.toNodeId);
    if (fromRendered && toRendered) {
      renderableEdges.push(e);
    } else if (!hasPastBundle) {
      continue; // 묶음 카드 자체가 없다(펼쳤거나 애초에 과거가 0) — 기존 동작 그대로 드롭.
    } else if (!aliveIds.has(e.fromNodeId) && !aliveIds.has(e.toNodeId)) {
      internalCount += 1; // 양끝 다 과거 — 카드에서 나와 카드로 돌아가는 고리, 그릴 수 없다.
    } else if (!aliveIds.has(e.fromNodeId) && toRendered) {
      renderableEdges.push({ ...e, fromNodeId: PAST_BUNDLE_NODE_ID }); // 과거 → 살아있음(나가는)
      outgoingCount += 1;
    } else if (!aliveIds.has(e.toNodeId) && fromRendered) {
      renderableEdges.push({ ...e, toNodeId: PAST_BUNDLE_NODE_ID }); // 살아있음 → 과거(들어오는)
    }
    // 나머지(한쪽 또는 양쪽이 "살아있지만 TOP_N에 잘려 카드가 없는" 경우)는 기존 그대로 드롭
    // — 이 판에서 손 안 댐(오르테가군 지시, 접기 임계는 축척 스토리 몫).
  }

  return {
    epicId, title, pastTotal, nowNodes, queueNodesByDepth, overflows, edges: renderableEdges,
    pastBundle: { total: pastTotal, internalCount, outgoingCount },
    pastNodes,
  };
}

/** 노드 하나의 «논리 좌표» — 데이터가 정하는 것(축척과 무관). `column`이 `'now'`면 지금
 * 클러스터(항상 지금선 바로 옆 고정 열, depth 개념 밖) · 숫자면 그 depth 열. `row`는 그
 * 열 안에서의 순번(위에서부터 0,1,2…) — 오늘의 카드 렌더 순서(now는 nowNodes 순서, queue는
 * queueNodesByDepth의 그 depth 배열 순서)와 정확히 같다. */
export interface FlowMapLogicalPosition {
  column: 'now' | 'past-bundle' | 'past-expanded' | number;
  row: number;
}

// 과거 묶음 카드의 고정 위치(px) — flow-map-canvas.tsx의 기존 하드코딩(left:20, top:4)과
// 정확히 같은 값을 여기 단일 소스로 옮긴다(카드 렌더링과 간선 계산이 서로 다른 좌표를
// 쓰면 언젠가 어긋난다 — computeNodePositions의 존재 이유 그대로).
export const PAST_BUNDLE_LEFT = 20;
export const PAST_BUNDLE_TOP = 4;
// 유나양 규격(아티팩트 a125909a) 3줄(완료 N·묶음 / 안에서 이어진 것 M / 여기서 나온 다음 K건)
// 반영 — 기존 2줄(90px 폭)보다 넓고 높아야 숫자가 안 잘린다. 일반 카드(110px)와 폭을
// 맞춰 시각적으로도 "노드 하나"처럼 보이게 한다(유나양 규격 "묶음 카드가 노드 하나처럼
// 행동한다"와 일치).
export const PAST_BUNDLE_CARD_WIDTH = 110;
export const PAST_BUNDLE_CARD_HEIGHT = 52;

// 펼친 상태(유나양 규격, "opened" 박스) — 개별 과거 카드는 일반 카드보다 작다(mockup
// .nd.past 실측 비율 그대로: 132/190 ≈ .69 폭, 좁은 카드). 박스 상단에 캡션("완료 N·펼쳐짐")
// 자리를 두고 그 아래로 카드가 쌓인다.
export const PAST_EXPANDED_LEFT = PAST_BUNDLE_LEFT + 10;
export const PAST_EXPANDED_TOP_START = PAST_BUNDLE_TOP + 22; // 박스 캡션 높이
export const PAST_EXPANDED_CARD_WIDTH = 90;
export const PAST_EXPANDED_CARD_HEIGHT = 24;
export const PAST_EXPANDED_ROW_HEIGHT = 28;
export const PAST_EXPANDED_BOX_WIDTH = 172; // mockup 실측(.opened width:190 - 여백)

/** BE 응답(now/queue 노드) → 노드별 논리 좌표. 화면 픽셀이 «전혀» 등장하지 않는다 — 이
 * 자리가 "데이터가 정하는 것"과 "축척이 정하는 것"의 경계(오르테가군 지시 2026-07-30,
 * 축척 스토리 착수 前 정지 작업: "지금 x = depth × GRID_STEP로 논리 좌표가 곧 화면 픽셀이라
 * 축척이 들어오면 그 계산이 통째로 흔들린다 — 그 둘을 가르는 자리를 하나 두시는"). */
export function computeNodeLogicalPositions(lane: FlowMapLane): Map<string, FlowMapLogicalPosition> {
  const positions = new Map<string, FlowMapLogicalPosition>();
  lane.nowNodes.forEach((node, i) => {
    positions.set(node.id, { column: 'now', row: i });
  });
  for (const [depth, nodes] of lane.queueNodesByDepth) {
    nodes.forEach((node, i) => {
      positions.set(node.id, { column: depth, row: i });
    });
  }
  // 유나양 규격(아티팩트 a125909a) — 펼친 상태(pastNodes가 채워짐)면 개별 과거 노드가
  // 각자 좌표를 갖고, 묶음 카드(집계) 자리는 사라진다("카드를 누르면 안의 노드가 낱개로
  // 서는" — 집계 카드와 펼친 개별 카드가 동시에 있지 않다). 접힌 상태(pastNodes 비어있고
  // pastTotal>0)일 때만 묶음 앵커 하나.
  if (lane.pastNodes.length > 0) {
    lane.pastNodes.forEach((node, i) => {
      positions.set(node.id, { column: 'past-expanded', row: i });
    });
  } else if (lane.pastTotal > 0) {
    positions.set(PAST_BUNDLE_NODE_ID, { column: 'past-bundle', row: 0 });
  }
  return positions;
}

/** 논리→화면 변환에 필요한 값 전부(호출부가 명시로 넘긴다 — 상수에 암묵적으로 기대지 않는다).
 * `scale`은 오늘 항상 1(축척 스토리가 아직 없다, 오르테가군 지시 — "축척 자체는 아직 안
 * 지으시는") — 이 값이 들어오는 자리를 미리 두는 것이 이 리팩터의 전부다. gridStep과
 * rowHeight «둘 다»에 곱해 열 간격·행 높이가 함께 줄고 늘도록 한다(하나만 축척 타면
 * 카드 비율이 깨진다). */
export interface FlowMapProjectionConfig {
  gridStep: number;
  depth0X: number;
  nowClusterX: number;
  rowHeight: number;
  rowTopOffset: number;
  scale: number;
}

/** 논리 좌표 하나 → 화면 픽셀 {left, top}. 이 함수 «한 곳»에서만 `scale`을 곱한다 — 축척이
 * 착지하면 이 함수 안 곱셈 자리만 실제 배율을 받으면 된다(호출부 전부 무변경). */
export function projectToScreen(
  position: FlowMapLogicalPosition,
  config: FlowMapProjectionConfig,
): { left: number; top: number } {
  if (position.column === 'past-bundle') {
    // 과거 묶음 카드는 depth 그리드 밖의 고정 앵커 — flow-map-canvas.tsx의 카드 렌더링과
    // 정확히 같은 값(PAST_BUNDLE_LEFT/TOP)을 쓴다(단일 소스, 위 now/queue와 동일 원칙).
    return { left: PAST_BUNDLE_LEFT, top: PAST_BUNDLE_TOP };
  }
  if (position.column === 'past-expanded') {
    // 펼친 박스 안에서 세로로 쌓인다 — 축척과 무관한 고정 앵커(오늘은 묶음처럼 depth 그리드
    // 밖). scale이 이 열에도 적용될지는 축척 스토리가 정할 몫(오늘은 항상 scale=1이라 무해).
    return { left: PAST_EXPANDED_LEFT, top: PAST_EXPANDED_TOP_START + position.row * PAST_EXPANDED_ROW_HEIGHT };
  }
  const left = position.column === 'now'
    ? config.nowClusterX
    : config.depth0X + position.column * config.gridStep * config.scale;
  const top = config.rowTopOffset + position.row * config.rowHeight * config.scale;
  return { left, top };
}

/** 노드 하나가 화면에 그려질 {left, top}(카드 좌상단) — FlowMapCanvas의 카드 렌더링과
 * «같은 공식»을 간선 SVG 렌더링도 써야 선이 카드 위치와 어긋나지 않는다(위치 계산을 두 곳에
 * 따로 두면 언젠가 하나만 바뀌어 어긋난다 — 단일 소스). 내부적으로 논리 좌표(위
 * `computeNodeLogicalPositions`) → 화면 좌표(`projectToScreen`)를 거친다 — `scale` 생략 시
 * 1(오늘의 기존 동작과 완전히 동일, 이 리팩터로 픽셀값이 하나도 안 바뀐다). */
export function computeNodePositions(
  lane: FlowMapLane,
  nodeRowHeight: number,
  nowClusterX: number,
  scale = 1,
): Map<string, { left: number; top: number }> {
  const logical = computeNodeLogicalPositions(lane);
  const config: FlowMapProjectionConfig = {
    gridStep: FLOW_MAP_GRID_STEP, depth0X: FLOW_MAP_DEPTH0_X, nowClusterX,
    rowHeight: nodeRowHeight, rowTopOffset: 4, scale,
  };
  const positions = new Map<string, { left: number; top: number }>();
  for (const [id, pos] of logical) {
    positions.set(id, projectToScreen(pos, config));
  }
  return positions;
}

// 라이브 실측 자가발견(2026-07-30, PR#2706 배포 후) — `FlowMapNodeCard`의 카드 너비(110px)와
// `FLOW_MAP_GRID_STEP`(110px)이 «정확히 같아서» 인접 depth 열(예: depth2→depth3)의 «같은
// 행(row)»에 있는 두 카드는 간격이 0이다. 그 경우 간선의 x1(from 오른쪽 끝)과 x2(to 왼쪽 끝)이
// «완전히 같은 좌표»가 돼 선 길이가 0(점 하나, 화면에 안 보임)이 된다 — 데이터는 맞게 왔는데
// 렌더가 점이 되는 것은 진짜 병이다(라이브에서 x1===x2===732, y1===y2===16으로 직접 확認).
const EDGE_MIN_VISIBLE_LENGTH = 6;

export interface FlowMapNodeDimensions {
  width: number;
  height: number;
}

/** 간선 하나의 SVG `<line>` 시작/끝 좌표 — 항상 «카드 가장자리 중앙»(유나양 규격, 묶음-간선
 * 후속 2026-07-30: "개별 노드 자리를 추정해 그리지 않는다 — 접힌 것의 속을 안다고 말하지
 * 않기 위해서"). 두 끝점이 실질적으로 겹치면(FLOW_MAP_GRID_STEP===카드너비인 사정) 최소 가시
 * 길이를 보장하도록 x축으로 살짝 벌린다 — 카드 쪽으로 몇 px 파고드는 것이, 데이터가 왔는데
 * 안 보이는 것보다 낫다. 위치가 없는(TOP_N에 잘린) 노드로의 간선은 null(호출부가 그 자리를
 * 건너뛴다). `dimensionOverrides`는 과거 묶음 카드처럼 «일반 노드 카드와 크기가 다른» 끝점을
 * 위한 것(오늘은 묶음 하나뿐) — 생략된 노드는 `defaultDimensions`(일반 카드 크기)를 쓴다. */
export function computeEdgeLineEndpoints(
  positions: Map<string, { left: number; top: number }>,
  edge: { fromNodeId: string; toNodeId: string },
  defaultDimensions: FlowMapNodeDimensions,
  dimensionOverrides?: Map<string, FlowMapNodeDimensions>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = positions.get(edge.fromNodeId);
  const to = positions.get(edge.toNodeId);
  if (!from || !to) return null;
  const fromDim = dimensionOverrides?.get(edge.fromNodeId) ?? defaultDimensions;
  const toDim = dimensionOverrides?.get(edge.toNodeId) ?? defaultDimensions;
  let x1 = from.left + fromDim.width;
  const y1 = from.top + fromDim.height / 2;
  let x2 = to.left;
  const y2 = to.top + toDim.height / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.sqrt(dx * dx + dy * dy) < EDGE_MIN_VISIBLE_LENGTH) {
    x1 -= EDGE_MIN_VISIBLE_LENGTH / 2;
    x2 += EDGE_MIN_VISIBLE_LENGTH / 2;
  }
  return { x1, y1, x2, y2 };
}

// 유나양 규격(2026-07-30, 묶음-간선 후속) — "여러 선이 한 점에 모이면 굵기 3단 + 수를 선
// 위에". 굵기만으로는 몇 건인지 못 세므로 수를 같이 적는다(규격 원문). 색은 "여러 종이
// 섮이면 무채 · 한 종뿐이면 그 종의 색"(섮인 것을 한 색으로 칠하면 단정이 된다).
export const EDGE_GROUP_THIN_WIDTH = 1.4; // 1건
export const EDGE_GROUP_MEDIUM_WIDTH = 2; // 2~3건
export const EDGE_GROUP_THICK_WIDTH = 2.6; // 4건 이상

export interface FlowMapEdgeGroup {
  fromNodeId: string;
  toNodeId: string;
  count: number;
  /** 그룹 내 모든 간선이 같은 종이면 그 종, 하나라도 다르면 null(무채로 그린다 — 섮인 것을
   * 한 색으로 단정하지 않는다). */
  uniformKind: FlowMapEdgeKind | 'mixed';
  /** 그룹 내 «전부»가 확認일 때만 실선 — 하나라도 제안이면 점선(제안 하나를 확定인 척
   * 그리지 않는다, 오늘 세션 전체의 "제안을 화면이 대신 확定하지 않는다" 규율 그대로). */
  allConfirmed: boolean;
  /** story #2353(AC7·AC8) — 되돌리기 팝오버의 재료. count===1(겹친 간선이 없는 단일 관계)
   * 일 때만 채운다 — 겹친 그룹(count>1)은 "이 선 하나"가 어느 candidate인지 화면이 대신
   * 고를 수 없어(묶음 카드 뒤 여러 과거 스토리가 겹친 경우 등) 되돌리기 대상에서 뺀다. */
  candidateId?: string;
  declaredBy?: string | null;
  declaredAt?: string | null;
}

/** 같은 (from, to) 쌍으로 향하는 간선을 하나의 시각 단위로 묶는다 — 묶음 카드 하나로 여러
 * 과거 스토리가 모이면 같은 (bundle, aliveNode) 쌍에 여러 간선이 겹쳐 그려질 수 있어(유나양
 * 지적: "여러 선이 한 점에 모이는" 실제 사례), 겹친 채로 두면 몇 건인지 안 보인다. */
export function groupEdgesByEndpoints(edges: FlowMapEdge[]): FlowMapEdgeGroup[] {
  const groups = new Map<string, FlowMapEdge[]>();
  for (const e of edges) {
    const key = `${e.fromNodeId} ${e.toNodeId}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return Array.from(groups.values()).map((group) => {
    const kinds = new Set(group.map((e) => e.kind));
    const solo = group.length === 1 ? group[0]! : null;
    return {
      fromNodeId: group[0]!.fromNodeId,
      toNodeId: group[0]!.toNodeId,
      count: group.length,
      uniformKind: kinds.size === 1 ? group[0]!.kind : 'mixed',
      allConfirmed: group.every((e) => e.confirmed),
      candidateId: solo?.candidateId,
      declaredBy: solo?.declaredBy,
      declaredAt: solo?.declaredAt,
    };
  });
}

export function edgeGroupStrokeWidth(count: number): number {
  if (count >= 4) return EDGE_GROUP_THICK_WIDTH;
  if (count >= 2) return EDGE_GROUP_MEDIUM_WIDTH;
  return EDGE_GROUP_THIN_WIDTH;
}

/** 범례 표시 여부의 «단일 진실»(PO 지시 2026-07-31, 유나양 라이브 실측 후속) —
 * `lane.edges.length`(데이터 건수)가 아니라 «실제로 SVG `<line>`으로 그려지는» 수를 센다.
 * `lane.edges.length`로 세면 두 가지로 거짓말이 된다: ①그룹(`groupEdgesByEndpoints`)이
 * 여러 간선을 한 선으로 겹쳐 그리므로 데이터 건수 > 그려진 선 개수일 수 있고, ②좌표 없는
 * 노드로 향하는 간선(`computeEdgeLineEndpoints`가 null)은 데이터엔 있어도 화면엔 없다.
 * 최종 문구(2026-07-31, 세 번째 확定)는 숫자를 안 싣지만("일부입니다" 한 낱말로 범위를
 * 말하는 것으로 족하다는 PO 판정), 표시 조건 자체는 여전히 «그려진 선이 있는가»여야 한다
 * (선 0개면 이 줄도 안 떠야 하는 — 문구가 숫자 없이도 "설명할 대상이 있다"를 전제하므로).
 * FlowMapCanvas의 실제 렌더 루프와 «같은 순수함수 조합»(computeNodePositions →
 * groupEdgesByEndpoints → computeEdgeLineEndpoints)을 그대로 재사용하므로 두 계산이 갈릴
 * 수 없다 — 렌더 로직을 복제하지 않고 같은 자를 다시 대는 것. */
export function countRenderedEdgeLines(
  lane: FlowMapLane,
  nodeRowHeight: number,
  nowClusterX: number,
  defaultDimensions: FlowMapNodeDimensions,
): number {
  const positions = computeNodePositions(lane, nodeRowHeight, nowClusterX);
  const dimensionOverrides = new Map([
    [PAST_BUNDLE_NODE_ID, { width: PAST_BUNDLE_CARD_WIDTH, height: PAST_BUNDLE_CARD_HEIGHT }],
  ]);
  return groupEdgesByEndpoints(lane.edges).filter(
    (group) => computeEdgeLineEndpoints(positions, group, defaultDimensions, dimensionOverrides) !== null,
  ).length;
}

/** 유나 가디언 리뷰(2026-07-31, PR#2720 issuecomment-5139624505) — 정직한 범례 문구의
 * 뒤 절("사람이 확인한 것은 아직 없습니다")에 «만료 조건»이 코드에 없었다. #2725(포트)가
 * 착지해 사람이 만든(declared) 선이 하나라도 실선으로 그려지면 그 순간 이 문장이 거짓이
 * 된다 — 지금 고치는 "실선=확定"과 같은 거짓말의 반대 방향. `countRenderedEdgeLines`와
 * «같은 순회»(groupEdgesByEndpoints → computeEdgeLineEndpoints)를 다시 태워 새 경로를
 * 만들지 않는다 — 새로 짜면 두 계산이 갈릴 수 있다. */
export function hasConfirmedRenderedEdgeLine(
  lane: FlowMapLane,
  nodeRowHeight: number,
  nowClusterX: number,
  defaultDimensions: FlowMapNodeDimensions,
): boolean {
  const positions = computeNodePositions(lane, nodeRowHeight, nowClusterX);
  const dimensionOverrides = new Map([
    [PAST_BUNDLE_NODE_ID, { width: PAST_BUNDLE_CARD_WIDTH, height: PAST_BUNDLE_CARD_HEIGHT }],
  ]);
  return groupEdgesByEndpoints(lane.edges).some(
    (group) => group.allConfirmed
      && computeEdgeLineEndpoints(positions, group, defaultDimensions, dimensionOverrides) !== null,
  );
}

/** 유나양 지적(2026-07-30, PO 전달) — "대체"(supersede)만 유일하게 «간선이 노드 렌더에
 * 영향을 주는» 종류다(낳음·잇따름은 둘 다 살아있는 관계라 선만 그으면 되지만, 대체는 한쪽이
 * 죽는 관계라 «옛 노드»의 표시가 같이 바뀌어야 — 안 그러면 "대체됐는데 옛 것이 멀쩡히 살아
 * 보이는" 화면이 된다). ⛔단 «확認된» 대체만 — «제안» 상태의 대체까지 옛 노드를 흐리면
 * 확認 안 된 것을 화면이 대신 판정하는 것이 된다(유나양 지적, 사람이 안 한 판정을 화면이
 * 대신 내면 안 된다). 방향 규칙(이 세션 확定): fromNodeId=옛 노드(대체당함), toNodeId=새
 * 노드(대체함) — "이전→이후" 시간 방향은 낳음·잇따름과 동일하게 유지한다. */
export function computeSupersededNodeIds(edges: FlowMapEdge[]): Set<string> {
  return new Set(
    edges.filter((e) => e.kind === 'supersede' && e.confirmed).map((e) => e.fromNodeId),
  );
}

/** 레인 하나의 높이(px) — 고정값이 아니라 «내용»에서 계산한다(판C ⑤, "고정이면 어느 레인은
 * 비고 어느 레인은 넘친다"). 열마다 카드 스택 높이 중 최댓값을 열 높이로 삼는다 — "지금"
 * 열도 같은 방식으로 하나의 열로 취급한다. */
export function computeLaneHeight(lane: FlowMapLane, nodeRowHeight: number, minHeight: number): number {
  const nowColumnCount = lane.nowNodes.length;
  const queueColumnCounts = Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => {
    const hasOverflow = lane.overflows.some((o) => o.depth === depth);
    return nodes.length + (hasOverflow ? 1 : 0); // 더보기 카드도 한 행을 차지한다
  });
  const maxColumnCount = Math.max(1, nowColumnCount, ...queueColumnCounts);
  // 과거 묶음 카드(묶음-간선 후속, 3줄로 늘어난 뒤 PAST_BUNDLE_CARD_HEIGHT가 한 행보다
  // 커질 수 있다) — 그 높이도 레인 높이 후보에 넣는다(안 넣으면 카드가 레인 밖으로 넘친다).
  const pastBundleHeight = lane.pastTotal > 0 && lane.pastNodes.length === 0
    ? PAST_BUNDLE_TOP + PAST_BUNDLE_CARD_HEIGHT
    : 0;
  // 펼친 상태 — PO 판정 2026-07-30("많으니 미리 잘라 두자는 안 하시는, 먼저 다 그려 보고
  // 읽히는지를 재는 것이 순서") 그대로 개수를 미리 자르지 않는다. 레인이 그만큼 커진다.
  const pastExpandedHeight = lane.pastNodes.length > 0
    ? PAST_EXPANDED_TOP_START + lane.pastNodes.length * PAST_EXPANDED_ROW_HEIGHT
    : 0;
  return Math.max(minHeight, maxColumnCount * nodeRowHeight, pastBundleHeight, pastExpandedHeight);
}

/** story #2224 AC18(2026-07-31) — 리사이즈 가능 캔버스 pane의 «기본/한계 높이»를 픽셀
 * 하드코딩 없이 계산한다. 목업의 690px(레인 8×76) 식은 그 목업의 레인 수 기준이라 라이브
 * (레인이 몇 개든 가변 높이)엔 안 선다 — 그래서 «레인 개수»를 단위로 받아 실제
 * computeLaneHeight를 그대로 누적한다("레인 3"은 수이지 픽셀이 아니다, 픽셀은 계산된다).
 * visibleLaneCount가 lanes.length보다 크면 있는 만큼만 더한다(전부 보이면 그 이상 잴 것이
 * 없다 — clamp가 «잘못된 값»이 아니라 «다 보인다»는 뜻이다). */
export function computeCumulativeLaneHeight(
  lanes: FlowMapLane[], visibleLaneCount: number, nodeRowHeight: number, laneMinHeight: number, headerHeight: number,
): number {
  const count = Math.max(0, Math.min(visibleLaneCount, lanes.length));
  let total = headerHeight;
  for (let i = 0; i < count; i += 1) {
    total += computeLaneHeight(lanes[i]!, nodeRowHeight, laneMinHeight);
  }
  return total;
}

/** story #2224 AC18 ① — 드래그는 자유 픽셀(손은 연속)이지만 «결과»는 레인 정수 경계에
 * 스냅한다(자유 픽셀로 두면 "카드가 잘린 채로 멈추는" 것이 재발한다, AC17-C가 막 고친
 * 겹침 결함과 같은 병). 후보 높이(레인 부분만, 헤더 제외)에 가장 가까운 «레인 몇 개까지의
 * 누적 높이» 경계를 찾아 그 레인 수(1-indexed)를 돌려준다. 레인이 0개면 0을 돌려준다
 * (호출부가 그 경우 드래그 UI 자체를 안 보여준다). */
export function snapToNearestLaneCount(laneHeights: number[], candidateLanesOnlyHeight: number): number {
  if (laneHeights.length === 0) return 0;
  let bestCount = 1;
  let bestDiff = Infinity;
  let cumulative = 0;
  for (let i = 0; i < laneHeights.length; i += 1) {
    cumulative += laneHeights[i]!;
    const diff = Math.abs(cumulative - candidateLanesOnlyHeight);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCount = i + 1;
    }
  }
  return bestCount;
}

/** ⑥ 조건부 문구(PO 판정 2026-07-30) 트리거 — depth 0 열은 있는데 depth 1 이상이 «전혀»
 * 없을 때만 참. 하드코딩된 상수가 아니라 실제 맵 상태에서 계산하므로, 간선이 착지해
 * depth≥1 노드가 생기는 날 이 함수가 스스로 false를 내 문구가 사라진다(거짓말 될 위험 없음). */
export function shouldShowNoDeeperReason(lane: FlowMapLane): boolean {
  if (!lane.queueNodesByDepth.has(0)) return false;
  return !Array.from(lane.queueNodesByDepth.keys()).some((d) => d >= 1);
}
