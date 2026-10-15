// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc 자리 ②) — handleReorder/handleMove/
// handleRename/handleDeleteDoc 4개가 실패 시 fetchTree()로 조용히 원복되던 자리(문서
// 표는 docs-shell-client.tsx의 rename 1개만 잡았으나 그 파일은 죽은 코드 — 라이브
// docs-client-layout.tsx 4핸들러 전부에 처방). DocTree를 목으로 대체해 콜백 4개를
// 직접 호출하고 addToast가 실제로 뜨는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({}),
}));
vi.mock('@/components/nav/top-bar-context', () => ({
  useTopBar: () => ({ scrollContainer: null, setHidden: vi.fn() }),
}));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/use-hide-on-scroll', () => ({ useHideOnScroll: () => false }));
vi.mock('@/components/docs/use-recent-docs', () => ({
  useRecentDocs: () => ({ recentSlugs: [], pushRecent: vi.fn() }),
}));
vi.mock('@/components/docs/use-tree-expanded', () => ({
  useTreeExpanded: () => ({ isExpanded: () => false, toggleExpanded: vi.fn(), expandFolder: vi.fn() }),
}));
// [SID:4288] closedDrawerProps(닫힌 서랍 속성)는 실제 것을 쓴다 — 훅만 닫힌 상태로 고정.
vi.mock('@/lib/use-swipe-drawer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-swipe-drawer')>()),
  useSwipeDrawer: () => ({ progress: 0, dragging: false }),
}));
vi.mock('@/hooks/use-focus-trap', () => ({ useFocusTrap: () => ({ current: null }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));

// DocTree를 목으로 대체 — onReorder/onMove/onRename/onDelete를 전역에 노출해 직접 호출.
const captured: {
  // story #4353 — 끌기 콜백은 «어느 부모 · 어느 형제 뒤» 한 자리(plan)를 받는다.
  onReorder?: (plan: { docId: string; parentId: string | null; afterId?: string | null }) => Promise<void>;
  onMove?: (plan: { docId: string; parentId: string | null; afterId?: string | null }) => Promise<void>;
  onRename?: (docId: string, name: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
  docs?: Array<{ id: string; parent_id: string | null; sort_order: number }>;
} = {};
vi.mock('@/components/docs/doc-tree', () => ({
  DocTree: (props: typeof captured) => {
    captured.onReorder = props.onReorder;
    captured.onMove = props.onMove;
    captured.onRename = props.onRename;
    captured.onDelete = props.onDelete;
    captured.docs = props.docs; // story #4353(까디르 4736 P3) — 서버 번호 반영을 트리 입력으로 확인
    return <div data-testid="doc-tree-mock" />;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const DOC_A = { id: 'd1', parent_id: null, title: '문서A', slug: 'doc-a', icon: null, sort_order: 0, is_folder: false, status: 'confirmed', updated_at: '2026-08-20T00:00:00Z' };

function stubFetch(patchOk: boolean) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/docs') && (init?.method === 'PATCH' || (init?.method === 'POST' && url.includes('/api/docs/reorder')))) {
      if (!patchOk) return { ok: false, json: async () => ({}) };
      // story #4445 — real shapes: PATCH /api/docs/{id} passes the bare DocResponse through; /api/docs/reorder is wrapped
      return init?.method === 'PATCH'
        ? { ok: true, json: async () => ({ id: 'd1', updated_at: '2026-09-07T00:00:00Z' }) }
        : { ok: true, json: async () => ({ data: { updated_at: '2026-09-07T00:00:00Z' } }) };
    }
    if (typeof url === 'string' && url.includes('/api/docs') && init?.method === 'DELETE') {
      return patchOk ? { ok: true, json: async () => ({}) } : { ok: false, json: async () => ({}) };
    }
    if (typeof url === 'string' && url.includes('/api/docs')) {
      return { ok: true, json: async () => ({ data: [DOC_A], meta: { hasMore: false, nextCursor: null } }) };
    }
    return { ok: false, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  stubLocalStorage();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// story #3759 — DocsClientLayout이 useToast()로 공유 Context를 구독한다. afterEach의
// vi.resetModules()가 모듈 레지스트리를 지우므로, DocsClientLayout과 «같은» 새로 뜬
// @/components/ui/toast 인스턴스를 매 mount()마다 함께 동적 import한다(kanban-board.
// test.tsx와 동형 처방 — 정적 import 사본 0).
async function mount() {
  const { DocsClientLayout } = await import('./docs-client-layout');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');

  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }

  await act(async () => {
    root.render(wrap(
      <ToastProvider>
        <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><div>본문</div></DocsClientLayout>
        <TestToastRenderer />
      </ToastProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  // "내 폴더" 탭으로 전환해야 DocTree(목)가 마운트된다.
  const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
  await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('DocsClientLayout — 낙관 UI 실패 시 문장(story #3637)', () => {
  it('handleReorder 실패 시 reorderFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await mount();
    await act(async () => { await captured.onReorder!({ docId: 'd1', parentId: null, afterId: null }); });
    expect(container.textContent).toContain(koMessages.docs.reorderFailed);
  });

  it('handleMove 실패 시 moveFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await mount();
    await act(async () => { await captured.onMove!({ docId: 'd1', parentId: 'p1' }); });
    expect(container.textContent).toContain(koMessages.docs.moveFailed);
  });

  it('handleRename 실패 시 renameFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await mount();
    await act(async () => { await captured.onRename!('d1', '새 이름'); });
    expect(container.textContent).toContain(koMessages.docs.renameFailed);
  });

  it('handleDeleteDoc 실패 시 deleteFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await mount();
    await act(async () => { await captured.onDelete!('d1'); });
    expect(container.textContent).toContain(koMessages.docs.deleteFailed);
  });

  it('뮤테이션 대표 — handleRename 성공 시엔 토스트가 안 뜬다(과보고 방지)', async () => {
    stubFetch(true);
    await mount();
    await act(async () => { await captured.onRename!('d1', '새 이름'); });
    expect(container.textContent).not.toContain(koMessages.docs.renameFailed);
  });
});

// 까디르(4736 P2) — 성공 응답(BFF가 감싼 {data: {doc, siblings}})을 화면이 실제로 읽는다: 서버 번호를 그대로 반영하고 트리 전체를
// 다시 읽지 않는다(예전엔 json.data.doc이 비어 성공마다 재읽기 — 새로고침 뒤 유지가 그 재읽기 덕에 통과했었다).
// 뮤테이션: placeDoc이 봉투 밖(json.doc)을 읽으면 재읽기가 생겨 RED.
describe('DocsClientLayout — 재정렬 성공은 서버 번호로(story #4353 · 4736 P2)', () => {
  // story #4445 — PATCH /api/docs/{id} passes the backend's DocResponse through as is (a bare object, not `{ data }`). The
  // rename read `{ data }`, so a saved rename threw on `data.updated_at`: «이름 바꾸기 실패» + a tree re-read, and the remote
  // change baseline was never set. The mocks here answered `{ data }` and stayed green. The real shape now:
  it('⭐#4445 — 실제 응답 모양(맨 DocResponse)으로 이름 바꾸기 성공: 실패 토스트 0 · 트리 다시 읽기 0 · 원격 변경 기준선 갱신', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/docs/d1' && init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ id: 'd1', title: '새 이름', slug: 'doc-a', updated_at: '2026-10-01T01:00:00Z' }) };
      }
      if (typeof url === 'string' && url.includes('/api/docs')) {
        return { ok: true, json: async () => ({ data: [DOC_A], meta: { hasMore: false, nextCursor: null } }) };
      }
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { useDocsLayout } = await import('./docs-context');
    function Pending() {
      const { pendingDocUpdate } = useDocsLayout();
      return <span data-testid="pending">{pendingDocUpdate ? `${pendingDocUpdate.id}@${pendingDocUpdate.updated_at}` : ''}</span>;
    }
    const { DocsClientLayout } = await import('./docs-client-layout');
    const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');
    function TestToastRenderer() {
      const { toasts, dismissToast } = useToast();
      return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
    }
    await act(async () => {
      root.render(wrap(
        <ToastProvider>
          <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><Pending /></DocsClientLayout>
          <TestToastRenderer />
        </ToastProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const treeReads = () => fetchMock.mock.calls.filter(([u, i]) => typeof u === 'string' && u.includes('/api/docs') && (!i || !(i as RequestInit).method || (i as RequestInit).method === 'GET')).length;
    const before = treeReads();
    await act(async () => { await captured.onRename!('d1', '새 이름'); });
    expect(container.textContent).not.toContain(koMessages.docs.renameFailed);
    expect(treeReads()).toBe(before);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe('d1@2026-10-01T01:00:00Z');
  });

  it('⭐성공 응답의 번호를 반영하고 트리 목록을 다시 부르지 않는다', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/docs/reorder') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ data: { doc: { id: 'd1', parent_id: null, sort_order: 7 }, siblings: [{ id: 'd1', sort_order: 7 }] } }) };
      }
      if (typeof url === 'string' && url.includes('/api/docs')) {
        return { ok: true, json: async () => ({ data: [DOC_A], meta: { hasMore: false, nextCursor: null } }) };
      }
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const treeReads = () => fetchMock.mock.calls.filter(([u, i]) => typeof u === 'string' && u.includes('/api/docs') && !u.includes('/reorder') && (!i || !(i as RequestInit).method || (i as RequestInit).method === 'GET')).length;
    const before = treeReads();
    await act(async () => { await captured.onReorder!({ docId: 'd1', parentId: null, afterId: null }); });
    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && u.includes('/api/docs/reorder'))).toBe(true);
    expect(treeReads()).toBe(before);
    // 까디르(4736 P3) — 서버 번호(7)를 처음 값(0)과 다르게 둬 «반영»을 실제로 잰다.
    expect(captured.docs?.find((d) => d.id === 'd1')?.sort_order).toBe(7);
    expect(container.textContent).not.toContain(koMessages.docs.reorderFailed);
  });
});
