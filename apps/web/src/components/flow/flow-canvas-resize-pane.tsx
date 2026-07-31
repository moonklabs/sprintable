'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { computeCumulativeLaneHeight, computeLaneHeight, snapToNearestLaneCount, type FlowMapLane } from './derive-flow-map';

const STORAGE_KEY = 'sprintable-flow-canvas-lane-count';
const DEFAULT_LANE_COUNT = 3;

interface FlowCanvasResizePaneProps {
  lanes: FlowMapLane[];
  nodeRowHeight: number;
  laneMinHeight: number;
  headerHeight: number;
  children: ReactNode;
}

// reference-candidates.ts의 readRejectedSet/writeRejectedSet과 같은 관례 — localStorage
// 접근은 항상 try/catch로 감싼다(용량초과·프라이빗모드·이 API 자체가 없는 환경 전부 조용히
// 무시, 다음 렌더에서 기본값으로 자연히 대체된다).
function readStoredLaneCount(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredLaneCount(value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 조용히 무시 — 다음 렌더는 여전히 기본값으로 정상 동작한다.
  }
}

/**
 * story #2224 AC18(2026-07-31, 선생님 08:11Z + 유나 규격 08:14Z) — 지도 pane 높이를
 * 사용자가 지정한다. ①손잡이는 자유 픽셀로 끌리지만 «놓는 순간» 레인 정수 경계로
 * 스냅한다(연속량이 아니라 «지금 몇 줄기를 보고 싶은가»가 재는 대상이므로 — 자유
 * 픽셀이면 카드가 잘린 채 멈춘다). ②하한 = 레인 1개. ③값은 localStorage(사람 단위,
 * 1차) — 기기를 바꾸면 «기본값»으로 뜨는 것이지 «틀린 화면»이 아니므로 조용한 실패가
 * 아니다. ④되돌리기 버튼. ⑤기본 높이는 픽셀 하드코딩이 아니라
 * computeCumulativeLaneHeight(레인 3까지 누적, 가변)로 계산한다 — 라이브 레인 높이가
 * 목업(레인 8 기준 690px)과 다를 수 있으므로 «세는 단위(레인 수)»만 고정하고 픽셀은
 * 매번 다시 잰다.
 *
 * localStorage엔 픽셀이 아니라 «레인 수»를 저장한다 — 픽셀을 저장하면 다음 세션에
 * 레인 내용이 달라졌을 때(카드 추가/과거 펼침 등) 값이 낡는다. 레인 수는 "몇 줄기를
 * 보고 싶은가"라는 사용자의 «의도»이므로 매 렌더에서 현재 lanes로 다시 계산해도
 * 의미가 안 바뀐다.
 */
export function FlowCanvasResizePane({ lanes, nodeRowHeight, laneMinHeight, headerHeight, children }: FlowCanvasResizePaneProps) {
  const t = useTranslations('flow');
  const [laneCount, setLaneCount] = useState(() => readStoredLaneCount() ?? DEFAULT_LANE_COUNT);
  const [dragHeightPx, setDragHeightPx] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  const laneHeights = useMemo(
    () => lanes.map((lane) => computeLaneHeight(lane, nodeRowHeight, laneMinHeight)),
    [lanes, nodeRowHeight, laneMinHeight],
  );
  const minHeightPx = useMemo(
    () => computeCumulativeLaneHeight(lanes, 1, nodeRowHeight, laneMinHeight, headerHeight),
    [lanes, nodeRowHeight, laneMinHeight, headerHeight],
  );
  const maxHeightPx = headerHeight + laneHeights.reduce((sum, h) => sum + h, 0);
  const clampedLaneCount = Math.max(1, Math.min(laneCount, lanes.length || 1));
  const committedHeightPx = useMemo(
    () => computeCumulativeLaneHeight(lanes, clampedLaneCount, nodeRowHeight, laneMinHeight, headerHeight),
    [lanes, clampedLaneCount, nodeRowHeight, laneMinHeight, headerHeight],
  );
  const displayHeightPx = dragHeightPx ?? committedHeightPx;
  const defaultLaneCount = Math.min(DEFAULT_LANE_COUNT, lanes.length || DEFAULT_LANE_COUNT);
  const isAtDefault = clampedLaneCount === defaultLaneCount;

  const commitLaneCount = useCallback((next: number) => {
    const clamped = Math.max(1, Math.min(next, lanes.length || 1));
    setLaneCount(clamped);
    writeStoredLaneCount(String(clamped));
  }, [lanes.length]);

  const commitFromRawHeight = useCallback((rawHeightPx: number) => {
    const candidateLanesOnly = rawHeightPx - headerHeight;
    commitLaneCount(snapToNearestLaneCount(laneHeights, candidateLanesOnly));
  }, [laneHeights, headerHeight, commitLaneCount]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: committedHeightPx };
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
  }, [committedHeightPx]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    setDragHeightPx(Math.max(minHeightPx, Math.min(maxHeightPx, d.startHeight + dy)));
  }, [minHeightPx, maxHeightPx]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const el = e.currentTarget as HTMLElement;
    if (typeof el.releasePointerCapture === 'function') el.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    if (dragHeightPx !== null) commitFromRawHeight(dragHeightPx);
    setDragHeightPx(null);
  }, [dragHeightPx, commitFromRawHeight]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      commitLaneCount(clampedLaneCount + 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      commitLaneCount(clampedLaneCount - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitLaneCount(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      commitLaneCount(lanes.length);
    }
  }, [clampedLaneCount, commitLaneCount, lanes.length]);

  const handleReset = useCallback(() => {
    setLaneCount(DEFAULT_LANE_COUNT);
    writeStoredLaneCount(null);
  }, []);

  // 레인이 0개면(로딩·빈 화면) 조절할 대상 자체가 없다 — 손잡이 UI를 안 보여준다.
  if (lanes.length === 0) return <>{children}</>;

  return (
    <div>
      <div data-testid="flow-canvas-resize-pane" className="overflow-y-auto focus-inset" style={{ height: displayHeightPx }}>
        {children}
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-border bg-muted/20 py-1">
        <div
          role="slider"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t('canvasResizeHandleLabel')}
          aria-valuenow={clampedLaneCount}
          aria-valuemin={1}
          aria-valuemax={lanes.length}
          data-testid="flow-canvas-resize-handle"
          className="focus-inset h-1.5 w-10 cursor-row-resize touch-none rounded-full bg-border hover:bg-muted-foreground/40"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onKeyDown={handleKeyDown}
        />
        {!isAtDefault ? (
          <button
            type="button"
            onClick={handleReset}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            data-testid="flow-canvas-resize-reset"
          >
            {t('canvasResizeReset')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
