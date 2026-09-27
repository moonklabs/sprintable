// @vitest-environment jsdom
//
// [SID:4367] 한 Esc = 한 층 — 모바일 트리 서랍 안 «새 폴더» 입력칸의 Esc는 입력칸만 닫는다. 입력칸은 전부터 preventDefault했지만
// 서랍의 초점 가두기(document Esc)가 그 표시를 안 봐 서랍까지 닫았다(실 브라우저 판 · 저장소 서랍과 같은 모양).
// docs-client-layout.test.tsx는 useFocusTrap을 가짜로 바꿔 서랍 Esc가 아예 안 돈다 → 이 파일은 **실제 useFocusTrap**을 쓴다
// (나머지 가짜는 그 파일과 같다). 둘째 Esc로 서랍이 닫히는 것이 양성 대조(가두기가 살아 있다).
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
const DOC_B_ = { id: 'd2', parent_id: null, title: '문서B', slug: 'doc-b', icon: null, sort_order: 1, is_folder: false, status: 'pending', updated_at: '2026-08-21T00:00:00Z', tags: ['스펙'] };

function stubFetch(overrides?: { onCall?: (url: string, init?: RequestInit) => void }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    overrides?.onCall?.(url, init);
    if (typeof url === 'string' && url.includes('/api/docs') && init?.method === 'POST') {
      const body = JSON.parse((init.body as string) ?? '{}');
      return { ok: true, json: async () => ({ data: { id: 'new-1', title: body.title, slug: body.slug, parent_id: body.parent_id, sort_order: 0, is_folder: !!body.is_folder, updated_at: '2026-08-23T00:00:00Z' } }) };
    }
    if (typeof url === 'string' && url.includes('/api/docs')) {
      return { ok: true, json: async () => ({ data: [DOC_A, DOC_B_], meta: { hasMore: false, nextCursor: null } }) };
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


const esc = (target: EventTarget) => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
const drawer = () => [...container.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((el) => el.className.includes('w-[280px]'))!;

describe('DocsClientLayout — 서랍 안 새 폴더 입력칸 Esc는 입력칸만([SID:4367])', () => {
  it('서랍을 열고 새 폴더 입력칸에서 Esc → 입력칸 닫힘 · 서랍 그대로 → 한 번 더 Esc → 서랍 닫힘(양성 대조)', async () => {
    stubFetch();
    await mount();
    const opener = container.querySelector(`button[aria-label="${koMessages.docs.openDocTree}"]`) as HTMLButtonElement;
    await act(async () => { opener.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(drawer().getAttribute('aria-hidden')).toBe('false');
    // 실제 가두기가 돈다 — 열면 초점이 서랍 안으로 간다(가짜 훅이면 body에 남는다).
    expect(drawer().contains(document.activeElement)).toBe(true);
    // «새 폴더»는 상단바 버튼(서랍 밖) — 누르면 입력칸이 트리 목록(서랍 안에도 같은 목록)에 선다.
    const newFolderBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === koMessages.docs.newFolder)!;
    await act(async () => { newFolderBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = drawer().querySelector(`input[placeholder="${koMessages.docs.newFolderPlaceholder}"]`) as HTMLInputElement;
    expect(input).toBeTruthy();
    let ev!: KeyboardEvent;
    await act(async () => { ev = esc(input); });
    expect(ev.defaultPrevented).toBe(true);
    expect(drawer().querySelector(`input[placeholder="${koMessages.docs.newFolderPlaceholder}"]`)).toBeNull();
    expect(drawer().getAttribute('aria-hidden')).toBe('false');
    await act(async () => { esc(document.activeElement ?? document.body); });
    expect(drawer().getAttribute('aria-hidden')).toBe('true');
  });
});
