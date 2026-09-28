// @vitest-environment jsdom
//
// story #2963(doc docs-nav-rail-v2-editorial-handoff §1/§5) — 공유 네비 레일 에디토리얼
// 승격. 최상위 제약: 기존 6 능력(전문검색·태그 필터·정렬 3모드·드래그 재정렬·뷰모드·
// 문서/폴더 생성) 무손실 — done 게이트 = 이 6개 회귀 테스트 0. 형태(class)만 바뀌었으니
// state·API 호출·핸들러가 이전과 동일하게 발화하는지만 고정한다(픽셀 단위 스타일은
// design:pass 몫).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { DocsClientLayout } from './docs-client-layout';

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

async function mount() {
  await act(async () => {
    root.render(wrap(
      <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><div>본문</div></DocsClientLayout>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

// story #4376 — 사이드바 트리는 한 번에(tree=true) + 총량. 예전엔 층 구분 없는 평면 목록을 20개씩 받아(limit=20) 방금 만든
// 문서 · 폴더가 뒤 쪽에 떨어지면 새로고침 뒤 트리에서 사라졌다. 상한을 넘는 프로젝트만 «받은 수 / 총량» + 더 보기.
describe('DocsClientLayout — 문서 트리는 한 번에 받는다(story #4376)', () => {
  async function openFolders() {
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  it('첫 트리 요청은 tree=true · limit 없음(20개씩 받지 않는다)', async () => {
    const calls: string[] = [];
    stubFetch({ onCall: (url) => calls.push(url) });
    await mount();
    const treeCall = calls.find((u) => u.startsWith('/api/docs?') && !u.includes('q='));
    expect(treeCall).toBeTruthy();
    const params = new URL(treeCall!, 'http://t').searchParams;
    expect(params.get('tree')).toBe('true');
    expect(params.get('project_id')).toBe('proj-1');
    expect(params.has('limit')).toBe(false);
  });

  it('다 왔으면(hasMore false) 더 보기 · 총량 줄이 없다', async () => {
    stubFetch();
    await mount();
    await openFolders();
    expect(container.textContent).toContain('문서A');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '더 보기')).toBe(false);
    expect(container.textContent).not.toContain('개 중 ');
  });

  it('상한을 넘는 프로젝트: «받은 수 / 총량» + 더 보기 → 커서와 tree=true로 이어 받고 붙인다', async () => {
    const calls: string[] = [];
    const DOC_C = { ...DOC_A, id: 'd3', title: '문서C', slug: 'doc-c', sort_order: 2 };
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      const cursor = new URL(url, 'http://t').searchParams.get('cursor');
      return cursor
        ? { ok: true, json: async () => ({ data: [DOC_C], meta: { hasMore: false, nextCursor: null, totalCount: 3 } }) }
        : { ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: true, nextCursor: 'cur-1', totalCount: 3 } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    await openFolders();
    expect(container.textContent).toContain('전체 3개 중 2개');
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기');
    expect(more).toBeTruthy();
    await act(async () => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const next = new URL(calls.at(-1)!, 'http://t').searchParams;
    expect(next.get('cursor')).toBe('cur-1');
    expect(next.get('tree')).toBe('true');
    expect(container.textContent).toContain('문서C');
    expect(container.textContent).not.toContain('전체 3개 중');
  });
});
