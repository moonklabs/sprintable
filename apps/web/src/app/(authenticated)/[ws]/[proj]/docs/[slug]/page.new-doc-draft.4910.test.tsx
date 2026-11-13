// @vitest-environment jsdom
//
// 4910 (디디 4906 둘째 바퀴 → PO) — 문서 줄 «새 문서» 제목칸, 새 기능 0:
//  ① 막 만든 초안의 제목칸에 «제목 없음»이 진짜 글자로 들어 있어 쓰면 뒤에 붙었다 → 손대기 전엔 칸을 비우고 그 글은 placeholder로.
//  (② 누르는 순간 서버에 빈 초안이 생겨 고아로 남는 것은 PO 판단으로 이 PR 밖 — «나갈 때 지우기»는 받지 않고 뿌리인 «첫 저장 때 만들기»로 따로.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

const { routerMock, paramsMock, editorProps } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn() },
  paramsMock: { slug: 'untitled-123' },
  editorProps: { current: null as null | { title?: string; titlePlaceholder?: string; onTitleChange?: (v: string) => void; onChange?: (v: string) => void } },
}));
vi.mock('next/navigation', () => ({ useParams: () => paramsMock, useRouter: () => routerMock }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/components/ui/human-only-action', () => ({ HumanOnlyAction: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
const { docSyncMock, syncOptions } = vi.hoisted(() => ({
  docSyncMock: { status: 'idle' as const, isDirty: false, save: () => Promise.resolve(), clearSyncAlerts: () => {}, adoptNormalized: () => {} },
  syncOptions: { current: null as null | { savePayload: { title: string; content: string } } },
}));
vi.mock('@/components/docs/use-doc-sync', () => ({
  useDocSync: (opts: { savePayload: { title: string; content: string } }) => { syncOptions.current = opts; return docSyncMock; },
  unwrapDocResponse: (json: unknown) => {
    const root = (json ?? {}) as { data?: unknown };
    return { doc: root.data ?? root, updatedAt: undefined };
  },
}));
vi.mock('@/components/docs/doc-editor', () => ({
  DocEditor: (props: { title?: string; titlePlaceholder?: string; onTitleChange?: (v: string) => void; onChange?: (v: string) => void }) => {
    editorProps.current = props;
    return <div data-testid="editor-stub" />;
  },
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
const DEFAULT_TITLE = (koMessages as unknown as { docs: { newDocDefaultTitle: string; titlePlaceholder: string } }).docs.newDocDefaultTitle;
const PLAIN_PLACEHOLDER = (koMessages as unknown as { docs: { titlePlaceholder: string } }).docs.titlePlaceholder;

let container: HTMLDivElement;
let root: Root;
let unmounted = false;
let docTitle = DEFAULT_TITLE;
let docContent = '';
const fetchMock = vi.fn();
const setTree = vi.fn();
const CTX = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1',
  tree: [], setTree, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {},
  pendingDocUpdate: null, clearPendingDocUpdate: () => {},
  expandFolder: () => {}, openTreeDrawer: () => {},
};

beforeEach(() => {
  docTitle = DEFAULT_TITLE; docContent = ''; docSyncMock.isDirty = false;
  editorProps.current = null; syncOptions.current = null; unmounted = false;
  fetchMock.mockClear(); setTree.mockClear();
  window.history.replaceState(null, '', '/moonklabs/sprintable/docs/untitled-123');
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchMock(url, init);
    if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
    if (url.includes('/api/docs?')) {
      return new Response(JSON.stringify({ data: { id: 'doc-1', title: docTitle, slug: 'untitled-123', content: docContent, content_format: 'markdown', updated_at: '2026-11-13T00:00:00Z' } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (!unmounted) await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const open = async (asNew: boolean) => {
  if (asNew) window.history.replaceState(null, '', '/moonklabs/sprintable/docs/untitled-123?new=1');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider>
      </NextIntlClientProvider>,
    );
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const leave = async () => { await act(async () => { root.unmount(); }); unmounted = true; };
const deleteCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');

describe('① 막 만든 «새 문서»의 제목칸', () => {
  it('손대기 전: 칸은 비어 있고 «제목 없음»은 placeholder로 — 쓰면 뒤에 붙지 않는다', async () => {
    await open(true);
    expect(editorProps.current!.title).toBe('');
    expect(editorProps.current!.titlePlaceholder).toBe(DEFAULT_TITLE);
    await act(async () => { editorProps.current!.onTitleChange!('분기 회고'); });
    expect(editorProps.current!.title).toBe('분기 회고'); // «제목 없음분기 회고»가 아니다
    expect(editorProps.current!.titlePlaceholder).toBe(PLAIN_PLACEHOLDER); // 손댄 뒤엔 평소 안내
  });

  it('사용자가 우연히 기본 글(«제목 없음»)과 똑같이 써도 «손댄 것»이다 — 쓴 글을 비우지 않고, 문서도 안 지운다', async () => {
    await open(true);
    await act(async () => { editorProps.current!.onTitleChange!(DEFAULT_TITLE); });
    expect(editorProps.current!.title).toBe(DEFAULT_TITLE); // 칸이 도로 비워지지 않는다
    expect(editorProps.current!.titlePlaceholder).toBe(PLAIN_PLACEHOLDER);
    await leave();
    expect(deleteCalls()).toHaveLength(0);
  });

  it('⭐저장 내용(savePayload): 제목칸이 비어 보여도 상태의 제목은 기본 글 그대로 — 내용만 써도 저장이 빈 제목을 보내 서버의 «제목 없음»을 지우지 않는다', async () => {
    await open(true);
    expect(editorProps.current!.title).toBe(''); // 칸은 빔
    await act(async () => { editorProps.current!.onChange!('본문만 씀'); });
    expect(syncOptions.current!.savePayload.title).toBe(DEFAULT_TITLE);
    expect(syncOptions.current!.savePayload.content).toBe('본문만 씀');
    await act(async () => { editorProps.current!.onTitleChange!('분기 회고'); });
    expect(syncOptions.current!.savePayload.title).toBe('분기 회고');
  });

  it('새 문서가 아니면(?new=1 없음) 제목이 «제목 없음»이어도 평소대로 — 값은 제목 그대로', async () => {
    await open(false);
    expect(editorProps.current!.title).toBe(DEFAULT_TITLE);
    expect(editorProps.current!.titlePlaceholder).toBe(PLAIN_PLACEHOLDER);
  });

  it('새 문서라도 제목이 이미 기본 글이 아니면(예: 이름을 붙인 뒤 새로고침) 값 그대로', async () => {
    docTitle = '이미 이름 있는 문서';
    await open(true);
    expect(editorProps.current!.title).toBe('이미 이름 있는 문서');
    expect(editorProps.current!.titlePlaceholder).toBe(PLAIN_PLACEHOLDER);
  });
});
