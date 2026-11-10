// @vitest-environment jsdom
//
// story #4885 (UI-2) — B 셸 초안(아이콘 막대)의 구조 시험: 같은 데이터(nav-config)를 읽어 «매일 구역 아이콘 · 대화 카드 · 조직 펼침 · 맨 아래 찾기/설정/전체»로 그린다.
// 모양(색 · 선)은 UI-3 몫이라 여기선 구조 · 접근 이름 · 판정만 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef, queryRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' }, queryRef: { current: '' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(queryRef.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
// «계정» 팝오버가 옮겨 싣는 길잡이 부품들 — 부품 자체의 동작은 각자의 시험 몫이라 여기선 «막대의 팝오버 안에 모두 있다»만 본다.
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
beforeEach(() => { pathnameRef.current = '/dashboard'; queryRef.current = ''; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(props: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NavRail {...props} /></NextIntlClientProvider>);
  });
}
const names = () => [...container.querySelectorAll('[data-testid="nav-rail"] > a, [data-testid="nav-rail"] > div > a, [data-testid="nav-rail"] > div > button, [data-testid="nav-rail"] > div > div > a, [data-testid="nav-rail"] > div > div > button')]
  .map((el) => el.getAttribute('aria-label'));

describe('NavRail — B 셸 초안(아이콘 막대)', () => {
  it('⭐위에서 아래 순서: 오늘 → 대화 → 일감 → 팀 → 지식 · 맨 아래 조직 → 찾기 → 설정 → 전체', async () => {
    await mount();
    expect(names()).toEqual(['오늘', '대화', '일감', '팀', '지식', '조직', '검색…', '설정', '전체']);
  });

  it('구역의 첫 항목이 아이콘의 링크다(오늘 = /org-briefing · 일감 = /flow · 팀 = /organization/members(구역 첫 항목 구성원) · 지식 = /docs)', async () => {
    await mount();
    const href = (id: string) => container.querySelector(`[data-rail-item="${id}"]`)?.getAttribute('href');
    expect(href('org-briefing')).toBe('/org-briefing');
    expect(href('chats')).toBe('/chats');
    expect(href('board')).toBe('/flow');
    expect(href('org-members')).toBe('/organization/members');
    expect(href('docs')).toBe('/docs');
    expect(href('settings')).toBe('/settings');
    expect(href('all-screens')).toBe('/more');
  });

  it('⭐항목이 더 있는 구역은 옆 목록에 전부 싣는다(오늘 = 오늘 · 결재 · 일감 = 일감 · 목표 · 실행 · 팀 = 구성원 · 에이전트 · 실행 기록 · API 키 · 지식 = 문서 · 산출물 · 스토리지)', async () => {
    await mount();
    const flyout = (group: string) => [...container.querySelectorAll(`[data-rail-group="${group}"] [data-flyout-item]`)].map((a) => a.getAttribute('data-flyout-item'));
    expect(flyout('now')).toEqual(['org-briefing', 'inbox']);
    expect(flyout('dev')).toEqual(['board', 'goals', 'loops']);
    expect(flyout('team')).toEqual(['org-members', 'org-workforce', 'org-workforce-runs', 'org-workforce-api-keys']);
    expect(flyout('knowledge')).toEqual(['docs', 'artifacts', 'storage']);
  });

  it('⭐«조직»은 눌러야 펼쳐지고(기본 닫힘) 조직 항목 전부가 나오며 Esc로 닫힌다', async () => {
    await mount();
    expect(container.querySelector('[data-testid="rail-org-panel"]')).toBeNull();
    const button = container.querySelector('[data-rail-item="org"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { button.click(); });
    const items = [...container.querySelectorAll('[data-testid="rail-org-panel"] [data-flyout-item]')].map((a) => a.getAttribute('data-flyout-item'));
    expect(items).toEqual(['org-insights-board', 'org-channels', 'org-generation-connectors', 'org-content-rules', 'org-events', 'org-trust', 'org-roles', 'activity', 'content', 'channel-posts']);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[data-testid="rail-org-panel"]')).toBeNull();
  });

  it('⭐건수 배지: «오늘» 아이콘은 넘겨받은 todayCount를 그대로 그린다(셈은 UI-5 몫 — 막대는 값을 받아 그리기만) · «대화»는 안 읽은 수', async () => {
    await mount({ todayCount: 3, chatUnreadTotal: 120 });
    const badgeOf = (id: string) => container.querySelector(`[data-rail-item="${id}"] [data-testid="rail-badge"]`)?.textContent;
    expect(badgeOf('org-briefing')).toBe('3');
    expect(badgeOf('chats')).toBe('99+');
    expect(badgeOf('board')).toBeUndefined();
    // 옆 목록의 «결재» 줄에는 따로 숫자가 없다 — 숫자는 «오늘» 하나(결재만 세는 두 번째 셈을 두지 않는다)
    expect(container.querySelector('[data-flyout-item="inbox"] .bg-primary')).toBeNull();
  });

  it('값이 0이면 배지가 없다', async () => {
    await mount({ todayCount: 0, chatUnreadTotal: 0 });
    expect(container.querySelector('[data-testid="rail-badge"]')).toBeNull();
  });

  it('⭐«지금 여기»는 사이드바와 같은 판정이다: /organization/workforce/runs에서 «팀» 아이콘이 켜지고(구역 안) 옆 목록에선 «실행 기록»만 켜진다', async () => {
    pathnameRef.current = '/organization/workforce/runs';
    await mount();
    expect(container.querySelector('[data-rail-item="org-members"]')?.getAttribute('aria-current')).toBe('page');
    const current = [...container.querySelectorAll('[data-flyout-item][aria-current="page"]')].map((a) => a.getAttribute('data-flyout-item'));
    expect(current).toEqual(['org-workforce-runs']);
  });

  it('쿼리 항목: /inbox?tab=gates에서 «오늘» 구역이 켜지고 옆 목록의 «결재»가 켜진다 · 알림 탭에선 꺼진다', async () => {
    pathnameRef.current = '/inbox';
    queryRef.current = 'tab=gates';
    await mount();
    expect([...container.querySelectorAll('[data-flyout-item][aria-current="page"]')].map((a) => a.getAttribute('data-flyout-item'))).toEqual(['inbox']);
    expect(container.querySelector('[data-rail-item="org-briefing"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('지금 화면이 «조직» 안이면 조직 아이콘이 켜져 있다(펼치지 않아도 위치가 사라지지 않는다)', async () => {
    pathnameRef.current = '/organization/channels';
    await mount();
    const icon = container.querySelector('[data-rail-item="org"] span');
    expect(icon?.className).toContain('bg-muted');
  });

  it('찾기 아이콘은 팔레트를 연다(⌘K와 같은 창)', async () => {
    const open = vi.fn();
    await mount({ onOpenPalette: open });
    await act(async () => { (container.querySelector('[data-rail-item="search"]') as HTMLButtonElement).click(); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('데스크톱 앱은 막대에 아이콘이 없다(설정 구역의 둘째 항목이라 «전체» 지도에서 닿는다) — 막대 맨 아래엔 설정 하나', async () => {
    await mount({ navV3Flags: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: true } });
    expect(container.querySelector('[data-rail-item="settings"]')).not.toBeNull();
    expect(container.querySelector('[data-rail-item="desktop-app"]')).toBeNull();
  });
  it('⭐옆 목록은 CSS 호버가 아니라 상태로 연다: 닫힘 → 초점 들어오면 열림 → Esc로 닫힘 (터치 · 키보드에서도 닿는다)', async () => {
    await mount();
    const flyout = () => container.querySelector('[data-rail-group="dev"] [data-testid="rail-flyout"]') as HTMLElement;
    expect(flyout().getAttribute('data-open')).toBe('false');
    expect(flyout().className).toContain('hidden');
    // 아이콘과 목록 사이 빈틈 0(codex P1): 바깥 상자가 왼쪽 padding으로 틈을 메우고 margin은 없다 — 마우스가 건너는 동안 그룹 mouseleave가 안 난다
    expect(flyout().className).toContain('pl-1');
    expect(flyout().className).not.toMatch(/(^|\s)ml-/);
    expect(flyout().closest('[data-rail-group="dev"]')).not.toBeNull();
    await act(async () => { (container.querySelector('[data-rail-item="board"]') as HTMLAnchorElement).focus(); });
    expect(flyout().getAttribute('data-open')).toBe('true');
    expect(flyout().className).not.toContain('hidden');
    await act(async () => { (container.querySelector('[data-rail-item="board"]') as HTMLAnchorElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(flyout().getAttribute('data-open')).toBe('false');
  });

  it('⭐«계정» 팝오버: 길잡이 머리 · 바닥에만 있던 쪽이 아닌 입구가 막대에서도 닿는다(전환 · 새 프로젝트 · 에이전트 옮기기 · 프로필 · 언어 · 테마 · 사업자 정보)', async () => {
    await mount({ account: { orgId: 'o1', orgMemberships: [], projectId: 'p1', projectMemberships: [], userName: '디디' } });
    expect(names()).toEqual(['오늘', '대화', '일감', '팀', '지식', '조직', '계정', '검색…', '설정', '전체']);
    expect(document.querySelector('[data-testid="rail-account-panel"]')).toBeNull();
    await act(async () => { (container.querySelector('[data-rail-item="account"]') as HTMLElement).click(); });
    const parts = [...document.querySelectorAll('[data-testid="rail-account-panel"] [data-part]')].map((el) => el.getAttribute('data-part'));
    expect(parts).toEqual(['switcher', 'new-project', 'move-agents', 'profile', 'locale', 'theme', 'business-info']);
  });

  it('account를 안 넘기면 «계정» 아이콘은 없다(단독 사용)', async () => {
    await mount();
    expect(container.querySelector('[data-rail-item="account"]')).toBeNull();
  });

  it('⭐목록 칸 단추: listColumn을 넘기면 접기·펴기 단추가 서고(aria-expanded = 열림) 누르면 onToggle — 가장자리 손잡이가 막대 뒤에 가려져도 목록 칸을 다시 펼 길', async () => {
    const onToggle = vi.fn();
    await mount({ listColumn: { open: false, onToggle } });
    const btn = container.querySelector('[data-rail-item="list-column-toggle"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('사이드바 접기·펼치기');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { btn.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('listColumn을 안 넘기면 목록 칸 단추는 없다', async () => {
    await mount();
    expect(container.querySelector('[data-rail-item="list-column-toggle"]')).toBeNull();
  });

  it('«계정» 팝오버 상자에 접근 이름(계정)이 있다(codex P2)', async () => {
    await mount({ account: { orgId: 'o1', orgMemberships: [], projectId: 'p1', projectMemberships: [], userName: '디디' } });
    await act(async () => { (container.querySelector('[data-rail-item="account"]') as HTMLElement).click(); });
    expect(document.querySelector('[data-testid="rail-account-panel"]')?.getAttribute('aria-label')).toBe('계정');
  });
});
