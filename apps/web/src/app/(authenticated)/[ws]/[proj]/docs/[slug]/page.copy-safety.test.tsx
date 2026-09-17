// @vitest-environment jsdom
//
// story #3986 CHANGES(페드루 PO 2회차 C2·C3 잔여) — 마크다운 복사 실패 패널이
// mdCopyFailed(3초 코스메틱 플래그)에 묶여 있어, 손으로 원문을 고를 시간이 있기도
// 전에 안내와 함께 원문 칸까지 통째로 사라졌다. 「직접 선택해 복사해 주세요」가
// 실제로 지킬 수 있는 말이 되려면, 원문 칸은 다음 성공(또는 닫기)까지 남아야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

const { routerMock, paramsMock } = vi.hoisted(() => ({
  routerMock: { replace: () => {}, push: () => {} },
  paramsMock: { slug: 'my-doc' },
}));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock,
  useRouter: () => routerMock,
}));
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
// DocEditor는 무거운 에디터라 목으로 대체하되, docActions(= 이 페이지가 만든
// 복사 버튼+실패 패널 JSX)는 실제로 전달된 그대로 렌더한다 — 목이 대신하는 건
// DocEditor 내부뿐, 복사-실패 로직 자체는 page.tsx 안에 있다.
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

let container: HTMLDivElement;
let root: Root;

const RAW_MARKDOWN = '# 제목\n\n본문 내용';

function makeFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('/api/docs?')) {
      return new Response(JSON.stringify({
        data: {
          id: 'doc-1',
          title: '테스트 문서',
          slug: 'my-doc',
          content: RAW_MARKDOWN,
          content_format: 'markdown',
          updated_at: '2026-09-01T00:00:00Z',
        },
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const DOCS_LAYOUT_CTX_VALUE = {
  wsSlug: 'moonklabs', projSlug: 'sprintable', projectId: 'proj-1',
  tree: [], setTree: () => {}, loading: false, loadError: false,
  handleNewDoc: () => {}, fetchTree: async () => {},
  pendingDocUpdate: null, clearPendingDocUpdate: () => {},
  expandFolder: () => {}, openTreeDrawer: () => {},
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DocsLayoutContext.Provider value={DOCS_LAYOUT_CTX_VALUE}>
        {node}
      </DocsLayoutContext.Provider>
    </NextIntlClientProvider>
  );
}

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  global.fetch = makeFetch() as unknown as typeof fetch;
  await act(async () => {
    root.render(wrap(<DocSlugPage />));
    await vi.advanceTimersByTimeAsync(50);
  });
}

describe('DocSlugPage — 마크다운 복사 실패 패널(story #3986 CHANGES)', () => {
  it('⭐복사 실패 3초가 지나도 원문 칸은 남아 있다(코스메틱 플래그와 분리)', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await mount();

    const copyBtn = container.querySelector('[aria-label="마크다운 복사"], [title]') as HTMLButtonElement;
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.includes('마크다운') || b.title.includes('마크다운'));
    expect(btn ?? copyBtn).toBeTruthy();
    await act(async () => { (btn ?? copyBtn).click(); await vi.advanceTimersByTimeAsync(0); });

    expect(container.querySelector('[data-testid="docs-copy-markdown-failed-raw"]')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });

    // 3초 코스메틱 타이머는 지났어도, 원문 칸은 그대로 남아야 한다.
    const raw = container.querySelector('[data-testid="docs-copy-markdown-failed-raw"]') as HTMLTextAreaElement | null;
    expect(raw).not.toBeNull();
    expect(raw!.value).toBe(RAW_MARKDOWN);
  });

  it('복사 성공 시엔 원문 칸이 없다', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await mount();

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.title.includes('마크다운'));
    await act(async () => { btn!.click(); await vi.advanceTimersByTimeAsync(0); });

    expect(container.querySelector('[data-testid="docs-copy-markdown-failed-raw"]')).toBeNull();
  });
});
