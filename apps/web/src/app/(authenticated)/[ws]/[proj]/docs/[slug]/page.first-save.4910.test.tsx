// @vitest-environment jsdom
//
// 4910 ② «첫 저장 때 만들기» — 「새 문서」는 서버에 아무것도 안 만들고 임시 주소(`untitled-…?new=1`)의 초안 화면으로만 온다. 그 주소에 문서가 없으면(404) 이 화면은 초안 모드:
// 첫 «쓴 것»(제목 한 글자 · 내용 비공백)에서 문서를 한 번 만들고(디바운스 1.5초 · single-flight), 그 뒤는 예전 PATCH 자동저장 길. 쓰지 않고 나가면 요청이 한 번도 없다(고아 0 · 지우는 길 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

type EditorProps = {
  title?: string; titlePlaceholder?: string; currentDocId?: string; isDirty?: boolean;
  onTitleChange?: (v: string) => void; onChange?: (v: string) => void; onSave?: () => Promise<boolean>;
};
type SyncOpts = { docId: string | null; savePayload: { title: string; content: string; content_format: string }; adoptBaselineSnapshot?: string | null };
const { routerMock, paramsMock, editorProps, addToastMock, syncOptions } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn() },
  paramsMock: { slug: 'untitled-123456789' },
  editorProps: { current: null as null | EditorProps },
  addToastMock: vi.fn(),
  syncOptions: { current: null as null | SyncOpts },
}));
vi.mock('next/navigation', () => ({ useParams: () => paramsMock, useRouter: () => routerMock }));
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
  DocEditor: (props: EditorProps) => { editorProps.current = props; return <div data-testid="editor-stub" />; },
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
const KO = (koMessages as unknown as { docs: { newDocDefaultTitle: string; titlePlaceholder: string; createFailed: string } }).docs;

let container: HTMLDivElement;
let root: Root;
let unmounted = false;
let postMode: 'ok' | 'fail' | 'hang' | 'conflict-once' = 'ok';
let resolveHungPost: (() => void) | null = null;
const fetchMock = vi.fn();
const setTree = vi.fn();
const CTX = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1',
  tree: [], setTree, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {},
  pendingDocUpdate: null, clearPendingDocUpdate: () => {},
  expandFolder: () => {}, openTreeDrawer: () => {},
};
const created = (body: Record<string, unknown>) => ({ data: { id: 'new-doc', title: body.title, slug: body.slug, parent_id: body.parent_id ?? null, sort_order: 0, is_folder: false, updated_at: '2026-11-13T00:00:05Z', content: body.content, content_format: body.content_format } });

beforeEach(() => {
  vi.useFakeTimers();
  postMode = 'ok'; resolveHungPost = null; unmounted = false;
  editorProps.current = null; syncOptions.current = null;
  fetchMock.mockClear(); setTree.mockClear(); addToastMock.mockClear(); routerMock.replace.mockClear();
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchMock(url, init);
    if (init?.method === 'POST' && url === '/api/docs') {
      const body = JSON.parse(init.body as string);
      if (postMode === 'fail') return new Response('{}', { status: 500 });
      if (postMode === 'conflict-once') { postMode = 'ok'; return new Response('{}', { status: 409 }); }
      if (postMode === 'hang') await new Promise<void>((resolve) => { resolveHungPost = resolve; });
      return new Response(JSON.stringify(created(body)), { status: 201 });
    }
    if (url.includes('slug=existing-doc')) return new Response(JSON.stringify({ data: { id: 'doc-existing', title: '남의 문서', slug: 'existing-doc', content: '원래 내용', content_format: 'markdown', updated_at: '2026-11-13T00:00:01Z' } }), { status: 200 });
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
const postBody = (i = 0) => JSON.parse((posts()[i]![1] as RequestInit).body as string);
const leave = async () => { await act(async () => { root.unmount(); }); unmounted = true; };
const beforeUnloadPrevented = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

describe('초안 모드 진입 (4910 ②)', () => {
  it('?new=1 + 임시 슬러그(untitled-숫자) + 404 → 오류가 아니라 초안: 편집기가 뜨고 목록으로 안 돌아가고, 요청은 조회 하나뿐이며 제목칸은 비고 placeholder = 기본 글', async () => {
    await open();
    expect(editorProps.current).not.toBeNull();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
    expect(editorProps.current!.title).toBe('');
    expect(editorProps.current!.titlePlaceholder).toBe(KO.newDocDefaultTitle);
    expect(syncOptions.current!.docId).toBeNull(); // 서버 문서가 없으니 자동저장 길은 꺼져 있다
  });

  it('?new=1이 없으면 같은 404는 예전처럼 목록으로 돌아간다(오래된 링크가 빈 초안이 되지 않게)', async () => {
    await open('');
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(String(routerMock.replace.mock.calls[0]![0])).toMatch(/\/docs$/);
    expect(editorProps.current).toBeNull();
  });

  it('슬러그가 임시 슬러그가 아니면(?new=1이어도) 404는 목록으로 — 남의 문서 주소를 초안으로 열지 않는다', async () => {
    await open('?new=1', 'quarterly-review');
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(editorProps.current).toBeNull();
  });
});

describe('첫 «쓴 것»에서 한 번 만든다 (4910 ②)', () => {
  it('⭐쓰지 않고 오래 둬도 · 나가도 요청이 없다 — 고아 초안이 생길 길이 없다(지우는 길도 없다)', async () => {
    await open();
    await wait(10_000);
    expect(posts()).toHaveLength(0);
    await leave();
    expect(posts()).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
  });

  it('제목 한 글자 → 디바운스 1.5초 뒤 POST 1회(제목 = 쓴 글 · 슬러그 = 임시 슬러그 · 내용 · 형식 · parent null)', async () => {
    await open();
    await type('title', '가');
    await wait(1400);
    expect(posts()).toHaveLength(0); // 아직 박자 안
    await wait(200);
    expect(posts()).toHaveLength(1);
    expect(postBody()).toEqual({ project_id: 'proj-1', title: '가', content: '', content_format: 'markdown', slug: 'untitled-123456789', parent_id: null });
  });

  it('박자 안에서 여러 번 써도 POST는 한 번(디바운스) — 마지막 값으로', async () => {
    await open();
    for (const v of ['가', '가나', '가나다']) { await type('title', v); await wait(300); }
    await wait(1600);
    expect(posts()).toHaveLength(1);
    expect(postBody().title).toBe('가나다');
  });

  it('내용만 써도 만든다 — 제목은 기본 글(«제목 없음»)', async () => {
    await open();
    await type('content', '안녕');
    await wait(1600);
    expect(posts()).toHaveLength(1);
    expect(postBody().title).toBe(KO.newDocDefaultTitle);
    expect(postBody().content).toBe('안녕');
  });

  it('공백 · 줄바꿈뿐인 내용은 «쓴 것»이 아니다 — 안 만든다', async () => {
    await open();
    await type('content', '  \n ');
    await wait(5000);
    expect(posts()).toHaveLength(0);
  });

  it('하위 문서(?parent=)면 parent_id를 싣는다', async () => {
    await open('?new=1&parent=folder-9');
    await type('title', '가');
    await wait(1600);
    expect(postBody().parent_id).toBe('folder-9');
  });

  it('⭐만든 뒤: 문서로 채택(currentDocId) · 사이드바 트리에 행 추가 · 같은 편집기 유지 · useDocSync는 docId를 받고 기준선 = 보낸 값', async () => {
    await open();
    await type('title', '분기 회고');
    await type('content', '본문');
    await wait(1600);
    expect(editorProps.current!.currentDocId).toBe('new-doc');
    expect(syncOptions.current!.docId).toBe('new-doc');
    expect(syncOptions.current!.adoptBaselineSnapshot).toBe(JSON.stringify({ title: '분기 회고', content: '본문', content_format: 'markdown' }));
    // 제목을 쓸 때도 트리 갱신(map)이 불리므로, 갱신 함수들을 옛 목록에 적용해 «새 행이 맨 위에 붙은 결과»가 하나 있는지 본다.
    const results = setTree.mock.calls.map(([u]) => (u as (prev: Array<{ id: string }>) => Array<{ id: string; title?: string }>)([{ id: 'old' }]));
    expect(results).toContainEqual([expect.objectContaining({ id: 'new-doc', title: '분기 회고' }), { id: 'old' }]);
    await wait(5000);
    expect(posts()).toHaveLength(1); // 이후는 PATCH 길 — 다시 안 만든다
  });
});

describe('가장 위험한 자리 · 실패 · 단일 비행 (4910 ②)', () => {
  it('⭐만드는 중에 친 글자: 응답이 오기 전에 더 친 글(제목 · 내용)이 상태에 남고, 기준선은 «보낸 값»이라 보낸 값과 달라 dirty가 된다', async () => {
    postMode = 'hang';
    await open();
    await type('title', '가');
    await wait(1600); // POST 시작(응답 대기)
    expect(posts()).toHaveLength(1);
    await type('title', '가나다'); await type('content', '더 쓴 내용'); // 응답 오기 전에 더 침
    await act(async () => { resolveHungPost!(); await vi.advanceTimersByTimeAsync(5); });
    expect(syncOptions.current!.docId).toBe('new-doc');
    expect(syncOptions.current!.adoptBaselineSnapshot).toBe(JSON.stringify({ title: '가', content: '', content_format: 'markdown' })); // 보낸 값
    expect(syncOptions.current!.savePayload.title).toBe('가나다'); // 지금 값은 더 쳤다 → 둘이 달라 자동저장이 보낸다
    expect(syncOptions.current!.savePayload.content).toBe('더 쓴 내용');
  });

  it('⭐만드는 중에 제목을 쓰고 비운 칸은 응답이 와도 되살아나지 않는다(손댄 칸)', async () => {
    postMode = 'hang';
    await open();
    await type('content', '내용만');
    await wait(1600);
    expect(posts()).toHaveLength(1);
    expect(postBody().title).toBe(KO.newDocDefaultTitle);
    await type('title', '가'); await type('title', ''); // 쓰고 지움 = 손댄 것
    await act(async () => { resolveHungPost!(); await vi.advanceTimersByTimeAsync(5); });
    expect(editorProps.current!.title).toBe('');
  });

  it('대조: 제목을 손대지 않았으면 응답 뒤 기본 글이 제목 값으로 들어간다', async () => {
    postMode = 'hang';
    await open();
    await type('content', '내용만');
    await wait(1600);
    await act(async () => { resolveHungPost!(); await vi.advanceTimersByTimeAsync(5); });
    expect(syncOptions.current!.savePayload.title).toBe(KO.newDocDefaultTitle);
  });

  it('⭐POST가 409(슬러그 충돌)면 같은 요청을 되풀이하지 않고 새 임시 슬러그로 다음 박자에 다시 만든다 — 토스트 없음 · 글 그대로 · 주소는 안 옮김(옮기면 이 쪽이 새로 서서 글이 사라진다)', async () => {
    postMode = 'conflict-once';
    await open();
    await type('title', '가');
    await wait(1600);
    expect(posts()).toHaveLength(1);
    expect(addToastMock).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(editorProps.current!.title).toBe('가');
    await wait(1600);
    expect(posts()).toHaveLength(2);
    const fresh = postBody(1).slug as string;
    expect(fresh).toMatch(/^untitled-\d+$/);
    expect(fresh).not.toBe(postBody(0).slug); // 새 슬러그로 다시
    expect(editorProps.current!.currentDocId).toBe('new-doc');
  });

  it('⭐만든 뒤 같은 화면에서 다른 기존 문서로 가면(트리 이동 — [slug]만 바뀜) 낡은 «보낸 값» 기준선이 그 문서 기준선이 되지 않는다(쓸데없는 PATCH 0)', async () => {
    await open();
    await type('title', '가');
    await wait(1600);
    expect(syncOptions.current!.docId).toBe('new-doc');
    expect(syncOptions.current!.adoptBaselineSnapshot).toBe(JSON.stringify({ title: '가', content: '', content_format: 'markdown' }));
    paramsMock.slug = 'existing-doc';
    window.history.replaceState(null, '', '/moonklabs/sprintable/docs/existing-doc');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider>
        </NextIntlClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(syncOptions.current!.docId).toBe('doc-existing');
    expect(syncOptions.current!.adoptBaselineSnapshot).toBeNull(); // 만든 문서 'new-doc'의 기준선이 'doc-existing'에 새지 않는다
  });

  it('단일 비행: 만드는 중에 «저장»(onSave)을 또 눌러도 POST는 한 번', async () => {
    postMode = 'hang';
    await open();
    await type('title', '가');
    await wait(1600);
    await act(async () => { void editorProps.current!.onSave!(); void editorProps.current!.onSave!(); });
    expect(posts()).toHaveLength(1);
    await act(async () => { resolveHungPost!(); await vi.advanceTimersByTimeAsync(5); });
    expect(posts()).toHaveLength(1);
  });

  it('⭐만들기 실패: 오류 토스트(createFailed) · 쓴 글은 그대로 · 초안 모드 유지 — 다음 입력이 다시 시도한다(되돌리기 · 삭제 없음)', async () => {
    postMode = 'fail';
    await open();
    await type('title', '가');
    await wait(1600);
    expect(addToastMock).toHaveBeenCalledWith({ title: KO.createFailed, type: 'error' });
    expect(syncOptions.current!.docId).toBeNull();
    expect(editorProps.current!.title).toBe('가'); // 쓴 글 그대로
    await wait(5000);
    expect(posts()).toHaveLength(1); // 값이 그대로면 저절로 반복하지 않는다
    postMode = 'ok';
    await type('title', '가나');
    await wait(1600);
    expect(posts()).toHaveLength(2);
    expect(editorProps.current!.currentDocId).toBe('new-doc');
  });

  it('「저장」 단추(onSave)는 박자를 기다리지 않고 바로 만든다', async () => {
    await open();
    await type('title', '가');
    await act(async () => { await editorProps.current!.onSave!(); });
    expect(posts()).toHaveLength(1);
  });
});

describe('나갈 때 · 탭 닫기 (4910 ② · 가 · 나)', () => {
  it('⭐쓴 것이 있는데 아직 안 만들었으면 화면을 떠날 때 지금 만든다(쓴 글이 사라지지 않게) — 쓴 게 없으면 요청 0', async () => {
    await open();
    await type('title', '가');
    await leave();
    expect(posts()).toHaveLength(1);
    expect(postBody().title).toBe('가');
  });

  it('⭐탭 닫기 · 새로고침 경고(beforeunload): 쓴 것이 있는 초안 · 만드는 중에만 선다 — 비었거나 만든 뒤엔 안 선다', async () => {
    await open();
    expect(beforeUnloadPrevented()).toBe(false); // 아무것도 안 씀
    await type('title', '가');
    expect(beforeUnloadPrevented()).toBe(true); // 쓴 것 있음(디바운스 안)
    await wait(1600);
    expect(editorProps.current!.currentDocId).toBe('new-doc');
    expect(beforeUnloadPrevented()).toBe(false); // 만든 뒤(이후는 자동저장 길)
  });

  it('만드는 중(응답 대기)에도 경고가 선다', async () => {
    postMode = 'hang';
    await open();
    await type('title', '가');
    await wait(1600);
    expect(beforeUnloadPrevented()).toBe(true);
    await act(async () => { resolveHungPost!(); await vi.advanceTimersByTimeAsync(5); });
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it('편집기의 «저장 안 됨» 표시(isDirty)가 초안의 쓴 것과 같이 켜진다', async () => {
    await open();
    expect(editorProps.current!.isDirty).toBe(false);
    await type('content', '안녕');
    expect(editorProps.current!.isDirty).toBe(true);
  });
});
