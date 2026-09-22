// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// !projectId 조기반환/로디드 두 분기 모두 같은 TopBarSlot h1 패턴이라(상호배타) 어느 쪽도
// h1이 2개가 되지 않는다 — 이 컴포넌트엔 아직 전용 렌더 테스트가 없어 새로 둔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider><TopBarTitleProbe />{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  const { default: RewardsPage } = await import('./page');
  await act(async () => { root.render(wrap(<RewardsPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('RewardsPage — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목) — projectId 있는 로디드 분기', async () => {
    useDashboardContextMock.mockReturnValue({ projectId: 'p1' });
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⭐h1이 정확히 1개다(TopBarSlot 제목) — projectId 없는 조기반환 분기', async () => {
    useDashboardContextMock.mockReturnValue({ projectId: null });
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
