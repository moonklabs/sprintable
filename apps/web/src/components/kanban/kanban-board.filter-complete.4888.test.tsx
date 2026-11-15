// @vitest-environment jsdom
//
// story #4888 (UI-5 «하다 나온 결함») — the board's cards are loaded a page at a time (20 per status, done 10). Two things used to hide card 21 onward:
//  ① the default (trust-axis) view had no «더 보기» and no «N+» at all — the classic columns had them, the trust columns did not;
//  ② a filter that runs in the browser (라벨 · 담당자 종류 · 검색) only saw the loaded cards, so a match past the first page silently dropped out of the result.
// The goal (epic) filter is one the list API already applies on the server: it goes in the request (`epic_id`), not into a read-to-the-end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

// story #4171 — 스프린트 칩 라벨 테스트가 ?sprint_id를 싣는다(기본은 빈 쿼리 — 기존 테스트 무변).
const { searchRef } = vi.hoisted(() => ({ searchRef: { current: '' } }));
vi.mock('next/navigation', () => ({
  // story #4307 — replace가 실제로 쿼리를 바꾸게(필터 변경 → 다시 불러오기 재현). 다른 테스트는 다시 그리지 않으니 무영향.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn((url: string) => { searchRef.current = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''; }) }),
  useSearchParams: () => new URLSearchParams(searchRef.current),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — viewMode 기본값이 이제 useIsMobile()로 갈리므로
// (예전엔 'board' 하드코딩) jsdom엔 window.matchMedia가 없어(use-mobile.ts가 그걸 직접 부른다)
// 이 파일의 기존 테스트 전부가 크래시했다. flow-client.test.tsx와 동일 패턴 — 훅 자체를
// 모킹해 desktop(false)을 기본값으로 고정, 이 스토리의 신규 describe에서만 true로 override.
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_BREAKPOINT: 1024,
}));

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #2933 H4 qa:changes(카디르+codex, 2026-08-22) — handleTrustDragEnd(교차 신뢰컬럼
// 드래그)를 실제로 발화시켜 검증하려면 <DndContext onDragEnd={...}>의 그 콜백을 손에 쥐어야
// 한다. 이 코드베이스 전체에 dnd-kit 실 포인터 제스처 시뮬레이션 선례가 0(grep 확認) —
// useSseNotifications를 모킹해 콜백을 캡처하는 기존 관례(story-detail-panel.test.tsx)와
// 동형으로, DndContext만 부분 모킹해 onDragEnd를 캡처한다(다른 export는 실물 그대로 재사용 —
// useDroppable/useSortable 등은 실제 dnd-kit 훅이라야 카드 wiring 테스트가 의미 있음).
const { capturedDragEndHandlers } = vi.hoisted(() => ({
  capturedDragEndHandlers: [] as Array<(event: unknown) => void>,
}));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ onDragEnd, children }: { onDragEnd?: (event: unknown) => void; children?: React.ReactNode }) => {
      if (onDragEnd) capturedDragEndHandlers.push(onDragEnd);
      return children;
    },
  };
});

// The project-switch test below reads a 2,600-card status to its 2,500 cap; the card body is not what these tests look at, so a title-only stand-in keeps that cheap.
vi.mock('./story-card', () => ({
  StoryCard: ({ story }: { story: { title: string } }) => <div>{story.title}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
// story #3759 — kanban-board.tsx는 이제 저장오류 배너를 useDashboardContext().
// bottomDockBannerSlot으로 포털한다(BottomDock 소유 dock 컬럼 실물 대신 테스트용 DOM
// 노드). `container`(createRoot 대상) 밖에 별도로 붙인다 — createRoot는 자기 container의
// 자식 전체를 소유해 렌더마다 지우므로, container 안에 미리 넣어두면 첫 렌더에 사라진다.
// 배너 관련 단언은 `bannerSlot`을 직접 쿼리한다(container 대신).
let bannerSlot: HTMLDivElement;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// PO 긴급 fix(P0-04 기본축 trust 플립, 2026-08-22) — 실 BE는 trust_stage를 매 요청마다
// derive_trust_stage()로 항상 계산해 내려준다(backend/app/services/trust_pipeline.py, done/미지
// status 제외 None 없음). 이 축과 무관한 기존 테스트 다수가 trust_stage 없는 고정(fixture)을
// 써왔는데, 기본 뷰가 trust로 바뀌면 그 고정이 실 BE 응답과 달라 카드가 어느 컬럼에도 안 걸려
// 사라진다(storyTrustColumn: status!=='done'이면 trust_stage ?? null). 개별 테스트 50여곳을
// 일일이 고치는 대신 이 stub 자체를 실 BE 파생 규칙과 정합시킨다 — 명시적으로 trust_stage를
// 지정한 케이스(H4 테스트 등, null 명시 포함)는 그대로 존중하고 아예 안 준 경우만 채운다.
function deriveDefaultTrustStage(status: string): string | null {
  if (status === 'backlog' || status === 'ready-for-dev') return 'queued';
  if (status === 'in-progress') return 'running';
  if (status === 'in-review') return 'claimed_done';
  return null; // done/미지 status — derive_trust_stage와 동형.
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

// story #2059 — 보드 실시간 반영용 EventSource 페이크. addEventListener로 등록된
// story.status_changed/story.assignee_changed 리스너를 캡처해 테스트에서 직접 dispatch한다.
type SseListener = (e: { data: string; lastEventId?: string }) => void;
let sseListeners: Record<string, SseListener[]>;

function stubEventSource() {
  sseListeners = {};
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: SseListener | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string, _opts?: unknown) {}
    addEventListener(name: string, cb: SseListener) {
      (sseListeners[name] ??= []).push(cb);
    }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  bannerSlot = document.createElement('div');
  document.body.appendChild(bannerSlot);
  root = createRoot(container);
  stubLocalStorage();
  stubEventSource();
  useDashboardContextMock.mockReturnValue({
    currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human',
    bottomDockBannerSlot: bannerSlot,
  });
  capturedDragEndHandlers.length = 0;
  isMobileMock = false;
  searchRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  bannerSlot.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// story #3759 — kanban-board.tsx가 useToast()로 공유 Context를 구독한다. afterEach의
// vi.resetModules()가 모듈 레지스트리를 지우므로, 이 파일 최상단에서 한 번 정적 import한
// ToastProvider/ToastContainer/useToast와 kanban-board.tsx가(동적 import 뒤) 실제로 읽는
// 모듈 인스턴스가 서로 달라져(각자 다른 createContext() 결과물) Provider 밖 에러가 났다 —
// kanban-board.tsx와 «같은» 새로 뜬 모듈 인스턴스를 매 mount()마다 함께 동적 import해
// 이 파일도 그 인스턴스를 쓴다(정적 import 사본 0, 같은 자리에서 같이 새로 뜬다).
async function mount() {
  const { KanbanBoard } = await import('./kanban-board');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');
  // story #4698 — 보드의 실시간은 RealtimeProvider(멀티플렉서)의 스트림 하나로 온다(훅의 독립 EventSource 폴백 삭제). resetModules 뒤라 KanbanBoard와 «같은» 새 모듈
  // 인스턴스의 Provider를 같이 동적 import해야 같은 Context를 본다.
  const { RealtimeProvider } = await import('@/components/realtime-provider');

  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }

  await act(async () => {
    root.render(wrap(
      <RealtimeProvider currentTeamMemberId="me-1">
        <ToastProvider>
          <KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />
          <TestToastRenderer />
        </ToastProvider>
      </RealtimeProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}


// ── fake paginated list API: `limit`, `cursor` (offset), `status`, `epic_id` are honoured like the real route ──────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown> & { id: string; status: string; title: string };
function stubPagedFetch(rows: Row[], opts: { failCursorRequests?: { n: number }; smallProject?: string; hold?: { release?: () => void; held?: boolean } } = {}): string[] {
  const urls: string[] = [];
  const withStage: Row[] = rows.map((s) => ('trust_stage' in s ? s : { ...s, trust_stage: deriveDefaultTrustStage(s.status) }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      urls.push(url);
      const sp = new URL(url, 'http://localhost').searchParams;
      if (sp.get('cursor') && opts.failCursorRequests && opts.failCursorRequests.n > 0) {
        opts.failCursorRequests.n -= 1;
        return { ok: false, json: async () => null };
      }
      const status = sp.get('status');
      const epic = sp.get('epic_id');
      const limit = Number(sp.get('limit') ?? '50');
      const offset = Number(sp.get('cursor') ?? '0');
      const forProject = opts.smallProject && sp.get('project_id') === opts.smallProject ? withStage.slice(0, 5) : withStage;
      const all = forProject.filter((s) => s.status === status && (!epic || s.epic_id === epic));
      // like the route + the backend board query: ask for limit + 1 to learn whether a next page exists, and the backend serves at most 10 `done` cards per request
      const asked = status === 'done' ? Math.min(limit + 1, 10) : limit + 1;
      const fetched = all.slice(offset, offset + asked);
      const hasMore = fetched.length > limit;
      const page = fetched.slice(0, limit);
      const next = hasMore ? String(offset + limit) : null;
      const response = { ok: true, json: async () => ({ data: page, meta: { nextCursor: next, hasMore: next !== null } }) };
      if (sp.get('cursor') && opts.hold && !opts.hold.held) {
        opts.hold.held = true;
        return new Promise((resolve) => { opts.hold!.release = () => resolve(response); });
      }
      return response;
    }
    if (typeof url === 'string' && url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
  return urls;
}

const inProgress = (n: number, extra: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, status: 'in-progress', title: `카드-${i + 1}`, position: i + 1, ...extra }));

/** the header number of a trust column, found by its label */
function headerOf(label: string): string {
  const h3s = [...container.querySelectorAll('h3')];
  const h3 = h3s.find((h) => h.textContent?.trim() === label) ?? h3s.find((h) => h.textContent?.includes(label));
  for (let el: HTMLElement | null | undefined = h3?.parentElement, i = 0; el && i < 3; el = el.parentElement, i += 1) {
    const n = el.querySelector('span.tabular-nums');
    if (n) return (n.textContent ?? '').trim();
  }
  return '';
}
const loadMoreButtons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === '더 보기');

async function openSearchAndType(text: string) {
  const toggle = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title')?.includes('제목 또는 담당자'));
  expect(toggle).not.toBeUndefined();
  await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const input = container.querySelector('input[type="search"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}

describe('KanbanBoard 4888 — 기본 보기(신뢰축)의 «더 보기» · «N+»', () => {
  it('첫 쪽(20건)보다 많으면 열 머리가 «20+», 더 보기로 마지막 카드까지 닿는다', async () => {
    stubPagedFetch(inProgress(25));
    await mount();
    expect(container.textContent).toContain('카드-20');
    expect(container.textContent).not.toContain('카드-21');
    expect(headerOf('실행 중')).toBe('20+');
    expect(loadMoreButtons()).toHaveLength(1);

    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

    expect(container.textContent).toContain('카드-25');
    expect(headerOf('실행 중')).toBe('25');
    expect(loadMoreButtons()).toHaveLength(0);
  });

  it('딱 20건이면 «20+»도 «더 보기»도 없다 — 더 있다고 거짓말하지 않는다', async () => {
    stubPagedFetch(inProgress(20));
    await mount();
    expect(headerOf('실행 중')).toBe('20');
    expect(loadMoreButtons()).toHaveLength(0);
  });
});

describe('KanbanBoard 4888 — 브라우저에서 거르는 필터는 첫 쪽 밖 카드도 찾는다', () => {
  it('검색: 21번째 이후 카드가 조건에 맞으면 결과에 나오고, 열은 100건 쪽으로 끝까지 읽는다', async () => {
    const rows = inProgress(25).map((r) => (r.id === 's25' ? { ...r, title: '특별한 보고서' } : r));
    const urls = stubPagedFetch(rows);
    await mount();
    expect(container.textContent).not.toContain('특별한 보고서'); // first page only: 20 of 25

    await openSearchAndType('특별한');

    expect(container.textContent).toContain('특별한 보고서');
    expect(urls.some((u) => u.includes('limit=100'))).toBe(true);
    expect(headerOf('실행 중')).toBe('1'); // exact: the column is read to its end, nothing more to load
  });

  it('검색을 안 켠 채로는 100건 읽기를 하지 않는다 — 첫 쪽만(20건)', async () => {
    const urls = stubPagedFetch(inProgress(25));
    await mount();
    expect(urls.some((u) => u.includes('limit=100'))).toBe(false);
    expect(urls.some((u) => u.includes('limit=20') || u.includes('limit=10'))).toBe(true);
  });

  it('목표(에픽): 서버가 거르는 파라미터라 요청에 epic_id가 실리고, 끝까지 읽기(limit=100)는 하지 않는다', async () => {
    searchRef.current = 'epic_id=e1';
    const rows = inProgress(30).map((r, i) => ({ ...r, epic_id: i < 22 ? 'e1' : 'e2' }));
    const urls = stubPagedFetch(rows);
    await mount();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => new URL(u, 'http://localhost').searchParams.get('epic_id') === 'e1')).toBe(true);
    expect(urls.some((u) => u.includes('limit=100'))).toBe(false);
    // server-filtered set has 22 cards → first page 20 + a working «더 보기» reaching the 22nd
    expect(headerOf('실행 중')).toBe('20+');
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(container.textContent).toContain('카드-22');
    expect(container.textContent).not.toContain('카드-23');
    expect(headerOf('실행 중')).toBe('22');
  });
});

describe('KanbanBoard 4888 — 코덱스 검수에서 나온 칸들', () => {
  it('5단계 클래식: 마지막 쪽까지 불러온 뒤 머리가 첫 쪽 수(20)로 되돌아가지 않는다', async () => {
    localStorage.setItem('board_axis_mode_proj-1', 'status');
    stubPagedFetch(inProgress(25));
    await mount();
    expect(headerOf('진행 중')).toBe('20+');
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(container.textContent).toContain('카드-25');
    expect(headerOf('진행 중')).toBe('25');
  });

  it('«더 보기» 쪽 요청이 실패하면 커서가 남아 버튼이 그대로 있고, 다시 누르면 이어서 불러온다', async () => {
    const fail = { n: 1 };
    stubPagedFetch(inProgress(25), { failCursorRequests: fail });
    await mount();
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(fail.n).toBe(0); // the failing page was really asked
    expect(container.textContent).not.toContain('카드-25');
    expect(headerOf('실행 중')).toBe('20+');
    expect(loadMoreButtons()).toHaveLength(1);

    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(container.textContent).toContain('카드-25');
    expect(headerOf('실행 중')).toBe('25');
  });

  it('파생 열(입력 필요): 같은 상태에 더 있으면 «N+»만 보이고 «더 보기»는 실행 중 열 하나뿐이다', async () => {
    const rows = inProgress(25).map((r) => (r.id === 's3' ? { ...r, trust_stage: 'needs_input' } : r));
    stubPagedFetch(rows);
    await mount();
    expect(headerOf('입력 필요')).toBe('1+');
    expect(loadMoreButtons()).toHaveLength(1);
  });

  // re-render the already mounted board for another project (same component instance, as when the project is switched in the app)
  async function switchProject(projectId: string) {
    const { KanbanBoard } = await import('./kanban-board');
    const { ToastProvider } = await import('@/components/ui/toast');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    await act(async () => {
      root.render(wrap(
        <RealtimeProvider currentTeamMemberId="me-1">
          <ToastProvider>
            <KanbanBoard projectId={projectId} wsSlug="ws-1" projSlug={projectId} />
          </ToastProvider>
        </RealtimeProvider>,
      ));
    });
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
  }

  it('프로젝트를 바꾸면, 옛 프로젝트에 남은 커서(2,500건 한도 밖)로 새 프로젝트를 100건 단위로 읽지 않는다', async () => {
    const urls = stubPagedFetch(inProgress(2600), { smallProject: 'proj-2' });
    await mount();
    await openSearchAndType('카드'); // browser-side filter on → proj-1 read to its cap: 25 pages of 100, a cursor is left
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    expect(urls.filter((u) => u.includes('project_id=proj-1') && u.includes('status=in-progress') && u.includes('limit=100'))).toHaveLength(25);
    expect(headerOf('실행 중')).toBe('2500+');

    await switchProject('proj-2');
    expect(urls.some((u) => u.includes('project_id=proj-2'))).toBe(true);
    expect(urls.filter((u) => u.includes('project_id=proj-2')).some((u) => u.includes('limit=100'))).toBe(false);
  });

  it('프로젝트가 바뀐 뒤에 도착한 옛 프로젝트의 «더 보기» 쪽은 버려진다', async () => {
    const hold: { release?: () => void; held?: boolean } = {};
    stubPagedFetch(inProgress(25), { smallProject: 'proj-2', hold });
    await mount();
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(hold.held).toBe(true); // the page of proj-1 is on its way

    await switchProject('proj-2');
    await act(async () => { hold.release!(); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

    expect(container.textContent).not.toContain('카드-25'); // proj-1's late page did not land in proj-2's board
    expect(container.textContent).toContain('카드-5');
  });

  it('옛 프로젝트의 «더 보기»가 아직 안 끝났어도, 바뀐 프로젝트의 «더 보기» 버튼은 눌린다', async () => {
    const hold: { release?: () => void; held?: boolean } = {};
    stubPagedFetch(inProgress(25), { hold });
    await mount();
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(hold.held).toBe(true);
    // while a page is on its way the button reads «불러오는 중…» and is disabled
    const loadingBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '불러오는 중…');
    expect(loadingBtn?.disabled).toBe(true);

    await switchProject('proj-2'); // same 25 cards: a fresh first page, a fresh button
    expect(loadMoreButtons()).toHaveLength(1);
    expect(loadMoreButtons()[0]!.disabled).toBe(false);

    // proj-2's own page is now on its way; the old project's page finishing must not clear proj-2's «loading»
    const releaseOld = hold.release!;
    hold.held = false;
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(hold.held).toBe(true);
    await act(async () => { releaseOld(); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    const stillLoading = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '불러오는 중…');
    expect(stillLoading?.disabled).toBe(true);
  });

  it('완료(done) 열도 검색이 켜지면 끝까지 읽는다 — 백엔드가 한 번에 10건만 주므로 쪽 크기는 9', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ id: `d${i + 1}`, status: 'done', title: i === 44 ? '오래된 완료 보고서' : `완료-${i + 1}`, position: i + 1 }));
    const urls = stubPagedFetch(rows);
    await mount();
    expect(container.textContent).not.toContain('오래된 완료 보고서');
    await openSearchAndType('오래된');
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
    expect(container.textContent).toContain('오래된 완료 보고서');
    expect(urls.filter((u) => u.includes('status=done')).every((u) => u.includes('limit=9'))).toBe(true);
  });

  it('완료(done) 열 첫 쪽: 10건을 넘으면 «9+»와 «더 보기»가 서고, 마지막 카드까지 닿는다', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: `d${i + 1}`, status: 'done', title: `완료-${i + 1}`, position: i + 1 }));
    stubPagedFetch(rows);
    await mount();
    expect(headerOf('완료')).toBe('9+');
    expect(container.textContent).not.toContain('완료-10');
    expect(loadMoreButtons()).toHaveLength(1);
    await act(async () => { loadMoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(container.textContent).toContain('완료-15');
    expect(headerOf('완료')).toBe('15');
  });
});

