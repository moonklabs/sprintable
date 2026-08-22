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
});
