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
vi.mock('@/lib/use-swipe-drawer', () => ({ useSwipeDrawer: () => ({ progress: 0, dragging: false }) }));
vi.mock('@/hooks/use-focus-trap', () => ({ useFocusTrap: () => ({ current: null }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));

// DocTree를 목으로 대체 — onReorder/onMove/onRename/onDelete를 전역에 노출해 직접 호출.
const captured: {
  onReorder?: (docId: string, n: number) => Promise<void>;
  onMove?: (docId: string, p: string | null, n: number) => Promise<void>;
  onRename?: (docId: string, name: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
} = {};
vi.mock('@/components/docs/doc-tree', () => ({
  DocTree: (props: typeof captured) => {
    captured.onReorder = props.onReorder;
    captured.onMove = props.onMove;
    captured.onRename = props.onRename;
    captured.onDelete = props.onDelete;
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
    if (typeof url === 'string' && url.includes('/api/docs') && init?.method === 'PATCH') {
      return patchOk
        ? { ok: true, json: async () => ({ data: { updated_at: '2026-09-07T00:00:00Z' } }) }
        : { ok: false, json: async () => ({}) };
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

async function mount() {
  const { DocsClientLayout } = await import('./docs-client-layout');
  await act(async () => {
    root.render(wrap(
      <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><div>본문</div></DocsClientLayout>,
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
    await act(async () => { await captured.onReorder!('d1', 5); });
    expect(container.textContent).toContain(koMessages.docs.reorderFailed);
  });

  it('handleMove 실패 시 moveFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await mount();
    await act(async () => { await captured.onMove!('d1', null, 0); });
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
