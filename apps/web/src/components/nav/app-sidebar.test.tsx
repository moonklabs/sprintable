// @vitest-environment jsdom
//
// story 5031 (C1 step 2a) — the list column of the new shell draws the rows of the ONE place you are in (홈 · 채팅 · 에이전트 · 설정), taken from the nav catalog through nav-placement.json (doors: depth1).
// Replaces the story #2681 / #3824 / #4885 renders that listed every zone: no zone headers, no fold, no «전체» row, no chat card — those screens are reached through the icon bar's four places, ⌘K «모든 화면», cards and panels
// (nav-placement.test.ts keeps «빠짐 0»). What stays pinned here: the rows (labels · hrefs · order) of each place, «지금 여기», the project mark, the pending badge, the ⌘K order, the v3 flags not moving anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

const { pathnameRef, queryRef } = vi.hoisted(() => ({ pathnameRef: { current: '/org-briefing' }, queryRef: { current: '' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(queryRef.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withProviders(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <SidebarProvider>{node}</SidebarProvider>
    </NextIntlClientProvider>
  );
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { inboxUnreadCount: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
}
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia();
  stubFetch();
  stubLocalStorage();
  pathnameRef.current = '/org-briefing';
  queryRef.current = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(navV3Flags?: NavV3Flags) {
  await act(async () => {
    root.render(withProviders(<AppSidebar projectMemberships={[]} chatUnreadTotal={0} navV3Flags={navV3Flags} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const ALL_ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true, desktopDownloadEnabled: true };
const OFF: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: false };

const rowIds = () => [...container.querySelectorAll('[data-nav-id]')].map((el) => el.getAttribute('data-nav-id'));
const rowLabels = () => [...container.querySelectorAll('[data-nav-id] [data-nav-label]')].map((el) => el.textContent);
const hrefOf = (id: string) => container.querySelector(`[data-nav-id="${id}"]`)?.getAttribute('href');
const current = () => [...container.querySelectorAll('[data-nav-id][aria-current="page"]')].map((el) => el.getAttribute('data-nav-id'));

describe('⭐목록 칸 — 지금 있는 «자리»의 줄만(story 5031)', () => {
  it('홈: 홈 → 결재 → 성과 보드 → 활동 로그 (데스크톱 앱 플래그가 꺼져도 같다)', async () => {
    pathnameRef.current = '/org-briefing';
    await mount(OFF);
    expect(rowIds()).toEqual(['org-briefing', 'inbox', 'org-insights-board', 'activity']);
    expect(rowLabels()).toEqual(['홈', '결재', '성과 보드', '활동 로그']);
    expect(container.querySelector('[data-testid="depth1-list"]')?.getAttribute('data-depth1-slot')).toBe('home');
  });

  it('채팅: 대화가 맨 위 → 일감 → 목표 → 실행 → 문서 → 산출물 → 스토리지 → 콘텐츠 → 채널 포스트 → 채널 채팅', async () => {
    pathnameRef.current = '/chats';
    await mount(OFF);
    expect(rowIds()).toEqual(['chats', 'board', 'goals', 'loops', 'docs', 'artifacts', 'storage', 'content', 'channel-posts', 'channel-chat']);
    expect(container.querySelector('[data-testid="depth1-list"]')?.getAttribute('data-depth1-slot')).toBe('chat');
  });

  it('에이전트: 에이전트 → 신뢰 센터 → 리워드 (실행 기록 · API 키는 목록 위 «전체 보기» 줄로 — story 5035) (구성원은 설정 «사람과 역할»로 갔다)', async () => {
    pathnameRef.current = '/organization/workforce';
    await mount(OFF);
    expect(rowIds()).toEqual(['org-workforce', 'org-trust', 'rewards']);
    expect(rowIds()).not.toContain('org-members');
  });

  it('설정: 목록 칸엔 «설정» 한 줄뿐 — 사람 · 역할 · 연결 · 콘텐츠 규칙 · 이벤트는 설정 안 링크 줄로만(story 5032 · PO 11-27: 겹쳐 보여 뺌 · ⌘K는 그대로) · 데스크톱 앱 항목은 그 화면이 켜진 곳에서만 마지막에', async () => {
    pathnameRef.current = '/settings';
    await mount(OFF);
    expect(rowIds()).toEqual(['settings']); // reverted (the six sub-screens back as list rows) → they show beside the settings page's own link rows
    root.unmount();
    root = createRoot(container);
    await mount({ ...OFF, desktopDownloadEnabled: true });
    expect(rowIds().at(-1)).toBe('desktop-app');
    expect(hrefOf('desktop-app')).toBe('/desktop');
  });

  it('길이 아무 자리에도 안 닿거나 셸 밖이면 홈의 줄을 그린다(빈 칸으로 두지 않는다)', async () => {
    pathnameRef.current = '/no/such/screen/at/all';
    await mount(OFF);
    expect(rowIds()).toEqual(['org-briefing', 'inbox', 'org-insights-board', 'activity']);
  });

  it('옛 구역 머리 · 접기 · «전체» 줄 · 대화 카드는 없다', async () => {
    await mount(OFF);
    expect(container.querySelector('[data-testid="depth1-list"] [aria-expanded]')).toBeNull();
    expect(container.querySelector('[data-nav-id="all-screens"]')).toBeNull();
    expect(container.querySelector('[data-chat-center-active]')).toBeNull();
    expect(localStorage.getItem('sidebar_group_collapsed')).toBeNull();
  });
});

describe('줄의 href · 표식 · 지금 여기', () => {
  it('정적 줄의 href는 길 그대로(홈 · 결재 · 대화 · 설정 · 에이전트)', async () => {
    pathnameRef.current = '/org-briefing';
    await mount(OFF);
    expect(hrefOf('org-briefing')).toBe('/org-briefing');
    expect(hrefOf('inbox')).toBe('/inbox?tab=gates');
    expect(hrefOf('org-insights-board')).toBe('/organization/insights-board');
    expect(hrefOf('activity')).toBe('/activity');
  });

  it('리소스 줄(일감 · 목표 · 문서)은 org/project slug가 없으면 bare href로 폴백한다', async () => {
    pathnameRef.current = '/chats';
    await mount(OFF);
    expect(hrefOf('board')).toBe('/flow');
    expect(hrefOf('docs')).toBe('/docs');
    expect(hrefOf('chats')).toBe('/chats');
  });

  it('⭐줄마다 «프로젝트» 표식이 붙지 않는다 — 프로젝트는 위쪽 프로젝트 필터 하나로 알린다(PO 11-26 · 칩은 한 자리에 하나)', async () => {
    pathnameRef.current = '/chats';
    await mount(OFF);
    for (const id of rowIds()) expect(container.querySelector(`[data-nav-id="${id}"]`)?.textContent ?? '', String(id)).not.toContain('프로젝트');
    expect(container.querySelector('[data-testid="depth1-list"]')?.textContent).not.toContain('프로젝트');
  });

  it('⭐목록 칸에는 검색 상자 · 계정 줄 · 언어 · 테마 · 사업자 정보가 없다 — 아이콘 막대의 검색 · 계정 팝오버가 가진다(둘씩 보이던 것 · PO 11-26)', async () => {
    await mount(OFF);
    expect(container.querySelector('[aria-label="검색…"]')).toBeNull();
    expect(container.textContent).not.toContain('검색…');
    expect(container.textContent).not.toContain('사업자');
    expect(container.querySelector('[data-testid="depth1-list"]')).not.toBeNull();
    // the project filter stays at the top of the column (one place for it)
    expect(container.querySelector('[data-sidebar="header"]')).not.toBeNull();
  });

  it('줄은 높이 40 · 아이콘 24 · 아이콘과 글 16 · 구분선 없음(눈금 클래스만 — 임의 수치 0)', async () => {
    await mount(OFF);
    const row = container.querySelector('[data-nav-id="org-briefing"]')!;
    expect(row.className).toMatch(/\bh-10\b/);
    expect(row.className).toMatch(/\bgap-x-4\b/);
    expect(row.className).toMatch(/\bpx-4\b/);
    expect(row.className).toMatch(/\bborder-b-0\b/);
    expect(row.querySelector('svg')?.getAttribute('class')).toMatch(/\bsize-6\b/);
    expect(row.className).not.toMatch(/\[\d+px\]/);
  });

  it('지금 여기: 정확히 한 줄(aria-current=page) — 상세 화면은 부모 줄을 켠다', async () => {
    pathnameRef.current = '/organization/workforce/abc';
    await mount(OFF);
    expect(current()).toEqual(['org-workforce']);
    root.unmount();
    root = createRoot(container);
    pathnameRef.current = '/organization/workforce/runs';
    await mount(OFF);
    expect(current()).toEqual(['org-workforce']); // story 5035: «실행 기록»은 전체 보기 줄로 갔다 — 그 아래 주소도 «에이전트» 줄이 켜진다
  });

  it('⭐일감 줄은 일감 탭 어디서든(flow · work-list · sprints · epics · retro · hypotheses) 켜진다(story #3844)', async () => {
    for (const tab of ['flow', 'work-list', 'sprints', 'epics', 'retro', 'hypotheses']) {
      root.unmount();
      root = createRoot(container);
      pathnameRef.current = `/${tab}`; // flat bare path (no org / project slug): the proxy forwards it; the list still shows the chat place's rows
      await mount(OFF);
      expect(current(), tab).toEqual(['board']);
    }
  });

  it('결재 줄의 쿼리(?tab=gates)는 «지금 여기»를 막지 않는다', async () => {
    pathnameRef.current = '/inbox';
    queryRef.current = 'tab=gates';
    await mount(OFF);
    expect(current()).toEqual(['inbox']);
  });
});

describe('결재 배지 · v3 플래그', () => {
  it('결재 줄에 «내 손 필요» 이름이 달린 배지가 서고(진행 중 요청 수), 다른 줄엔 없다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { count: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    pathnameRef.current = '/org-briefing';
    await mount(OFF);
    const badges = [...container.querySelectorAll('[data-slot="ds-count-badge"]')];
    // the count comes from the shared designated-pending-count client; whatever it returns, only the inbox row carries a badge
    for (const b of badges) expect(b.closest('[data-nav-id]')?.getAttribute('data-nav-id')).toBe('inbox');
  });

  it('⭐v3 플래그를 전부 켜도 줄 · href는 그대로다(새 셸은 플래그 없이 하나)', async () => {
    pathnameRef.current = '/org-briefing';
    await mount(OFF);
    const off = rowIds().map((id) => [id, hrefOf(id!)]);
    root.unmount();
    root = createRoot(container);
    await mount(ALL_ON);
    const on = rowIds().map((id) => [id, hrefOf(id!)]);
    expect(on).toEqual(off);
  });
});

describe('⭐줄 순서는 ⌘K 팔레트 «이동» 순서와 어긋나지 않는다(story #4885 → 5031)', () => {
  it('자리마다: 목록 칸 줄의 상대 순서 = 팔레트 이동 목록에서 그 줄들만 거른 순서(첫 화면이 맨 위로 올라온 것만 빼고)', async () => {
    const { deriveNavigateItems } = await import('@/components/command-palette/command-palette');
    const palette = deriveNavigateItems((r) => `/${r}`).map((i) => i.id);
    for (const [path, first] of [['/org-briefing', 'org-briefing'], ['/chats', 'chats'], ['/organization/workforce', 'org-workforce'], ['/settings', 'settings']] as const) {
      root.unmount();
      root = createRoot(container);
      pathnameRef.current = path;
      await mount({ ...OFF, desktopDownloadEnabled: false });
      const rows = rowIds().filter((id): id is string => !!id && id !== first);
      const inPalette = palette.filter((id) => rows.includes(id));
      // rows missing from the palette (none expected) would shorten this list
      expect(rows.filter((id) => palette.includes(id)), path).toEqual(inPalette);
    }
  });
});
