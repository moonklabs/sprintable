// @vitest-environment jsdom
//
// story #4931 — (derived from the 4888 seam harness) the home counts an agent that waits at a Mac terminal question of MY computer; the 4888 seam text follows:
// story #4888 (UI-5 AC4, home) — the seam the home must close: the navigation bar's «홈» badge (NavRail `todayCount`) was always 0 while the home body showed rows. Now the bar and the home
// read ONE model; the number on the bar is the number of rows in «내 손이 필요해요» (and the number in the home's header). These tests mount the REAL bar and the REAL home screen under
// the shared provider and fail when the two are given different numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/org-briefing',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
// the bar's account popover parts are other tests' business
function part(name: string) { return function Part() { return <div data-part={name} />; }; }
vi.mock('@/components/nav/unified-switcher', () => ({ UnifiedSwitcher: part('switcher') }));
vi.mock('@/components/nav/new-project-entry', () => ({ NewProjectEntry: part('new-project'), MoveAgentsEntry: part('move-agents') }));
vi.mock('@/components/nav/profile-menu', () => ({ ProfileMenu: part('profile') }));
vi.mock('@/components/locale-switcher', () => ({ LocaleSwitcher: part('locale') }));
vi.mock('@/components/nav/theme-toggle', () => ({ ThemeToggle: part('theme') }));
vi.mock('@/components/nav/business-info-disclosure', () => ({ BusinessInfoDisclosure: part('business-info') }));
// the checklist card has its own tests; here it only has to be a card in the home's slot
vi.mock('@/components/dashboard/activation-checklist-banner', () => ({
  ActivationChecklistBanner: ({ placement }: { placement?: string }) => <div data-testid="activation-banner-stub" data-placement={placement ?? 'shell'} />,
}));
vi.mock('@/components/org-briefing/agent-state-section', () => ({ AgentStateSection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [] });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const session = (id: string, over: Record<string, unknown> = {}) => ({
  agent_id: id, agent_name: `에이전트 ${id}`, conversation_id: `c-${id}`, conversation_project_id: 'p1', bound_setup_id: null, bound_device_name: null,
  setup_id: `s-${id}`, device_name: `맥 ${id}`, state: 'working', activity: 'working', state_at: '2026-11-14T05:00:00Z', limit: null,
  first_screen: { ask: 'trust' }, device_is_mine: true, ...over,
});

function stubWorld(opts: { sessions: unknown[] | 'fail' }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/today') {
      return { ok: true, status: 200, json: async () => ({ data: {
        needs_me: [], needs_me_count: 0, agent_progress: [], completed_today: [],
        published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
      } }) };
    }
    if (url.startsWith('/api/notifications')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url === '/api/agents/desktop-sessions') {
      if (opts.sessions === 'fail') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: opts.sessions }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  }));
}

async function mountBarAndHome() {
  const { HomeModelProvider } = await import('./home-model-provider');
  const { NavRailWithHomeBadge } = await import('./home-nav-rail');
  const { OrgBriefingShell } = await import('@/components/org-briefing/org-briefing-shell');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <HomeModelProvider viewerMemberId={null} projectId={undefined}>
          <NavRailWithHomeBadge />
          <OrgBriefingShell />
        </HomeModelProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
}

const railBadge = () => container.querySelector('[data-rail-item="org-briefing"] [data-testid="rail-badge"]')?.textContent ?? null;
const headerLineN = () => /손 필요 (\d+)/.exec(container.querySelector('[data-testid="home-header-line"]')?.textContent ?? '')?.[1] ?? null;
const needsRows = () => [...container.querySelectorAll('[data-testid="home-section-needs-hand"] [data-row-key]')].map((e) => e.getAttribute('data-row-key'));

describe('홈 «손 필요» — Mac 터미널 물음을 기다리는 에이전트 (story #4931)', () => {
  it('기다림 0 — 손 필요 0 · 배지 없음 · «모두 확인했어요»(지금 그대로)', async () => {
    stubWorld({ sessions: [] });
    await mountBarAndHome();
    expect(railBadge()).toBeNull();
    expect(needsRows()).toEqual([]);
    expect(container.textContent).toContain('모두 확인했어요');
  });

  it('⭐기다림 1(내 기기) — 한 줄 · 수 1 · 막대 배지 1 · «모두 확인했어요» 안 뜸 · 누르면 그 에이전트 대화', async () => {
    stubWorld({ sessions: [session('a1')] });
    await mountBarAndHome();
    expect(needsRows()).toEqual(['terminal:a1']);
    expect(headerLineN()).toBe('1');
    expect(railBadge()).toContain('1');
    expect(container.textContent).not.toContain('모두 확인했어요');
    const rowEl = container.querySelector('[data-row-key="terminal:a1"]')!;
    expect(rowEl.textContent).toContain('에이전트 a1');
    expect(rowEl.textContent).toContain('Mac 터미널에서 답 기다림');
    expect(rowEl.querySelector('a')?.getAttribute('href')).toContain('/chats/c-a1');
  });

  it('기다림 여럿 — 막대 배지 · 머리 한 줄 · 본문 행 수가 같은 수', async () => {
    stubWorld({ sessions: [session('a1'), session('a2', { activity: 'idle', state: 'idle' }), session('a3')] });
    await mountBarAndHome();
    expect(needsRows().sort()).toEqual(['terminal:a1', 'terminal:a2', 'terminal:a3']);
    expect(headerLineN()).toBe('3');
    expect(railBadge()).toContain('3');
  });

  it('⭐남의 기기 기다림 → 수 0 — 그 맥 앞 사람만 답할 수 있다: 줄 없음 · 배지 없음 · «모두 확인했어요»', async () => {
    stubWorld({ sessions: [session('a1', { device_is_mine: false }), session('a2', { device_is_mine: false })] });
    await mountBarAndHome();
    expect(needsRows()).toEqual([]);
    expect(railBadge()).toBeNull();
    expect(container.textContent).toContain('모두 확인했어요');
  });

  it('내 것 1 + 남의 것 1 — 내 것만 센다', async () => {
    stubWorld({ sessions: [session('mine'), session('theirs', { device_is_mine: false })] });
    await mountBarAndHome();
    expect(needsRows()).toEqual(['terminal:mine']);
    expect(railBadge()).toContain('1');
  });

  it('에이전트 상태 읽기가 실패하면 «모두 확인했어요»라 단정하지 않는다(못 읽은 것은 비었다고 말하지 않는다)', async () => {
    stubWorld({ sessions: 'fail' });
    await mountBarAndHome();
    expect(container.textContent).not.toContain('모두 확인했어요');
    expect(container.querySelector('[data-testid="home-incomplete-notice"]')).not.toBeNull();
  });
});
