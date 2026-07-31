'use client';

import { useTranslations } from 'next-intl';
import type { FlowMapLane, FlowMapNode, FlowMapEdgeKind, FlowMapEdgeGroup } from './derive-flow-map';
import {
  FLOW_MAP_GRID_STEP, FLOW_MAP_NOW_LINE_X, FLOW_MAP_DEPTH0_X, computeLaneHeight, shouldShowNoDeeperReason,
  computeNodePositions, computeSupersededNodeIds, computeEdgeLineEndpoints, groupEdgesByEndpoints,
  edgeGroupStrokeWidth, countRenderedEdgeLines, PAST_BUNDLE_NODE_ID, PAST_BUNDLE_LEFT, PAST_BUNDLE_TOP,
  PAST_BUNDLE_CARD_WIDTH, PAST_BUNDLE_CARD_HEIGHT, PAST_EXPANDED_LEFT, PAST_EXPANDED_TOP_START,
  PAST_EXPANDED_ROW_HEIGHT, PAST_EXPANDED_BOX_WIDTH,
} from './derive-flow-map';

// 카드 실측(FlowMapNodeCard): w-[110px], 높이는 두 줄 텍스트+padding으로 24px 안팎(NODE_ROW_HEIGHT
// 28px 중 4px가 행간) — 선은 카드 "왼쪽 가장자리 중앙"→"오른쪽 가장자리 중앙"을 잇는다.
const NODE_CARD_WIDTH = 110;
const NODE_CARD_HEIGHT = 24;

// 유나 목업(`be8709a4`) 실측 치수 — "그림이 정본"(2026-07-30), 비슷한 값이 아니라 그 숫자.
const HEADER_HEIGHT = 22; // .colhd
const NODE_ROW_HEIGHT = 28; // .n(24px) + 행간
const LANE_MIN_HEIGHT = 70;
const NOW_CLUSTER_X = FLOW_MAP_NOW_LINE_X - 40; // "지금" 노드는 세로선 바로 왼쪽에 클러스터(착수시각순)

interface FlowMapCanvasProps {
  lanes: FlowMapLane[];
  /** 노드 클릭 → 스토리 상세 패널(선생님 지적 2026-07-30 — 동사 0개였다). story #2354
   * 후속(2026-07-31) — 예전엔 `?view=list&story={id}`로 칸반 오픈 경로를 탔으나, view를
   * 갈아 끼우는 것 자체가 캔버스를 언마운트시키는 원인이었다(선생님 "인터랙션이 없다"의
   * 구조적 뿌리). 지금은 호출부(flow-client.tsx)가 `?story={id}`만 붙이고 지도 «위»에
   * 겹치는 팝오버로 같은 `StoryDetailPanel`을 재사용한다 — view는 그대로 둔다. */
  onSelectStory: (storyId: string) => void;
  /** 유나양 규격(아티팩트 a125909a, "누르면 펼쳐지는 것이 곧 줌인") — 묶음 카드를 누르면
   * 호출부(FlowEpicNodes)가 개별 과거 스토리를 fetch해 `pastItems`로 다시 넘긴다. 오늘은
   * 레인이 늘 하나(펼친 에픽 하나)라 콜백에 lane 식별자가 없다 — `onSelectStory`와 같은
   * 자리(오늘의 단일-레인 구조에 내일의 여러-레인 모양을 미리 맞추는 대신, 지금은 콜백
   * 자체를 단순하게 둔다. 멀티레인이 오면 epicId 인자를 추가하는 것으로 끝난다). */
  onTogglePastBundle: () => void;
  /** fetch 진행 중 — 묶음 카드가 "불러오는 중…"을 보이는 자리. */
  isPastBundleLoading: boolean;
  /** story #2354 AC6 — 패널을 «닫아도» 마지막으로 누른 노드가 선택된 채로 남는다(고리 강조
   * ring). URL의 `?story=`가 단일 소스 — 패널이 닫혀도 이 값은 지워지지 않는다(호출부가
   * 패널의 열림/닫힘만 별도 로컬 상태로 관리, 선택 자체는 URL 그대로). */
  selectedNodeId?: string | null;
}

// PO 지적(2026-07-30) — 판을 갈아엎으며 색/모양(border-left)만 남기고 「status를 사람이
// 읽는 말」이 조용히 사라질 뻔했다(구 FlowNodeCard의 상태 배지가 이 카드로 안 옮겨짐). 색은
// 범례 없이는 뜻을 못 나르므로, 카드 자체에 라벨 텍스트를 그대로 유지한다(구 카드와 동형).
const STATUS_LABEL_KEY: Record<string, string> = {
  'in-progress': 'nodeStatusInProgress',
  'in-review': 'nodeStatusInReview',
  'ready-for-dev': 'nodeStatusReadyForDev',
  blocked: 'nodeStatusBlocked',
  backlog: 'nodeStatusBacklog',
  done: 'nodeStatusDone',
};

function nodeToneClass(node: FlowMapNode): string {
  if (node.kind === 'now') return 'border-l-info';
  if (node.kind === 'past') return 'border-l-border'; // 펼친 과거 — 끝난 것이라 점선(미착수 표시) 아님
  if (node.status === 'blocked') return 'border-l-destructive';
  return 'border-l-border border-dashed'; // .n.queue — 아직 시작 안 한 것은 점선
}

function FlowMapNodeCard({ node, left, top, superseded, selected, onSelectStory }: { node: FlowMapNode; left: number; top: number; superseded: boolean; selected: boolean; onSelectStory: (storyId: string) => void }) {
  const t = useTranslations('flow');
  const statusKey = STATUS_LABEL_KEY[node.status];
  // 유나양 규격(아티팩트 a125909a `.nd.past{opacity:.62}`) — 펼친 과거 카드는 항상 흐림
  // (대체-확認 흐림과 별개 사정 — 이미 끝난 일이라는 사실 자체를 흐림으로 나타낸다).
  const dimmed = superseded || node.kind === 'past';
  return (
    <button
      type="button"
      // story #2354 — data-node-id는 오버레이 패널이 "이 노드를 가리지 않는" 위/아래 반전
      // 위치를 계산할 앵커(getBoundingClientRect)를 찾는 자리다. onSelectStory 시그니처를
      // 건드리지 않는다(오르빈·목록 피커 등 «노드가 아닌» 호출부가 여럿이라, DOM 앵커
      // 개념이 없는 그 호출부들까지 억지로 끌고 갈 이유가 없다 — 호출부는 storyId 하나만
      // 안다). 패널을 닫아도 selected는 유지된다("누른 노드가 선택된 채로 남는다", AC6).
      data-node-id={node.id}
      onClick={() => onSelectStory(node.id)}
      className={`focus-inset absolute w-[110px] cursor-pointer overflow-visible rounded border border-l-[3px] border-border bg-card px-1.5 py-1 text-left text-[11px] shadow-sm hover:border-info/60 ${nodeToneClass(node)} ${dimmed ? 'opacity-50' : ''} ${selected ? 'ring-2 ring-brand ring-offset-1 ring-offset-background' : ''}`}
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-1 font-mono text-[9px] text-muted-foreground">
        <span className="truncate">#{node.storyNumber}</span>
        <span className="shrink-0">{statusKey ? t(statusKey) : node.status}</span>
      </div>
      {/* 대체(확認됨)만 — "옛 노드"에 취소선(유나양 규격). 제안 상태는 절대 취소선을 넣지
          않는다(computeSupersededNodeIds가 confirmed 간선만 모으므로 이 자리는 값만 받는다 —
          "제안이면 안 흐린다"는 판단을 이 컴포넌트가 다시 하지 않는다). */}
      <div className={`truncate ${superseded ? 'line-through' : ''}`}>{node.title}</div>
      {/* ⑥ 포트(형태만, 2026-07-30 PO 판정) — 간선이 org 전체 0건인 지금이야말로 포트를
          «먼저» 세워야 한다(포트가 첫 연결을 만드는 유일한 길 — 재료를 소비만 하는 것과
          달리 재료를 만드는 것은 미룰수록 0이 굳는다). 오늘은 모양만: 실제 드래그로
          `POST /api/v2/dependencies`(from=왼쪽/to=오른쪽/dep_type='blocks' 고정, 방향
          PO 확定 2026-07-30)를 부르는 배선은 다음 조각. */}
      <span
        aria-hidden="true"
        className="absolute right-[-5px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full border-[1.5px] border-info bg-card"
      />
    </button>
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
 * 포트(⑥)는 «그림»만 서 있다 — 실제 저장 배선은 #2221(부산물형 간선 3종)이 착지한 뒤
 * (PO 정정 2026-07-30, 기존 `dependencies`(계획형)에 쓰면 6주 0건 운명을 물려받는다).
 *
 * `lanes`를 배열로 받는 것은 오늘의 단일-에픽 구조에 이미 «내일의 모양»을 맞춰 두는 것이다
 * (PO 지시 — "한 레인 전용으로 짜지 마시는, 처음부터 레인 배열을 받는 형태로"). 오늘은 이
 * 배열의 길이가 늘 1(펼친 에픽 하나) — 멀티레인 계약이 오면 호출부만 배열을 채워 넘기면 된다.
 */
export function FlowMapCanvas({ lanes, onSelectStory, onTogglePastBundle, isPastBundleLoading, selectedNodeId = null }: FlowMapCanvasProps) {
  const t = useTranslations('flow');
  const maxDepth = Math.max(0, ...lanes.flatMap((l) => Array.from(l.queueNodesByDepth.keys())));
  const canvasWidth = FLOW_MAP_DEPTH0_X + (maxDepth + 1) * FLOW_MAP_GRID_STEP + 20;
  // 범례 {n}·표시여부의 단일 진실 — countRenderedEdgeLines 하나로 아래 두 곳(조건·개수)이
  // 항상 같은 값을 본다(PO 지시 2026-07-31, derive-flow-map.ts 문서 참고).
  const renderedEdgeLineCount = lanes.reduce(
    (sum, lane) => sum + countRenderedEdgeLines(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X, { width: NODE_CARD_WIDTH, height: NODE_CARD_HEIGHT }),
    0,
  );

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

      <div className="focus-inset overflow-x-auto">
        <div className="relative" style={{ width: Math.max(canvasWidth, 400) }}>
          {lanes.map((lane) => {
            const height = computeLaneHeight(lane, NODE_ROW_HEIGHT, LANE_MIN_HEIGHT);
            const supersededIds = computeSupersededNodeIds(lane.edges);
            return (
              <div key={lane.epicId} className="relative flex border-b border-border last:border-b-0" style={{ height }}>
                <div className="w-[150px] shrink-0 border-r border-border px-2 py-1.5">
                  <p className="truncate text-[11px] font-semibold text-foreground">{lane.title}</p>
                </div>
                <div className="relative min-w-0 flex-1">
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
                          return (
                            <g key={`${group.fromNodeId}-${group.toNodeId}`}>
                              <line
                                data-edge-kind={group.uniformKind === 'mixed' ? 'mixed' : (group.uniformKind ?? 'unknown')}
                                data-edge-confirmed={group.allConfirmed}
                                data-edge-count={group.count}
                                x1={x1} y1={y1} x2={x2} y2={y2}
                                stroke={style.color}
                                strokeWidth={edgeGroupStrokeWidth(group.count)}
                                strokeDasharray={group.allConfirmed ? undefined : '4 3'}
                                markerEnd={style.markerEnd}
                                markerStart={style.markerStart}
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
                      onClick={onTogglePastBundle}
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
                        {isPastBundleLoading ? t('flowMapPastLoading') : t('flowMapPastExpandHint')}
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
                        onClick={onTogglePastBundle}
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
                      selected={node.id === selectedNodeId}
                      onSelectStory={onSelectStory}
                    />
                  ))}

                  {lane.nowNodes.map((node, i) => (
                    <FlowMapNodeCard key={node.id} node={node} left={NOW_CLUSTER_X} top={4 + i * NODE_ROW_HEIGHT} superseded={supersededIds.has(node.id)} selected={node.id === selectedNodeId} onSelectStory={onSelectStory} />
                  ))}

                  {/* ①깊이 좌표 — x = FLOW_MAP_DEPTH0_X + depth × FLOW_MAP_GRID_STEP. depth는
                      computeNodeDepth가 실제 계산한 값(간선 없는 오늘은 전부 0 → 한 열). */}
                  {Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => {
                    const overflow = lane.overflows.find((o) => o.depth === depth);
                    const x = FLOW_MAP_DEPTH0_X + depth * FLOW_MAP_GRID_STEP;
                    return (
                      <div key={depth}>
                        {nodes.map((node, i) => (
                          <FlowMapNodeCard key={node.id} node={node} left={x} top={4 + i * NODE_ROW_HEIGHT} superseded={supersededIds.has(node.id)} selected={node.id === selectedNodeId} onSelectStory={onSelectStory} />
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
                    <p
                      className="absolute whitespace-nowrap font-mono text-[9px] text-brand"
                      style={{ left: FLOW_MAP_DEPTH0_X + FLOW_MAP_GRID_STEP + 12, top: height / 2 - 6 }}
                    >
                      {t('flowMapNoDeeperReason')}
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
          띄운다(빈 기능을 위한 상시 chrome을 만들지 않는다, 기존 원칙 그대로). */}
      {renderedEdgeLineCount > 0 ? (
        <div className="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
          {t('edgeLegendMachineFoundPartial')}
        </div>
      ) : null}
    </div>
  );
}
