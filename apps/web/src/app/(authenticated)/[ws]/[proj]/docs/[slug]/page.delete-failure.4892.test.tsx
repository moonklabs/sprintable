// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #4) — the editor page's «삭제» menu item used to run an inline handler whose empty catch swallowed a failed delete.
// The hook has its own test (components/docs/use-doc-delete.test.tsx); this one pins the WIRING: the real page's menu item must reach the hook,
// so a refused DELETE shows the error toast and leaves the document (no redirect). Revert the page to the old inline handler (or unwire the
// hook) and the toast never comes → RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

const { routerMock, paramsMock, addToastMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn() },
  paramsMock: { slug: 'my-doc' },
  addToastMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock,
  useRouter: () => routerMock,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));
vi.mock('@/components/ui/human-only-action', () => ({ HumanOnlyAction: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
}));
const { docSyncMock } = vi.hoisted(() => ({
  docSyncMock: { status: 'idle' as const, isDirty: false, save: () => Promise.resolve(), clearSyncAlerts: () => {} },
}));
vi.mock('@/components/docs/use-doc-sync', () => ({
  useDocSync: () => docSyncMock,
  unwrapDocResponse: (json: unknown) => {
    const root = (json ?? {}) as { data?: unknown };
    return { doc: root.data ?? root, updatedAt: undefined };
  },
}));
vi.mock('@/components/docs/doc-editor', () => ({
  DocEditor: (props: { actions?: React.ReactNode }) => <div>{props.actions}</div>,
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
const ko = koMessages as unknown as { docs: { deleteFailed: string; deleteDoc: string } };

let container: HTMLDivElement;
let root: Root;
let deleteStatus = 500;
const fetchMock = vi.fn();

function makeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    fetchMock(url, init);
    if (init?.method === 'DELETE') return new Response(JSON.stringify({ error: 'nope' }), { status: deleteStatus });
    if (url.includes('/api/docs?')) {
      return new Response(JSON.stringify({
        data: { id: 'doc-1', title: '테스트 문서', slug: 'my-doc', content: '# 제목', content_format: 'markdown', updated_at: '2026-09-01T00:00:00Z' },
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const setTree = vi.fn();
const CTX = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1',
  tree: [], setTree, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {},
  pendingDocUpdate: null, clearPendingDocUpdate: () => {},
  expandFolder: () => {}, openTreeDrawer: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
  deleteStatus = 500;
  fetchMock.mockClear(); addToastMock.mockClear(); routerMock.replace.mockClear(); setTree.mockClear();
  vi.stubGlobal('confirm', vi.fn(() => true));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openMenuAndClickDelete() {
  global.fetch = makeFetch() as unknown as typeof fetch;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocsLayoutContext.Provider value={CTX}>
          <DocSlugPage />
        </DocsLayoutContext.Provider>
      </NextIntlClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(50);
  });
  const trigger = Array.from(container.ownerDocument.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-ellipsis, svg.lucide-more-horizontal'))
    ?? (Array.from(container.ownerDocument.querySelectorAll('[aria-haspopup="menu"]'))[0] as HTMLElement | undefined);
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    trigger!.click();
    await vi.advanceTimersByTimeAsync(20);
  });
  const item = Array.from(container.ownerDocument.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes(ko.docs.deleteDoc)) as HTMLElement | undefined;
  expect(item, 'the page shows a delete menu item').toBeTruthy();
  await act(async () => { item!.click(); await vi.advanceTimersByTimeAsync(20); });
}

describe('DocSlugPage — 삭제 메뉴는 use-doc-delete에 연결돼 있다(story 4892)', () => {
  it('⭐삭제가 거절되면 오류 토스트가 뜨고, 문서는 그대로(목록으로 이동 · 트리에서 제거 없음)', async () => {
    deleteStatus = 500;
    await openMenuAndClickDelete();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
    expect(addToastMock).toHaveBeenCalledWith({ title: ko.docs.deleteFailed, type: 'error' });
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(setTree).not.toHaveBeenCalled();
  });

  it('삭제가 되면 트리에서 빼고 목록으로 간다(토스트 없음)', async () => {
    deleteStatus = 200;
    await openMenuAndClickDelete();
    expect(addToastMock).not.toHaveBeenCalled();
    expect(setTree).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
  });
});
