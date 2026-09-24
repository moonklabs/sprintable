// @vitest-environment jsdom
// story #4231 3차 — 래칫 예외(«내비 설정 경로는 소비처가 감싼다»)의 근거를 렌더로 잠근다: 커맨드 팔레트 탐색 항목 · nav-v3 항목 목록이
// flat(static) 목적지에 현재 프로젝트(`?p=`)를 싣고, 워크스페이스 목적지(resource)엔 싣지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { LEGACY_NAV_ITEMS } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS } from '@/lib/nav-v3-destinations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = { projectId: 'proj-A' as string | undefined, orgMemberships: [] as unknown[], projectMemberships: [] as unknown[] };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }), usePathname: () => '/org-briefing' }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}

describe('내비 설정 경로 소비처가 flat 목적지를 감싼다(story #4231 3차)', () => {
  it('nav-v3 항목 목록 — static은 `?p=proj-A` · resource(일감)는 그대로', async () => {
    const { NavV3ItemList } = await import('./nav-v3-item-list');
    await render(<NavV3ItemList flags={DEFAULT_NAV_V3_FLAGS} activeKey="today" />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/org-briefing?p=proj-A', '/chats?p=proj-A', '/flow', '/organization/insights-board?p=proj-A']);
  });

  it('커맨드 팔레트 — flat(static) 탐색 항목은 `?p=proj-A`를 싣고 이동', async () => {
    const staticItem = LEGACY_NAV_ITEMS.find((i) => i.kind === 'static' && i.path.startsWith('/organization/'))!;
    const { CommandPalette } = await import('@/components/command-palette/command-palette');
    await render(<CommandPalette open onOpenChange={vi.fn()} />);
    const btn = document.querySelector(`[data-command-id="${staticItem.id}"]`) as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith(`${staticItem.path}?p=proj-A`);
  });
});
