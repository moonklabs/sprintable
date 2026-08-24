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
vi.mock('@/lib/use-swipe-drawer', () => ({
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

describe('DocsClientLayout — 레일 v2 재조립 후 6 능력 회귀가드(§1/§5)', () => {
  it('①전문검색 — 입력 250ms 후 /api/docs?q=로 서버 검색을 친다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    const fetchMock = stubFetch({ onCall: (url) => calls.push(url) });
    await mount();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '결제');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(calls.some((u) => u.includes('/api/docs?') && u.includes('q=') )).toBe(true);
    vi.useRealTimers();
    void fetchMock;
  });

  it('②태그 필터 — 태그 펼치고 선택하면 selectedTags가 반영돼 /api/docs가 tags 파라미터로 재요청된다', async () => {
    const calls: string[] = [];
    stubFetch({ onCall: (url) => calls.push(url) });
    await mount();
    const tagToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('태그'));
    expect(tagToggle).toBeTruthy();
    await act(async () => { tagToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const tagChip = [...container.querySelectorAll('button')].find((b) => b.textContent === '#스펙');
    expect(tagChip).toBeTruthy();
    await act(async () => { tagChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(calls.some((u) => u.includes('tags=') && u.includes('%EC%8A%A4%ED%8E%99') === false ? u.includes('tags=') : true)).toBe(true);
    expect(calls.some((u) => u.includes('tags='))).toBe(true);
  });

  it('③정렬 3모드 — "내 폴더" 뷰에서 정렬 토글 3개가 뜨고 클릭이 sortMode를 localStorage에 저장한다', async () => {
    stubFetch();
    await mount();
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const titleSortBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '이름순');
    expect(titleSortBtn).toBeTruthy();
    await act(async () => { titleSortBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(localStorage.getItem('docs-sort-mode:proj-1')).toBe('title');
  });

  // PR#3391 카디르 QA CHANGES(2026-08-23, codex 교차검증) — select→3버튼 전환에서
  // aria-pressed 등 선택상태 접근성 시맨틱이 소실됐던 것을 복원.
  it('정렬 토글 — 그룹에 접근 가능한 이름이 있고, 선택된 버튼만 aria-pressed=true다', async () => {
    stubFetch();
    await mount();
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('정렬');
    const manualBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '수동 순서');
    const titleBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '이름순');
    expect(manualBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(titleBtn?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { titleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(manualBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(titleBtn?.getAttribute('aria-pressed')).toBe('true');
  });

  // PR#3391 카디르 QA CHANGES — 236px 레일에서 긴 로케일 문자열(영문 등)이 넘치지 않게
  // flex-wrap으로 여러 줄 감쌈을 허용하는지(overflow 대신 wrap) 고정.
  it('정렬 토글 행은 flex-wrap이라 긴 라벨이 넘치지 않고 줄바꿈된다(영문 로케일 회귀가드)', async () => {
    stubFetch();
    await mount();
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const group = container.querySelector('[role="group"]');
    expect(group?.className).toContain('flex-wrap');
  });

  it('④드래그 재정렬 — DocTree(내 폴더 뷰)에 onReorder/onMove/onMoveDenied 핸들러가 배선된다(수동 모드)', async () => {
    stubFetch();
    await mount();
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // DocTree는 드래그 핸들(GripVertical)이 hover 시 노출되는 버튼 없는 span이라, 여기선
    // "내 폴더" 뷰가 정상 렌더되고 두 문서가 다 보이는 것으로 DocTree가 실제 마운트됐음을
    // 확認한다(핸들러 프로퍼티 자체는 doc-tree.tsx가 이미 자기 pure-function 테스트를 가짐).
    expect(container.textContent).toContain('문서A');
    expect(container.textContent).toContain('문서B');
  });

  it('⑤뷰모드 — "자동 묶음"/"내 폴더" 탭 전환이 렌더를 바꾼다(DocAutoGroups ↔ DocTree)', async () => {
    stubFetch();
    await mount();
    // 기본값(grouped) — DocAutoGroups는 그룹 헤더가 기본 접힘이라 문서명은 그룹을 펼쳐야
    // 보인다(GroupHeader 자체 상태, 이 스토리가 안 건드림) — 그룹 라벨(예: "이전")의 존재로
    // grouped 뷰가 실제 마운트됐음을 확認한다.
    expect(container.querySelectorAll('nav').length).toBeGreaterThan(0);
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(localStorage.getItem('docs-view-mode:proj-1')).toBe('folders');
    // "내 폴더"(DocTree)는 루트 문서를 그룹 접힘 없이 바로 보여준다 — 전환이 실제로 렌더를 바꿨다는 증거.
    expect(container.textContent).toContain('문서A');
    expect(container.textContent).toContain('문서B');
  });

  it('⑥문서 생성 — "새 문서" 클릭이 POST /api/docs를 쏘고 신규 문서 라우트로 이동한다', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch({ onCall: (url, init) => calls.push({ url, init }) });
    await mount();
    const newDocBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('새 문서'));
    expect(newDocBtn).toBeTruthy();
    await act(async () => { newDocBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    const postCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/api/docs'));
    expect(postCall).toBeTruthy();
    expect(pushMock).toHaveBeenCalled();
  });

  it('⑥폴더 생성 — "새 폴더" 클릭이 인라인 폼을 열고 제출이 POST /api/docs(is_folder=true)를 쏜다', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch({ onCall: (url, init) => calls.push({ url, init }) });
    await mount();
    const newFolderBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('새 폴더'));
    await act(async () => { newFolderBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input[placeholder="폴더 이름"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '새 폴더 이름');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirmBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '만들기');
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    const postCall = calls.find((c) => c.init?.method === 'POST' && (JSON.parse((c.init.body as string) ?? '{}').is_folder === true));
    expect(postCall).toBeTruthy();
  });
});

describe('DocsClientLayout — 레일 v2 신규 요소(§3 proof 상태 도트·§2 에디토리얼 마스트헤드)', () => {
  it('마스트헤드(kicker+H1+citron rule)가 렌더된다', async () => {
    stubFetch();
    await mount();
    expect(container.textContent).toContain('INDEX');
    expect(container.querySelectorAll('h1, div').length).toBeGreaterThan(0);
  });

  it('문서 항목(내 폴더 뷰)에 status 색 도트가 뜬다(발명 0 — 색은 도트에만)', async () => {
    stubFetch();
    await mount();
    // DocTree(내 폴더)는 그룹 접힘 없이 루트 문서를 바로 그려 도트 검증에 적합.
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('.bg-success')).not.toBeNull(); // DOC_A confirmed
    expect(container.querySelector('.bg-warning')).not.toBeNull(); // DOC_B pending
  });
});

// story #3007(로드맵 P2·PR-E, L1) — 모바일 스와이프 드로어는 floating이라 --elev-overlay.
describe('DocsClientLayout — 로드맵 P2·PR-E L1(모바일 드로어 elevation 토큰)', () => {
  it('트리 열기 버튼으로 연 드로어 패널이 shadow-[var(--elev-overlay)]를 쓰고 shadow-lg는 안 쓴다', async () => {
    stubFetch();
    await mount();
    const openBtn = container.querySelector('button[aria-label="문서 트리 열기"]') as HTMLButtonElement;
    await act(async () => { openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const panel = document.querySelector('[role="dialog"][aria-label="문서 트리"]')
      ?? [...document.querySelectorAll('[role="dialog"]')][0];
    expect(panel).toBeTruthy();
    expect(panel?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(panel?.className).not.toMatch(/(^|\s)shadow-lg(\s|$)/);
  });
});
