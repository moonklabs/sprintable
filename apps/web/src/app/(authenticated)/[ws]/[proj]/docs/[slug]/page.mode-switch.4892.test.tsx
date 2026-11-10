// @vitest-environment jsdom
//
// story 4892 (UI-9 상세 열) — the EDITING screen carries the same «읽기 | 고치기» pair as the reading screen (it replaces the icon-only «미리보기» eye),
// with «고치기» as the current side; and the ⋯ menu trigger has a name now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

const { routerMock, paramsMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn() },
  paramsMock: { slug: 'my-doc' },
}));
vi.mock('next/navigation', () => ({ useParams: () => paramsMock, useRouter: () => routerMock }));
vi.mock('@/components/ui/human-only-action', () => ({ HumanOnlyAction: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
vi.mock('@/components/docs/use-doc-sync', () => ({
  useDocSync: () => ({ status: 'idle' as const, isDirty: false, save: () => Promise.resolve(), clearSyncAlerts: () => {} }),
  unwrapDocResponse: (json: unknown) => { const r = (json ?? {}) as { data?: unknown }; return { doc: r.data ?? r, updatedAt: undefined }; },
}));
vi.mock('@/components/docs/doc-editor', () => ({
  DocEditor: (props: { actions?: React.ReactNode; onNavigate?: (slug: string) => void }) => (
    <div>{props.actions}<button type="button" data-testid="editor-wiki-link" onClick={() => props.onNavigate?.('target-doc')} /></div>
  ),
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
const CTX = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1', tree: [], setTree: () => {}, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {}, pendingDocUpdate: null, clearPendingDocUpdate: () => {}, expandFolder: () => {}, openTreeDrawer: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount() {
  global.fetch = vi.fn(async (url: string) => (url.includes('/api/docs?')
    ? new Response(JSON.stringify({ data: { id: 'doc-1', title: '테스트', slug: 'my-doc', content: '# 제목', content_format: 'markdown', updated_at: '2026-09-01T00:00:00Z' } }), { status: 200 })
    : new Response('nf', { status: 404 }))) as unknown as typeof fetch;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocsLayoutContext.Provider value={CTX}><DocSlugPage /></DocsLayoutContext.Provider>
      </NextIntlClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(50);
  });
}

describe('DocSlugPage — 읽기 | 고치기 전환 (4892)', () => {
  it('⭐편집 화면에도 같은 «읽기 | 고치기» 한 쌍이 있고, 고치기가 지금 쪽이다', async () => {
    await mount();
    const group = container.querySelector('[data-slot="doc-mode-switch"]')!;
    expect(group, 'the mode switch').toBeTruthy();
    const [read, edit] = [...group.querySelectorAll('a')] as HTMLAnchorElement[];
    expect(read!.getAttribute('href')).toBe('/moonklabs/sprintable/docs/my-doc/view');
    expect(edit!.getAttribute('href')).toBe('/moonklabs/sprintable/docs/my-doc');
    expect(edit!.getAttribute('aria-current')).toBe('page');
    expect(read!.getAttribute('aria-current')).toBeNull();
  });

  it('옛 아이콘만 있던 «미리보기» 눈 링크는 더 없다(한 쌍으로 합쳐짐)', async () => {
    await mount();
    expect(container.querySelector(`a[aria-label="미리보기"]`)).toBeNull();
    expect(container.querySelector('svg.lucide-eye')).toBeNull();
  });

  it('⋯ 메뉴 단추에 이름이 있다', async () => {
    await mount();
    expect(container.querySelector(`button[aria-label="${koMessages.docs.moreActions}"]`)).toBeTruthy();
  });

  it('⭐편집기 안에서 [[위키 링크]] · 페이지 임베드를 누르면 대상 문서를 읽기 화면(/view)으로 연다', async () => {
    routerMock.push.mockClear();
    await mount();
    await act(async () => { (container.querySelector('[data-testid="editor-wiki-link"]') as HTMLButtonElement).click(); });
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/moonklabs/sprintable/docs/target-doc/view');
  });
});
