// @vitest-environment jsdom
//
// story #2955 §3(doc docs-index-reader-redesign-handoff) — 셸 B "에디토리얼 리더" 페이지
// 배선 회귀가드. 하위 컴포넌트(DocStatusHeader/DocEvidenceRail/backlinks/본문 렌더러)는
// 각자 자기 테스트가 있으므로 여기선 스텁으로 대체 — 이 페이지 자체의 몫(breadcrumb,
// 마스트헤드, 읽기시간 파생, 카테고리 해소)만 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../../messages/ko.json';

const { useDocsLayoutMock, fetchWithAuthMock } = vi.hoisted(() => ({
  useDocsLayoutMock: vi.fn(),
  fetchWithAuthMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'payments-v2' }) }));
vi.mock('../../docs-context', () => ({ useDocsLayout: () => useDocsLayoutMock() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/components/docs/doc-status-rail', () => ({
  DocStatusHeader: ({ status }: { status?: string }) => <div data-testid="status-header">{status}</div>,
  DocEvidenceRail: ({ status }: { status?: string }) => <div data-testid="evidence-rail">{status}</div>,
}));
vi.mock('@/components/docs/doc-content-renderer', () => ({
  DocContentRenderer: ({ content }: { content: string }) => <div data-testid="content">{content}</div>,
}));
vi.mock('@/components/shared/entity-backlinks-section', () => ({
  EntityBacklinksSection: () => <div data-testid="backlinks" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
  fetchWithAuthMock.mockReset();
});

const TREE = [
  { id: 'f1', parent_id: null, title: '제품 스펙', slug: 'f1', icon: null, sort_order: 0, is_folder: true },
];

const DOC = {
  id: 'd1', title: '결제 스펙 v2', slug: 'payments-v2', content: '본문 '.repeat(600),
  content_format: 'markdown', status: 'pending', parent_id: 'f1',
  updated_at: '2026-08-21T00:00:00Z', assignee: { id: 'm1', name: '윤도선' }, revisions: { count: 3, latest_at: null },
};

async function mount() {
  useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE });
  fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ data: DOC }), { status: 200 }));
  const { default: DocViewPage } = await import('./page');
  await act(async () => { root.render(wrap(<DocViewPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('DocViewPage — 에디토리얼 리더 배선(§3)', () => {
  it('breadcrumb에 카테고리(부모 폴더 제목)와 문서 제목이 뜬다', async () => {
    await mount();
    expect(container.textContent).toContain('지식');
    expect(container.textContent).toContain('제품 스펙');
    expect(container.textContent).toContain('결제 스펙 v2');
  });

  it('마스트헤드 H1 + 담당자/버전 메타가 뜬다', async () => {
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('결제 스펙 v2');
    expect(container.textContent).toContain('윤도선');
    expect(container.textContent).toContain('v3');
  });

  // story #2974 §1/§3(PR-D0) — 리더 마스트헤드 h1이 font-display 토큰 경유(D0=Pretendard,
  // 시각 무변화).
  it('마스트헤드 h1이 font-display 토큰을 경유한다(#2974 D0 배선)', async () => {
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.className).toContain('font-display');
  });

  it('상태 헤더와 증거 레일에 문서 status가 그대로 배선된다', async () => {
    await mount();
    const header = container.querySelector('[data-testid="status-header"]');
    const rail = container.querySelector('[data-testid="evidence-rail"]');
    expect(header?.textContent).toBe('pending');
    expect(rail?.textContent).toBe('pending');
  });

  it('본문(DocContentRenderer)과 backlinks가 렌더된다', async () => {
    await mount();
    expect(container.querySelector('[data-testid="content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="backlinks"]')).toBeTruthy();
  });

  it('문서를 못 찾으면(404) notFound 문구를 보여준다', async () => {
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE });
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    const { default: DocViewPage } = await import('./page');
    await act(async () => { root.render(wrap(<DocViewPage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('찾을 수 없');
  });
});
