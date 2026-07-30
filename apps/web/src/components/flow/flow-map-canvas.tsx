'use client';

import { useTranslations } from 'next-intl';
import type { FlowMapLane, FlowMapNode } from './derive-flow-map';
import { FLOW_MAP_GRID_STEP, FLOW_MAP_NOW_LINE_X, FLOW_MAP_DEPTH0_X, computeLaneHeight } from './derive-flow-map';

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
      className={`absolute w-[110px] truncate rounded border border-l-[3px] border-border bg-card px-1.5 py-1 text-[11px] shadow-sm ${nodeToneClass(node)}`}
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-1 font-mono text-[9px] text-muted-foreground">
        <span className="truncate">#{node.storyNumber}</span>
        <span className="shrink-0">{statusKey ? t(statusKey) : node.status}</span>
      </div>
      <div className="truncate">{node.title}</div>
    </div>
  );
}

/**
 * story #2224 L3 — 갈래 «지도» 최소 본체(유나 목업 `be8709a4` 판A/판B/판C, PO 판정
 * 2026-07-30). 오늘 범위는 딱 셋: ⑤레인 높이가 «내용에서 계산»(고정 아님) · ①노드가 «의존
 * 깊이 좌표»(x = depth × 110px, computeNodeDepth가 실제 계산 — 오늘은 간선이 없어 전부
 * depth 0) · ②「지금」 세로선(left 292px). 열마다 상위3+더보기·과거 묶음카드·포트·슬롯은
 * 레인 6개를 한 판에 얹는 멀티레인 BE 계약이 착지한 다음 단계(별도 PR) — 여기서 미리 안 짓는다.
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
                  <p className="text-[9px] text-muted-foreground">{t('canvasPast')} · {lane.pastTotal}</p>
                </div>
                <div className="relative min-w-0 flex-1">
                  {/* ②「지금」 세로선 — 아티팩트 실측: left 292px, top 0~바닥, 1px, info, opacity .5 */}
                  <span
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 w-px bg-info opacity-50"
                    style={{ left: FLOW_MAP_NOW_LINE_X }}
                  />

                  {lane.nowNodes.length === 0 && lane.queueNodesByDepth.size === 0 ? (
                    <p className="absolute left-3 top-2 text-[11px] text-muted-foreground">{t('flowMapLaneEmpty')}</p>
                  ) : null}

                  {lane.nowNodes.map((node, i) => (
                    <FlowMapNodeCard key={node.id} node={node} left={NOW_CLUSTER_X} top={4 + i * NODE_ROW_HEIGHT} />
                  ))}

                  {/* ①깊이 좌표 — x = FLOW_MAP_DEPTH0_X + depth × FLOW_MAP_GRID_STEP. depth는
                      computeNodeDepth가 실제 계산한 값(간선 없는 오늘은 전부 0 → 한 열). */}
                  {Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => (
                    <div key={depth}>
                      {nodes.map((node, i) => (
                        <FlowMapNodeCard
                          key={node.id}
                          node={node}
                          left={FLOW_MAP_DEPTH0_X + depth * FLOW_MAP_GRID_STEP}
                          top={4 + i * NODE_ROW_HEIGHT}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
