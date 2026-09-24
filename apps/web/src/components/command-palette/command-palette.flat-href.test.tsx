// @vitest-environment jsdom
//
// story #4231 4차 B(까디르 codex 01a0d3ad ①) — 커맨드 팔레트의 앵커 목적지(GUARD_ANCHOR_ITEMS · 래칫 예외)는 소비처가 flatHref로 감싼다는 것이
// 예외의 전제다. 기존 테스트는 isWorkspaceless만 봐서 소비처의 flatHref를 빼도 초록이었다 — 프로젝트 맥락에서 실제로 가는 주소(`?p=`)를 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ orgId: 'org-1', orgMemberships: [], currentProjectSlug: null, projectId: 'proj-1', projectMemberships: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
  pushMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('CommandPalette — 앵커 목적지는 현재 프로젝트(?p=)를 싣는다(#4231 4차 B)', () => {
  it.each([
    ['스프린트로 이동', '/sprints?p=proj-1'],
    ['회고로 이동', '/retro?p=proj-1'],
  ])('⭐%s → %s', async (label, href) => {
    const { CommandPalette } = await import('./command-palette');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <CommandPalette open onOpenChange={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    expect(btn).toBeDefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith(href);
  });
});
