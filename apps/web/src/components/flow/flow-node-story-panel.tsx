'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { StoryDetailPanel, type Task } from '@/components/kanban/story-detail-panel';
import type { KanbanStory } from '@/components/kanban/types';
import { useIsMobile } from '@/hooks/use-mobile';

const OVERLAY_GAP = 8; // 노드와 패널 사이 여백(px)
const OVERLAY_EDGE_MARGIN = 16; // 뷰포트 가장자리 여백(px)
const OVERLAY_MAX_HEIGHT_RATIO = 0.5; // AC5 — 뷰포트 절반 이하

interface FlowNodeStoryPanelProps {
  storyId: string;
  onClose: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; story: KanbanStory; tasks: Task[] };

/** AC4(누른 노드를 가리지 않는다)·AC5(높이≤뷰포트 절반) — 순수함수로 뺀 이유는 useEffect
 * 본문에서 직접 계산하면(무조건부 setState) react-hooks/set-state-in-effect가 걸리기
 * 때문만이 아니라, 위/아래 반전 규칙 자체를 DOM/React와 무관하게 값으로 검증하기 위해서다. */
function computeOverlayPosition(rect: DOMRect | null, viewportHeight: number): { top: number; heightPx: number } {
  const maxHeightPx = viewportHeight * OVERLAY_MAX_HEIGHT_RATIO;
  if (!rect) {
    // 앵커를 못 찾은 폴백 — 뷰포트 중앙에 최대높이로.
    return { top: (viewportHeight - maxHeightPx) / 2, heightPx: maxHeightPx };
  }
  const nodeIsUpperHalf = rect.top < viewportHeight / 2;
  if (nodeIsUpperHalf) {
    // 노드가 위쪽 — 패널은 그 «아래»에, 뷰포트 하단까지 남는 공간과 상한 중 작은 쪽.
    const top = rect.bottom + OVERLAY_GAP;
    const heightPx = Math.max(120, Math.min(maxHeightPx, viewportHeight - OVERLAY_EDGE_MARGIN - top));
    return { top, heightPx };
  }
  // 노드가 아래쪽 — 패널은 그 «위»에, 상단까지 남는 공간과 상한 중 작은 쪽.
  const heightPx = Math.max(120, Math.min(maxHeightPx, rect.top - OVERLAY_GAP - OVERLAY_EDGE_MARGIN));
  const top = rect.top - OVERLAY_GAP - heightPx;
  return { top, heightPx };
}

/**
 * story #2354 — 「패널을 자립시키는 일」(2026-07-31 조사 결론 그대로) 구현. `StoryDetailPanel`은
 * 필수 prop이 story·tasks·onClose 셋뿐이고 나머지 11개가 이미 옵셔널이라, storyId 하나로
 * 자체 fetch하는 이 얇은 래퍼가 그 위에 서면 충분하다(새 BE 0 — `GET /api/stories/{id}` ·
 * `GET /api/tasks?story_id=`는 kanban-board.tsx가 오늘 이미 쓰는 그 경로 그대로, AC8).
 *
 * 위치 계산(AC4 — 누른 노드를 가리지 않는다) — `data-node-id`(flow-map-canvas.tsx)로 클릭된
 * 노드 카드의 실제 화면 좌표를 찾는다. 노드가 뷰포트 위쪽 절반이면 패널을 그 «아래»에,
 * 아래쪽 절반이면 «위»에 둔다. 앵커를 못 찾으면(오르빈 등 캔버스 밖 호출 — 오늘은 실제로
 * 안 일어난다, onSelectStory는 노드 클릭 전용 경로에서만 storyId를 이 컴포넌트로 올린다)
 * 뷰포트 중앙 폴백으로 안전하게 내려간다.
 *
 * ⛔유나 가디언 리뷰(2026-07-31, PR#2722 issuecomment-5139371576) — 모바일(390px)엔 이
 * 소형 오버레이를 그대로 쓰지 않는다. 「지도를 살려 둔다」가 데스크톱서 값 있는 건 지도가
 * «넓어서»다 — 모바일은 지도도 절반·상세도 절반이 되어 헤더+설명+작업+댓글이 못 들어간다
 * (IA §5에 이미 선 판단: 겹침이 아니라 독립 화면). isMobile이면 앵커 위치 계산 자체를 건너
 * 뛰고 `StoryDetailPanel`에 overlayPosition을 안 넘긴다 — 그러면 그 컴포넌트가 이미 갖고
 * 있는 전체화면 드로어 모드(KanbanBoard가 쓰는 그 경로 그대로, 새 컴포넌트 아님)로 뜬다.
 */
export function FlowNodeStoryPanel({ storyId, onClose }: FlowNodeStoryPanelProps) {
  const t = useTranslations('flow');
  const isMobile = useIsMobile();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [overlayPosition, setOverlayPosition] = useState<{ top: number; heightPx: number } | null>(null);

  // 「story가 바뀔 때 loading으로 되돌리는」 것은 여기서 수동으로 안 한다 — 호출부
  // (flow-client.tsx)가 `key={storyId}`로 이 컴포넌트를 통째로 다시 마운트시킨다(초기값
  // {kind:'loading'}이 매번 자연히 맞다). next-maker-screen.tsx가 GoalStemCard를
  // key={focusedStem.epicId}로 다루는 것과 같은 관례 — effect 본문 최상위의 무조건
  // setState(react-hooks/set-state-in-effect가 막는 자리)를 마운트 자체로 대신한다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storyJson, tasksJson] = await Promise.all([
        fetch(`/api/stories/${storyId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`/api/tasks?story_id=${storyId}&limit=20`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (cancelled) return;
      const story = storyJson?.data as KanbanStory | undefined;
      if (!story) {
        setState({ kind: 'error' });
        return;
      }
      const tasks = (tasksJson?.data ?? []) as Task[];
      setState({ kind: 'ready', story, tasks });
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  // 앵커 위치는 클릭된 실 DOM(data-node-id)에서 한 번 잰다 — 패널이 열려 있는 동안 캔버스가
  // 스크롤돼도 다시 재지 않는다(AC6 "닫으면 그대로" 판정선이 스크롤 위치 자체를 건드리지
  // 말라는 것이지, 패널이 스크롤을 실시간 추적하라는 요구가 아니다 — 열 때 한 번으로 충분).
  // rAF로 감싸는 이유 — DOM 페인트(레이아웃 확정) «후» 재야 정확하고, react-hooks/
  // set-state-in-effect가 effect 본문 최상위의 무조건 setState를 막는다(mobile-selection-
  // menu.tsx의 "구독→콜백에서 setState" 관례와 같은 자리 — 여긴 구독 대상이 rAF 타이밍).
  useEffect(() => {
    if (isMobile) return; // 모바일은 전체화면 드로어라 앵커 좌표가 필요 없다.
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      // CSS.escape 기반 셀렉터 문자열 조립 대신 속성값을 직접 비교한다 — storyId에 CSS
      // 셀렉터 특수문자(UUID라 실무상 없지만)가 섞여도 안전하고, CSS.escape 전역이 없는
      // 실행환경(jsdom 테스트 등)에도 안 깨진다.
      const anchorEl = Array.from(document.querySelectorAll('[data-node-id]'))
        .find((el) => el.getAttribute('data-node-id') === storyId) ?? null;
      setOverlayPosition(computeOverlayPosition(anchorEl?.getBoundingClientRect() ?? null, window.innerHeight));
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [storyId, isMobile]);

  // ⛔유나 가디언 리뷰(2026-07-31) — loading 구간에서 null을 반환하면 누른 직후 "아무 변화
  // 없는" 침묵 구간이 선다(실패보다 나쁘다 — 신호 자체가 없어서). 이미 있는 `nodesLoading`
  // 키(flow-epic-nodes.tsx가 같은 뜻으로 쓰는 그 키, ko.json:463)를 그대로 재사용한다.
  if (state.kind === 'loading' || (!isMobile && !overlayPosition)) {
    return (
      <div
        className="fixed inset-x-4 top-4 z-50 mx-auto max-w-xl rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground shadow-xl sm:inset-x-auto sm:right-4 sm:w-full"
        style={!isMobile && overlayPosition ? { top: overlayPosition.top } : undefined}
      >
        {t('nodesLoading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        className="fixed inset-x-4 top-4 z-50 mx-auto max-w-xl rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground shadow-xl sm:inset-x-auto sm:right-4 sm:w-full"
        style={!isMobile && overlayPosition ? { top: overlayPosition.top } : undefined}
      >
        {t('nodesError')}
      </div>
    );
  }

  if (isMobile) {
    // IA §5 — 모바일은 겹침이 아니라 독립 화면. overlayPosition을 안 넘기면
    // StoryDetailPanel이 이미 갖고 있는 전체화면 드로어 모드로 뜬다(KanbanBoard와 동일 경로).
    return <StoryDetailPanel story={state.story} tasks={state.tasks} onClose={onClose} />;
  }

  return (
    <StoryDetailPanel
      story={state.story}
      tasks={state.tasks}
      onClose={onClose}
      overlayPosition={{ top: overlayPosition!.top, heightPx: overlayPosition!.heightPx }}
    />
  );
}
