// @vitest-environment jsdom
//
// story #2224 AC18(2026-07-31) — 지도 pane 높이를 사용자가 지정한다. 자를 «둘»로 잰다
// (유나 규격 08:14Z — 자와 기본값이 하나면 자가 자기를 검사한다, positive control must be
// able to fail): ㉠기본 상태에서 레인 3개가 온전히 ㉡최소까지 줄여도 레인 1개는 온전히.
// 손잡이는 드래그(자유 픽셀→놓으면 레인 정수 스냅) + 키보드(레인 단위 직접 이동) 둘 다
// 같은 커밋 경로(commitLaneCount)를 타므로, 여기선 값을 확실히 재는 키보드 경로로 대부분의
// 판정을 걸고 드래그는 스냅 값 계산만 별도로 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowCanvasResizePane } from './flow-canvas-resize-pane';
import { computeLaneHeight, type FlowMapLane } from './derive-flow-map';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NODE_ROW_HEIGHT = 32;
const LANE_MIN_HEIGHT = 70;
const HEADER_HEIGHT = 22;
const STORAGE_KEY = 'sprintable-flow-canvas-lane-count';

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeLane(epicId: string, nowCount: number): FlowMapLane {
  return {
    epicId, title: `Epic ${epicId}`, pastTotal: 0,
    nowNodes: Array.from({ length: nowCount }, (_, i) => ({
      id: `${epicId}-n${i}`, storyNumber: i, title: 't', status: 'backlog', kind: 'now' as const, depth: 0,
    })),
    queueNodesByDepth: new Map(), overflows: [], edges: [],
    pastBundle: { total: 0, internalCount: 0, outgoingCount: 0 }, pastNodes: [],
  };
}

// 균일하지 않은 레인 다섯 — 서로 다른 노드 수라 각 레인 높이가 균일 곱셈이 아니다(실제
// computeLaneHeight를 통과시켜 진짜 값으로 잰다, 손 계산한 숫자를 중복하지 않는다).
const LANES: FlowMapLane[] = [
  makeLane('e1', 1), // minHeight(70)이 이긴다 — 1*32=32 < 70
  makeLane('e2', 3), // 3*32=96
  makeLane('e3', 1), // 70
  makeLane('e4', 4), // 4*32=128
  makeLane('e5', 1), // 70
];
const LANE_HEIGHTS = LANES.map((l) => computeLaneHeight(l, NODE_ROW_HEIGHT, LANE_MIN_HEIGHT));

async function render(lanes: FlowMapLane[] = LANES) {
  await act(async () => {
    root.render(wrap(
      <FlowCanvasResizePane lanes={lanes} nodeRowHeight={NODE_ROW_HEIGHT} laneMinHeight={LANE_MIN_HEIGHT} headerHeight={HEADER_HEIGHT}>
        <div data-testid="canvas-stub" style={{ height: 9999 }}>stub</div>
      </FlowCanvasResizePane>,
    ));
  });
}

function paneHeightPx(): number {
  const el = container.querySelector('[data-testid="flow-canvas-resize-pane"]') as HTMLElement | null;
  return el ? Number(el.style.height.replace('px', '')) : NaN;
}

function handle(): HTMLElement {
  const el = container.querySelector('[data-testid="flow-canvas-resize-handle"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

// kanban-board.test.tsx의 관례 그대로 — jsdom 기본 localStorage에 기대지 않고 Map 기반
// 스텁을 직접 세운다(테스트 간 격리는 beforeEach의 새 store로).
let localStorageStore: Map<string, string>;

function stubLocalStorage() {
  localStorageStore = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStorageStore.get(k) ?? null,
    setItem: (k: string, v: string) => { localStorageStore.set(k, v); },
    removeItem: (k: string) => { localStorageStore.delete(k); },
    clear: () => { localStorageStore.clear(); },
  });
}

beforeEach(() => {
  stubLocalStorage();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('FlowCanvasResizePane — AC18 ⑤ 기본 높이는 하드코딩이 아니라 계산값', () => {
  it('㉠ default state: pane height equals the REAL computed sum of the first 3 lanes + header (not a hardcoded 690/168 etc)', async () => {
    await render();
    const expected = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]! + LANE_HEIGHTS[2]!;
    expect(paneHeightPx()).toBe(expected);
    // 양성대조 — 이 값이 목업의 상수(690)나 옛 고정값(168)과 «우연히» 같지 않음을 확인해
    // "그냥 아무 숫자나 나와도 통과"가 아님을 명시적으로 배제한다.
    expect(paneHeightPx()).not.toBe(690);
    expect(paneHeightPx()).not.toBe(168);
  });

  it('fewer than 3 lanes exist — default clamps to "all of them", not a crash or an assumed 3', async () => {
    await render(LANES.slice(0, 2));
    const expected = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]!;
    expect(paneHeightPx()).toBe(expected);
  });

  it('0 lanes — renders children directly with no resize handle at all (아무 것도 조절할 게 없다)', async () => {
    await render([]);
    expect(container.querySelector('[data-testid="flow-canvas-resize-pane"]')).toBeNull();
    expect(container.querySelector('[data-testid="flow-canvas-resize-handle"]')).toBeNull();
    expect(container.querySelector('[data-testid="canvas-stub"]')).not.toBeNull();
  });
});

describe('FlowCanvasResizePane — AC18 ①② 키보드(레인 단위) — 자유 픽셀 드래그와 같은 커밋 경로', () => {
  it('ArrowDown repeatedly reaches ㉡ minimum (레인 1개) and stops there — never degenerates to 0 or partial', async () => {
    await render();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
    }
    // ㉡ — 최소까지 줄여도 레인 «1개»는 온전히(카드 안 잘림): 높이가 정확히 레인 1의 실 높이 + 헤더.
    const expectedMin = HEADER_HEIGHT + LANE_HEIGHTS[0]!;
    expect(paneHeightPx()).toBe(expectedMin);
    expect(paneHeightPx()).toBeGreaterThan(HEADER_HEIGHT); // 0으로 접히지 않는다(지도는 접지 않는다)
  });

  it('Home jumps straight to minimum (레인 1개), End jumps to all lanes', async () => {
    await render();
    await act(async () => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(paneHeightPx()).toBe(HEADER_HEIGHT + LANE_HEIGHTS[0]!);

    await act(async () => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    const allHeight = HEADER_HEIGHT + LANE_HEIGHTS.reduce((a, b) => a + b, 0);
    expect(paneHeightPx()).toBe(allHeight);
  });

  it('ArrowUp past the last lane clamps at all-lanes (no runaway past the data)', async () => {
    await render();
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      });
    }
    const allHeight = HEADER_HEIGHT + LANE_HEIGHTS.reduce((a, b) => a + b, 0);
    expect(paneHeightPx()).toBe(allHeight);
  });
});

describe('FlowCanvasResizePane — AC18 ③④ localStorage 영속 + 되돌리기', () => {
  it('a committed lane count survives an unmount/remount (사람 단위 값이 «남는다»)', async () => {
    await render();
    await act(async () => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    const allHeight = HEADER_HEIGHT + LANE_HEIGHTS.reduce((a, b) => a + b, 0);
    expect(paneHeightPx()).toBe(allHeight);

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();
    // 재마운트해도 방금 고른 값(레인 전체)이 그대로 — 기본값(3레인)으로 되돌아가지 않는다.
    expect(paneHeightPx()).toBe(allHeight);
  });

  it('reset button is hidden at default, appears after a non-default choice, and clicking it restores the computed default AND clears storage', async () => {
    await render();
    expect(container.querySelector('[data-testid="flow-canvas-resize-reset"]')).toBeNull();

    await act(async () => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    const resetBtn = container.querySelector('[data-testid="flow-canvas-resize-reset"]') as HTMLButtonElement | null;
    expect(resetBtn).not.toBeNull();

    await act(async () => { resetBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const defaultHeight = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]! + LANE_HEIGHTS[2]!;
    expect(paneHeightPx()).toBe(defaultHeight);
    expect(container.querySelector('[data-testid="flow-canvas-resize-reset"]')).toBeNull();
    expect(localStorageStore.get(STORAGE_KEY)).toBeUndefined();
  });
});

describe('FlowCanvasResizePane — stale localStorage(레인 수가 이전 세션보다 «줄어든» 경우)', () => {
  it('a stored lane count larger than the CURRENT lane list clamps to "all of them" instead of overflowing/crashing', async () => {
    stubLocalStorage();
    localStorageStore.set(STORAGE_KEY, '99'); // 지난 세션엔 레인이 더 많았다고 가정
    await render(LANES.slice(0, 2)); // 지금은 레인 2개뿐
    const expected = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]!;
    expect(paneHeightPx()).toBe(expected);
    // computeCumulativeLaneHeight 자체가 픽셀은 이미 안전하게 클램프하지만, 손잡이의
    // aria-valuenow(99)까지 그대로 새면 스크린리더가 "99/2" 같은 무의미한 값을 읽는다 —
    // 그 자리는 이 컴포넌트가 별도로 잰다.
    expect(handle().getAttribute('aria-valuenow')).toBe('2');
  });
});

describe('FlowCanvasResizePane — AC18 ① 드래그 스냅(자유 픽셀 → 레인 정수 경계)', () => {
  function dispatchPointer(el: Element, type: string, opts: { clientX?: number; clientY?: number; pointerId?: number } = {}) {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.assign(ev, {
      clientX: opts.clientX ?? 0, clientY: opts.clientY ?? 0, pointerId: opts.pointerId ?? 1,
      button: 0, pointerType: 'mouse',
    });
    el.dispatchEvent(ev);
  }

  it('dragging down past the 2-lane boundary and releasing snaps the committed height to exactly 2 lanes (not the raw drag pixel value)', async () => {
    await render();
    const h = handle();
    const startHeight = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]! + LANE_HEIGHTS[2]!; // 기본(3레인)
    const twoLaneHeight = HEADER_HEIGHT + LANE_HEIGHTS[0]! + LANE_HEIGHTS[1]!;
    // 위로(음의 dy) 끌어서 2레인 경계 근처에 놓는다 — 정확한 경계 픽셀이 아니라 "가장 가까운
    // 쪽"으로 스냅되는지가 핵심이므로 경계에서 살짝 안쪽(2레인 쪽)인 지점을 목표로 잡는다.
    const dy = (twoLaneHeight - startHeight) + 2; // 2레인 높이보다 2px 더 큰 지점(그래도 2레인이 더 가깝다)
    await act(async () => { dispatchPointer(h, 'pointerdown', { clientY: 0 }); });
    await act(async () => { dispatchPointer(h, 'pointermove', { clientY: dy }); });
    // 드래그 «중»엔 자유 픽셀(스냅 전) — 커밋된 값(committedHeightPx)이 아니라 라이브 드래그 값이 보인다.
    expect(paneHeightPx()).not.toBe(startHeight);
    await act(async () => { dispatchPointer(h, 'pointerup', { clientY: dy }); });
    // 놓은 뒤엔 레인 정수 경계로 스냅 — 카드가 잘린 채 멈추지 않는다.
    expect(paneHeightPx()).toBe(twoLaneHeight);
  });
});
