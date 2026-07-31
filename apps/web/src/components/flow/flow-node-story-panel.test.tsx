// @vitest-environment jsdom
//
// story #2354 — FlowNodeStoryPanel(패널 자립 래퍼)의 자체 로직만 격리해서 잰다:
// ①storyId 하나로 GET /api/stories/{id}·GET /api/tasks?story_id= 두 개만 부르는가(AC8, 새
// BE 0), ②앵커 노드(data-node-id)의 화면 위치로 위/아래 반전이 맞게 계산되는가(AC4),
// ③앵커를 못 찾으면 안전하게 폴백하는가. StoryDetailPanel 내부 렌더 정확성은 그 자신의
// 테스트가 이미 커버하므로 여기선 스텁으로 대체하고 «넘겨받은 props»만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowNodeStoryPanel } from './flow-node-story-panel';
import koMessages from '../../../messages/ko.json';

vi.mock('@/components/kanban/story-detail-panel', () => ({
  StoryDetailPanel: ({ story, onClose, overlayPosition }: { story: { title: string }; onClose: () => void; overlayPosition?: { top: number; heightPx: number } }) => (
    <div data-testid="story-detail-panel-stub" data-mode={overlayPosition ? 'overlay' : 'fullscreen'}>
      <span data-testid="stub-title">{story.title}</span>
      {overlayPosition ? (
        <>
          <span data-testid="stub-top">{overlayPosition.top}</span>
          <span data-testid="stub-height">{overlayPosition.heightPx}</span>
        </>
      ) : null}
      <button type="button" onClick={onClose}>close</button>
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

function stubFetch(calledUrls: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calledUrls.push(url);
    if (url.startsWith('/api/stories/')) {
      return { ok: true, json: async () => ({ data: { id: 'story-abc', title: '앵커 시험 스토리', status: 'backlog' } }) };
    }
    if (url.startsWith('/api/tasks?')) {
      return { ok: true, json: async () => ({ data: [{ id: 't1', title: 'Task', status: 'backlog' }] }) };
    }
    return { ok: false, json: async () => null };
  }));
}

// jsdom 기본 innerHeight(768)를 테스트별로 고정 — 위/아래 절반 판정의 재료.
function setViewportHeight(h: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

// useIsMobile()은 실제 판정값을 window.innerWidth<1024로 계산하고(use-mobile.ts), matchMedia는
// addEventListener 배선용으로만 쓴다 — 그래서 둘 다 맞춰야 한다(matches만 바꿔선 안 갈린다).
function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function setViewportWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

function placeAnchor(id: string, rect: Partial<DOMRect>) {
  const el = document.createElement('button');
  el.setAttribute('data-node-id', id);
  el.getBoundingClientRect = () => ({
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {},
    ...rect,
  } as DOMRect);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setViewportHeight(768);
  setViewportWidth(1280); // 기본 데스크톱(1024 이상) — 모바일 테스트는 명시적으로 좁힌다.
  stubMatchMedia();
  // 위치 계산 effect가 rAF로 미뤄져 있다(react-hooks/set-state-in-effect 회피 — 컴포넌트
  // 문서 참고). 테스트에서는 동기로 즉시 실행해 결정적으로 만든다.
  let rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return ++rafId; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.querySelectorAll('[data-node-id]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

describe('FlowNodeStoryPanel — 자립 fetch (story #2354 AC8, 새 BE 0)', () => {
  it('fetches exactly GET /api/stories/{id} and GET /api/tasks?story_id= — no other endpoints', async () => {
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    placeAnchor('story-abc', { top: 100, bottom: 130 });

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls).toContain('/api/stories/story-abc');
    expect(calledUrls.some((u) => u.startsWith('/api/tasks?story_id=story-abc'))).toBe(true);
    expect(calledUrls).toHaveLength(2);
    expect(container.querySelector('[data-testid="stub-title"]')?.textContent).toBe('앵커 시험 스토리');
  });
});

describe('FlowNodeStoryPanel — 위/아래 반전(story #2354 AC4, 누른 노드를 가리지 않는다)', () => {
  it('places the panel BELOW the node when the node is in the upper half of the viewport', async () => {
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    // 뷰포트 768 — 위쪽 절반(384px 미만)에 노드를 둔다.
    placeAnchor('story-abc', { top: 50, bottom: 80 });

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const top = Number(container.querySelector('[data-testid="stub-top"]')?.textContent);
    // 노드 아래(bottom=80)에 여백을 두고 시작 — 노드 위(0~80)를 침범하지 않는다.
    expect(top).toBeGreaterThan(80);
  });

  it('places the panel ABOVE the node when the node is in the lower half of the viewport', async () => {
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    // 뷰포트 768 — 아래쪽 절반(384px 이상)에 노드를 둔다.
    placeAnchor('story-abc', { top: 700, bottom: 730 });

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const top = Number(container.querySelector('[data-testid="stub-top"]')?.textContent);
    const height = Number(container.querySelector('[data-testid="stub-height"]')?.textContent);
    // 패널의 아래 끝(top+height)이 노드의 위(700)를 넘지 않는다 — 노드를 안 가린다.
    expect(top + height).toBeLessThanOrEqual(700);
  });

  it('caps the panel height at 50% of the viewport (AC5)', async () => {
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    placeAnchor('story-abc', { top: 50, bottom: 80 });

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const height = Number(container.querySelector('[data-testid="stub-height"]')?.textContent);
    expect(height).toBeLessThanOrEqual(768 * 0.5);
  });

  it('falls back to a centered position when the anchor node is not found in the DOM (defensive — no crash)', async () => {
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    // 앵커를 아예 배치하지 않는다.

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="story-detail-panel-stub"]')).not.toBeNull();
    const top = Number(container.querySelector('[data-testid="stub-top"]')?.textContent);
    expect(Number.isFinite(top)).toBe(true);
  });
});

describe('FlowNodeStoryPanel — 로딩 표시(유나 가디언 리뷰 2026-07-31, issuecomment-5139371576, 침묵 구간 금지)', () => {
  it('shows the nodesLoading text — NOT nothing — while the fetch is still pending', () => {
    // fetch를 절대 안 풀리는 Promise로 스텁 — 이 시점의 렌더는 항상 loading 상태다.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    placeAnchor('story-abc', { top: 100, bottom: 130 });

    act(() => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
    });

    expect(container.textContent).toContain('노드를 불러오는 중');
    // ⛔누른 직후 "아무 것도 안 뜬 것"처럼 보이면 침묵 구간이 선다 — StoryDetailPanel은
    // 아직 마운트되지 않아야 정상이다(fetch가 안 끝났으므로).
    expect(container.querySelector('[data-testid="story-detail-panel-stub"]')).toBeNull();
  });
});

describe('FlowNodeStoryPanel — 모바일 게이트(유나 가디언 리뷰 2026-07-31, issuecomment-5139371576)', () => {
  it('on mobile (<1024px), renders StoryDetailPanel WITHOUT overlayPosition — full-screen drawer mode, not the compact overlay', async () => {
    setViewportWidth(375);
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    placeAnchor('story-abc', { top: 100, bottom: 130 }); // 앵커가 있어도 모바일은 무시한다.

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const stub = container.querySelector('[data-testid="story-detail-panel-stub"]');
    expect(stub?.getAttribute('data-mode')).toBe('fullscreen');
    expect(container.querySelector('[data-testid="stub-top"]')).toBeNull();
  });

  it('on mobile, the loading indicator renders without waiting on the (unused) anchor position effect', () => {
    setViewportWidth(375);
    // 앵커를 배치하지 않는다 — 모바일은 앵커 좌표 자체가 필요 없으므로 여전히 안전해야 한다.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    act(() => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
    });

    expect(container.textContent).toContain('노드를 불러오는 중');
  });

  it('on desktop (>=1024px), still uses the compact overlay (regression guard — mobile gate does not leak to desktop)', async () => {
    setViewportWidth(1280);
    const calledUrls: string[] = [];
    stubFetch(calledUrls);
    placeAnchor('story-abc', { top: 100, bottom: 130 });

    await act(async () => {
      root.render(wrap(<FlowNodeStoryPanel storyId="story-abc" onClose={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const stub = container.querySelector('[data-testid="story-detail-panel-stub"]');
    expect(stub?.getAttribute('data-mode')).toBe('overlay');
  });
});
