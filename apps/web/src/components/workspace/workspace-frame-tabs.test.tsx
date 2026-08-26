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
  it('보드·스프린트·에픽 3탭이 렌더한다(story #2931로 에픽 스윔레인 실체 생겨 3번째 탭 합류)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['보드', '스프린트', '에픽']);
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
    expect(tabs.map((t) => t.textContent)).toEqual(['Board', 'Sprints', 'Epic']);
  });

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — "「지금」 탭을 열 때 여기가 보드인 것이
  // 즉시 읽히게" 시각 위계 승격. PR#3358 규율(상위=underline·내부=pill)은 유지하고 그 안에서
  // <lg만 텍스트·인디케이터를 키운다.
  describe('<lg 시각 위계 승격', () => {
    it('모바일이면 탭 텍스트가 더 커진다(text-base) — 데스크톱은 text-sm 그대로', async () => {
      isMobileMock = true;
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
      const boardTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드');
      expect(boardTab?.className).toContain('text-base');
      expect(boardTab?.className).not.toContain('text-sm');
    });

    it('데스크톱(기본값)이면 기존 text-sm 그대로다(회귀 없음)', async () => {
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
      const boardTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '보드');
      expect(boardTab?.className).toContain('text-sm');
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
});
