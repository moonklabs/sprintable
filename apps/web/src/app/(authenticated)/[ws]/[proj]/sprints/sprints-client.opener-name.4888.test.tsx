// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면, dev 실측 11-11) — 폰 폭에서 상단 바의 «새 스프린트» 열기 단추는 글자가 `hidden sm:inline`이라 아이콘(+)뿐이었다:
// 접근 이름이 빈 칸(스크린리더가 «버튼»만 읽음)이고 크기 38×28(폰 누름 영역 44 미만). 이름을 aria-label로 주고 폰 누름 영역 44를 준다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div data-testid="top-bar">{title}{actions}</div>
  ),
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({ WorkspaceFrameTabs: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [{ id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' }] }) };
    }
    if (typeof url === 'string' && url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SprintsClient projectId="proj-1" orgId="org-1" /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const opener = () => container.querySelector('[data-testid="top-bar"] button') as HTMLButtonElement | null;

describe('스프린트 화면 — 상단 «새 스프린트» 열기 단추(story #4888)', () => {
  it('⭐접근 이름이 «새 스프린트»다(글자가 폰 폭에서 숨어도 aria-label이 이름을 준다) — 예전엔 이름이 빈 칸', async () => {
    await mount();
    expect(opener()).not.toBeNull();
    expect(opener()!.getAttribute('aria-label')).toBe(koMessages.sprints.newSprint);
  });

  it('⭐폰(coarse)에서 누름 영역 44 이상 — min-h-11 · min-w-11 클래스를 가진다', async () => {
    await mount();
    const cls = opener()!.className.split(/\s+/);
    expect(cls).toContain('pointer-coarse:min-h-11');
    expect(cls).toContain('pointer-coarse:min-w-11');
  });

  it('누르면 만들기 폼이 열린다(동작은 그대로)', async () => {
    await mount();
    await act(async () => { opener()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain(koMessages.sprints.newSprint);
    expect(document.body.textContent).toContain('스프린트 이름');
  });
});
