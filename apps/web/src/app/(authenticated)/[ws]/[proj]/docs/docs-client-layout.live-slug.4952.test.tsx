// @vitest-environment jsdom
//
// 4952 D1 — the editor tells the layout which doc is open after the first save moved the address WITHOUT a navigation (route params keep the old name).
// story #2963(doc docs-nav-rail-v2-editorial-handoff §1/§5) — 공유 네비 레일 에디토리얼
// 승격. 최상위 제약: 기존 6 능력(전문검색·태그 필터·정렬 3모드·드래그 재정렬·뷰모드·
// 문서/폴더 생성) 무손실 — done 게이트 = 이 6개 회귀 테스트 0. 형태(class)만 바뀌었으니
// state·API 호출·핸들러가 이전과 동일하게 발화하는지만 고정한다(픽셀 단위 스타일은
// design:pass 몫).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { DocsClientLayout } from './docs-client-layout';
import { useDocsLayout } from './docs-context';

const { pushMock, paramsMock } = vi.hoisted(() => ({ pushMock: vi.fn(), paramsMock: { current: {} as Record<string, string> } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => paramsMock.current,
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const DOC_A = { id: 'd1', parent_id: null, title: '문서A', slug: 'doc-a', icon: null, sort_order: 0, is_folder: false, status: 'confirmed', updated_at: '2026-08-20T00:00:00Z' };
const DOC_B = { id: 'd2', parent_id: null, title: '문서B', slug: 'doc-b', icon: null, sort_order: 1, is_folder: false, status: 'pending', updated_at: '2026-08-21T00:00:00Z', tags: ['스펙'] };

function stubFetch(overrides?: { onCall?: (url: string, init?: RequestInit) => void }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    overrides?.onCall?.(url, init);
    if (typeof url === 'string' && url.includes('/api/docs') && init?.method === 'POST') {
      const body = JSON.parse((init.body as string) ?? '{}');
      return { ok: true, json: async () => ({ data: { id: 'new-1', title: body.title, slug: body.slug, parent_id: body.parent_id, sort_order: 0, is_folder: !!body.is_folder, updated_at: '2026-08-23T00:00:00Z' } }) };
    }
    if (typeof url === 'string' && url.includes('/api/docs')) {
      return { ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: false, nextCursor: null } }) };
    }
    return { ok: false, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// story #2059 관례(kanban-board.test.tsx) — 이 프로젝트 jsdom 환경은 ambient localStorage를
// 안 준다(Node 실험적 localStorage가 --localstorage-file 없이는 undefined) — 매 테스트
// 인메모리 폴리필을 직접 건다.
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



const holder: { report?: (slug: string) => void } = {};
function Reporter() { const { reportLiveSlug } = useDocsLayout(); useEffect(() => { holder.report = reportLiveSlug; }); return <div>본문</div>; }
const rerender = async () => {
  await act(async () => { root.render(wrap(<DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><Reporter /></DocsClientLayout>)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
};
const openFolders = async () => {
  const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
  await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};
const current = () => [...container.querySelectorAll('[aria-current="page"]')].map((e) => (e.textContent ?? '').trim());

describe('DocsClientLayout — 편집기가 알린 «지금 열린 문서»(4952 D1)', () => {
  it('⭐라우트 params는 옛 이름(doc-a)인데 편집기가 doc-b라고 알리면 트리 강조가 문서B로 간다', async () => {
    stubFetch();
    paramsMock.current = { slug: 'doc-a' };
    await rerender(); await openFolders();
    expect(current().some((t) => t.includes('문서A'))).toBe(true);
    await act(async () => { holder.report!('doc-b'); });
    expect(current().some((t) => t.includes('문서B'))).toBe(true);
    expect(current().some((t) => t.includes('문서A'))).toBe(false);
  });

  it('⭐알림은 그 라우트에서만 쓴다 — 다른 라우트로 갔다가 같은 이름(doc-a)으로 돌아오면 옛 알림(doc-b)이 되살아나지 않는다', async () => {
    stubFetch();
    paramsMock.current = { slug: 'doc-a' };
    await rerender(); await openFolders();
    await act(async () => { holder.report!('doc-b'); });
    paramsMock.current = { slug: 'doc-x' }; // 다른 문서로 이동
    await rerender();
    paramsMock.current = { slug: 'doc-a' }; // 같은 이름의 문서로 돌아옴(옛 문서는 이름을 doc-b로 바꿨고 doc-a는 이제 다른 문서일 수 있다)
    await rerender();
    expect(current().some((t) => t.includes('문서A'))).toBe(true);
    expect(current().some((t) => t.includes('문서B'))).toBe(false);
  });
});
