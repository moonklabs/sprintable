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
    expect(container.textContent).not.toContain('개 표시 중');
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
    expect(container.textContent).toContain('3개 중 2개 표시 중');
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기');
    expect(more).toBeTruthy();
    await act(async () => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const next = new URL(calls.at(-1)!, 'http://t').searchParams;
    expect(next.get('cursor')).toBe('cur-1');
    expect(next.get('tree')).toBe('true');
    expect(container.textContent).toContain('문서C');
    expect(container.textContent).not.toContain('개 표시 중');
  });
});

// story #4385 — «더 보기»가 «폴더 보기»에만 있었다(viewMode === 'folders' && docsHasMore · develop부터). 기본인 «묶음 보기»에서는
// 서버가 has_more를 줘도 나머지를 받을 수단이 없었다(상한 5,000을 넘는 프로젝트만 닿음 · 오늘 dev 0곳). 두 보기 모두 같은 줄 · 같은 버튼.
// 상한은 목 응답의 hasMore로 주입한다(상한 = 2개).
describe('DocsClientLayout — «묶음 보기»에서도 나머지를 이어 받는다(story #4385)', () => {
  const DOC_C = { ...DOC_A, id: 'd3', title: '문서C', slug: 'doc-c', sort_order: 2 };
  function capped(calls: string[], first = [DOC_A, DOC_B]) {
    return vi.fn(async (url: string) => {
      calls.push(url);
      if (!url.startsWith('/api/docs?') || url.includes('q=')) return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      const cursor = new URL(url, 'http://t').searchParams.get('cursor');
      return cursor
        ? { ok: true, json: async () => ({ data: [DOC_C], meta: { hasMore: false, nextCursor: null, totalCount: 3 } }) }
        : { ok: true, json: async () => ({ data: first, meta: { hasMore: true, nextCursor: 'cur-1', totalCount: 3 } }) };
    });
  }
  const moreButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기');

  it('묶음 보기(기본): «받은 수 / 총량» + 더 보기 → 커서 · tree=true로 이어 받고 붙인다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', capped(calls));
    await mount();
    expect(container.textContent).toContain('3개 중 2개 표시 중');
    expect(moreButton()).toBeTruthy();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const next = new URL(calls.filter((u) => u.startsWith('/api/docs?') && !u.includes('q=')).at(-1)!, 'http://t').searchParams;
    expect(next.get('cursor')).toBe('cur-1');
    expect(next.get('tree')).toBe('true');
    expect(container.textContent).not.toContain('개 표시 중');
    expect(moreButton()).toBeFalsy();
  });

  it('묶음 보기 + 태그 필터: 이어 받기 요청에 고른 태그가 실린다', async () => {
    const calls: string[] = [];
    const TAGGED_A = { ...DOC_A, tags: ['spec'] };
    vi.stubGlobal('fetch', capped(calls, [TAGGED_A, DOC_B]));
    await mount();
    const tagToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.docs.tagFilter));
    await act(async () => { tagToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const chip = [...container.querySelectorAll('button')].find((b) => b.textContent === '#spec');
    await act(async () => { chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(moreButton()).toBeTruthy();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const next = new URL(calls.filter((u) => u.startsWith('/api/docs?') && !u.includes('q=')).at(-1)!, 'http://t').searchParams;
    expect(next.get('cursor')).toBe('cur-1');
    expect(next.get('tags')).toBe('spec');
  });

  it('상한 이하(hasMore false)면 묶음 보기에도 줄 · 버튼 0 — 지금 화면 그대로', async () => {
    const calls: string[] = [];
    stubFetch({ onCall: (url) => calls.push(url) });
    await mount();
    // 묶음 보기는 묶음을 접은 채 그려 문서 제목이 곧바로 안 보인다 — 트리 요청이 실제로 나갔는지부터 본다(빈 판정 방지).
    expect(calls.some((u) => u.startsWith('/api/docs?') && new URL(u, 'http://t').searchParams.get('tree') === 'true')).toBe(true);
    expect(moreButton()).toBeFalsy();
    expect(container.textContent).not.toContain('개 표시 중');
  });
});

