// @vitest-environment jsdom
// story #4274(유나 판정) — 스프린트 화면의 보이는 로딩은 서버 page가 아니라 이 클라이언트의 `if (loading)` 분기다. 맨 글자만 그리면
// 보드 → 스프린트 이동 때 탭 줄이 ~1.4s 사라졌다 — 같은 프레임 스켈레톤(WorkspaceFrameLoading · 스프린트 탭 · sticky)을 그리는지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
vi.mock('@/components/workspace/workspace-frame-loading', () => ({
  WorkspaceFrameLoading: ({ active, layout }: { active: string; layout: string }) => (
    <div data-testid="frame-loading" data-active={active} data-layout={layout} />
  ),
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', orgId: 'org-1' });
  // 응답이 오지 않는 동안(로딩 분기)을 본다.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('SprintsClient — 로딩 분기가 탭 줄을 품는다(story #4274)', () => {
  it('⭐데이터를 기다리는 동안 WorkspaceFrameLoading(active=sprints · sticky)을 그리고 맨 글자 «불러오는 중»은 없다', async () => {
    const { SprintsClient } = await import('./sprints-client');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <SprintsClient projectId="proj-1" orgId="org-1" />
        </NextIntlClientProvider>,
      );
    });
    const frame = container.querySelector('[data-testid="frame-loading"]');
    expect(frame?.getAttribute('data-active')).toBe('sprints');
    expect(frame?.getAttribute('data-layout')).toBe('sticky');
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});
