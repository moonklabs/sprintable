// @vitest-environment jsdom
//
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

const need = (id: string, at: string) => ({
  kind: 'approval', risk: 'low', source: 'gate', source_id: id,
  work_item: { type: 'story', id: `s-${id}`, title: `결재 ${id}` },
  requested_by: null, reason: null, created_at: at, actions: ['approve'],
});

function stubWorld(opts: { needsMe: unknown[]; needsMeCount?: number; notifications?: Array<{ id: string; type: string; title: string }> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/today') {
      return { ok: true, status: 200, json: async () => ({ data: {
        needs_me: opts.needsMe, needs_me_count: opts.needsMeCount ?? opts.needsMe.length, agent_progress: [], completed_today: [],
        published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
      } }) };
    }
    if (url.startsWith('/api/notifications')) {
      const data = (opts.notifications ?? []).map((n) => ({ ...n, is_read: false, reference_type: null, reference_id: null, created_at: '2026-09-13T06:00:00Z', href: null }));
      return { ok: true, status: 200, json: async () => ({ data }) };
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
const headerBadge = () => container.querySelector('[data-testid="needs-me-header-badge"]')?.textContent ?? null;
const headerLineN = () => /손 필요 (\d+)/.exec(container.querySelector('[data-testid="home-header-line"]')?.textContent ?? '')?.[1] ?? null;
const bodyRows = () => container.querySelectorAll('[data-testid="home-section-needs-hand"] [data-row-key]').length;

describe('홈 이음새 — 막대 «홈» 배지 = 홈 본문의 수 (story #4888)', () => {
  it('⭐막대 배지 · 머리 배지 · 머리 한 줄 · 본문 행 수가 모두 같은 수다 — 결재 2 + 알림 1(멘션) = 3, 결재와 겹치는 알림(gate.pending_approval)은 안 센다', async () => {
    stubWorld({
      needsMe: [need('g1', '2026-09-13T05:00:00Z'), need('g2', '2026-09-13T05:30:00Z')],
      notifications: [
        { id: 'n1', type: 'conversation.mention', title: '멘션' },
        { id: 'n2', type: 'gate.pending_approval', title: '결재 알림(위 결재와 같은 일)' },
        { id: 'n3', type: 'conversation.message', title: '새 대화 글(대화 배지 몫)' },
      ],
    });
    await mountBarAndHome();
    expect(railBadge()).toContain('3');
    expect(headerBadge()).toContain('3');
    expect(headerLineN()).toBe('3');
    expect(bodyRows()).toBe(3);
  });

  it('손 필요한 일이 0이면 막대에 배지가 없고 본문은 «모두 확인했어요»다', async () => {
    stubWorld({ needsMe: [] });
    await mountBarAndHome();
    expect(railBadge()).toBeNull();
    expect(headerBadge()).toBeNull();
    expect(container.textContent).toContain('모두 확인했어요');
  });

  it('서버가 센 건수가 행보다 많아도(식별자 결손) 막대 수는 «행 수»이고, 모자란 만큼은 말로 알린다 — 세지 못한 것을 수에 섞지 않는다', async () => {
    stubWorld({ needsMe: [need('g1', '2026-09-13T05:00:00Z')], needsMeCount: 4 });
    await mountBarAndHome();
    expect(railBadge()).toContain('1');
    expect(bodyRows()).toBe(1);
    expect(container.querySelector('[data-testid="home-hidden-notice"]')?.textContent).toContain('3건은 정보가 부족해 표시하지 못했어요');
  });

  it('시작 체크리스트는 홈 목록 위의 자리(placement="home")에 서고, 배지 수에 안 센다', async () => {
    stubWorld({ needsMe: [] });
    await mountBarAndHome();
    const slot = container.querySelector('[data-testid="home-checklist-slot"]');
    expect(slot?.querySelector('[data-testid="activation-banner-stub"]')?.getAttribute('data-placement')).toBe('home');
    expect(railBadge()).toBeNull(); // the checklist adds nothing to the number
    // it stands above the list
    const list = container.querySelector('[data-testid="home-list"]')!;
    expect(slot!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('«내 손이 필요해요» 5건 넘으면 5건 + «N개 더 보기» — 접힌 행도 수에는 들어 있다(머리 · 막대는 전체 수)', async () => {
    const needsMe = Array.from({ length: 7 }, (_, i) => need(`g${i + 1}`, `2026-09-13T05:0${i}:00Z`));
    stubWorld({ needsMe });
    await mountBarAndHome();
    expect(railBadge()).toContain('7');
    expect(headerLineN()).toBe('7');
    expect(bodyRows()).toBe(5);
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === '2개 더 보기');
    expect(more).toBeTruthy();
    await act(async () => { more!.click(); });
    expect(bodyRows()).toBe(7);
  });

  it('체크리스트 자리는 홈 모델을 읽는 동안에도 그 자리에 서 있다(늦게 끼어들어 목록을 밀지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // nothing ever answers: the model stays unread
    await mountBarAndHome();
    expect(railBadge()).toBeNull();
    expect(container.querySelector('[data-testid="home-list"]')).toBeNull(); // still loading
    expect(container.querySelector('[data-testid="home-checklist-slot"] [data-testid="activation-banner-stub"]')).not.toBeNull();
  });
});

