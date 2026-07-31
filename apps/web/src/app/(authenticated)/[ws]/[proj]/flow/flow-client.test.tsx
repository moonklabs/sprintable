// @vitest-environment jsdom
//
// story #2354 회귀 가드 — 「노드를 눌러도 지도가 살아 있게」의 근본(옛 handleSelectStory가
// `view=list`를 함께 갈아 끼워 캔버스를 언마운트시켰다)이 다시 안 나는지 값으로 닫는다.
// KanbanBoard/NextMakerScreen/FlowNodeStoryPanel은 각자 자기 테스트가 있으므로 여기선 얇은
// 스텁으로 대체하고, flow-client.tsx 자신의 배선(URL 조립·panelOpen 로컬 상태·view별
// 렌더 분기)만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

let currentSearch = '';
// push는 실제 next/navigation처럼 "URL이 바뀐다"까지 흉내낸다(그래야 뒤이은
// setPanelOpen(true)로 인한 리렌더에서 useSearchParams()가 새 값을 본다) — 실제 앱에서는
// router.push 자체가 이 반영을 일으킨다, 이 목이 그 효과만 대신한다.
const pushMock = vi.fn((url: string) => {
  const qIndex = url.indexOf('?');
  currentSearch = qIndex >= 0 ? url.slice(qIndex + 1) : '';
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
}));

vi.mock('@/components/kanban/kanban-board', () => ({
  KanbanBoard: () => <div data-testid="kanban-board-stub">kanban</div>,
}));

vi.mock('@/components/glance/exception-stream', () => ({
  ExceptionStream: () => <div data-testid="exception-stream-stub" />,
}));

vi.mock('@/components/glance/load-glance-data', () => ({
  loadGlanceData: async () => ({ memberMap: {}, attentionSignals: [] }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

// NextMakerScreen 스텁 — onSelectStory 호출 버튼 + selectedNodeId를 텍스트로 노출(threading 검증용).
vi.mock('@/components/flow/next-maker-screen', () => ({
  NextMakerScreen: ({ onSelectStory, selectedNodeId }: { onSelectStory: (id: string) => void; selectedNodeId?: string | null }) => (
    <div data-testid="next-maker-screen-stub">
      <span data-testid="selected-node-id">{selectedNodeId ?? 'none'}</span>
      <button type="button" onClick={() => onSelectStory('story-abc')}>select-node</button>
    </div>
  ),
}));

// FlowNodeStoryPanel 스텁 — storyId를 텍스트로 노출 + close 버튼.
vi.mock('@/components/flow/flow-node-story-panel', () => ({
  FlowNodeStoryPanel: ({ storyId, onClose }: { storyId: string; onClose: () => void }) => (
    <div data-testid="flow-node-story-panel-stub">
      <span data-testid="panel-story-id">{storyId}</span>
      <button type="button" onClick={onClose}>close-panel</button>
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  currentSearch = '';
  pushMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderFlowClient() {
  const { default: FlowPageClient } = await import('./flow-client');
  await act(async () => {
    root.render(wrap(<FlowPageClient projectId="p1" wsSlug="ws-1" projSlug="proj-1" />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('FlowPageClient — story #2354 (노드 클릭이 지도를 안 끈다)', () => {
  it('handleSelectStory pushes ?story=<id> WITHOUT touching view — 옛 버그(view=list 강제)가 재발하지 않는다', async () => {
    await renderFlowClient();

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'select-node');
    expect(selectButton).toBeTruthy();
    await act(async () => {
      selectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('story=story-abc');
    // 이게 이 회귀가드의 핵심 — 옛 코드는 여기서 반드시 view=list를 같이 붙였다.
    expect(pushedUrl).not.toContain('view=');
  });

  it('clicking a node opens the overlay panel while the flow canvas stub stays mounted (캔버스가 언마운트되지 않는다)', async () => {
    await renderFlowClient();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'select-node');
    await act(async () => {
      selectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 캔버스 스텁은 그대로 살아있다 — 클릭이 언마운트를 일으키지 않는다.
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-story-id"]')?.textContent).toBe('story-abc');
  });

  it('deep link (?story=<id> already in URL) opens the panel on mount without needing a click', async () => {
    currentSearch = 'story=story-deep';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-story-id"]')?.textContent).toBe('story-deep');
    // selectedNodeId도 같은 값으로 NextMakerScreen에 threading됨 — 노드 고리 강조의 재료.
    expect(container.querySelector('[data-testid="selected-node-id"]')?.textContent).toBe('story-deep');
  });

  it('closing the panel keeps the node selected (AC6 판정선) — selectedNodeId survives close, only panel visibility toggles', async () => {
    currentSearch = 'story=story-abc';
    await renderFlowClient();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();

    const closeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'close-panel');
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 패널은 사라지지만 — URL의 story는 안 지웠으므로(닫기가 router 호출을 안 함) selectedNodeId는 그대로다.
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="selected-node-id"]')?.textContent).toBe('story-abc');
  });

  it('view=list renders KanbanBoard and does NOT also mount the flow overlay panel (AC9 — no double panel)', async () => {
    currentSearch = 'view=list&story=story-abc';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="kanban-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).toBeNull();
    // KanbanBoard 스스로 story=를 읽어 자기 방식으로 여는 것이 기존 동작 — 여기서 또 열면 두 벌.
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();
  });
});

// PO 정정(2026-07-31) — story #2352의 원래 결함은 관제 서랍의 "게이트·막힘 신호 · N"
// 라벨이 0단계 카드의 "승인 대기 · 28"과 다른 표를 세면서 같은 낱말("막힘")로 화면이
// 자기모순한 것이었다. 지시는 «그 수»를 이름 없이 빼는 것이었는데, 처음 구현은 서랍
// 영역(ExceptionStream) 자체를 통째로 걷어내 목적어가 넓어졌다 — #2224 AC4가 이 컴포넌트를
// 하단 관제와 "하나"로 요구하는 것과도 어긋났다. 서랍은 남고, 라벨만 숫자 없이 갈린다.
describe('FlowPageClient — story #2352 정정(PO, 2026-07-31) — 관제 서랍은 남긴다, 라벨만 간다', () => {
  it('renders the ExceptionStream drawer (region survives) with a label that has NO count number and does not say "막힘"', async () => {
    await renderFlowClient();

    expect(container.querySelector('[data-testid="exception-stream-stub"]')).not.toBeNull();
    const summary = Array.from(container.querySelectorAll('summary')).find(
      (s) => container.contains(s),
    );
    expect(summary).toBeTruthy();
    expect(summary!.textContent).not.toContain('막힘');
    // "게이트·막힘 신호 · 0" 처럼 숫자를 붙이던 옛 라벨 자리 — 새 라벨은 그 어떤 아라비아
    // 숫자도 달지 않는다(그 수 자체가 원래 결함이었다).
    expect(summary!.textContent).not.toMatch(/\d/);
  });
});
