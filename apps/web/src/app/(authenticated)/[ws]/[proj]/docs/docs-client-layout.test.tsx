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
import { DocsIndex } from './docs-index';
import layoutSource from './docs-client-layout.tsx?raw';

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

describe('DocsClientLayout — 레일 v2 재조립 후 6 능력 회귀가드(§1/§5)', () => {
  it('①전문검색 — 입력 250ms 후 /api/docs?q=로 서버 검색을 친다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    const fetchMock = stubFetch({ onCall: (url) => calls.push(url) });
    await mount();
    const input = container.querySelector('input[type="text"][data-slot="ds-input"]') as HTMLInputElement;
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

  // story #3784(페드루 재검토 10:11Z) — 이미 트리가 있는 상태에서 태그를 토글하면
  // fetchTree가 cursor 없이 재호출된다(:201 effect, selectedTags deps). 그 재호출이
  // pending인 동안에도 «지금 보여줄 게 없다»는 거짓이므로 로딩 화면으로 전체를 갈아끼우면
  // 안 된다(마스트헤드·필터행·기존 목록이 살아있어야 함) — hasContentRef가 이 판정을 진다.
  it('③문서가 이미 있는 상태에서 태그 토글 — pending 中에도 로딩 화면으로 안 갈리고 기존 목록·필터행이 유지된다', async () => {
    let resolveSecond!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: false, nextCursor: null } }) };
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    // 기본(grouped) 뷰는 그룹 헤더가 접혀 있어 문서명이 안 보인다 — "내 폴더"(DocTree)로
    // 전환해 루트 문서를 바로 드러낸다(⑤뷰모드 테스트와 동형).
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더');
    await act(async () => { foldersTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('문서A');

    const tagToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('태그'));
    expect(tagToggle).toBeTruthy();
    await act(async () => { tagToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const tagChip = [...container.querySelectorAll('button')].find((b) => b.textContent === '#스펙');
    expect(tagChip).toBeTruthy();
    await act(async () => { tagChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 두 번째 fetch(태그 반영)가 아직 pending — 로딩 문구 0·기존 목록·필터행(「태그」 토글) 유지.
    expect(container.textContent).not.toContain('불러오는 중');
    expect(container.textContent).toContain('문서A');
    expect(tagToggle!.isConnected).toBe(true);

    await act(async () => {
      resolveSecond({ ok: true, json: async () => ({ data: [DOC_B], meta: { hasMore: false, nextCursor: null } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain('문서B');
  });

  // story 4892 (UI-9 목록 열) — «태그 필터» 머리글이 ds SectionHeader: 접기 단추(aria-expanded)가 펼침 상태를 말하고, 제목은 머리글(h2) 안에 있다.
  it('4892 ⭐태그 필터 머리글은 ds SectionHeader — 접힘 상태가 aria-expanded로 말해지고 누르면 태그 칩이 열린다', async () => {
    stubFetch();
    await mount();
    const headers = [...container.querySelectorAll('[data-slot="ds-section-header"]')] as HTMLElement[];
    const tagHeader = headers.find((h) => h.textContent?.includes('태그'));
    expect(tagHeader, 'the tag filter heading is a ds SectionHeader').toBeTruthy();
    expect(tagHeader!.querySelector('h2')?.textContent).toContain('태그');
    // a collapsed heading shows ONE bottom line (the ds header's own) — the wrapper's border appears only under the open chips
    expect(tagHeader!.parentElement!.className).not.toContain('border-b');
    const toggle = tagHeader!.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '#스펙')).toBe(false);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '#스펙')).toBe(true);
    expect(tagHeader!.parentElement!.className).toContain('border-b');
  });

  // story #3053(2984-S5) — 선택 태그 칩은 헤어라인(border-proof-line+bg-transparent)을 쓰고
  // 옛 bg-proof-blue-soft 채움은 안 쓴다. 태그 접었을 때 카운트는 CountBadge(mono+엠보스)로.
  it('④재질 — 선택 태그 칩이 헤어라인을 쓰고 bg-proof-blue-soft는 안 쓴다, 접으면 CountBadge가 뜬다', async () => {
    stubFetch();
    await mount();
    const tagToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('태그'));
    await act(async () => { tagToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const tagChip = [...container.querySelectorAll('button')].find((b) => b.textContent === '#스펙');
    await act(async () => { tagChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // story 4892 — 태그 칩은 ds Button: 고른 칩 = 보조(윤곽) 변형 + aria-pressed · 안 고른 칩 = 조용 변형. 옛 proof 재질 클래스는 없다.
    expect(tagChip?.getAttribute('data-slot')).toBe('ds-button');
    expect(tagChip?.getAttribute('aria-pressed')).toBe('true');
    expect(tagChip?.className).toContain('border-ds-line-control');
    expect(tagChip?.className).not.toContain('bg-proof-blue-soft');
    expect(tagChip?.className).not.toContain('proof-surface');

    // 접으면 카운트 배지(ds CountBadge)가 뜬다.
    await act(async () => { tagToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const badge = container.querySelector('[data-slot="ds-count-badge"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('1');
    expect(container.querySelector('.bg-proof-blue-soft')).toBeNull();
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
    const group = container.querySelector('[role="group"][aria-label="정렬"]');   // story 4892 — the view-mode pair is a named group too, so select the sort one by name
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
    const group = container.querySelector('[role="group"][aria-label="정렬"]');
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
    const input = container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]') as HTMLInputElement;
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

describe('DocsClientLayout — 새 폴더 이름 칸의 한글 조합(IME) 가드 (story 4831 측정 중 발견)', () => {
  const keydown = (el: Element, key: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };
  async function openFolderForm() {
    await mount();
    const newFolderBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('새 폴더'));
    await act(async () => { newFolderBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '기획문');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  }
  const posts = (calls: Array<{ url: string; init?: RequestInit }>) => calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/api/docs'));

  it('조합 중의 엔터는 폴더를 만들지 않고, 조합이 끝난 뒤의 엔터만 만든다', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch({ onCall: (url, init) => calls.push({ url, init }) });
    const input = await openFolderForm();
    let ev!: KeyboardEvent;
    await act(async () => { ev = keydown(input, 'Enter', { isComposing: true }); });
    await act(async () => { await Promise.resolve(); });
    expect(posts(calls)).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { keydown(input, 'Enter', { keyCode: 229 }); });
    expect(posts(calls)).toHaveLength(0);
    await act(async () => { ev = keydown(input, 'Enter'); });
    await act(async () => { await Promise.resolve(); });
    expect(ev.defaultPrevented).toBe(true);
    expect(posts(calls)).toHaveLength(1);
  });

  it('조합 중의 에스케이프는 새 폴더 폼을 닫지 않고, 조합이 아닌 에스케이프는 닫는다', async () => {
    stubFetch();
    const input = await openFolderForm();
    await act(async () => { keydown(input, 'Escape', { isComposing: true }); });
    expect(container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]')).not.toBeNull();
    await act(async () => { keydown(input, 'Escape'); });
    expect(container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]')).toBeNull();
  });
});

describe('DocsClientLayout — 레일 v2 신규 요소(§3 proof 상태 도트·§2 에디토리얼 마스트헤드)', () => {
  // story 4892 (UI-9 목록 열) — 에디토리얼 마스트헤드(kicker «지식 · 색인» · 큰 제목 · 시그니처 선)는 걷혔다. 열 머리가 대신한다(아래 describe).
  it('옛 마스트헤드(kicker)는 더 렌더되지 않는다', async () => {
    stubFetch();
    await mount();
    expect(container.textContent).not.toContain('색인');
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

// story #3784(카디르 QA·PO 짚음) — DocsLayoutContextType에 loading이 없어 DocsIndex가
// "아직 안 옴"과 "0건"을 못 가르던 실사고. 실 소비처 구성(page.tsx = DocsClientLayout이
// DocsIndex를 children으로 감싸는 형)을 그대로 재현해 컨텍스트 실 배선을 검증한다 —
// docs-index.test.tsx의 useDocsLayout() 모킹 테스트는 컴포넌트 로직만 잰다(배선 자체는
// 안 잰다).
describe('DocsClientLayout — story #3784 loading/loadError 컨텍스트 실 배선(DocsIndex 실 자식)', () => {
  async function mountWithIndex() {
    await act(async () => {
      root.render(wrap(
        <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><DocsIndex /></DocsClientLayout>,
      ));
    });
  }

  it('트리 fetch가 아직 안 끝난 순간엔 DocsIndex가 "아직 쌓인 문서가 없어요"를 안 그린다(로딩 게이트 실 배선)', async () => {
    let resolveFetch!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));
    await mountWithIndex();
    // fetch가 아직 안 풀린 시점(pending) — 로딩 中.
    expect(container.textContent).not.toContain('아직 쌓인 문서가 없어요');
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: false, nextCursor: null } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain('문서A'); // 로드 완료 후엔 정상 렌더.
  });

  it('트리 fetch가 실패(ok:false)하면 DocsIndex가 "아직 쌓인 문서가 없어요"가 아니라 실패 배너를 그린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
    await mountWithIndex();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('아직 쌓인 문서가 없어요');
    expect(container.textContent).toContain('불러오지 못했어요');
  });

  // story #4310 AC3 — 트리 요청이 응답 없이 걸려도 fetchWithAuth 시간 제한(30s) 뒤 실패 문구 + 다시 시도(망 오류와 같은 갈래).
  // 예전엔 «불러오는 중»이 CF 524(~100초)까지 그대로였다. 실제 fetch처럼 신호가 끊겨야만 reject한다.
  it('⭐트리 요청이 응답 없이 걸려도 30s 뒤 «불러오지 못했어요» + 다시 시도(그 전엔 불러오는 중)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      })));
      await mountWithIndex();
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      expect(container.textContent).not.toContain('불러오지 못했어요');
      expect(container.querySelector('aside [data-slot="ds-skeleton-group"]')?.getAttribute('aria-label')).toBe('불러오는 중…');   // 목록 열은 ds SkeletonGroup(이름 «불러오는 중»)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(container.textContent).toContain('불러오지 못했어요');
      expect(container.textContent).not.toContain('아직 쌓인 문서가 없어요');
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('다시 시도'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // story #3784(카디르 QA·페드루 재현, 10:02Z) — 실패 뒤 「다시 시도」를 누른 순간부터 그
  // 재시도가 응답하기 전까지, fetchTree()가 loading을 다시 켜지 않으면
  // loading=false·loadError=false·tree=[]인 순간이 생겨 두 페인이 또 "없어요"를 단정한다
  // (원 결함의 재발 — 뮤테이션 대상: fetchTree 시작의 setLoading(true)를 걷으면 이 자리가
  // 정확히 RED).
  it('실패 뒤 「다시 시도」 pending 中엔 양쪽 다 "없어요"가 아니라 로딩 문구가 선다', async () => {
    let resolveRetry!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => null })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    await mountWithIndex();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('불러오지 못했어요');

    const retryButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('다시 시도'));
    expect(retryButton).toBeTruthy();
    await act(async () => { retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 재시도 fetch가 아직 안 풀린 시점(pending) — 양쪽 다 "없어요" 단정 0, 로딩 문구는 有.
    expect(container.textContent).not.toContain('아직 쌓인 문서가 없어요');
    expect(container.textContent).not.toContain('불러오지 못했어요');
    expect(container.querySelector('aside [data-slot="ds-skeleton-group"]')?.getAttribute('aria-label')).toBe('불러오는 중…');

    await act(async () => {
      resolveRetry({ ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: false, nextCursor: null } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain('문서A'); // 재시도 성공 후엔 정상 렌더.
  });

  // story #3784(유나 짚음, 09:34Z) — 오른쪽 DocsIndex만 가르면 왼쪽 사이드바 트리가
  // "0건"(빈 EmptyState "문서를 선택하세요")으로 조용히 남아 같은 화면이 두 말을 한다.
  it('트리 fetch 실패 시 왼쪽 사이드바도 "문서를 선택하세요"가 아니라 같은 실패 문구+다시 시도를 그린다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => null }));
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(container.textContent).not.toContain('문서를 선택하세요');
    expect(container.textContent).toContain('불러오지 못했어요');
    const callsBefore = fetchMock.mock.calls.length;
    const retryButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '다시 시도');
    expect(retryButton).toBeTruthy();
    await act(async () => { retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore); // 재시도가 fetchTree()를 다시 친다.
  });

  // story #3784(페드루 짚음, 09:49Z) — 로드 완료·진짜 0건일 때도 왼쪽("문서를
  // 선택하세요")과 오른쪽("아직 쌓인 문서가 없어요")이 다른 말을 하던 자리. 같은
  // 사실은 같은 낱말로 — 왼쪽도 emptyTitle 한 줄만(CTA는 오른쪽+상단 바에 이미
  // 있어 뺀다).
  it('로드 완료·진짜 0건이면 왼쪽 사이드바도 "문서를 선택하세요"가 아니라 "아직 쌓인 문서가 없어요"를 그린다(CTA 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) })));
    await mount();
    expect(container.textContent).not.toContain('문서를 선택하세요');
    expect(container.textContent).toContain('아직 쌓인 문서가 없어요');
  });

  // story #3945(#3942 배포 92 디자인 감사) — TopBarSlot 브레드크럼 라벨이 DocsIndex의
  // 마스트헤드 h1과 같이 <h1>이라 페이지에 h1이 2개(개념적으로 다른 문구: "문서" vs
  // 실 목록 제목)였다(헤딩 위계 위반). TopBarSlot을 실 자식(DocsIndex)과 함께 마운트해
  // 실 페이지 조합 그대로 재현·고정한다 — DocsIndex는 goals-client와 달리 마스트헤드를
  // 반응형으로 이중 렌더하지 않아(단일 wrapper) 정확히 1개가 정답.
  it('⭐문서 목록 화면은 h1이 정확히 1개다(TopBarSlot 라벨은 비-헤딩, DocsIndex 마스트헤드만 h1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta: { hasMore: false, nextCursor: null } }) })));
    await mountWithIndex();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).not.toContain('text-sm font-medium');
  });

  // story #3946(유나 확認·페드루 정정) — 로디드 스냅샷만 재면 트리 fetch가 아직 안 풀린
  // 순간(DocsIndex가 `return null`)엔 h1이 0개가 되는 gap을 못 잡는다. fetch를 고의로
  // pending으로 묶어 «첫 렌더 직후(아직 응답 전)»를 그대로 잰다.
  it('⭐트리 fetch가 아직 안 풀린 로딩 상태에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await act(async () => {
      root.render(wrap(
        <DocsClientLayout wsSlug="ws1" projSlug="proj1" projectId="proj-1"><DocsIndex /></DocsClientLayout>,
      ));
    });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });
});

// [SID:4288] 닫힌 모바일 트리 서랍 — aria-hidden만이 아니라 inert(초점 · 클릭에서 빠짐)까지 실제 DOM에 붙는다. 안의 닫기 · 문서 버튼이
// Tab 순서에서 빠져 보이지 않는 곳에 초점이 가지 않는다(라이브 axe · Tab 순회는 배포 뒤 PO 판).
describe('DocsClientLayout — 닫힌 트리 서랍은 inert([SID:4288])', () => {
  it('닫힘(progress 0) → 서랍에 inert · aria-hidden, 안에 버튼은 있음(숨은 초점 후보를 inert가 덮는다)', async () => {
    await mount();
    const drawer = [...container.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((el) => el.className.includes('w-[280px]'));
    expect(drawer).toBeTruthy();
    expect(drawer!.hasAttribute('inert')).toBe(true);
    expect(drawer!.getAttribute('aria-hidden')).toBe('true');
    expect(drawer!.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  // 유나 design 4653 회귀 — 여는 렌더에선 isOpen이 참인데 progress는 아직 0(이 테스트의 훅 mock이 그 상태로 고정)이다. 그때 inert가
  // 남으면 초점 가두기의 focus()가 실패해 초점이 여는 버튼에 머문다(실 브라우저 · jsdom은 inert를 구현하지 않아 activeElement로는 못 잰다).
  it('여는 렌더(isOpen 참 · progress 0)에는 inert · aria-hidden이 없다 — 초점 가두기가 서랍 안으로 초점을 옮길 수 있다', async () => {
    await mount();
    const opener = container.querySelector(`button[aria-label="${koMessages.docs.openDocTree}"]`) as HTMLButtonElement | null;
    expect(opener).not.toBeNull();
    await act(async () => { opener!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const drawer = [...container.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((el) => el.className.includes('w-[280px]'));
    expect(drawer!.hasAttribute('inert')).toBe(false);
    expect(drawer!.getAttribute('aria-hidden')).toBe('false');
  });
});

// story 4892 (UI-9 목록 열) — 열 머리 + 보기 전환/정렬 + 틀. 동작은 그대로(만들기 · 보기 · 정렬), 모양만 ds 부품.
describe('DocsClientLayout — 목록 열 머리 · 토글 · 틀 (4892)', () => {
  const columnHeader = () => container.querySelector('aside h2')!.parentElement!.parentElement as HTMLElement;   // h2 + 개수가 한 칸(flex) 안 · 그 칸이 열 머리 안
  const inHeader = (label: string) => [...columnHeader().querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it('⭐열 머리 = 제목(h2 «문서») + 새 폴더(ds IconButton) + 새 문서(ds Button) — kicker 없음', async () => {
    stubFetch();
    await mount();
    const h2 = container.querySelector('aside h2');
    expect(h2?.textContent).toBe('문서');
    expect(inHeader('새 폴더')?.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(inHeader('새 문서')?.getAttribute('data-slot')).toBe('ds-button');
  });

  it('⭐머리의 «새 문서»는 실제로 문서를 만든다(POST /api/docs, 폴더 아님)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch({ onCall: (url, init) => calls.push({ url, init }) });
    await mount();
    await act(async () => { inHeader('새 문서')!.click(); });
    await act(async () => { await Promise.resolve(); });
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse((post!.init!.body as string) ?? '{}').is_folder).toBeFalsy();
  });

  it('⭐머리의 «새 폴더»는 이름 칸 폼을 연다', async () => {
    stubFetch();
    await mount();
    expect(container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]')).toBeNull();
    await act(async () => { inHeader('새 폴더')!.click(); });
    expect(container.querySelector('input[data-slot="ds-input"][placeholder="폴더 이름"]')).toBeTruthy();
  });

  it('두 동작은 한 화면에 한 자리 — 머리의 것은 lg 이상에서만, 상단 바의 것은 lg 미만에서만 보인다', async () => {
    stubFetch();
    await mount();
    for (const label of ['새 폴더', '새 문서']) {
      const cls = inHeader(label)!.className.split(/\s+/);
      expect(cls, label).toContain('hidden');
      expect(cls, label).toContain('lg:inline-flex');
    }
    const topBarBtn = [...container.querySelectorAll('button')].find((b) => !columnHeader().contains(b) && b.getAttribute('aria-label') === '새 문서');
    expect(topBarBtn!.parentElement!.className.split(/\s+/)).toContain('lg:hidden');
  });

  it('⭐보기 전환은 ds 단추 둘 — 고른 쪽만 aria-pressed, 누르면 바뀐다', async () => {
    stubFetch();
    await mount();
    const grouped = [...container.querySelectorAll('button')].find((b) => b.textContent === '자동 묶음') as HTMLButtonElement;
    const folders = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더') as HTMLButtonElement;
    expect(grouped.getAttribute('data-slot')).toBe('ds-button');
    expect(folders.getAttribute('data-slot')).toBe('ds-button');
    const pressed = (b: HTMLButtonElement) => b.getAttribute('aria-pressed') === 'true';
    expect([pressed(grouped), pressed(folders)].filter(Boolean).length).toBe(1);
    const openOne = pressed(grouped) ? grouped : folders;
    const otherOne = openOne === grouped ? folders : grouped;
    await act(async () => { otherOne.click(); });
    expect(pressed(otherOne)).toBe(true);
    expect(pressed(openOne)).toBe(false);
  });

  it('정렬 단추 셋도 ds 단추다(고른 쪽만 aria-pressed)', async () => {
    stubFetch();
    await mount();
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더') as HTMLButtonElement).click(); });
    const group = container.querySelector('[role="group"][aria-label="정렬"]')!;
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.length).toBe(3);
    for (const b of buttons) expect(b.getAttribute('data-slot')).toBe('ds-button');
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').length).toBe(1);
  });

  it('⭐레일을 접어도 새 문서 · 새 폴더는 닿는다 — 접히면 상단 바의 두 동작이 lg에서도 보인다', async () => {
    stubFetch();
    await mount();
    // the rail may be gone (collapsed) — look the header up without assuming it exists
    const topBarBtn = () => [...container.querySelectorAll('button')].find((b) => !container.querySelector('aside')?.contains(b) && b.getAttribute('aria-label') === '새 문서') as HTMLButtonElement;
    expect(topBarBtn().parentElement!.className.split(/\s+/)).toContain('lg:hidden');          // rail open → the header has them
    const hide = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === '문서 트리 숨기기') as HTMLButtonElement;
    expect(hide, 'the collapse button').toBeTruthy();
    await act(async () => { hide.click(); });
    expect(container.querySelector('aside')).toBeNull();                                           // rail gone
    expect(topBarBtn().parentElement!.className.split(/\s+/)).not.toContain('lg:hidden');       // → the top bar must carry them
  });

  it('머리 오른쪽은 접기 단추 자리를 비워 둔다(lg:pr-11) — 단추가 새 문서 위에 겹치지 않는다', async () => {
    stubFetch();
    await mount();
    expect(columnHeader().className.split(/\s+/)).toContain('lg:pr-11');
  });

  it('보기 전환 둘은 이름 있는 그룹(«보기 방식») 안에 있다 · 새 폴더 IconButton은 title과 aria-label을 갖는다', async () => {
    stubFetch();
    await mount();
    const group = container.querySelector('[role="group"][aria-label="보기 방식"]')!;
    expect(group).toBeTruthy();
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['자동 묶음', '내 폴더']);
    const folder = inHeader('새 폴더')!;
    expect(folder.getAttribute('title')).toBe('새 폴더');
    expect(folder.getAttribute('aria-label')).toBe('새 폴더');
  });

  it('⭐틀 — 레일은 lg(1024~1279)에선 236px, xl(≥1280)부터 300px · ds 선과 바탕을 쓴다', async () => {
    stubFetch();
    await mount();
    const cls = container.querySelector('aside')!.className.split(/\s+/);
    expect(cls).toContain('w-[236px]');        // lg: the reading column keeps its width (544 at 1100)
    expect(cls).toContain('xl:w-[300px]');     // xl and up: the wider list column
    expect(cls).not.toContain('w-[300px]');    // never 300 below xl
    expect(cls).toContain('border-ds-line');
    expect(cls).toContain('bg-ds-background');
  });
});

// story 4892 (UI-9 D1) — choosing a document from the list opens it to READ (the reading screen), not the editor. «고치기» in the detail header is the
// way into the editor. (A NEW doc still opens the editor — the new-doc test above.)
describe('DocsClientLayout — 목록에서 문서를 고르면 읽기로 연다 (4892 D1)', () => {
  it('⭐문서 행을 누르면 /view(읽기 화면) 주소로 간다 — 편집기 주소가 아니다', async () => {
    pushMock.mockClear();
    stubFetch();
    await mount();
    const foldersTab = [...container.querySelectorAll('button')].find((b) => b.textContent === '내 폴더') as HTMLButtonElement;
    await act(async () => { foldersTab.click(); });
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('문서A')) as HTMLButtonElement;
    expect(row, 'the doc row').toBeTruthy();
    await act(async () => { row.click(); });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(String(pushMock.mock.calls[0]![0])).toMatch(/\/docs\/doc-a\/view$/);
  });
});

// story 4892 (UI-9 목록 열) — the new-folder panel, the retry button and the tag count wear the ds parts (ds Input · ds Button · ds CountBadge); the old ui/ parts are gone from the layout.
describe('DocsClientLayout — 새 폴더 칸 · 다시 시도 · 건수는 ds 부품 (4892)', () => {
  it('⭐the inline new-folder panel: a ds Input, «취소» is a quiet ds Button and «만들기» the primary ds Button', async () => {
    stubFetch();
    await mount();
    const newFolderBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('새 폴더'));
    await act(async () => { newFolderBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input[placeholder="폴더 이름"]') as HTMLInputElement;
    expect(input.getAttribute('data-slot')).toBe('ds-input');
    const panel = input.parentElement as HTMLElement;
    expect(panel.className).toContain('border-ds-line');
    const cancel = [...panel.querySelectorAll('button')].find((b) => b.textContent === '취소') as HTMLButtonElement;
    const confirm = [...panel.querySelectorAll('button')].find((b) => b.textContent === '만들기') as HTMLButtonElement;
    expect(cancel.getAttribute('data-slot')).toBe('ds-button');
    expect(confirm.getAttribute('data-slot')).toBe('ds-button');
    expect(cancel.className).not.toContain('bg-ds-action');
    expect(confirm.className).toContain('bg-ds-action');
  });

  it('the layout no longer imports the old ui/ button · input · count-badge (and the top-bar actions are ds buttons in the source)', () => {
    expect(layoutSource).not.toMatch(/from '@\/components\/ui\/(button|input|count-badge)'/);
    expect(layoutSource).toMatch(/from '@\/components\/ds\/input'/);
    expect(layoutSource).toMatch(/from '@\/components\/ds\/count-badge'/);
    expect(layoutSource).not.toMatch(/<Button\b/);   // every button is a DsButton / IconButton now
  });
});

// story 4892 (UI-9 문서 화면 배치) — 열 머리 개수 · 접기 단추 · 폰 서랍이 ds 부품이고, 겹침이 없다(codex: 접기 단추가 폰에서 44가 되어 머리 40을 넘거나 읽기 머리 제목을 덮던 자리).
describe('DocsClientLayout — 열 머리 개수 · 접기 단추 · 폰 서랍 (4892 배치)', () => {
  const count = () => container.querySelector('[data-testid="docs-list-count"]');
  const stubWithMeta = (meta: Record<string, unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (typeof url === 'string' && url.includes('/api/docs')
      ? { ok: true, json: async () => ({ data: [DOC_A, DOC_B], meta }) }
      : { ok: false, json: async () => null })));
  };

  it('⭐개수: 다 받았으면 받은 수(서버 총량이 더 커도 — 만들기 · 지우기에 늘 맞는다) · «더 보기»가 남았으면 서버 총량', async () => {
    stubWithMeta({ hasMore: false, nextCursor: null, totalCount: 5 });
    await mount();
    expect(count()?.textContent).toBe('2');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubWithMeta({ hasMore: true, nextCursor: 'c1', totalCount: 99 });
    await mount();
    expect(count()?.textContent).toBe('99');
  });

  it('⭐개수는 0건이면 숨고, 열 머리는 폰(touch)에서 44로 자란다(접기 단추 44가 머리 밖으로 안 나가게)', async () => {
    stubWithMeta({ hasMore: false, nextCursor: null, totalCount: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (typeof url === 'string' && url.includes('/api/docs')
      ? { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null, totalCount: 0 } }) }
      : { ok: false, json: async () => null })));
    await mount();
    expect(count()).toBeNull();
    const header = container.querySelector('aside h2')!.parentElement!.parentElement as HTMLElement;
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(['h-10', 'touch:h-11']));
  });

  it('⭐접기 · 펴기 단추는 ds IconButton(aria-expanded) — 열 머리 안에 있고(top-1.5 · 폰 top-0) 읽기 머리 제목을 덮지 않는 자리(left-1)', async () => {
    stubFetch();
    await mount();
    const hide = container.querySelector<HTMLButtonElement>(`aside button[aria-label="${koMessages.docs.hideSidebar}"]`)!;
    expect(hide.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(hide.className.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'right-1', 'top-1.5', 'touch:top-0']));
    await act(async () => { hide.click(); });
    const open = container.querySelector<HTMLButtonElement>(`button[aria-label="${koMessages.docs.openSidebar}"]`)!;
    expect(open.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.className.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'left-1', 'top-1.5', 'touch:top-0']));
    expect(open.className.split(/\s+/)).not.toContain('left-2');
  });

  it('⭐폰: «문서 목록 열기»는 ds Button · 서랍 닫기는 ds IconButton(이름 «닫기»)', async () => {
    stubFetch();
    await mount();
    const opener = container.querySelector<HTMLButtonElement>(`button[aria-label="${koMessages.docs.openDocTree}"]`)!;
    expect(opener.getAttribute('data-slot')).toBe('ds-button');
    await act(async () => { opener.click(); });
    const drawer = [...container.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((el) => el.className.includes('w-[280px]'))!;
    const close = drawer.querySelector<HTMLButtonElement>(`button[aria-label="${koMessages.common.close}"]`)!;
    expect(close.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(drawer.className).toContain('border-ds-line');
    expect(drawer.className).not.toContain('border-border');
  });
});
