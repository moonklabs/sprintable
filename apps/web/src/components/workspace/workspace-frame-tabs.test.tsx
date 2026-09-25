// @vitest-environment jsdom
//
// story #2930(P0-G) I3(doc ia-4zone-redesign-2930, PO 스코프 확定 ①=ⓒ 2026-08-22) — flow+sprints가
// nav에서 「보드」 단일 항목으로 접히며 사라진 sprints 진입점을 이 프레임이 메우는지, 실제로는
// 진짜 라우트 네비게이션(router.push)인지를 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({ ws: 'my-ws', proj: 'my-proj' }),
}));

// story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — <lg에서 이 탭행 텍스트·인디케이터가 커진다
// (useIsMobile). jsdom엔 window.matchMedia가 없어 훅 자체를 모킹(flow-client.test.tsx와
// 동일 패턴) — 기존 6개 테스트는 desktop(false) 기본값으로 회귀 0 유지.
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_BREAKPOINT: 1024,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, messages: typeof koMessages = koMessages) {
  return (
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  isMobileMock = false;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  pushMock.mockReset();
});

describe('WorkspaceFrameTabs — story #2930 I3', () => {
  it('보드·스프린트·에픽·회고·목록·가설 6탭이 렌더한다(story #2931 에픽·#3845 회고·#3844 목록·#3989 가설 합류)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['목록', '보드', '스프린트', '에픽', '회고', '가설']);
  });

  it('active="board"면 보드 탭에 aria-selected=true가 붙는다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const boardTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드');
    const sprintsTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '스프린트');
    expect(boardTab?.getAttribute('aria-selected')).toBe('true');
    expect(sprintsTab?.getAttribute('aria-selected')).toBe('false');
  });

  it('스프린트 탭 클릭 시 /{ws}/{proj}/sprints로 진짜 라우트 네비게이션한다(in-page 상태 아님)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const sprintsTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '스프린트');
    await act(async () => { sprintsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/sprints');
  });

  it('보드 탭 클릭 시 /{ws}/{proj}/flow로 이동한다(nav-config path 불변과 정합)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="sprints" />)); });
    const boardTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드');
    await act(async () => { boardTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/flow');
  });

  it('story #2931 — 에픽 탭 클릭 시 /{ws}/{proj}/epics로 이동한다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const epicTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '에픽');
    await act(async () => { epicTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/epics');
  });

  it('en 로케일에서도 렌더된다(ko/en 파리티)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />, enMessages)); });
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['List', 'Board', 'Sprints', 'Epic', 'Retro', 'Hypothesis']);
  });

  it('story #3989 — 가설 탭 클릭 시 /{ws}/{proj}/hypotheses로 이동하고 active="hypothesis"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const hypothesisTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '가설');
    await act(async () => { hypothesisTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/hypotheses');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="hypothesis" />)); });
    const selected = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '가설');
    expect(selected?.getAttribute('aria-selected')).toBe('true');
  });

  it('story #3845 — 회고 탭 클릭 시 /{ws}/{proj}/retro로 이동하고 active="retro"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const retroTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '회고');
    await act(async () => { retroTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/retro');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="retro" />)); });
    const activeRetroTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '회고');
    expect(activeRetroTab?.getAttribute('aria-selected')).toBe('true');
  });

  it('story #3844 — 목록 탭 클릭 시 /{ws}/{proj}/work-list로 이동하고 active="workList"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const listTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '목록');
    await act(async () => { listTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/work-list');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="workList" />)); });
    const activeListTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '목록');
    expect(activeListTab?.getAttribute('aria-selected')).toBe('true');
  });

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — "「지금」 탭을 열 때 여기가 보드인 것이
  // 즉시 읽히게" 시각 위계 승격. PR#3358 규율(상위=underline·내부=pill)은 유지하고 그 안에서
  // <lg만 텍스트·인디케이터를 키운다.
  describe('<lg 시각 위계 승격', () => {
    // story #4222 — 크기 분기는 JS(useIsMobile)가 아니라 CSS 중단점: 모바일 기본(text-base·pb-2.5·border-b-[3px]) + lg:(1024) 덮어쓰기.
    // 서버·첫 렌더와 하이드레이션 뒤 클래스가 같아 390에서 탭 높이가 30→37px로 바뀌던 흔들림 0.
    it('모바일 기본 text-base · lg에서 text-sm — 뷰포트 판정과 무관하게 같은 클래스(서버 = 최종)', async () => {
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      for (const mobile of [true, false]) {
        isMobileMock = mobile;
        await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
        const cls = ([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드')?.className ?? '').split(/\s+/);
        for (const c of ['text-base', 'pb-2.5', 'border-b-[3px]', 'lg:text-sm', 'lg:pb-2', 'lg:border-b-2']) expect(cls, `${mobile} ${c}`).toContain(c);
      }
    });

    it('모바일에서도 라우팅·aria-selected 동작은 회귀 없다', async () => {
      isMobileMock = true;
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="sprints" />)); });
      const boardTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드');
      expect(boardTab?.getAttribute('aria-selected')).toBe('false');
      await act(async () => { boardTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pushMock).toHaveBeenCalledWith('/my-ws/my-proj/flow');
    });
  });

  // story #4277(유나 판단 ① 필수) — 줄이 가로 스크롤이라 켜진 탭이 화면 밖일 수 있다 → 그릴 때 · 탭이 바뀔 때 켜진 탭을 줄 안으로(nearest).
  it('⭐켜진 탭을 그릴 때 · 바뀔 때 scrollIntoView(nearest) — 다른 탭은 부르지 않는다', async () => {
    const calls: Array<{ text: string | null; opts: unknown }> = [];
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, opts?: unknown) { calls.push({ text: this.textContent, opts }); } as typeof orig;
    try {
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="hypothesis" />)); });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts).toEqual({ block: 'nearest', inline: 'nearest' });
      const selected = container.querySelector('[aria-selected="true"]');
      expect(calls[0]!.text).toBe(selected?.textContent);
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.text).toBe(container.querySelector('[aria-selected="true"]')?.textContent);
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });
});

