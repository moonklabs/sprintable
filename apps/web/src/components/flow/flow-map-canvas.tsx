'use client';

import { useTranslations } from 'next-intl';
import type { FlowMapLane, FlowMapNode } from './derive-flow-map';
import {
  FLOW_MAP_GRID_STEP, FLOW_MAP_NOW_LINE_X, FLOW_MAP_DEPTH0_X, computeLaneHeight, shouldShowNoDeeperReason,
  computeNodePositions,
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
  if (node.status === 'blocked') return 'border-l-destructive';
  return 'border-l-border border-dashed'; // .n.queue — 아직 시작 안 한 것은 점선
}

function FlowMapNodeCard({ node, left, top }: { node: FlowMapNode; left: number; top: number }) {
  const t = useTranslations('flow');
  const statusKey = STATUS_LABEL_KEY[node.status];
  return (
    <div
      className={`absolute w-[110px] overflow-visible rounded border border-l-[3px] border-border bg-card px-1.5 py-1 text-[11px] shadow-sm ${nodeToneClass(node)}`}
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-1 font-mono text-[9px] text-muted-foreground">
        <span className="truncate">#{node.storyNumber}</span>
        <span className="shrink-0">{statusKey ? t(statusKey) : node.status}</span>
      </div>
      <div className="truncate">{node.title}</div>
      {/* ⑥ 포트(형태만, 2026-07-30 PO 판정) — 간선이 org 전체 0건인 지금이야말로 포트를
          «먼저» 세워야 한다(포트가 첫 연결을 만드는 유일한 길 — 재료를 소비만 하는 것과
          달리 재료를 만드는 것은 미룰수록 0이 굳는다). 오늘은 모양만: 실제 드래그로
          `POST /api/v2/dependencies`(from=왼쪽/to=오른쪽/dep_type='blocks' 고정, 방향
          PO 확定 2026-07-30)를 부르는 배선은 다음 조각. */}
      <span
        aria-hidden="true"
        className="absolute right-[-5px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full border-[1.5px] border-info bg-card"
      />
    </div>
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
export function FlowMapCanvas({ lanes }: FlowMapCanvasProps) {
  const t = useTranslations('flow');
  const maxDepth = Math.max(0, ...lanes.flatMap((l) => Array.from(l.queueNodesByDepth.keys())));
  const canvasWidth = FLOW_MAP_DEPTH0_X + (maxDepth + 1) * FLOW_MAP_GRID_STEP + 20;

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
                      없었다(양쪽 다 진짜 병이었다). 종류별(낳음/잇따름/대체) 시각 구분은
                      유나양의 4번째 축(제안↔확認) 확定 대기 중이라 오늘은 «단일 스타일 직선»
                      으로만 "연결이 있으면 선이 실제로 그려진다"를 증명한다 — 종별 스타일은
                      그 축이 오면 이 자리(strokeDasharray/marker 분기)에 얹는다. */}
                  {lane.edges.length > 0 ? (
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0"
                      width="100%"
                      height="100%"
                    >
                      {(() => {
                        const positions = computeNodePositions(lane, NODE_ROW_HEIGHT, NOW_CLUSTER_X);
                        return lane.edges.map((edge) => {
                          const from = positions.get(edge.fromNodeId);
                          const to = positions.get(edge.toNodeId);
                          if (!from || !to) return null;
                          const x1 = from.left + NODE_CARD_WIDTH;
                          const y1 = from.top + NODE_CARD_HEIGHT / 2;
                          const x2 = to.left;
                          const y2 = to.top + NODE_CARD_HEIGHT / 2;
                          return (
                            <line
                              key={`${edge.fromNodeId}-${edge.toNodeId}`}
                              x1={x1} y1={y1} x2={x2} y2={y2}
                              stroke="var(--muted-foreground)"
                              strokeWidth={1.2}
                            />
                          );
                        });
                      })()}
                    </svg>
                  ) : null}

                  {lane.pastTotal === 0 && lane.nowNodes.length === 0 && lane.queueNodesByDepth.size === 0 ? (
                    <p className="absolute left-3 top-2 text-[11px] text-muted-foreground">{t('flowMapLaneEmpty')}</p>
                  ) : null}

                  {/* ④과거 묶음 카드 — BE past:{total}엔 items가 없어(스키마 자체 없음) 개별
                      카드/최근1건을 지을 수 없다. 건수만 정직하게 보인다(지어내지 않는다). */}
                  {lane.pastTotal > 0 ? (
                    <div
                      className="absolute w-[90px] rounded border border-border bg-muted px-1.5 py-1 opacity-75"
                      style={{ left: 20, top: 4 }}
                    >
                      <div className="font-mono text-[9px] font-semibold text-foreground">
                        {t('flowMapPastCount', { n: lane.pastTotal })}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{t('flowMapPastBundle')}</div>
                    </div>
                  ) : null}

                  {lane.nowNodes.map((node, i) => (
                    <FlowMapNodeCard key={node.id} node={node} left={NOW_CLUSTER_X} top={4 + i * NODE_ROW_HEIGHT} />
                  ))}

                  {/* ①깊이 좌표 — x = FLOW_MAP_DEPTH0_X + depth × FLOW_MAP_GRID_STEP. depth는
                      computeNodeDepth가 실제 계산한 값(간선 없는 오늘은 전부 0 → 한 열). */}
                  {Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => {
                    const overflow = lane.overflows.find((o) => o.depth === depth);
                    const x = FLOW_MAP_DEPTH0_X + depth * FLOW_MAP_GRID_STEP;
                    return (
                      <div key={depth}>
                        {nodes.map((node, i) => (
                          <FlowMapNodeCard key={node.id} node={node} left={x} top={4 + i * NODE_ROW_HEIGHT} />
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
    </div>
  );
}
