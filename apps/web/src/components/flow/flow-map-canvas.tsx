'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FlowMapLane, FlowMapNode, FlowMapEdgeKind, FlowMapEdgeGroup } from './derive-flow-map';
import {
  FLOW_MAP_GRID_STEP, FLOW_MAP_NOW_LINE_X, FLOW_MAP_DEPTH0_X, computeLaneHeight, shouldShowNoDeeperReason,
  computeNodePositions, computeSupersededNodeIds, computeEdgeLineEndpoints, groupEdgesByEndpoints,
  edgeGroupStrokeWidth, countRenderedEdgeLines, hasConfirmedRenderedEdgeLine, PAST_BUNDLE_NODE_ID, PAST_BUNDLE_LEFT, PAST_BUNDLE_TOP,
  PAST_BUNDLE_CARD_WIDTH, PAST_BUNDLE_CARD_HEIGHT, PAST_EXPANDED_LEFT, PAST_EXPANDED_TOP_START,
  PAST_EXPANDED_ROW_HEIGHT, PAST_EXPANDED_BOX_WIDTH,
} from './derive-flow-map';
import { isValidPortDropTarget, PORT_LINK_KINDS, resolveUndoTitle, type PortLinkKind } from './flow-port-linking';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// 카드 실측(FlowMapNodeCard): w-[110px] · 높이 24px(한 줄) — 선은 카드 "왼쪽 가장자리
// 중앙"→"오른쪽 가장자리 중앙"을 잇는다.
const NODE_CARD_WIDTH = 110;
const NODE_CARD_HEIGHT = 24;

// 유나 목업(`be8709a4`) 실측 치수 — "그림이 정본"(2026-07-30), 비슷한 값이 아니라 그 숫자.
const HEADER_HEIGHT = 22; // .colhd
// ⛔story #2224 AC17-C(2026-07-31, 유나 라이브 실측 05:28Z·확定 05:34Z) — 노드가 두 줄
// (「#2296 · In Progress」)이던 이유는 상태 글자였는데, 좌측 3px 색이 이미 §4-4의 상태
// 정본이라 글자는 «중복»이었다. 상태 글자를 빼 한 줄(24px)로 줄이고 행 간격을 28→32로
// 올린다(단순 「행 간격 ≥ 노드 높이 + 8」자를 지금 값에 그대로 대면 48이 되어 AC17-A(캔버스가
// 레인 수 × 76을 따라간다)를 더 나쁘게 하므로, 노드를 줄이는 것과 «짝»으로 낸 값 — 8개 ×
// 32 = 256px, 겹침 0쌍).
const NODE_ROW_HEIGHT = 32;
const LANE_MIN_HEIGHT = 70;
const NOW_CLUSTER_X = FLOW_MAP_NOW_LINE_X - 40; // "지금" 노드는 세로선 바로 왼쪽에 클러스터(착수시각순)

/** story #2353 — 포트 잇기 상태기계. 포인터 드래그와 키보드(AC13)가 같은 phase들을 타되
 * `via`만 다르다 — 「드래그로 되는 일은 키보드로도 같은 결과에 닿는다」(AC13)를 타입
 * 레벨에서도 한 상태기계로 강제한다(두 벌을 안 짠다). */
type LinkDraft =
  | { phase: 'idle' }
  | { phase: 'linking'; sourceId: string; via: 'pointer' | 'keyboard'; pointerClientX: number; pointerClientY: number; hoverTargetId: string | null }
  | { phase: 'confirming'; sourceId: string; targetId: string }
  | { phase: 'submitting'; sourceId: string; targetId: string }
  // AC15 — 실패하면 점선이 사라지고 "왜인지" 한 줄. message는 서버 원문 그대로(진단을 새로
  // 짓지 않는다) — 이 phase 자체가 "그 자리에 남는" 자리다(㉦-2, 토스트로 흘려보내지 않는다).
  | { phase: 'error'; sourceId: string; targetId: string; message: string };

interface FlowMapCanvasProps {
  lanes: FlowMapLane[];
  /** 노드 클릭 → 스토리 상세 패널(선생님 지적 2026-07-30 — 동사 0개였다). story #2354
   * 후속(2026-07-31) — 예전엔 `?view=list&story={id}`로 칸반 오픈 경로를 탔으나, view를
   * 갈아 끼우는 것 자체가 캔버스를 언마운트시키는 원인이었다(선생님 "인터랙션이 없다"의
   * 구조적 뿌리). 지금은 호출부(flow-client.tsx)가 `?story={id}`만 붙이고 지도 «위»에
   * 겹치는 팝오버로 같은 `StoryDetailPanel`을 재사용한다 — view는 그대로 둔다. */
  onSelectStory: (storyId: string) => void;
  /** 유나양 규격(아티팩트 a125909a, "누르면 펼쳐지는 것이 곧 줌인") — 묶음 카드를 누르면
   * 호출부가 개별 과거 스토리를 fetch해 그 레인의 `pastItems`로 다시 넘긴다.
   * ⛔story #2224 AC1(멀티레인, 2026-07-31) — 레인이 여럿이 되며 "어느 레인의 묶음인가"를
   * 가려야 해 `epicId` 인자가 붙었다(예고된 그대로 — 이전 문서가 "멀티레인이 오면 epicId
   * 인자를 추가하는 것으로 끝난다"고 적어 둔 자리). */
  onTogglePastBundle: (epicId: string) => void;
  /** 어느 레인(들)이 지금 fetch 중인지 — 묶음 카드가 "불러오는 중…"을 보이는 자리도
   * 레인마다 갈린다(위와 같은 이유로 epicId 기준 Set으로 바뀌었다). */
  loadingPastBundleEpicIds: Set<string>;
  /** story #2354 AC6 — 패널을 «닫아도» 마지막으로 누른 노드가 선택된 채로 남는다(고리 강조
   * ring). URL의 `?story=`가 단일 소스 — 패널이 닫혀도 이 값은 지워지지 않는다(호출부가
   * 패널의 열림/닫힘만 별도 로컬 상태로 관리, 선택 자체는 URL 그대로). */
  selectedNodeId?: string | null;
  /** story #2353 — 포트로 새 연결을 만든다. 실제 fetch·로컬 edges 갱신은 호출부(FlowEpicNodes)
   * 책임(onSelectStory와 같은 원칙 — 이 컴포넌트는 순수 프레젠테이션+인터랙션이다). 서버
   * 응답 전엔 절대 선을 확定하지 않는다(AC14, 낙관적 업데이트 금지) — 호출부가 실제로
   * edges를 갱신해야 이 컴포넌트가 다음 렌더에서 실선을 그린다. */
  onCreateLink: (params: { apiSourceId: string; targetId: string; relationKind: PortLinkKind | null }) => Promise<CreateLinkResult>;
  /** story #2353(AC7·AC8) — 사람이 만든 선을 지운다. */
  /** anchorStoryId — BE DELETE 라우트가 접근권한 확認에 쓰는 «실재하는 story id»(project
   * access 앵커일 뿐, 어느 쪽 endpoint가 candidate를 만들었는지와 무관 — stories.py의
   * undeclare_story_reference_candidate 문서 참고). fromNodeId/toNodeId 아무 쪽이나
   * 유효한 story id면 되므로 호출부가 그중 하나를 골라 넘긴다. */
  onDeleteLink: (candidateId: string, anchorStoryId: string) => Promise<DeleteLinkResult>;
  /** story #2353 되돌리기 다이얼로그의 「{이름}이 만든 연결입니다」 이름 조회용(유나 가디언
   * 리뷰 v1.1 정정, ㉣ — declaredBy가 나 아니면 실명, 못 찾으면 중립으로 떨어진다. 새 fetch
   * 아님 — goal-stem-card.tsx가 이미 들고 있는 memberMap을 그대로 흘려보낸다). */
  memberMap: Record<string, { name: string }>;
}

export type CreateLinkResult = { ok: true } | { ok: false; error: string };
export type DeleteLinkResult = { ok: true } | { ok: false; error: string };

function nodeToneClass(node: FlowMapNode): string {
  if (node.kind === 'now') return 'border-l-info';
  if (node.kind === 'past') return 'border-l-border'; // 펼친 과거 — 끝난 것이라 점선(미착수 표시) 아님
  if (node.status === 'blocked') return 'border-l-destructive';
  return 'border-l-border border-dashed'; // .n.queue — 아직 시작 안 한 것은 점선
}

interface FlowMapNodeCardProps {
  node: FlowMapNode;
  left: number;
  top: number;
  superseded: boolean;
  /** story #2354 AC6 — 패널을 닫아도 마지막으로 누른 노드가 선택된 채로 남는다(고리 강조). */
  selected: boolean;
  onSelectStory: (storyId: string) => void;
  /** story #2353 — 이 노드가 현재 드래그/키보드 잇기의 «출발점»인가(포트를 크게+색있게 고정). */
  isLinkSource: boolean;
  /** 잇기 진행 중인데 이 노드가 «놓을 수 없는» 대상인가(AC3 — 자기 자신·이미 이어진 것 흐림). */
  isInvalidDropTarget: boolean;
  /** 잇기 진행 중이고 이 노드가 지금 가리키는(포인터 호버/키보드 포커스) 후보인가(AC3·AC13). */
  isDropHover: boolean;
  /** story #2353 — 방금 만든 선의 «반대편» 노드를 짧게 강조(㉣ "만든 직후 짧게 강조"). */
  isJustLinked: boolean;
  onPortPointerDown: (e: React.PointerEvent, nodeId: string) => void;
  onPortKeyDown: (e: React.KeyboardEvent, nodeId: string) => void;
}

function FlowMapNodeCard({
  node, left, top, superseded, selected, onSelectStory, isLinkSource, isInvalidDropTarget, isDropHover,
  isJustLinked, onPortPointerDown, onPortKeyDown,
}: FlowMapNodeCardProps) {
  const t = useTranslations('flow');
  // 유나양 규격(아티팩트 a125909a `.nd.past{opacity:.62}`) — 펼친 과거 카드는 항상 흐림
  // (대체-확認 흐림과 별개 사정 — 이미 끝난 일이라는 사실 자체를 흐림으로 나타낸다).
  const dimmed = superseded || node.kind === 'past' || isInvalidDropTarget;
  return (
    // story #2353 후속 — 포트가 «자기 카드를 여는 버튼»과 별개의 인터랙티브 요소가 되면서
    // (드래그 시작점) 버튼 안에 버튼을 못 넣는다(중첩 버튼은 무효 HTML). 바깥은 위치만 잡는
    // div, 안에 「카드 열기」버튼과 「포트」버튼 둘이 형제로 선다. data-node-id는 이 div에
    // 둔다 — story #2354 오버레이 패널이 "이 노드를 가리지 않는" 위치를 계산할 앵커
    // (getBoundingClientRect)이자, 포인터 드래그의 드롭 대상 판정(`closest('[data-node-id]')`)
    // 자리이기도 하다.
    // ⛔story #2224 AC17-C(2026-07-31) — 카드를 두 줄(40px)→한 줄(24px, h-6)로. 상태 글자
    // (「진행 중」 등)를 뺐다 — 좌측 3px border-l 색이 이미 §4-4의 상태 정본이라 글자는
    // «중복»이었고, 그 중복이 8개 레인을 원리적으로 못 서게(384px 초과) 막고 있었다.
    <div className="absolute h-6 w-[110px] overflow-visible" style={{ left, top }} data-node-id={node.id}>
      <button
        type="button"
        onClick={() => onSelectStory(node.id)}
        // story #2354 AC6 — 패널을 닫아도 selected는 유지된다("누른 노드가 선택된 채로
        // 남는다"). selected(패널 대상)와 isDropHover(잇기 대상 후보)는 같은 시각 신호
        // (ring-brand)를 쓴다.
        // ⛔유나 가디언 리뷰(2026-07-31, PR#2725 issuecomment-5139662978) — 예전 주석은
        // "잇기 중엔 패널이 안 열려 있어 둘이 동시에 참이 안 된다"고 주장했지만 틀렸다.
        // selected는 «패널이 열림»이 아니라 «URL에 ?story=가 있음»이고 AC6이 정확히
        // "닫아도 그 값을 안 지운다"로 만들었다 — A를 눌러 패널을 열고 닫은 뒤 B 포트에서
        // A로 끌면 selected와 isDropHover가 동시에 참이 된다. 무관한 노드가 "놓을 자리"로
        // 오인되므로, 이제 호출부(FlowMapCanvas)가 잇기 진행 중(linkDraft.phase !== 'idle')엔
        // selected 자체를 false로 넘겨 이 컴포넌트에 도달하기 전에 막는다.
        className={`focus-inset flex h-6 w-full items-center gap-1 rounded border border-l-[3px] border-border bg-card px-1.5 text-left text-[11px] shadow-sm hover:border-info/60 ${nodeToneClass(node)} ${dimmed ? 'opacity-50' : ''} ${selected || isDropHover ? 'ring-2 ring-brand ring-offset-1 ring-offset-background' : ''} ${isJustLinked ? 'ring-2 ring-success ring-offset-1 ring-offset-background' : ''}`}
      >
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">#{node.storyNumber}</span>
        {/* 대체(확認됨)만 — "옛 노드"에 취소선(유나양 규격). 제안 상태는 절대 취소선을 넣지
            않는다(computeSupersededNodeIds가 확認 간선만 모으므로 이 자리는 값만 받는다 —
            "제안이면 안 흐린다"는 판단을 이 컴포넌트가 다시 하지 않는다). */}
        <span className={`truncate ${superseded ? 'line-through' : ''}`}>{node.title}</span>
      </button>
      {/* ⑥ 포트(story #2353, doc `flow-port-slot-spec` ㉠) — 사람이 연결을 «만드는» 유일한
          손잡이. 상시 보이되 아주 작게(3px, 무채) → 호버/포커스/드래그 원점일 때 커지고
          색이 붙는다. 호버 전용이면 "있는 줄을 모른다"(AC1) — 그래서 기본 상태도 aria-hidden
          없이 항상 렌더된다(스크린샷에 항상 잡힌다). 오른쪽 변 «하나만»(AC2) — 방향은
          «끈 순서»가 정하므로 양쪽에 달지 않는다. */}
      <button
        type="button"
        aria-label={t('portLinkStart', { n: node.storyNumber })}
        onPointerDown={(e) => onPortPointerDown(e, node.id)}
        onKeyDown={(e) => onPortKeyDown(e, node.id)}
        className="focus-inset group absolute -right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full"
      >
        <span
          aria-hidden="true"
          className={`rounded-full transition-all ${isLinkSource ? 'h-[7px] w-[7px] bg-info' : 'h-[3px] w-[3px] bg-muted-foreground group-hover:h-[7px] group-hover:w-[7px] group-hover:bg-info group-focus-visible:h-[7px] group-focus-visible:w-[7px] group-focus-visible:bg-info'}`}
        />
      </button>
    </div>
  );
}

// 유나양 규격(2026-07-30, PO 전달) — 축1(관계 종류) 4종의 «모양» 채널. 축2(확認 상태)는
// 이와 직교하는 stroke-dasharray(확定=실선/제안=점선)로만 표현 — 아래 표에는 없다.
// null(종 미정)은 화살촉 자체가 없다(유나양 지적: 넷째 모양을 주면 "미정"이 확定된 하나의
// 종류처럼 보인다 — 모르면 그 채널을 비운다). 다만 방향은 아는지라 끝점에 점 하나만.
function edgeKindStyle(kind: FlowMapEdgeKind | 'mixed'): { color: string; markerEnd: string; markerStart?: string } {
  if (kind === 'spawn') return { color: 'var(--info)', markerEnd: 'url(#flow-edge-arrow-open)' };
  if (kind === 'then') return { color: 'var(--brand)', markerEnd: 'url(#flow-edge-arrow-filled)', markerStart: 'url(#flow-edge-dot-start)' };
  if (kind === 'supersede') return { color: 'var(--muted-foreground)', markerEnd: 'url(#flow-edge-bar)' };
  // 종 미정(null) · 여러 종이 섮인 그룹('mixed') — 둘 다 "이 선이 «무슨 종»인지 하나로
  // 말할 수 없다"는 같은 사정이라 같은 모양(화살촉 없음, 끝점 점)을 쓴다(유나양 규격:
  // 종 미정은 넷째 모양 없이 무채, 섮인 그룹도 "한 색으로 단정하지 않는다"=무채).
  return { color: 'var(--muted-foreground)', markerEnd: 'url(#flow-edge-dot-end)' };
}

function FlowEdgeMarkerDefs() {
  return (
    <defs>
      {/* 낳음 — 빈 화살촉(윤곽선만, 안이 안 채워짐) */}
      <marker id="flow-edge-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M1,1 L9,5 L1,9" fill="none" stroke="var(--info)" strokeWidth={1.4} />
      </marker>
      {/* 잇따름 — 채운 화살촉 + 출발점 점 */}
      <marker id="flow-edge-arrow-filled" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M1,1 L9,5 L1,9 Z" fill="var(--brand)" />
      </marker>
      <marker id="flow-edge-dot-start" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">
        <circle cx="5" cy="5" r="3.5" fill="var(--brand)" />
      </marker>
      {/* 대체 — 화살촉 없이 막대 끝(⊣) */}
      <marker id="flow-edge-bar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="8" orient="auto-start-reverse">
        <line x1="9" y1="1" x2="9" y2="9" stroke="var(--muted-foreground)" strokeWidth={1.6} />
      </marker>
      {/* 종 미정 — 화살촉 없음, 끝점에 작은 점만("여기서 끝난다"만 말하는, 방향 이상은 주장 안 함) */}
      <marker id="flow-edge-dot-end" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4">
        <circle cx="5" cy="5" r="3" fill="var(--muted-foreground)" />
      </marker>
    </defs>
  );
}

/**
 * story #2224 L3 — 갈래 «지도»(유나 목업 `be8709a4` 판A/판B/판C, PO 판정 2026-07-30).
 * ⑤레인 높이가 «내용에서 계산»(고정 아님) · ①노드가 «의존 깊이 좌표»(x = depth × 110px,
 * computeNodeDepth가 실제 계산 — 오늘은 간선이 없어 전부 depth 0) · ②「지금」 세로선
 * (left 292px) · ③열마다 상위 3 + 「+N건」 점선 카드(잘린 수를 정직하게 보이는 것 —
 * 「67 중 15」와 같은 규율) · ④과거는 개별 카드 없이 건수만(BE `past:{total}` 스키마에
 * items 필드가 아예 없어 "최근 1건 낱개"는 오늘 데이터로 지을 수 없다 — 지어내지 않는다).
 *
 * 포트(⑥, story #2353 착지) — 사람이 연결을 «만드는» 유일한 손잡이. doc
 * `flow-port-slot-spec` 그대로: 상시 보이는 3px 점(드래그 시작) → 놓으면 방향을 되읽는
 * 확認 다이얼로그 → declared로 바로 생성(estimated 경유 없음, story #2355 BE) → 사람이
 * 만든 선은 실선(기계 승인 선과 같은 모양, "출처가 아니라 확인 여부"가 축이라는 판정
 * 그대로). 키보드 동등 경로(AC13)도 같은 상태기계를 탄다 — 포인터/키보드 둘 다
 * `linkDraft.via`만 다르고 나머지 전이는 같다.
 *
 * `lanes`를 배열로 받는 것은 오늘의 단일-에픽 구조에 이미 «내일의 모양»을 맞춰 두는 것이다
 * (PO 지시 — "한 레인 전용으로 짜지 마시는, 처음부터 레인 배열을 받는 형태로"). 오늘은 이
 * 배열의 길이가 늘 1(펼친 에픽 하나) — 멀티레인 계약이 오면 호출부만 배열을 채워 넘기면 된다.
 * ⛔포트 드래그 좌표계산은 이 단일-레인 현실에 맞춰 「레인 컨테이너 ref 하나」로 짰다(여러
 * 레인이 오면 레인별 ref map으로 넓혀야 한다 — 아래 laneContainerRef 참고).
 */
export function FlowMapCanvas({
  lanes, onSelectStory, onTogglePastBundle, loadingPastBundleEpicIds, selectedNodeId = null, onCreateLink, onDeleteLink, memberMap,
}: FlowMapCanvasProps) {
  const t = useTranslations('flow');
  const { currentTeamMemberId } = useDashboardContext();
  const maxDepth = Math.max(0, ...lanes.flatMap((l) => Array.from(l.queueNodesByDepth.keys())));
  const canvasWidth = FLOW_MAP_DEPTH0_X + (maxDepth + 1) * FLOW_MAP_GRID_STEP + 20;
  // 범례 {n}·표시여부의 단일 진실 — countRenderedEdgeLines 하나로 아래 두 곳(조건·개수)이
  // 항상 같은 값을 본다(PO 지시 2026-07-31, derive-flow-map.ts 문서 참고).
  const renderedEdgeLineCount = lanes.reduce(
    (sum, lane) => sum + countRenderedEdgeLines(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X, { width: NODE_CARD_WIDTH, height: NODE_CARD_HEIGHT }),
    0,
  );
  // 유나 가디언 리뷰(2026-07-31, PR#2720 issuecomment-5139624505) — 뒤 절("사람이 확인한
  // 것은 아직 없습니다")의 만료 조건. #2725(포트)가 착지해 declared 선이 하나라도 실선으로
  // 그려지면 이 조건이 스스로 거짓이 되어 문장에서 빠진다(만료일이 코드에 박힌 문장).
  const hasAnyConfirmedRenderedEdge = lanes.some(
    (lane) => hasConfirmedRenderedEdgeLine(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X, { width: NODE_CARD_WIDTH, height: NODE_CARD_HEIGHT }),
  );

  // story #2353 — 캔버스 가장자리 자동 가로 스크롤(AC3, "41%가 밖이라 없으면 못 잇는다")의
  // 재료. 이 div가 overflow-x-auto 그 컨테이너다.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 오늘 레인은 늘 하나이므로 첫 레인의 컨테이너 하나만 추적(위 docblock 참고) — 포인터
  // 좌표를 "그 레인 안의 논리 좌표"로 바꾸는 기준점(computeNodePositions와 같은 좌표계).
  const laneContainerRef = useRef<HTMLDivElement | null>(null);

  const allEdges = useMemo(() => lanes.flatMap((l) => l.edges), [lanes]);
  const nodesById = useMemo(() => {
    const map = new Map<string, FlowMapNode>();
    for (const lane of lanes) {
      for (const n of lane.nowNodes) map.set(n.id, n);
      for (const nodes of lane.queueNodesByDepth.values()) for (const n of nodes) map.set(n.id, n);
      for (const n of lane.pastNodes) map.set(n.id, n);
    }
    return map;
  }, [lanes]);
  // story #2224 AC1 후속 — isValidPortDropTarget이 「같은 레인인가」를 판정할 재료. 레인이
  // 늘 하나였던 시절엔 필요 없었지만, 멀티레인에서 이게 없으면 레인 A→B로도 끌 수 있어 보인다
  // (flow-port-linking.ts 문서 참고 — goal-edges가 서기 전까진 막는 것이 맞다).
  const laneIdByNodeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      for (const n of lane.nowNodes) map.set(n.id, lane.epicId);
      for (const nodes of lane.queueNodesByDepth.values()) for (const n of nodes) map.set(n.id, lane.epicId);
      for (const n of lane.pastNodes) map.set(n.id, lane.epicId);
    }
    return map;
  }, [lanes]);
  // 드래그 가능한(=화면에 실제로 카드로 그려진) 노드 id — 키보드 순회(AC13)의 모집단.
  // Map 삽입 순서 = now→queue(depth순)→past 렌더 순서 그대로라 화면 순서와 일치한다.
  const draggableNodeIds = useMemo(() => Array.from(nodesById.keys()), [nodesById]);

  const [linkDraft, setLinkDraft] = useState<LinkDraft>({ phase: 'idle' });
  const [justLinkedNodeId, setJustLinkedNodeId] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<{ candidateId: string; fromNodeId: string; toNodeId: string; declaredBy: string | null; declaredAt: string | null } | null>(null);
  const [undoDeleteError, setUndoDeleteError] = useState<string | null>(null);
  const [undoDeleting, setUndoDeleting] = useState(false);

  const resetLinkDraft = useCallback(() => setLinkDraft({ phase: 'idle' }), []);

  const handlePortPointerDown = useCallback((e: React.PointerEvent, sourceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLinkDraft({ phase: 'linking', sourceId, via: 'pointer', pointerClientX: e.clientX, pointerClientY: e.clientY, hoverTargetId: null });
  }, []);

  // story #2353 AC13 — 포트가 button이라 포커스가 선다(노드 카드가 이미 button이라 그
  // 패턴을 그대로 잇는다). Enter=잇기 시작 · 화살표/Tab=대상 이동(놓을 수 있는 것만) ·
  // Enter=놓기 · Esc=취소. 드래그로 되는 일과 «같은 결과»에 닿는다 — 놓으면 똑같이
  // 'confirming' phase로 전이해 같은 확認 다이얼로그를 연다(두 벌이 아니다).
  const handlePortKeyDown = useCallback((e: React.KeyboardEvent, sourceId: string) => {
    if (linkDraft.phase === 'idle') {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const validTargets = draggableNodeIds.filter((id) => isValidPortDropTarget(sourceId, id, allEdges, laneIdByNodeId));
      setLinkDraft({ phase: 'linking', sourceId, via: 'keyboard', pointerClientX: 0, pointerClientY: 0, hoverTargetId: validTargets[0] ?? null });
      return;
    }
    if (linkDraft.phase !== 'linking' || linkDraft.via !== 'keyboard' || linkDraft.sourceId !== sourceId) return;
    const validTargets = draggableNodeIds.filter((id) => isValidPortDropTarget(sourceId, id, allEdges, laneIdByNodeId));
    if (e.key === 'Escape') {
      e.preventDefault();
      resetLinkDraft();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      const idx = linkDraft.hoverTargetId ? validTargets.indexOf(linkDraft.hoverTargetId) : -1;
      const next = validTargets[(idx + 1 + validTargets.length) % Math.max(1, validTargets.length)] ?? null;
      setLinkDraft({ ...linkDraft, hoverTargetId: next });
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      const idx = linkDraft.hoverTargetId ? validTargets.indexOf(linkDraft.hoverTargetId) : 0;
      const next = validTargets[(idx - 1 + validTargets.length) % Math.max(1, validTargets.length)] ?? null;
      setLinkDraft({ ...linkDraft, hoverTargetId: next });
      return;
    }
    if (e.key === 'Enter' && linkDraft.hoverTargetId) {
      e.preventDefault();
      setLinkDraft({ phase: 'confirming', sourceId, targetId: linkDraft.hoverTargetId });
    }
  }, [linkDraft, draggableNodeIds, allEdges, laneIdByNodeId, resetLinkDraft]);

  // 포인터 드래그 진행 중 — 문서 전체에서 이동/놓기를 받는다(포트를 벗어나도 계속 추적).
  // isPointerLinking을 밖에서 계산하는 이유 — deps 배열은 useEffect 콜백 밖의 별도 표현식이라
  // 콜백 안의 `if (linkDraft.phase !== 'linking') return` 좁히기가 거기까지 안 미친다(TS가
  // `linkDraft.via`를 유니언 전체에 대해 확인해 컴파일 에러를 낸다) — boolean으로 미리 접어
  // 이 문제 자체를 없앤다.
  const isPointerLinking = linkDraft.phase === 'linking' && linkDraft.via === 'pointer';
  useEffect(() => {
    if (!isPointerLinking) return undefined;

    const AUTO_SCROLL_EDGE_PX = 48;
    const AUTO_SCROLL_SPEED_PX = 14;

    const onMove = (e: PointerEvent) => {
      setLinkDraft((prev) => (prev.phase === 'linking' ? { ...prev, pointerClientX: e.clientX, pointerClientY: e.clientY } : prev));

      // AC3 — 캔버스 가장자리 자동 가로 스크롤(레이아웃은 고정, 스크롤 위치만 움직인다).
      const scrollEl = scrollRef.current;
      if (scrollEl) {
        const rect = scrollEl.getBoundingClientRect();
        if (e.clientX > rect.right - AUTO_SCROLL_EDGE_PX) scrollEl.scrollLeft += AUTO_SCROLL_SPEED_PX;
        else if (e.clientX < rect.left + AUTO_SCROLL_EDGE_PX) scrollEl.scrollLeft -= AUTO_SCROLL_SPEED_PX;
      }

      const hoverEl = (e.target as Element | null)?.ownerDocument
        ?.elementFromPoint(e.clientX, e.clientY)
        ?.closest('[data-node-id]');
      const hoverId = hoverEl?.getAttribute('data-node-id') ?? null;
      setLinkDraft((prev) => (prev.phase === 'linking' ? { ...prev, hoverTargetId: hoverId } : prev));
    };

    const onUp = (e: PointerEvent) => {
      const dropEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]');
      const targetId = dropEl?.getAttribute('data-node-id') ?? null;
      setLinkDraft((prev) => {
        if (prev.phase !== 'linking') return prev;
        if (targetId && isValidPortDropTarget(prev.sourceId, targetId, allEdges, laneIdByNodeId)) {
          return { phase: 'confirming', sourceId: prev.sourceId, targetId };
        }
        return { phase: 'idle' };
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allEdges 변경 중 드래그가 이어지는 흔치 않은 경우까지 재구독할 필요 없다(놓는 순간의 최신 allEdges가 필요하면 closure가 이미 최신 렌더의 값을 잡는다).
  }, [isPointerLinking]);

  const handleConfirmLink = useCallback((relationKind: PortLinkKind | null) => {
    if (linkDraft.phase !== 'confirming') return;
    const { sourceId, targetId } = linkDraft;
    setLinkDraft({ phase: 'submitting', sourceId, targetId });
    void (async () => {
      // 방향 매핑(followed/superseded는 API 호출 방향이 드래그 방향과 반대)은 flow-port-linking.ts
      // 한 곳에서만 계산한다 — 여기서 다시 안 짠다.
      const { resolveDeclareLinkCall } = await import('./flow-port-linking');
      const call = resolveDeclareLinkCall(sourceId, targetId, relationKind);
      const result = await onCreateLink(call);
      if (result.ok) {
        setJustLinkedNodeId(targetId);
        setTimeout(() => setJustLinkedNodeId(null), 2500);
        resetLinkDraft();
      } else {
        setLinkDraft({ phase: 'error', sourceId, targetId, message: result.error });
      }
    })();
  }, [linkDraft, onCreateLink, resetLinkDraft]);

  const handleUndoDelete = useCallback(() => {
    if (!undoTarget) return;
    setUndoDeleting(true);
    setUndoDeleteError(null);
    // 과거 묶음 카드 쪽(PAST_BUNDLE_NODE_ID)은 접근권한 앵커로 못 쓴다 — 실재하는 반대편을
    // 쓴다(둘 중 최소 하나는 항상 실재 story id다, 위 isUndoable 문서 참고).
    const anchorStoryId = undoTarget.fromNodeId === PAST_BUNDLE_NODE_ID ? undoTarget.toNodeId : undoTarget.fromNodeId;
    void onDeleteLink(undoTarget.candidateId, anchorStoryId).then((result) => {
      setUndoDeleting(false);
      if (result.ok) {
        setUndoTarget(null);
      } else {
        setUndoDeleteError(result.error);
      }
    });
  }, [undoTarget, onDeleteLink]);

  // AC3 — 잇기가 진행 중일 때만 소스/호버/무효 판정을 계산한다(그 외엔 전부 무해한 idle 값).
  const linkSourceIdForDimming = linkDraft.phase === 'linking' ? linkDraft.sourceId : null;
  const linkHoverTargetId = linkDraft.phase === 'linking' ? linkDraft.hoverTargetId : null;
  const linkSourceIdForBadge = linkDraft.phase === 'linking' || linkDraft.phase === 'confirming'
    || linkDraft.phase === 'submitting' || linkDraft.phase === 'error' ? linkDraft.sourceId : null;
  // 유나 가디언 리뷰(2026-07-31, PR#2725 issuecomment-5139662978) — 「잇기 중엔 패널이 안
  // 열려 있으므로 selected와 isDropHover가 동시에 참이 안 된다」는 주석의 전제가 라이브에서
  // 깨졌다. selected는 「패널이 열림」이 아니라 「URL에 ?story=가 있음」이고, #2354 AC6이
  // 정확히 "패널을 닫아도 그 값을 안 지운다"로 만들었다 — 그래서 A를 눌러 패널을 연 뒤
  // 닫아도 ring은 남고, 그 상태에서 다른 포트로 A를 향해 끌면 selected와 isDropHover가
  // «동시에 참»이 된다. 끄는 동안 화면이 답할 물음은 "어디에 놓나" 하나뿐인데, 무관한
  // 노드가 같은 강조를 달고 있으면 그것이 "놓을 자리"로 읽힌다 — 잇기 진행 중(idle이
  // 아닌 전체 phase)엔 selected ring을 끈다.
  const isLinkingActive = linkDraft.phase !== 'idle';

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex" style={{ height: HEADER_HEIGHT }}>
        <div className="w-[150px] shrink-0 border-b border-r border-border" />
        <div className="relative min-w-0 flex-1 overflow-hidden border-b border-border">
          <span className="absolute top-[5px] text-[9.5px] uppercase tracking-[0.06em] text-muted-foreground" style={{ left: 10 }}>
            {t('canvasPast')}
          </span>
          <span
            className="absolute top-[5px] text-[9.5px] font-semibold uppercase tracking-[0.06em] text-info"
            style={{ left: FLOW_MAP_NOW_LINE_X - 26 }}
          >
            {t('canvasNow')}
          </span>
          <span
            className="absolute top-[5px] text-[9.5px] uppercase tracking-[0.06em] text-muted-foreground"
            style={{ left: FLOW_MAP_DEPTH0_X - 60 }}
          >
            {t('canvasUpcoming')}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="focus-inset overflow-x-auto">
        <div className="relative" style={{ width: Math.max(canvasWidth, 400) }}>
          {lanes.map((lane, laneIndex) => {
            const height = computeLaneHeight(lane, NODE_ROW_HEIGHT, LANE_MIN_HEIGHT);
            const supersededIds = computeSupersededNodeIds(lane.edges);
            return (
              <div key={lane.epicId} className="relative flex border-b border-border last:border-b-0" style={{ height }}>
                <div className="w-[150px] shrink-0 border-r border-border px-2 py-1.5">
                  <p className="truncate text-[11px] font-semibold text-foreground">{lane.title}</p>
                </div>
                <div ref={laneIndex === 0 ? laneContainerRef : undefined} className="relative min-w-0 flex-1">
                  {/* ②「지금」 세로선 — PO 정정(2026-07-30): 두께·색·불투명도는 통합 골격
                      목업 `63b240a4`(정본) 실측 그대로(2px · foreground · opacity .85) —
                      기존 값(1px · info · .5)은 `be8709a4`(②영역 내부 좌표세부 판) 것이었던
                      PO 자신의 착오. left는 목업의 절대 560px을 그대로 옮기지 않는다 — 이
                      캔버스는 폭이 가변(overflow-x-auto)이라 "오늘 눈금의 위치"인
                      FLOW_MAP_NOW_LINE_X(그리드 규칙상의 지금-눈금)가 정본이지, 목업의 고정
                      1000px 캔버스 기준 절대좌표가 정본이 아니다. */}
                  <span
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 w-[2px] bg-foreground opacity-[0.85]"
                    style={{ left: FLOW_MAP_NOW_LINE_X }}
                  />

                  {/* 간선(⑥) — 선생님 지시(2026-07-30) 후속: "edges=[]를 항상 넘긴다"와
                      "받았는데 화면에 못 그린다"는 다른 병이라 이 SVG 레이어 자체가 오늘까지
                      없었다(양쪽 다 진짜 병이었다). 유나양 규격(축1 관계종류 4종×축2 확認
                      상태 2종=8) — 종은 marker(화살촉/점/막대)+색으로, 확認 여부는
                      strokeDasharray(확定=실선/제안=점선)로 직교하게 표현한다. */}
                  {lane.edges.length > 0 ? (
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0"
                      width="100%"
                      height="100%"
                    >
                      <FlowEdgeMarkerDefs />
                      {(() => {
                        const positions = computeNodePositions(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X);
                        const dimensionOverrides = new Map([
                          [PAST_BUNDLE_NODE_ID, { width: PAST_BUNDLE_CARD_WIDTH, height: PAST_BUNDLE_CARD_HEIGHT }],
                        ]);
                        // 유나양 규격(묶음-간선 후속) — 같은 (from,to) 쌍으로 여러 간선이
                        // 겹칠 수 있다(여러 과거 스토리가 같은 묶음 카드로 모여 같은 살아있는
                        // 노드를 가리키는 경우). 겹친 채로 두면 몇 건인지 안 보이므로 그룹당
                        // 하나의 선(굵기 3단+count>1이면 수 라벨)으로 그린다.
                        const groups = groupEdgesByEndpoints(lane.edges);
                        return groups.map((group: FlowMapEdgeGroup) => {
                          const coords = computeEdgeLineEndpoints(
                            positions, group, { width: NODE_CARD_WIDTH, height: NODE_CARD_HEIGHT }, dimensionOverrides,
                          );
                          if (!coords) return null;
                          const { x1, y1, x2, y2 } = coords;
                          const style = edgeKindStyle(group.uniformKind);
                          const midX = (x1 + x2) / 2;
                          const midY = (y1 + y2) / 2;
                          // story #2353(AC7·AC8) — 사람이 만든(candidateId 있는) 단일 간선만
                          // 클릭해서 되돌릴 수 있다. 얇은 실선은 클릭하기 어려우니 투명한
                          // 굵은 히트라인을 겹쳐 클릭 영역을 넓힌다(눈에 보이는 선은 그대로).
                          // ⛔오르테가 PO 지적(2026-07-31) — 과거 묶음 카드로 접힌 쪽에 닿은
                          // 간선도 되돌리기 UI를 그대로 낸다. deriveFlowMapLane의 분류상
                          // «양끝 다 과거»(internalCount)는 애초에 renderableEdges에 안
                          // 들어오므로, 여기 실제로 그려지는 간선은 fromNodeId·toNodeId
                          // «둘 중 최소 하나는 항상 실재 story id»다 — 앵커로 그 실재 쪽을
                          // 쓰면 되므로 "묶음이면 통째로 제외"는 과보수적이었다(클릭해도
                          // 아무 반응이 없어 "고장난 것"처럼 보이는 자리를 새로 심었다).
                          const isUndoable = Boolean(group.candidateId);
                          return (
                            <g key={`${group.fromNodeId}-${group.toNodeId}`}>
                              {isUndoable ? (
                                <line
                                  aria-hidden="true"
                                  x1={x1} y1={y1} x2={x2} y2={y2}
                                  stroke="transparent"
                                  strokeWidth={14}
                                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                                  onClick={() => setUndoTarget({
                                    candidateId: group.candidateId!, fromNodeId: group.fromNodeId, toNodeId: group.toNodeId,
                                    declaredBy: group.declaredBy ?? null, declaredAt: group.declaredAt ?? null,
                                  })}
                                />
                              ) : null}
                              <line
                                data-edge-kind={group.uniformKind === 'mixed' ? 'mixed' : (group.uniformKind ?? 'unknown')}
                                data-edge-confirmed={group.allConfirmed}
                                data-edge-count={group.count}
                                data-edge-candidate-id={group.candidateId}
                                x1={x1} y1={y1} x2={x2} y2={y2}
                                stroke={style.color}
                                strokeWidth={edgeGroupStrokeWidth(group.count)}
                                strokeDasharray={group.allConfirmed ? undefined : '4 3'}
                                markerEnd={style.markerEnd}
                                markerStart={style.markerStart}
                                style={isUndoable ? { pointerEvents: 'auto', cursor: 'pointer' } : undefined}
                                onClick={isUndoable ? () => setUndoTarget({
                                  candidateId: group.candidateId!, fromNodeId: group.fromNodeId, toNodeId: group.toNodeId,
                                  declaredBy: group.declaredBy ?? null, declaredAt: group.declaredAt ?? null,
                                }) : undefined}
                              />
                              {group.count > 1 ? (
                                <text
                                  x={midX} y={midY - 4}
                                  textAnchor="middle"
                                  className="fill-muted-foreground font-mono text-[9px] font-semibold"
                                  style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 }}
                                >
                                  {group.count}
                                </text>
                              ) : null}
                            </g>
                          );
                        });
                      })()}
                    </svg>
                  ) : null}

                  {/* story #2353(AC3) — 손끝을 따라오는 점선(㉡ "아직 확定 아니므로"). 오늘의
                      단일-레인 현실을 그대로 반영해 첫 레인에서만 그린다(laneContainerRef와
                      같은 사정, 위 컴포넌트 docblock 참고). */}
                  {laneIndex === 0 && linkDraft.phase === 'linking' && linkDraft.sourceId ? (() => {
                    const positions = computeNodePositions(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X);
                    const from = positions.get(linkDraft.sourceId);
                    if (!from) return null;
                    const x1 = from.left + NODE_CARD_WIDTH;
                    const y1 = from.top + NODE_CARD_HEIGHT / 2;
                    let x2: number; let y2: number;
                    if (linkDraft.hoverTargetId) {
                      // 키보드/포인터 둘 다 — 후보 위에 있으면 그 카드 왼쪽 가장자리로 스냅.
                      const to = positions.get(linkDraft.hoverTargetId);
                      if (!to) return null;
                      x2 = to.left;
                      y2 = to.top + NODE_CARD_HEIGHT / 2;
                    } else if (linkDraft.via === 'pointer' && laneContainerRef.current) {
                      const rect = laneContainerRef.current.getBoundingClientRect();
                      x2 = linkDraft.pointerClientX - rect.left;
                      y2 = linkDraft.pointerClientY - rect.top;
                    } else {
                      return null; // 키보드 잇기인데 아직 후보가 없다(놓을 곳이 없는 경우) — 그릴 끝점이 없다.
                    }
                    return (
                      <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width="100%" height="100%">
                        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--info)" strokeWidth={1.6} strokeDasharray="4 3" />
                      </svg>
                    );
                  })() : null}

                  {lane.pastTotal === 0 && lane.nowNodes.length === 0 && lane.queueNodesByDepth.size === 0 ? (
                    <p className="absolute left-3 top-2 text-[11px] text-muted-foreground">{t('flowMapLaneEmpty')}</p>
                  ) : null}

                  {/* ④과거 묶음 카드 — 유나양 규격(아티팩트 a125909a, "묶음이 선을 통과시킨다").
                      접힌 상태(pastNodes 비어있음): 3줄(무엇이 몇 개 접혔나 · 접힌 것끼리
                      이어진 수(볼 수 없는 것, 수로 정직하게) · 접힌 것이 지금·미래로 보낸
                      수(볼 수 있는 것 — 선생님 "후속 작업이 어떻게 준비되는가" 물음의 답))
                      + 클릭하면 펼쳐진다("누르면 펼쳐지는 것이 곧 줌인" — 별도 줌 컨트롤 불요). */}
                  {lane.pastTotal > 0 && lane.pastNodes.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => onTogglePastBundle(lane.epicId)}
                      className="focus-inset absolute cursor-pointer rounded border border-border bg-muted px-1.5 py-1 text-left opacity-75 hover:border-brand/60"
                      style={{ left: PAST_BUNDLE_LEFT, top: PAST_BUNDLE_TOP, width: PAST_BUNDLE_CARD_WIDTH }}
                    >
                      <div className="font-mono text-[9px] font-semibold text-foreground">
                        {t('flowMapPastCount', { n: lane.pastTotal })} · {t('flowMapPastBundle')}
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {t('flowMapPastInternalCount', { n: lane.pastBundle.internalCount })}
                      </div>
                      <div className="text-[9px] font-semibold text-brand">
                        {t('flowMapPastOutgoingCount', { n: lane.pastBundle.outgoingCount })}
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {loadingPastBundleEpicIds.has(lane.epicId) ? t('flowMapPastLoading') : t('flowMapPastExpandHint')}
                      </div>
                    </button>
                  ) : null}

                  {/* 펼친 상태 — 개별 과거 카드가 낱개로 서고, 위 간선 SVG가 이미 이 좌표
                      (computeNodePositions의 'past-expanded' 열)로 직접 그려진다. 다시
                      누르면 접힌다("다시 누르면 접힙니다", 유나양 규격 그대로). */}
                  {lane.pastNodes.length > 0 ? (
                    <div
                      className="absolute rounded border border-dashed border-brand/50 bg-brand/[0.03] px-2 pb-2 pt-5"
                      style={{
                        left: PAST_BUNDLE_LEFT, top: PAST_BUNDLE_TOP,
                        width: PAST_EXPANDED_BOX_WIDTH,
                        height: PAST_EXPANDED_TOP_START - PAST_BUNDLE_TOP + lane.pastNodes.length * PAST_EXPANDED_ROW_HEIGHT,
                      }}
                    >
                      <span className="absolute -top-[9px] left-2 bg-card px-1 font-mono text-[9.5px] text-brand">
                        {t('flowMapPastCount', { n: lane.pastTotal })} · {t('flowMapPastExpandedCaption')}
                      </span>
                      <button
                        type="button"
                        onClick={() => onTogglePastBundle(lane.epicId)}
                        className="focus-inset absolute right-1 top-1 text-[9px] text-muted-foreground underline"
                      >
                        {t('flowMapPastCollapseHint')}
                      </button>
                    </div>
                  ) : null}

                  {lane.pastNodes.map((node, i) => (
                    <FlowMapNodeCard
                      key={node.id}
                      node={node}
                      left={PAST_EXPANDED_LEFT}
                      top={PAST_EXPANDED_TOP_START + i * PAST_EXPANDED_ROW_HEIGHT}
                      superseded={supersededIds.has(node.id)}
                      selected={!isLinkingActive && node.id === selectedNodeId}
                      onSelectStory={onSelectStory}
                      isLinkSource={linkSourceIdForBadge === node.id}
                      isInvalidDropTarget={linkSourceIdForDimming !== null && !isValidPortDropTarget(linkSourceIdForDimming, node.id, allEdges, laneIdByNodeId)}
                      isDropHover={linkHoverTargetId === node.id}
                      isJustLinked={justLinkedNodeId === node.id}
                      onPortPointerDown={handlePortPointerDown}
                      onPortKeyDown={handlePortKeyDown}
                    />
                  ))}

                  {lane.nowNodes.map((node, i) => (
                    <FlowMapNodeCard
                      key={node.id}
                      node={node}
                      left={NOW_CLUSTER_X}
                      top={4 + i * NODE_ROW_HEIGHT}
                      superseded={supersededIds.has(node.id)}
                      selected={!isLinkingActive && node.id === selectedNodeId}
                      onSelectStory={onSelectStory}
                      isLinkSource={linkSourceIdForBadge === node.id}
                      isInvalidDropTarget={linkSourceIdForDimming !== null && !isValidPortDropTarget(linkSourceIdForDimming, node.id, allEdges, laneIdByNodeId)}
                      isDropHover={linkHoverTargetId === node.id}
                      isJustLinked={justLinkedNodeId === node.id}
                      onPortPointerDown={handlePortPointerDown}
                      onPortKeyDown={handlePortKeyDown}
                    />
                  ))}

                  {/* ①깊이 좌표 — x = FLOW_MAP_DEPTH0_X + depth × FLOW_MAP_GRID_STEP. depth는
                      computeNodeDepth가 실제 계산한 값(간선 없는 오늘은 전부 0 → 한 열). */}
                  {Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => {
                    const overflow = lane.overflows.find((o) => o.depth === depth);
                    const x = FLOW_MAP_DEPTH0_X + depth * FLOW_MAP_GRID_STEP;
                    return (
                      <div key={depth}>
                        {nodes.map((node, i) => (
                          <FlowMapNodeCard
                            key={node.id}
                            node={node}
                            left={x}
                            top={4 + i * NODE_ROW_HEIGHT}
                            superseded={supersededIds.has(node.id)}
                            selected={!isLinkingActive && node.id === selectedNodeId}
                            onSelectStory={onSelectStory}
                            isLinkSource={linkSourceIdForBadge === node.id}
                            isInvalidDropTarget={linkSourceIdForDimming !== null && !isValidPortDropTarget(linkSourceIdForDimming, node.id, allEdges, laneIdByNodeId)}
                            isDropHover={linkHoverTargetId === node.id}
                            isJustLinked={justLinkedNodeId === node.id}
                            onPortPointerDown={handlePortPointerDown}
                            onPortKeyDown={handlePortKeyDown}
                          />
                        ))}
                        {/* ③「+N건」 더보기 카드(판C) — 잘린 수를 정직하게 보인다. "숨김"이
                            아니라 "있다는 걸 보여주며 접는 것"(오늘 「67 중 15」와 같은 규율). */}
                        {overflow ? (
                          <div
                            className="absolute flex w-[110px] items-center gap-1 rounded border border-dashed border-border px-1.5 py-1 text-[10px] text-muted-foreground"
                            style={{ left: x, top: 4 + nodes.length * NODE_ROW_HEIGHT }}
                          >
                            <b className="font-mono font-semibold text-foreground">
                              {t('flowMapMoreCount', { n: overflow.hiddenCount })}
                            </b>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {/* ⑥ 조건부 문구(PO 판정 2026-07-30) — "그리지 않는 것"이 아니라 "왜 비었는지
                      말하는 것"이 0을 그리는 것의 완성형. 하드코딩된 텍스트가 아니라 depth≥1
                      항목이 실제로 없을 때만 뜨는 조건문 — 간선이 착지해 depth 2열이 생기는
                      날 이 조건이 스스로 거짓이 되어 사라진다(거짓말이 될 위험 없음).
                      ⛔라이브 실측 발견 버그(2026-07-30, PR#2691 배포 검증 중) — `whitespace-nowrap`
                      없이는 이 `<p>`가 `overflow-x-auto` 조상의 초기(스크롤 前) clientWidth를
                      넘는 left에 놓일 때 shrink-to-fit 가용폭이 음수로 계산돼 한글이 글자 하나당
                      한 줄로 쪼개져 세로로 줄바꿈됐다(실측: computed width 13px). 명시적으로
                      한 줄 강제. */}
                  {shouldShowNoDeeperReason(lane) ? (
                    // story #2353(AC9, doc ㉤) — 「아직 없습니다」(사실 진술)와 슬롯(초대)은
                    // 뜻이 다르므로 같은 것으로 만들지 않되, 같은 자리에서 글만 바뀐다: 평소엔
                    // 이 사실 문장, 잇기가 진행 중이면 "여기에 놓으면 다음이 됩니다"로 — 슬롯
                    // 자체는 상시 있는 빈 상자가 아니라 «끌 때만» 나타나는 것이라 이 조건부
                    // 문구(shouldShowNoDeeperReason)에 얹는다(새 상시 UI를 만들지 않는다).
                    <p
                      className="absolute whitespace-nowrap font-mono text-[9px] text-brand"
                      style={{ left: FLOW_MAP_DEPTH0_X + FLOW_MAP_GRID_STEP + 12, top: height / 2 - 6 }}
                    >
                      {linkDraft.phase === 'linking' ? t('flowMapSlotDragHint') : t('flowMapNoDeeperReason')}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 하단 범례 — 유나신 정정(2026-07-31, 라이브 실측 후속, 세 번째·최終 문구 확定): 옛
          4종×2축 범례는 실선(확定)이 «한 번도 안 나오는데» "실선=확定"이라 적어 없는 것을
          설명하고 있었다(종 미정 점선만 24/24). 종·확認축을 다 설명하는 대신 정직한 한 줄로
          바꾼다 — 숫자도 버튼도 없다("일부입니다" 한 낱말이 범위를 말하는 것으로 족하다는
          PO 판정, "보입니다"❌/숫자❌는 그대로 남는 위험이라 아예 뺀 것). [확認하기]는 이번
          판에 안 붙인다 — 서버 엔드포인트는 있으나(backend/app/routers/stories.py:806·846·886)
          인라인으로 묻는 UI가 아직 없다.
          표시 조건은 여전히 «데이터 건수»가 아니라 «실제로 그려진 선»이 있는가여야 한다
          (countRenderedEdgeLines, derive-flow-map.ts) — 0이면 설명할 대상이 없어 범례도 안
          띄운다(빈 기능을 위한 상시 chrome을 만들지 않는다, 기존 원칙 그대로).
          ⛔유나 가디언 리뷰(2026-07-31, issuecomment-5139624505) — 뒤 절("사람이 확인한 것은
          아직 없습니다")에 만료 조건이 없어 #2725(포트)가 착지하는 순간 거짓이 될 뻔했다.
          hasAnyConfirmedRenderedEdge가 참이면 그 뒤 절을 뗀다 — 앞 절만으로도 "일부"라는
          말이 여전히 성립한다(전량 확認이 아니라는 뜻이므로). */}
      {renderedEdgeLineCount > 0 ? (
        <div className="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
          {t('edgeLegendMachineFound')}
          {hasAnyConfirmedRenderedEdge ? null : ` — ${t('edgeLegendNoneConfirmedYet')}`}
        </div>
      ) : null}

      {/* story #2353(AC4·AC5·AC6·AC16, doc ㉢) — 놓으면 뜨는 확認. "이어졌습니까?"를 다시
          안 묻는다(놓는 행위 자체가 그 답) — 묻는 건 «종류»뿐이다. */}
      {(linkDraft.phase === 'confirming' || linkDraft.phase === 'submitting') ? (() => {
        const fromNode = nodesById.get(linkDraft.sourceId);
        const toNode = nodesById.get(linkDraft.targetId);
        if (!fromNode || !toNode) return null;
        const submitting = linkDraft.phase === 'submitting';
        return (
          <Dialog open onOpenChange={(open) => { if (!open && !submitting) resetLinkDraft(); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('portConfirmSentence', { fromNumber: fromNode.storyNumber, toNumber: toNode.storyNumber })}</DialogTitle>
                <DialogDescription>{fromNode.title} → {toNode.title}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                {PORT_LINK_KINDS.map((kind) => (
                  <Button key={kind} type="button" variant="outline" disabled={submitting} onClick={() => handleConfirmLink(kind)}>
                    {t(`portLinkKind_${kind}`)}
                  </Button>
                ))}
                <Button type="button" variant="ghost" disabled={submitting} onClick={() => handleConfirmLink(null)}>
                  {t('portLinkKindLater')}
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" disabled={submitting} onClick={resetLinkDraft}>
                  {t('portLinkCancel')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })() : null}

      {/* story #2353(AC15) — 실패는 토스트로 흘려보내지 않는다(㉦-2, "그 자리에 남는다") —
          여기 고정 배너가 그 "자리"다. message는 서버 원문 그대로(진단을 새로 안 짓는다). */}
      {linkDraft.phase === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <span>{linkDraft.message}</span>
          <button type="button" onClick={resetLinkDraft} className="shrink-0 underline">{t('portLinkErrorDismiss')}</button>
        </div>
      ) : null}

      {/* story #2353(AC7·AC8) — 되돌리기는 «그 선 자체가 진입점»이다(토스트 금지, ㉣). 「누가
          언제 만들었는가」는 지워지지 않는 속성이라 여기 그대로 보인다. */}
      {undoTarget ? (() => {
        const titleResolution = resolveUndoTitle(undoTarget.declaredBy, currentTeamMemberId, memberMap);
        return (
        <Dialog open onOpenChange={(open) => { if (!open) { setUndoTarget(null); setUndoDeleteError(null); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {titleResolution.key === 'portUndoTitleOther'
                  ? t('portUndoTitleOther', { name: titleResolution.name })
                  : t(titleResolution.key)}
              </DialogTitle>
              <DialogDescription>
                {undoTarget.declaredAt ? t('portUndoSignature', { at: new Date(undoTarget.declaredAt).toLocaleString() }) : t('portUndoSignatureUnknown')}
              </DialogDescription>
            </DialogHeader>
            {undoDeleteError ? <p role="alert" className="text-[11px] text-destructive">{undoDeleteError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={undoDeleting} onClick={() => setUndoTarget(null)}>
                {t('portUndoKeep')}
              </Button>
              <Button type="button" variant="destructive" disabled={undoDeleting} onClick={handleUndoDelete}>
                {t('portUndoDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        );
      })() : null}
    </div>
  );
}
