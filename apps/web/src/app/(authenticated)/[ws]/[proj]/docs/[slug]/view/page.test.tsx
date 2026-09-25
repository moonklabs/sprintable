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
  DocContentRenderer: ({ content, wikiLinkTargets }: { content: string; wikiLinkTargets?: Record<string, string> | null }) => (
    <div data-testid="content" data-wiki-link-targets={JSON.stringify(wikiLinkTargets ?? null)}>{content}</div>
  ),
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

async function mount(doc: typeof DOC & { wiki_link_targets?: Record<string, string> } = DOC) {
  useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE });
  fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ data: doc }), { status: 200 }));
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
  // 시각 무변화). delta(PO/유나 지적 2026-08-24) — font-editorial-heading(무게 유틸, 820)도
  // 같이 있어야 한다(family-only 치환이 무게 820→400을 조용히 지웠던 회귀 재발 방지).
  it('마스트헤드 h1이 font-display+font-editorial-heading 둘 다 경유한다(#2974 D0 배선)', async () => {
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.className).toContain('font-display');
    expect(h1?.className).toContain('font-editorial-heading');
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

  // story #4313 — 문서 응답의 위키 링크 대응(적힌 slug → 지금 slug)을 렌더러로 넘긴다(렌더러는 여기 든 것만 링크 · 없으면 전부 글자 그대로).
  it('⭐문서 응답의 wiki_link_targets를 렌더러 wikiLinkTargets로 넘긴다', async () => {
    await mount({ ...DOC, wiki_link_targets: { onboarding: 'onboarding', 'old-name': 'new-name' } });
    expect(container.querySelector('[data-testid="content"]')?.getAttribute('data-wiki-link-targets')).toBe('{"onboarding":"onboarding","old-name":"new-name"}');
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

// story #3946(유나 확認·페드루 정정) — 이 페이지는 TopBarSlot을 직접 안 쓴다(그건
// docs-client-layout.tsx 몫) — 본문 마스트헤드(doc.title h1)가 이 페이지의 유일한 h1
// 후보다. doc이 아직 안 왔거나(로딩) 못 찾았을 때(404)도 그 h1이 없으면 0개가 되는 gap을
// sr-only 자리표시자로 메웠다 — 로딩·404·로디드 세 상태 각각 정확히 1개임을 고정한다.
describe('DocViewPage — 페이지 h1 1개(story #3946)', () => {
  it('⭐로디드 상태 — h1이 정확히 1개다(doc.title)', async () => {
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(DOC.title);
  });

  it('⭐로딩 상태(fetch 미해결)에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE });
    fetchWithAuthMock.mockReturnValue(new Promise(() => {}));
    const { default: DocViewPage } = await import('./page');
    await act(async () => { root.render(wrap(<DocViewPage />)); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });

  it('⭐404 상태에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE });
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    const { default: DocViewPage } = await import('./page');
    await act(async () => { root.render(wrap(<DocViewPage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });
});
