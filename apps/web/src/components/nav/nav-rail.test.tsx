// @vitest-environment jsdom
//
// story 5031 (C1 step 2a) — the icon bar of the new shell is exactly the four places 홈 · 채팅 · 에이전트 · 설정 (lib/nav-depth1 · nav-placement.json), then at the bottom the list-column toggle · account · search.
// Replaces the story #4885 bar that listed the daily zones, an organisation flyout, settings and «전체». Shape (colours · lines) is the design tokens' job; this pins the structure · names · which one is lit · the badges.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/org-briefing' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
// «계정» 팝오버가 옮겨 싣는 길잡이 부품들 — 부품 자체의 동작은 각자의 시험 몫이라 여기선 «막대 안에 단추가 있다»만 본다.
function part(name: string) {
  return function Part() { return <div data-part={name} />; };
}
vi.mock('@/components/nav/unified-switcher', () => ({ UnifiedSwitcher: part('switcher') }));
vi.mock('@/components/nav/new-project-entry', () => ({ NewProjectEntry: part('new-project'), MoveAgentsEntry: part('move-agents') }));
vi.mock('@/components/nav/profile-menu', () => ({ ProfileMenu: part('profile') }));
vi.mock('@/components/locale-switcher', () => ({ LocaleSwitcher: part('locale') }));
vi.mock('@/components/nav/theme-toggle', () => ({ ThemeToggle: part('theme') }));
vi.mock('@/components/nav/business-info-disclosure', () => ({ BusinessInfoDisclosure: part('business-info') }));
const { NavRail } = await import('./nav-rail');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { pathnameRef.current = '/org-briefing'; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(props: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NavRail {...props} /></NextIntlClientProvider>);
  });
}
const rail = () => container.querySelector('[data-testid="nav-rail"]')!;
const items = () => [...rail().querySelectorAll('[data-rail-item]')];
const four = () => [...rail().querySelectorAll('a[data-rail-item^="depth1-"]')];

describe('NavRail — 1뎁스 넷(story 5031)', () => {
  it('⭐위에서 아래로 정확히 넷: 홈 → 채팅 → 에이전트 → 설정 (되돌리면 RED)', async () => {
    await mount();
    expect(four().map((el) => el.getAttribute('data-rail-item'))).toEqual(['depth1-home', 'depth1-chat', 'depth1-agents', 'depth1-settings']);
    expect(four().map((el) => el.getAttribute('aria-label'))).toEqual(['홈', '채팅', '에이전트', '설정']);
    // nothing else is a link in the bar: no zone icons, no organisation flyout, no «전체»
    expect(rail().querySelectorAll('a')).toHaveLength(4);
    expect(rail().querySelector('[data-rail-group]')).toBeNull();
    expect(rail().querySelector('[data-testid="rail-flyout"]')).toBeNull();
    expect(rail().querySelector('[data-rail-item="all-screens"]')).toBeNull();
  });

  it('네 링크는 각 자리의 첫 화면이다(홈 /org-briefing · 채팅 /chats · 에이전트 /organization/workforce · 설정 /settings) · 제목에 ⌘1~⌘4(키 처리가 있어서 — hooks/use-depth1-shortcuts.ts · keyboard-shortcuts.ts 표)', async () => {
    await mount();
    const href = (id: string) => rail().querySelector(`[data-rail-item="depth1-${id}"]`)?.getAttribute('href');
    expect(href('home')).toBe('/org-briefing');
    expect(href('chat')).toBe('/chats');
    expect(href('agents')).toBe('/organization/workforce');
    expect(href('settings')).toBe('/settings');
    expect(four().map((el) => el.getAttribute('title'))).toEqual(['홈 ⌘1', '채팅 ⌘2', '에이전트 ⌘3', '설정 ⌘4']);
  });

  it('맨 아래: (목록 칸 단추) · 계정 · 검색 — 검색은 팔레트를 연다', async () => {
    const onOpenPalette = vi.fn();
    const onToggle = vi.fn();
    await mount({ onOpenPalette, listColumn: { open: true, onToggle }, account: { orgMemberships: [], projectMemberships: [], userName: 'Q' } });
    expect(items().map((el) => el.getAttribute('data-rail-item'))).toEqual(['depth1-home', 'depth1-chat', 'depth1-agents', 'depth1-settings', 'list-column-toggle', 'account', 'search']);
    await act(async () => { (rail().querySelector('[data-rail-item="search"]') as HTMLButtonElement).click(); });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    await act(async () => { (rail().querySelector('[data-rail-item="list-column-toggle"]') as HTMLButtonElement).click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/org-briefing', 'depth1-home'], ['/inbox', 'depth1-home'], ['/gates/abc', 'depth1-home'],
    ['/chats', 'depth1-chat'], ['/chats/abc', 'depth1-chat'], ['/acme/web/flow', 'depth1-chat'], ['/acme/web/docs/some-slug', 'depth1-chat'],
    ['/organization/workforce', 'depth1-agents'], ['/organization/workforce/runs', 'depth1-agents'], ['/organization/trust', 'depth1-agents'], ['/rewards', 'depth1-agents'],
    ['/settings', 'depth1-settings'], ['/organization/members', 'depth1-settings'], ['/organization/channels', 'depth1-settings'], ['/desktop', 'depth1-settings'],
  ])('⭐지금 여기: %s → %s 하나만 켜진다(aria-current=page)', async (path, lit) => {
    pathnameRef.current = path;
    await mount();
    expect(four().filter((el) => el.getAttribute('aria-current') === 'page').map((el) => el.getAttribute('data-rail-item'))).toEqual([lit]);
  });

  it('셸 밖(꺼진 시안 · 로그인)이면 아무것도 켜지지 않는다', async () => {
    pathnameRef.current = '/today';
    await mount();
    expect(four().filter((el) => el.getAttribute('aria-current') === 'page')).toHaveLength(0);
  });

  it('«홈» 배지 = 받은 수(정확한 수가 아니면 «N+» · 링크 이름에도 실린다) · «채팅» 배지 = 안 읽은 수 · 0이면 둘 다 없다', async () => {
    await mount({ todayCount: 3, chatUnreadTotal: 120 });
    const home = rail().querySelector('[data-rail-item="depth1-home"]')!;
    const chat = rail().querySelector('[data-rail-item="depth1-chat"]')!;
    expect(home.querySelector('[data-testid="rail-badge"]')?.textContent).toContain('3');
    expect(home.getAttribute('aria-label')).toMatch(/홈 · .+ 3$/);
    expect(chat.querySelector('[data-testid="rail-badge"]')?.textContent).toContain('99+');
    expect(chat.getAttribute('aria-label')).toMatch(/채팅 · .+ 120$/);
    // the other two never carry a badge
    expect(rail().querySelector('[data-rail-item="depth1-agents"] [data-testid="rail-badge"]')).toBeNull();
    expect(rail().querySelector('[data-rail-item="depth1-settings"] [data-testid="rail-badge"]')).toBeNull();
    root.unmount();
    root = createRoot(container);
    await mount({ todayCount: 2, todayCountAtLeast: true });
    expect(rail().querySelector('[data-rail-item="depth1-home"]')?.getAttribute('aria-label')).toMatch(/2\+$/);
    root.unmount();
    root = createRoot(container);
    await mount();
    expect(rail().querySelector('[data-testid="rail-badge"]')).toBeNull();
  });

  it('⭐아이콘은 ds Icon이다 — data-icon을 가지고, 날것 lucide 호출(data-icon 없는 svg.lucide)은 0', async () => {
    await mount({ listColumn: { open: true, onToggle: () => undefined } });
    const icons = [...rail().querySelectorAll('[data-icon]')];
    expect(icons.length).toBeGreaterThanOrEqual(6);
    // story 5048 ④(PO 11-27 «한 집안 = lucide»): ds Icon이 이제 lucide를 그린다 — 그래서 `svg.lucide` 자체는 있고, «ds Icon을 거치지 않은 날것 lucide»(data-icon이 없는 것)가 0이어야 한다(시험의 뜻 그대로).
    expect(rail().querySelectorAll('svg.lucide:not([data-icon])')).toHaveLength(0);
    expect(four().map((el) => el.querySelector('[data-icon]')?.getAttribute('data-icon'))).toEqual(['newsmode', 'chat_bubble', 'smart_toy', 'settings']);
  });

  it('임의 수치 · 알파 배경이 없다 — 막대 소스에 대괄호 크기 · 색 리터럴 0(눈금 클래스와 ds 토큰만)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'nav-rail.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:bg|text|border|ring)-[a-z]+\/\d+/);
    expect(src).not.toMatch(/\bshadow-/);
  });
});
