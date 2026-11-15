// @vitest-environment jsdom
//
// 4913(UI-R5) D물결 — 블로그 포스트(글 목록)가 «한 쪽 틀» 안에 선다: 제목은 위 막대(h1 하나) · 본문은 wide 틀 · 머리 = 설명 + «대화 열기» · 탭 다섯 + «보관됨 보기» ·
// 목록은 RowList(표가 아니다 · 우클릭 = «⋯» 같은 항목 · 더블클릭 / Enter = 상세 열기) · 빈 / 로딩 / 오류 칸. 글 하나하나의 값(상태 · 작성자 · 버전 · 보관 · 다음 발)은 page.test.tsx가 그대로 지킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
  useChatsHref: () => '/chats',
  useConnectRulesHref: (fallback: string) => fallback,
}));
const { routerPushMock } = vi.hoisted(() => ({ routerPushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
  usePathname: () => '/content',
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.content;
const ORG_ID = 'org-1';

let container: HTMLDivElement;
let root: Root;

const DRAFT = {
  draft_id: 'd1', work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: '2호 글',
  current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
  body_sha256: 'h1', gate_status: null, reapproval_required: null, sealed_content_sha256: null, published_at: null,
};

function stubFetch(opts: { drafts?: unknown[]; status?: number; hang?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/\?$/, '');
    if (url === `/api/organizations/${ORG_ID}/site-posts/drafts`) {
      if (opts.hang) return new Promise(() => {});
      if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: opts.drafts ?? [], error: null, meta: null }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
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

const rows = () => [...container.querySelectorAll('[data-testid="content-list-row"]')] as HTMLElement[];
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

describe('ContentPostListPage — 한 쪽 틀(4913 D물결)', () => {
  it('⭐제목은 위 막대의 h1 하나뿐이고(본문 h1 0) 본문은 wide 틀(PageFrame) 안에 선다 · 머리는 설명 + «대화 열기»', async () => {
    stubFetch({ drafts: [DRAFT] });
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(T.title);
    expect(container.querySelector('[data-testid="topbar-probe"] h1')).not.toBeNull();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.getAttribute('data-width')).toBe('wide');
    expect(frame.querySelector('h1')).toBeNull();
    const head = frame.querySelector('[data-slot="ds-page-head"]')!;
    expect(head.textContent).toContain(T.description);
    const chat = head.querySelector('[data-slot="ds-page-head-actions"] a') as HTMLAnchorElement;
    expect(chat.textContent).toBe(T.openChatCta);
    expect(chat.getAttribute('href')).toBe('/chats');
  });

  it('⭐목록은 표가 아니라 RowList다 — 글 하나 = listitem 하나(이름 = 화면 제목) · <table> 0', async () => {
    stubFetch({ drafts: [DRAFT, { ...DRAFT, draft_id: 'd2', title: '3호 글' }] });
    await mount();
    expect(container.querySelector('table')).toBeNull();
    const list = container.querySelector('[data-testid="content-list"] [role="list"]')!;
    expect(list.getAttribute('aria-label')).toBe(T.title);
    expect(list.querySelectorAll('[role="listitem"][data-testid="content-list-row"]')).toHaveLength(2);
    // 한 줄 안에 제목(상세로 가는 링크) · 상태 칩(ds) · 수정 시각 · 버전이 다 있다
    const row = rows()[0]!;
    const link = row.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('2호 글');
    expect(link.getAttribute('href')).toContain('/content/d1');
    expect(row.querySelector('[data-slot="ds-chip"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="content-current-version"]')?.textContent).toContain('v2');
  });

  it('⭐탭 다섯 + «보관됨 보기»는 틀 안 한 줄에 서고, «보관됨 보기»는 눌림 상태(aria-pressed)를 알린다', async () => {
    stubFetch({ drafts: [DRAFT] });
    await mount();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.querySelectorAll('[role="tab"]')).toHaveLength(5);
    // 탭 줄은 틀 안에서 스스로 가로 스크롤한다 — flex 줄의 자식이 내용 폭으로 뻗어 쪽 전체를 옆으로 밀지 않게 min-w-0 · max-w-full(좁은 폰 · 글꼴이 넓은 환경에서 실제로 넘쳤다)
    const tabsRoot = frame.querySelector('[data-slot="ds-tabs"]')!;
    expect(tabsRoot.className).toContain('min-w-0');
    expect(tabsRoot.className).toContain('max-w-full');
    const toggle = frame.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
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

  it('⭐더블클릭 · Enter = 그 글의 상세를 연다 — 줄 안 단추를 더블클릭하면 열지 않는다', async () => {
    stubFetch({ drafts: [{ ...DRAFT, gate_status: 'pending' }] });
    await mount();
    const row = rows()[0]!;
    await act(async () => { mainOf(row).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(routerPushMock).toHaveBeenCalledTimes(1);
    expect(String(routerPushMock.mock.calls[0]![0])).toContain('/content/d1');
    routerPushMock.mockClear();
    mainOf(row).focus();
    await act(async () => { mainOf(row).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(routerPushMock).toHaveBeenCalledTimes(1);
    expect(String(routerPushMock.mock.calls[0]![0])).toContain('/content/d1');
    // 「승인 요청 보기」(행 안 단추)를 «진짜 더블클릭»(click · click · dblclick)해도 줄 열기가 아니다 — 그 단추 자기 길(받은함)만 간다(단추가 죽었으면 push가 0이라 이 단언은 못 지나간다)
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

  it('⭐불러오는 동안에도 제목(위 막대)과 틀이 쌍으로 선다 — 틀 안에 «불러오는 중» 상태가 알려진다', async () => {
    stubFetch({ hang: true });
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    const loading = frame.querySelector('[data-testid="content-list-loading"]')!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelectorAll('[data-slot="ds-skeleton"]').length).toBeGreaterThanOrEqual(3);
  });

  it('⭐빈 상태 · 오류는 ds 부품(EmptyState · Banner)이고 오류는 즉시 읽힌다(role=alert)', async () => {
    stubFetch({ drafts: [] });
    await mount();
    expect(container.querySelector('[data-slot="ds-empty-state"]')?.textContent).toContain(T.emptyTitle);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ status: 500 });
    await mount();
    const banner = container.querySelector('[data-slot="ds-banner"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain(T.loadFailed);
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
  });
});
