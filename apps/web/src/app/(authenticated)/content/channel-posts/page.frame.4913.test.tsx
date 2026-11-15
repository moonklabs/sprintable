// @vitest-environment jsdom
//
// 4913(UI-R5) D물결 — 채널 포스트(글 목록)가 «한 쪽 틀» 안에 선다: 제목은 위 막대(h1 하나) · 본문은 wide 틀 · 머리 = 설명 + «대화 열기» · 목록/캘린더/반응 전환 = 진짜 링크(TabNav) ·
// 상태 탭 5 + «보관됨 보기» · 목록은 RowList(표가 아니다 · 우클릭 = «⋯» 같은 항목 · 더블클릭 / Enter = 상세 열기 · 막힘 · 부분 성공 · 같은 스토리의 글은 행 아래 작은 글) · 연결 조회 · 빈 / 로딩 / 오류 칸.
// 글 하나하나의 값(상태 · 나가는 시각 우선순위 · 실패 표시 · 보관 · 다음 발)은 page.test.tsx가 그대로 지킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
  useChatsHref: () => '/chats',
  useConnectRulesHref: (fallback: string) => fallback,
}));
const { routerPushMock } = vi.hoisted(() => ({ routerPushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
  usePathname: () => '/content/channel-posts',
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.content;
const ORG_ID = 'org-1';

let container: HTMLDivElement;
let root: Root;

const DRAFT = {
  draft_id: 'd1', work_item_id: 'w1', channel: 'threads', connection_id: 'c1',
  current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
  body_sha256: 'h1', gate_status: null, reapproval_required: null, sealed_content_sha256: null,
  published_at: null, publication_status: null, text_preview: '본문 미리보기 한 줄',
};

function stubFetch(opts: { drafts?: unknown[]; status?: number; connections?: unknown[] | 'hang'; hangDrafts?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/\?$/, '');
    if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
      if (opts.connections === 'hang') return new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({ data: opts.connections ?? [{ id: 'conn-1', status: 'active' }], error: null, meta: null }) };
    }
    if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts`) {
      if (opts.hangDrafts) return new Promise(() => {});
      if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: opts.drafts ?? [], error: null, meta: null }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function mount() {
  const { default: Page } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider } = await import('@/components/ui/toast');
  function Probe() {
    const { title } = useTopBar();
    return <div data-testid="topbar-probe">{title}</div>;
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><ToastProvider><Probe /><Page /></ToastProvider></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

const rows = () => [...container.querySelectorAll('[data-testid="channel-posts-list-row"]')] as HTMLElement[];
const mainOf = (row: HTMLElement) => row.querySelector('[data-row-main]') as HTMLElement;
const menuLabels = () => [...document.body.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [] });
  routerPushMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ChannelPostListPage — 한 쪽 틀(4913 D물결)', () => {
  it('⭐제목은 위 막대의 h1 하나뿐이고(본문 h1 0) 본문은 wide 틀 안에 선다 · 머리는 설명 + «대화 열기»', async () => {
    stubFetch({ drafts: [DRAFT] });
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(T.channelPostsTitle);
    expect(container.querySelector('[data-testid="topbar-probe"] h1')).not.toBeNull();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.getAttribute('data-width')).toBe('wide');
    expect(frame.querySelector('h1')).toBeNull();
    const head = frame.querySelector('[data-slot="ds-page-head"]')!;
    expect(head.textContent).toContain(T.channelPostsDescription);
    const chat = head.querySelector('[data-slot="ds-page-head-actions"] a') as HTMLAnchorElement;
    expect(chat.textContent).toBe(T.openChatCta);
    expect(chat.getAttribute('href')).toBe('/chats');
  });

  it('⭐목록 / 캘린더 / 반응 전환은 틀 안의 TabNav(nav 랜드마크)이고 목록이 지금 자리다 — 캘린더 · 반응은 진짜 링크', async () => {
    stubFetch({ drafts: [] });
    await mount();
    const nav = container.querySelector('[data-slot="ds-page-frame"] [data-slot="ds-tab-nav"]') as HTMLElement;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe(T.channelPostsTitle);
    const links = [...nav.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual([T.channelPostsViewList, T.channelPostsViewCalendar, T.channelPostsViewEngagement]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null]);
    expect(links[1]!.getAttribute('href')).toBe('/content/channel-posts/calendar');
    expect(links[2]!.getAttribute('href')).toBe('/content/channel-posts/engagement');
  });

  it('⭐목록은 표가 아니라 RowList다 — 글 하나 = listitem 하나(이름 = 화면 제목) · <table> 0 · 줄 = 미리보기 링크 + 상태 칩 + 채널', async () => {
    stubFetch({ drafts: [DRAFT, { ...DRAFT, draft_id: 'd2', text_preview: '둘째 글' }] });
    await mount();
    expect(container.querySelector('table')).toBeNull();
    const list = container.querySelector('[data-testid="channel-posts-list"] [role="list"]')!;
    expect(list.getAttribute('aria-label')).toBe(T.channelPostsTitle);
    expect(list.querySelectorAll('[role="listitem"][data-testid="channel-posts-list-row"]')).toHaveLength(2);
    const row = rows()[0]!;
    const link = row.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('본문 미리보기 한 줄');
    expect(link.getAttribute('href')).toContain('/content/channel-posts/d1');
    expect(row.querySelector('[data-slot="ds-chip"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="ds-list-row"]')!.textContent).toContain(koMessages.channelConnect.channelThreads);
  });

  it('⭐막힘 · 부분 성공 · 같은 스토리의 글은 행 «아래 작은 글»(footnote)에 선다 — 접혀 있어도 늘 보인다', async () => {
    stubFetch({
      drafts: [{
        ...DRAFT, gate_status: 'approved', sealed_content_sha256: 'h1', command_status: 'dead_letter',
        publication_status: 'container_created', source_content_item_id: 'site-1', source_title: '원본 글',
      }],
    });
    await mount();
    const note = rows()[0]!.querySelector('[data-slot="ds-row-footnote"]')!;
    expect(note.querySelector('[data-testid="channel-post-failure-badge"]')).not.toBeNull();
    expect(note.querySelector('[data-testid="channel-post-partial-success"]')).not.toBeNull();
    expect(note.querySelector('[data-testid="channel-post-source-link"] a')?.getAttribute('href')).toBe('/content/site-1');
    // 긴 원본 제목은 줄 안에서 말줄임 — 링크 상자가 패널 밖으로 뻗지 않게 min-w-0 + truncate(인라인 <a>를 truncate 문단에 두면 상자가 뻗었다 — 레이아웃 e2e가 잡은 것)
    const sourceLink = note.querySelector('[data-testid="channel-post-source-link"] a') as HTMLElement;
    expect(sourceLink.className).toContain('min-w-0');
    expect(sourceLink.className).toContain('truncate');
    // 막힘이 없는 행엔 작은 글 칸 자체가 안 그려진다
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ drafts: [DRAFT] });
    await mount();
    expect(rows()[0]!.querySelector('[data-slot="ds-row-footnote"]')).toBeNull();
  });

  it('⭐상태 탭 5 + «보관됨 보기»는 틀 안 한 줄에 서고 «보관됨 보기»는 눌림 상태(aria-pressed)를 알린다 · 탭 줄은 틀 안에서 스스로 가로 스크롤한다(min-w-0 max-w-full)', async () => {
    stubFetch({ drafts: [DRAFT] });
    await mount();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')).toHaveLength(5);
    const tabsRoot = frame.querySelector('[data-slot="ds-tabs"]')!;
    expect(tabsRoot.className).toContain('min-w-0');
    expect(tabsRoot.className).toContain('max-w-full');
    const toggle = frame.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('data-slot')).toBe('ds-button');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { toggle.click(); });
    await flush();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('⭐행 우클릭 = 그 행 «⋯» 메뉴와 같은 항목이다(같은 배열)', async () => {
    stubFetch({ drafts: [{ ...DRAFT, can_archive: true }] });
    await mount();
    const trigger = rows()[0]!.querySelector('[data-slot="ds-row-context-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30, button: 2 })); });
    const viaContext = menuLabels();
    expect(viaContext).toEqual([T.archiveAction]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const more = rows()[0]!.querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement;
    await act(async () => { more.click(); });
    expect(menuLabels()).toEqual(viaContext);
  });

  it('⭐더블클릭 · Enter = 그 글의 상세를 연다 — 줄 안 단추를 «진짜 더블클릭»(click · click · dblclick)해도 줄 열기가 아니다', async () => {
    stubFetch({ drafts: [{ ...DRAFT, gate_status: 'pending' }] });
    await mount();
    const row = rows()[0]!;
    await act(async () => { mainOf(row).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(routerPushMock).toHaveBeenCalledTimes(1);
    expect(String(routerPushMock.mock.calls[0]![0])).toContain('/content/channel-posts/d1');
    routerPushMock.mockClear();
    mainOf(row).focus();
    await act(async () => { mainOf(row).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(routerPushMock).toHaveBeenCalledTimes(1);
    expect(String(routerPushMock.mock.calls[0]![0])).toContain('/content/channel-posts/d1');
    routerPushMock.mockClear();
    const next = [...row.querySelectorAll('button')].find((b) => b.textContent === T.approvalRequestViewCta)!;
    await act(async () => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      next.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
      next.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    });
    expect(routerPushMock).toHaveBeenCalledTimes(2);
    for (const call of routerPushMock.mock.calls) expect(String(call[0])).toBe('/inbox?tab=gates');
  });

  it('⭐불러오는 동안에도 제목(위 막대)과 틀이 쌍으로 선다 — 연결 조회 중 · 목록 조회 중 둘 다 틀 안에 «불러오는 중» 상태가 알려진다', async () => {
    stubFetch({ connections: 'hang' });
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    let loading = container.querySelector('[data-slot="ds-page-frame"] [data-testid="channel-posts-connections-loading"]')!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelectorAll('[data-slot="ds-skeleton"]').length).toBeGreaterThanOrEqual(2);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ hangDrafts: true });
    await mount();
    loading = container.querySelector('[data-slot="ds-page-frame"] [data-testid="channel-posts-list-loading"]')!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.querySelectorAll('[data-slot="ds-skeleton"]').length).toBeGreaterThanOrEqual(3);
  });

  it('⭐빈 상태 · 연결 0 · 오류는 ds 부품(EmptyState · Banner)이고 오류는 즉시 읽힌다(role=alert)', async () => {
    stubFetch({ drafts: [] });
    await mount();
    expect(container.querySelector('[data-slot="ds-empty-state"]')?.textContent).toContain(T.channelPostsEmptyTitle);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ drafts: [DRAFT], connections: [] });
    await mount();
    expect(container.querySelector('[data-slot="ds-empty-state"]')?.textContent).toContain(T.channelPostsNoChannelsTitle);
    expect(container.querySelector('[data-slot="ds-empty-state"] a')?.getAttribute('href')).toBe('/organization/channels');
    expect(rows()).toHaveLength(0);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ status: 500 });
    await mount();
    const banner = container.querySelector('[data-slot="ds-banner"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain(T.channelPostsLoadFailed);
  });
});
