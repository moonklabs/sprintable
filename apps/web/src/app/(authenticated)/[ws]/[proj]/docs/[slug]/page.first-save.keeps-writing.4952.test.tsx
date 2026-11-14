// @vitest-environment jsdom
//
// 4952 D1 — the FIRST SAVE moves the address to the doc's own slug WITHOUT a navigation (copy of the 4910 first-save harness) .
// 4910 ② «첫 저장 때 만들기» — 「새 문서」는 서버에 아무것도 안 만들고 임시 주소(`untitled-…?new=1`)의 초안 화면으로만 온다. 그 주소에 문서가 없으면(404) 이 화면은 초안 모드:
// 첫 «쓴 것»(제목 한 글자 · 내용 비공백)에서 문서를 한 번 만들고(디바운스 1.5초 · single-flight), 그 뒤는 예전 PATCH 자동저장 길. 쓰지 않고 나가면 요청이 한 번도 없다(고아 0 · 지우는 길 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

type EditorProps = {
  title?: string; titlePlaceholder?: string; currentDocId?: string; isDirty?: boolean;
  actions?: React.ReactNode; onTitleChange?: (v: string) => void; onChange?: (v: string) => void; onSave?: () => Promise<boolean>;
};
type SyncOpts = { docId: string | null; savePayload: { title: string; content: string; content_format: string }; adoptBaselineSnapshot?: string | null; onSaved?: (doc: never) => void };
const { routerMock, paramsMock, editorProps, addToastMock, syncOptions, searchOverride } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn() },
  paramsMock: { slug: 'untitled-123456789' },
  editorProps: { current: null as null | EditorProps },
  addToastMock: vi.fn(),
  syncOptions: { current: null as null | SyncOpts },
  searchOverride: { current: null as null | string }, // useSearchParams가 돌려줄 쿼리 — null이면 window.location.search. «렌더 때 useSearchParams는 ?new=1을 아는데 window.location은 아직 옛 주소»인 순서를 만든다.
}));
vi.mock('next/navigation', () => ({ useParams: () => paramsMock, useRouter: () => routerMock, useSearchParams: () => new URLSearchParams(searchOverride.current ?? window.location.search) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));
vi.mock('@/components/ui/human-only-action', () => ({ HumanOnlyAction: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
const { docSyncMock } = vi.hoisted(() => ({
  docSyncMock: { status: 'idle' as const, isDirty: false, save: () => Promise.resolve(true), clearSyncAlerts: () => {}, adoptNormalized: () => {} },
}));
vi.mock('@/components/docs/use-doc-sync', () => ({
  useDocSync: (opts: SyncOpts) => { syncOptions.current = opts; return docSyncMock; },
  unwrapDocResponse: (json: unknown) => { const root = (json ?? {}) as { data?: unknown }; return { doc: root.data ?? root, updatedAt: undefined }; },
}));
vi.mock('@/components/docs/doc-editor', () => ({
  DocEditor: (props: EditorProps) => { editorProps.current = props; return <div data-testid="editor-stub">{props.actions}</div>; },
}));
vi.mock('@/components/docs/doc-gate-section', () => ({ DocGateSection: () => null }));
vi.mock('@/components/docs/doc-assignee-control', () => ({ DocAssigneeControl: () => null }));
vi.mock('@/components/docs/doc-url-chip', () => ({ DocUrlChip: () => null }));
vi.mock('@/components/docs/doc-breadcrumb', () => ({ DocBreadcrumb: () => null }));
vi.mock('@/components/docs/doc-sync-banner', () => ({ DocSyncBanner: () => null }));
vi.mock('@/components/docs/doc-url-dialog', () => ({ DocUrlDialog: () => null }));
vi.mock('@/components/docs/doc-share-dialog', () => ({ DocShareDialog: () => null }));

import { DocsLayoutContext } from '../docs-context';
import DocSlugPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let unmounted = false;
let postMode: 'ok' | 'fail' | 'hang' | 'conflict-once' = 'ok';
let releasePost: (() => void) | null = null;
let releaseSlow: (() => void) | null = null;
let existingTitle = '남의 문서'; // slug=existing-doc 조회가 주는 제목
const fetchMock = vi.fn();
const setTree = vi.fn();
const reportLiveSlug = vi.fn();
const CTX = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1',
  tree: [], setTree, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {},
  pendingDocUpdate: null, clearPendingDocUpdate: () => {},
  expandFolder: () => {}, openTreeDrawer: () => {},
  reportLiveSlug,
};
const created = (body: Record<string, unknown>) => ({ data: { id: 'new-doc', title: body.title, slug: body.slug, parent_id: body.parent_id ?? null, sort_order: 0, is_folder: false, updated_at: '2026-11-13T00:00:05Z', content: body.content, content_format: body.content_format } });

beforeEach(() => {
  vi.useFakeTimers();
  postMode = 'ok'; releasePost = null; releaseSlow = null; unmounted = false; searchOverride.current = null; existingTitle = '남의 문서';
  editorProps.current = null; syncOptions.current = null;
  fetchMock.mockClear(); setTree.mockClear(); addToastMock.mockClear(); routerMock.replace.mockClear(); routerMock.push.mockClear(); reportLiveSlug.mockClear();
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchMock(url, init);
    if (init?.method === 'POST' && url === '/api/docs') {
      const body = JSON.parse(init.body as string);
      if (postMode === 'fail') return new Response('{}', { status: 500 });
      if (postMode === 'conflict-once') { postMode = 'ok'; return new Response('{}', { status: 409 }); }
      if (postMode === 'hang') await new Promise<void>((resolve) => { releasePost = resolve; });
      
      return new Response(JSON.stringify(created(body)), { status: 201 });
    }
    if (url.includes('slug=slow-doc')) return new Promise<Response>((resolve) => { releaseSlow = () => resolve(new Response(JSON.stringify({ data: { id: 'doc-slow', title: '느린 문서', slug: 'slow-doc', content: '', content_format: 'markdown', updated_at: '2026-11-14T00:00:00Z' } }), { status: 200 })); });
    if (url.includes('slug=existing-doc')) return new Response(JSON.stringify({ data: { id: 'doc-existing', title: existingTitle, slug: 'existing-doc', content: '원래 내용', content_format: 'markdown', updated_at: '2026-11-13T00:00:01Z' } }), { status: 200 });
    if (url.includes('/api/docs?')) return new Response('not found', { status: 404 }); // 서버에 아직 없는 초안
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  if (!unmounted) await act(async () => { root.unmount(); });
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

const open = async (search = '?new=1', slug = 'untitled-123456789') => {
  paramsMock.slug = slug;
  window.history.replaceState(null, '', `/moonklabs/sprintable/docs/${slug}${search}`);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider>
      </NextIntlClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
};
const type = (kind: 'title' | 'content', v: string) => act(async () => { (kind === 'title' ? editorProps.current!.onTitleChange! : editorProps.current!.onChange!)(v); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const posts = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/docs' && (init as RequestInit | undefined)?.method === 'POST');


const SAVED = (slug: string, id = 'new-doc') => ({ id, title: '회의 메모', slug, parent_id: null, sort_order: 0, is_folder: false, updated_at: '2026-11-14T00:00:00Z', content: '', content_format: 'markdown' });
const docGets = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/docs?') && (init as RequestInit | undefined)?.method !== 'POST');
const decodedPath = () => decodeURIComponent(window.location.pathname);

describe('첫 저장이 주소를 «화면은 그대로» 옮긴다 (4952 D1)', () => {
  it('⭐첫 저장이 제목에서 만든 슬러그(회의-메모)를 돌려주면 주소만 그 슬러그로 바뀐다 — router.replace(화면을 새로 세움)도 push도 없다', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600); // 만들기(POST)
    expect(posts()).toHaveLength(1);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    expect(decodedPath()).toBe('/moonklabs/sprintable/docs/회의-메모');
    expect(routerMock.replace).not.toHaveBeenCalled(); // 옛 코드: router.replace(docUrl(…)) → [slug] 구간이 바뀌어 편집기가 새로 서고 커서 · 친 글이 사라졌다
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('⭐주소에서 ?new=1이 빠져도(replaceState 뒤 useSearchParams가 바뀜) 문서를 다시 조회하지 않는다 — 옛 임시 이름으로 404 → 목록으로 튕기거나 서버 값으로 쓰던 글을 덮지 않는다', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    const before = docGets().length;
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    searchOverride.current = ''; // 이제 주소에는 쿼리가 없다
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>); await vi.advanceTimersByTimeAsync(5); });
    await wait(50);
    expect(docGets()).toHaveLength(before); // 같은 화면 — 조회는 처음 한 번뿐
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('⭐저장 응답이 오는 사이 이어 친 글이 그대로 남는다(제목 · 본문 상태가 서버 값으로 덮이지 않는다)', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    await type('title', '회의 메모 이어서 쓰기');
    await type('content', '본문 한 줄');
    await wait(100);
    expect(editorProps.current!.title).toBe('회의 메모 이어서 쓰기');
    expect(syncOptions.current!.savePayload.content).toBe('본문 한 줄');
  });

  it('⭐레이아웃(트리 강조 · 제목)에 «지금 열린 문서의 슬러그»를 알린다 — 라우트 params는 옛 값이라', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    expect(reportLiveSlug).toHaveBeenCalledWith('회의-메모');
  });

  it('⭐주소가 옮겨진 뒤 다시 조회해야 할 때(프로젝트 갱신 · 충돌 해결)는 옛 임시 이름이 아니라 문서의 살아 있는 이름으로 묻는다 — 옛 이름은 404 → 목록으로 튕김', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    fetchMock.mockClear();
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={{ ...CTX, projectId: 'proj-2' }}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    const urls = docGets().map(([u]) => String(u));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('slug=회의-메모');
    expect(urls[0]).not.toContain('untitled-');
  });

  it('⭐주소를 옮길 때 history 상태로 Next의 내부 표시(__NA)를 되돌려 넘기지 않는다 — null을 넘긴다(Next는 __NA가 실린 호출은 라우터 동기화를 건너뛴다: usePathname · useSearchParams가 옛 값으로 남음)', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] }, '', window.location.pathname + window.location.search);
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeNull();
    spy.mockRestore();
  });

  it('⭐첫 저장 뒤 «읽기 | 고치기»는 열린 문서의 이름(회의-메모)으로 간다 — 라우트 params의 옛 임시 이름(untitled-…)이 아니다', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    const hrefs = [...container.querySelectorAll('[data-slot="doc-mode-switch"] a')].map((a) => decodeURIComponent(a.getAttribute('href') ?? ''));
    expect(hrefs).toEqual(['/moonklabs/sprintable/docs/회의-메모/view', '/moonklabs/sprintable/docs/회의-메모']);
  });

  it('⭐옮겨 둔 이름은 그 라우트에서만 쓴다 — 다른 라우트(existing-doc)를 거쳐 같은 임시 이름으로 돌아와도 옛 이름(회의-메모)으로 조회하지 않는다', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600);
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모') as never); });
    const rerender = (projectId: string) => act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={{ ...CTX, projectId }}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    paramsMock.slug = 'existing-doc';
    await rerender('proj-1');
    paramsMock.slug = 'untitled-123456789';
    fetchMock.mockClear();
    await rerender('proj-1b'); // 같은 라우트 이름으로 돌아와 다시 조회
    const urls = docGets().map(([u]) => String(u));
    expect(urls.some((u) => u.includes('slug=untitled-123456789'))).toBe(true);
    expect(urls.some((u) => u.includes('slug=회의-메모'))).toBe(false);
  });

  it('⭐늦게 도착한 저장(옛 문서의 첫 저장)은 다른 라우트로 옮긴 뒤에는 주소를 옮기지도 짝을 쓰지도 않는다 — 화면에 있는 문서가 아니면 무시', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600); // 문서가 만들어져 이 라우트의 화면 문서가 된다(id new-doc)
    paramsMock.slug = 'existing-doc'; // 사람이 다른 문서로 옮겨 감
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    await wait(50);
    const addressBefore = window.location.pathname;
    reportLiveSlug.mockClear();
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('늦은-저장') as never); }); // 옛 문서(new-doc)의 저장이 이제서야 돌아옴
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(addressBefore);
    expect(reportLiveSlug).not.toHaveBeenCalled();
    spy.mockRestore();
    fetchMock.mockClear();
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={{ ...CTX, projectId: 'proj-3' }}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    const urls = docGets().map(([u]) => String(u));
    expect(urls.some((u) => u.includes('slug=existing-doc'))).toBe(true);
    expect(urls.some((u) => u.includes('늦은-저장'))).toBe(false); // 다시 조회가 옛 문서의 늦은 이름으로 가지 않는다
  });

  it('⭐라우트가 바뀐 뒤 새 문서가 «아직 안 온» 사이(옛 문서가 화면 상태에 남아 있는 동안)에도 옛 문서의 늦은 저장은 주소를 옮기지도 짝을 쓰지도 않는다', async () => {
    await open();
    await type('title', '회의 메모');
    await wait(1600); // 이 라우트의 화면 문서 = new-doc
    paramsMock.slug = 'slow-doc'; // 다른 문서로 옮겼고 그 문서는 아직 오지 않았다
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    reportLiveSlug.mockClear();
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('늦은-저장') as never); }); // new-doc의 첫 저장이 이제서야 돌아옴
    expect(spy).not.toHaveBeenCalled();
    expect(reportLiveSlug).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('⭐옛 생성(POST)이 라우트를 옮긴 뒤에 돌아와도 그 문서를 새 라우트의 화면 문서로 되돌려 놓지 않는다 — 그 문서의 늦은 저장은 새 라우트의 주소를 옮기지 않는다', async () => {
    postMode = 'hang';
    await open();
    await type('title', '회의 메모');
    await wait(1600); // POST가 응답 없이 걸려 있다
    paramsMock.slug = 'existing-doc';
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    await wait(50);
    await act(async () => { releasePost?.(); await vi.advanceTimersByTimeAsync(5); }); // 이제서야 옛 생성이 돌아옴(id new-doc)
    await wait(50);
    reportLiveSlug.mockClear();
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('늦은-저장') as never); });
    expect(spy).not.toHaveBeenCalled();
    expect(reportLiveSlug).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('⭐옛 조회(GET)가 라우트를 옮긴 뒤에 돌아와도 그 문서를 화면 문서로 되돌려 놓지 않는다', async () => {
    await open('', 'slow-doc'); // 이 라우트의 조회는 아직 안 돌아옴
    paramsMock.slug = 'existing-doc';
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider></NextIntlClientProvider>);
      await vi.advanceTimersByTimeAsync(5);
    });
    await wait(50);
    await act(async () => { releaseSlow?.(); await vi.advanceTimersByTimeAsync(5); }); // 옛 라우트의 조회가 이제서야 돌아옴(id doc-slow)
    await wait(50);
    reportLiveSlug.mockClear();
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('늦은-저장', 'doc-slow') as never); });
    expect(spy).not.toHaveBeenCalled();
    expect(reportLiveSlug).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('이미 그 주소에 있으면(슬러그가 그대로) 주소를 다시 쓰지 않는다 — 인코딩만 다른 같은 경로도 같은 것으로 본다', async () => {
    await open('', 'existing-doc');
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('existing-doc', 'doc-existing') as never); });
    expect(spy).not.toHaveBeenCalled();
    window.history.replaceState(null, '', `/moonklabs/sprintable/docs/${encodeURIComponent('회의-메모')}`);
    spy.mockClear();
    await act(async () => { syncOptions.current!.onSaved?.(SAVED('회의-메모', 'doc-existing') as never); });
    expect(spy).not.toHaveBeenCalled(); // 주소창은 %EC… 로, docUrl은 한글 그대로 — 같은 경로
    spy.mockRestore();
  });
});
