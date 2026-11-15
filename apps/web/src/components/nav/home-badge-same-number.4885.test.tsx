// @vitest-environment jsdom
//
// story #4885 (UI-1 §6 ①) — 웹 막대 「홈」 배지와 폰 하단 탭 「홈」 배지는 **같은 수**다. 둘 다 홈 모델(useHomeModel) 하나를 읽으니, 이 시험은 같은 모델을 둘에게 주고
// «눈에 보이는 글자»와 «화면 읽기 글자의 수»를 맞댄다 — 한쪽이 따로 세거나 상한 · «N+» 규칙이 갈라지면 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/org-briefing',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
const { homeState } = vi.hoisted(() => ({ homeState: { badge: 0, partial: false } }));
vi.mock('@/components/home/home-model-provider', () => ({
  useHomeModel: () => ({ model: { badge: homeState.badge }, sources: null, loadError: false, partial: homeState.partial, retry: () => {} }),
}));
function part(name: string) {
  return function Part() { return <div data-part={name} />; };
}
vi.mock('@/components/nav/unified-switcher', () => ({ UnifiedSwitcher: part('switcher') }));
vi.mock('@/components/nav/new-project-entry', () => ({ NewProjectEntry: part('new-project'), MoveAgentsEntry: part('move-agents') }));
vi.mock('@/components/nav/profile-menu', () => ({ ProfileMenu: part('profile') }));
vi.mock('@/components/locale-switcher', () => ({ LocaleSwitcher: part('locale') }));
vi.mock('@/components/nav/theme-toggle', () => ({ ThemeToggle: part('theme') }));
vi.mock('@/components/nav/business-info-disclosure', () => ({ BusinessInfoDisclosure: part('business-info') }));
const { NavRailWithHomeBadge } = await import('@/components/home/home-nav-rail');
const { MobileTabBar } = await import('./mobile-tab-bar');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>
);

async function read(badge: number, partial: boolean) {
  homeState.badge = badge; homeState.partial = partial;
  await act(async () => { root.render(wrap(<><NavRailWithHomeBadge account={undefined as never} /><MobileTabBar chatUnreadTotal={0} /></>)); });
  await act(async () => { await Promise.resolve(); });
  // 웹 막대 「홈」 아이콘의 배지(ds CountBadge · data-testid="rail-badge") — 「대화」 배지는 안 읽음이라 0이면 없다.
  const rail = container.querySelector('[data-rail-group="now"] [data-testid="rail-badge"]');
  const tabLink = [...container.querySelectorAll('[data-testid="mobile-tab-bar"] a')].find((a) => a.getAttribute('href')?.startsWith('/org-briefing'))!;
  const tab = tabLink.querySelector('[data-slot="ds-count-badge"]');
  return {
    railText: rail ? (rail.textContent ?? '').replace('내 손이 필요', '').replace(/\s+/g, ' ').trim() : null,
    tabText: tab ? (() => { const c = tab.cloneNode(true) as Element; c.querySelectorAll('.sr-only').forEach((n) => n.remove()); return (c.textContent ?? '').trim(); })() : null,
  };
}

describe('웹 막대 「홈」 배지 = 폰 「홈」 탭 배지 (story #4885)', () => {
  it.each([
    [0, false, null],
    [1, false, '1'],
    [7, false, '7'],
    [12, false, '12'],
    [99, false, '99'],
    [150, false, '99+'],
    [5, true, '5+'],
    [150, true, '99+'],
  ] as const)('⭐수 %i · partial %s → 둘 다 «%s»', async (badge, partial, expected) => {
    const { railText, tabText } = await read(badge, partial);
    expect(tabText).toBe(expected);
    // 웹 막대는 sr-only 이름(«사람 손이 필요한 일» 등) 뒤에 수를 싣는다 — 마지막 낱말(수)만 비교.
    const railNumber = railText === null ? null : railText.split(' ').pop()!;
    expect(railNumber).toBe(expected);
    expect(railNumber).toBe(tabText);
  });
});
