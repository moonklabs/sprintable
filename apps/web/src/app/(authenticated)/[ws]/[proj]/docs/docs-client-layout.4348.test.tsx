// @vitest-environment jsdom
//
// story #4348 — «⋮» 위로 · 아래로 · 폴더로의 저장(handleMenuMove). DocTree를 목으로 바꿔 onMenuMove · docs · hasMore를 잡고 직접 부른다.
// - 화면은 곧바로 새 자리(낙관) · 저장은 상대 이동 API 한 번(POST /api/docs/reorder {doc_id, parent_id, after_id?}).
// - 저장은 한 줄: 앞 이동의 응답 전엔 다음 POST 0. 앞 응답(서버 번호)을 반영해도 아직 안 닿은 뒤 이동의 낙관 순서는 그대로.
// - 실패(409 포함) = moveFailed 토스트 + 트리 다시 읽기 · 줄에 선 뒤 이동은 안 보냄.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import type { DocMoveAction, MenuMoveResult } from '@/components/docs/lib/doc-move';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
  useTreeExpanded: () => ({ isExpanded: () => false, toggleExpanded: vi.fn(), expandFolder: vi.fn(), expandFolders: vi.fn() }),
}));
vi.mock('@/lib/use-swipe-drawer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-swipe-drawer')>()),
  useSwipeDrawer: () => ({ progress: 0, dragging: false }),
}));
vi.mock('@/hooks/use-focus-trap', () => ({ useFocusTrap: () => ({ current: null }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));

type TreeDoc = { id: string; parent_id: string | null; sort_order: number };
const captured: {
  docs?: TreeDoc[];
  hasMore?: boolean;
  onMenuMove?: (docId: string, action: DocMoveAction) => Promise<MenuMoveResult>;
} = {};
vi.mock('@/components/docs/doc-tree', () => ({
  DocTree: (props: typeof captured) => {
    captured.docs = props.docs;
    captured.hasMore = props.hasMore;
    captured.onMenuMove = props.onMenuMove;
    return <div data-testid="doc-tree-mock" />;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const base = (id: string, sort_order: number, extra: Record<string, unknown> = {}) => ({ id, parent_id: null, title: id, slug: id, icon: null, sort_order, is_folder: false, status: 'confirmed', updated_at: '2026-09-01T00:00:00Z', ...extra });
const TREE = [base('a', 10), base('b', 20), base('c', 30), base('f', 40, { is_folder: true })];

type Held = { body: Record<string, unknown>; respond: (status: number, json?: unknown) => Promise<void> };
let posts: Held[];
let treeGets: number;
let getUrls: string[];
let tree: Array<Record<string, unknown>> = TREE;

function stubFetch(hasMore = false, data: Array<Record<string, unknown>> = TREE) {
  posts = [];
  treeGets = 0;
  getUrls = [];
  tree = data;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/docs/reorder' && init?.method === 'POST') {
      return new Promise((resolve) => {
        posts.push({
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          respond: async (status, json) => { await act(async () => { resolve({ ok: status < 300, status, json: async () => json }); for (let i = 0; i < 6; i++) await Promise.resolve(); }); },
        });
      });
    }
    if (url.startsWith('/api/docs?')) {
      treeGets += 1;
      getUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: tree, meta: { hasMore, nextCursor: hasMore ? 'c1' : null } }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => null });
  }));
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
  stubLocalStorage();
  for (const k of Object.keys(captured)) delete captured[k as keyof typeof captured];
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { DocsClientLayout } = await import('./docs-client-layout');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');
  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><div>본문</div></DocsClientLayout>
          <TestToastRenderer />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
  await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// 트리에서 보이는 순서(서버와 같은 (sort_order, id)) — 부모별.
const order = (parent: string | null = null) => captured.docs!.filter((d) => d.parent_id === parent).sort((x, y) => x.sort_order - y.sort_order || (x.id < y.id ? -1 : 1)).map((d) => d.id);
const numbers = () => Object.fromEntries(captured.docs!.map((d) => [d.id, d.sort_order]));
const move = (docId: string, action: DocMoveAction) => {
  let p!: Promise<MenuMoveResult>;
  act(() => { p = captured.onMenuMove!(docId, action); });
  return p;
};
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

describe('DocsClientLayout — «⋮» 옮기기 저장(story #4348)', () => {
  it('DocTree에 onMenuMove · hasMore(목록 meta)를 넘긴다', async () => {
    stubFetch(true);
    await mount();
    expect(typeof captured.onMenuMove).toBe('function');
    expect(captured.hasMore).toBe(true);
  });

  it('위로: 곧바로 새 자리 · POST 한 번(after_id = 새 앞 형제, 맨 앞이면 null) · 응답 번호 반영 · plan을 돌려줌', async () => {
    stubFetch();
    await mount();
    const p = move('b', { kind: 'up' });
    expect(order()).toEqual(['b', 'a', 'c', 'f']);
    await flush();
    expect(posts.map((x) => x.body)).toEqual([{ doc_id: 'b', parent_id: null, after_id: null }]);
    await posts[0].respond(200, { data: { doc: { id: 'b', parent_id: null, sort_order: 1 }, siblings: [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 2 }, { id: 'c', sort_order: 3 }, { id: 'f', sort_order: 4 }] } });
    expect(numbers()).toEqual({ a: 2, b: 1, c: 3, f: 4 });
    // 알림용 자리 = 응답 형제 전부로 센 자리(까디르 #4730 P3)
    await expect(p).resolves.toMatchObject({ plan: { ok: true, docId: 'b', index: 0 }, placed: { position: 1, total: 4 } });
    expect(container.textContent).not.toContain(koMessages.docs.moveFailed);
  });

  it('폴더로: after_id 키 없이(서버의 진짜 끝)', async () => {
    stubFetch();
    await mount();
    void move('a', { kind: 'into', parentId: 'f' });
    expect(order('f')).toEqual(['a']);
    await flush();
    expect(posts[0].body).toEqual({ doc_id: 'a', parent_id: 'f' });
    expect('after_id' in posts[0].body).toBe(false);
  });

  it('한 줄: 앞 응답 전엔 둘째 POST 0 · 앞 응답을 반영해도 둘째의 낙관 순서 유지 · 둘째 응답 뒤 서버 번호', async () => {
    stubFetch();
    await mount();
    void move('b', { kind: 'up' }); // b a c f
    const second = move('c', { kind: 'up' }); // b c a f
    expect(order()).toEqual(['b', 'c', 'a', 'f']);
    await flush();
    expect(posts).toHaveLength(1);
    await posts[0].respond(200, { doc: { id: 'b', parent_id: null, sort_order: 1 }, siblings: [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 2 }, { id: 'c', sort_order: 3 }, { id: 'f', sort_order: 4 }] });
    expect(order()).toEqual(['b', 'c', 'a', 'f']); // 앞 응답이 둘째 이동을 되돌리지 않음
    await flush();
    expect(posts.map((x) => x.body)).toEqual([
      { doc_id: 'b', parent_id: null, after_id: null },
      { doc_id: 'c', parent_id: null, after_id: 'b' },
    ]);
    await posts[1].respond(200, { doc: { id: 'c', parent_id: null, sort_order: 2 }, siblings: [{ id: 'b', sort_order: 1 }, { id: 'c', sort_order: 2 }, { id: 'a', sort_order: 3 }, { id: 'f', sort_order: 4 }] });
    expect(numbers()).toEqual({ a: 3, b: 1, c: 2, f: 4 });
    await expect(second).resolves.toMatchObject({ plan: { ok: true, docId: 'c' }, placed: { position: 2, total: 4 } });
  });

  it('409(낡은 순서): moveFailed 토스트 + 트리 다시 읽기 · null · 줄에 선 뒤 이동은 안 보냄', async () => {
    stubFetch();
    await mount();
    const gets = treeGets;
    const first = move('b', { kind: 'up' });
    const second = move('c', { kind: 'up' });
    await flush();
    await posts[0].respond(409, { error: { code: 'STALE' } });
    await flush();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(posts).toHaveLength(1);
    expect(container.textContent).toContain(koMessages.docs.moveFailed);
    expect(treeGets).toBe(gets + 1);
    expect(order()).toEqual(['a', 'b', 'c', 'f']); // 서버 트리로 돌아옴
  });

  it('500도 같은 길(moveFailed + 다시 읽기)', async () => {
    stubFetch();
    await mount();
    const gets = treeGets;
    const p = move('a', { kind: 'down' });
    await flush();
    await posts[0].respond(500, {});
    await expect(p).resolves.toBeNull();
    expect(container.textContent).toContain(koMessages.docs.moveFailed);
    expect(treeGets).toBe(gets + 1);
  });

  it('옮길 수 없는 계획(맨 위에서 위로)은 POST 0 · 화면 그대로 · 거부 plan을 돌려줌', async () => {
    stubFetch();
    await mount();
    const p = move('a', { kind: 'up' });
    await flush();
    await expect(p).resolves.toEqual({ plan: { ok: false, reason: 'boundary' }, placed: null });
    expect(posts).toHaveLength(0);
    expect(order()).toEqual(['a', 'b', 'c', 'f']);
  });

  it('자리 N은 응답의 새 부모 형제 전부로 센다 — 불러온 4개가 아니라 서버가 준 7개', async () => {
    stubFetch(true);
    await mount();
    const p = move('c', { kind: 'up' });
    await flush();
    await posts[0].respond(200, { doc: { id: 'c', parent_id: null, sort_order: 2 }, siblings: [
      { id: 'a', sort_order: 1 }, { id: 'c', sort_order: 2 }, { id: 'b', sort_order: 3 }, { id: 'f', sort_order: 4 },
      { id: 'u1', sort_order: 5 }, { id: 'u2', sort_order: 6 }, { id: 'u3', sort_order: 7 },
    ] });
    await expect(p).resolves.toMatchObject({ placed: { position: 2, total: 7 } });
  });

  // 까디르 #4730 필수 — 폴더로 옮기기가 서버에서 순환(400)으로 거부되면: moveFailed + 다시 읽기 → 낙관으로 폴더 안에 넣었던 행이 원래 부모 자리로.
  it('폴더로 → 400(순환): moveFailed 토스트 + 트리 다시 읽기 · 폴더 안에 넣었던 행이 원래 부모(맨 위)로 돌아옴 · null', async () => {
    stubFetch();
    await mount();
    const gets = treeGets;
    const p = move('a', { kind: 'into', parentId: 'f' });
    expect(order('f')).toEqual(['a']);
    expect(order()).toEqual(['b', 'c', 'f']);
    await flush();
    expect(posts[0].body).toEqual({ doc_id: 'a', parent_id: 'f' });
    await posts[0].respond(400, { error: { code: 'CIRCULAR_MOVE' } });
    await flush();
    await expect(p).resolves.toBeNull();
    expect(container.textContent).toContain(koMessages.docs.moveFailed);
    expect(treeGets).toBe(gets + 1);
    expect(order('f')).toEqual([]);
    expect(order()).toEqual(['a', 'b', 'c', 'f']);
  });

  // 까디르 #4730 P3 — 저장 중에 태그를 바꾸면, 실패 뒤 다시 읽기는 **지금** 태그로(시작 때 태그 [] 아님).
  it('저장 중 태그를 고름 → 실패 → 다시 읽기 요청에 지금 태그(tags=alpha)', async () => {
    stubFetch(false, TREE.map((d) => (d.id === 'b' ? { ...d, tags: ['alpha'] } : d)));
    await mount();
    const p = move('b', { kind: 'up' });
    await flush();
    const filterToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.docs.tagFilter)!;
    await act(async () => { filterToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '#alpha')!;
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const before = getUrls.length;
    await posts[0].respond(409, { error: { code: 'STALE' } });
    await flush();
    await expect(p).resolves.toBeNull();
    expect(getUrls.length).toBe(before + 1);
    expect(new URL(getUrls.at(-1)!, 'http://x').searchParams.get('tags')).toBe('alpha');
  });
});
