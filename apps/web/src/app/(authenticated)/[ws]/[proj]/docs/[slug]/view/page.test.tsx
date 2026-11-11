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

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'payments-v2' }), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
const { humanOnly } = vi.hoisted(() => ({ humanOnly: { current: true } }));
vi.mock('@/components/ui/human-only-action', () => ({ HumanOnlyAction: ({ children }: { children: React.ReactNode }) => (humanOnly.current ? <>{children}</> : null) }));
vi.mock('@/components/docs/use-doc-delete', () => ({ useDocDelete: () => deleteMock }));
vi.mock('@/components/docs/doc-share-dialog', () => ({
  DocShareDialog: ({ open, docId }: { open: boolean; docId: string }) => (open ? <div data-testid="share-dialog" data-doc-id={docId} /> : null),
}));
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
  useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE, setTree: vi.fn() });
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

  // story 4892 (UI-9 상세 열) — 리더의 제목은 옛 에디토리얼 글자(font-display · font-editorial-heading)가 아니라 ds 글자다 — 머리줄 안(text-ds-card-title · 시안의 머리줄 제목 크기).
  it('마스트헤드 h1은 ds 제목 글자를 입고, 페이지에 h1은 정확히 하나다', async () => {
    await mount();
    const h1s = container.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    const cls = h1s[0]!.className.split(/\s+/);
    expect(cls).toContain('text-ds-card-title');
    expect(cls).toContain('text-ds-ink');
    expect(cls).not.toContain('font-editorial-heading');
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
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE, setTree: vi.fn() });
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
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE, setTree: vi.fn() });
    fetchWithAuthMock.mockReturnValue(new Promise(() => {}));
    const { default: DocViewPage } = await import('./page');
    await act(async () => { root.render(wrap(<DocViewPage />)); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });

  it('⭐404 상태에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    useDocsLayoutMock.mockReturnValue({ wsSlug: 'ws1', projSlug: 'proj1', projectId: 'proj-id', tree: TREE, setTree: vi.fn() });
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    const { default: DocViewPage } = await import('./page');
    await act(async () => { root.render(wrap(<DocViewPage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });
});

// [SID:4356] 390/360 빵부스러기 «지식»이 한 글자 폭(10~12px)까지 줄어 «지 / 식»으로 꺾였다(nowrap flex · 한글 최소 폭 = 한 글자).
// jsdom은 배치를 안 해서 배치를 정하는 클래스를 못박는다(실제 폭은 헤드리스 Chromium 판 — PR 본문 표).
describe('DocViewPage — 빵부스러기 좁은 폭(4356)', () => {
  // 유나 CR(PR 4747) — 제목은 남는 자리만(flex-1 · 바탕 0 · 바닥 3rem) · 분류는 바탕 = 글자 폭(flex-1 아님)이라 짧은 분류가 통째로 남는다.
  // jsdom은 배치를 안 해서 여기선 클래스만 — 실제 폭은 e2e/mobile-width-overflow.spec.ts(짧은 분류 + 긴 제목 · 320/360/390)가 잰다.
  it('«지식» · 구분 «/»는 shrink-0(«지식»은 whitespace-nowrap) · 분류는 min-w-0 truncate(바탕 = 글자 폭) — 둘째 줄 · 제목은 머리 첫 줄 h1(min-w-[3rem] truncate)', async () => {
    await mount();
    const c = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);
    const sub = container.querySelector('[data-testid="docs-reader-subline"]')!;
    const rootLink = [...sub.querySelectorAll('a')].find((a) => a.textContent === koMessages.docs.breadcrumbKnowledgeRoot)!;
    expect(c(rootLink)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    const seps = [...sub.children].filter((el) => el.textContent === '/');
    expect(seps).toHaveLength(1);
    expect(c(seps[0])).toContain('shrink-0');
    const cat = [...sub.children].find((el) => el.textContent === '제품 스펙')!;
    expect(c(cat)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(c(cat)).not.toContain('flex-1');
    const title = container.querySelector('[data-testid="docs-reader-head"] h1')!;
    expect(c(title)).toEqual(expect.arrayContaining(['min-w-[3rem]', 'truncate']));
  });
});

describe('DocViewPage — 상세 열 읽기 화면이 ds 부품을 입는다 (4892)', () => {
  const editLink = () => [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('고치기')) as HTMLAnchorElement | undefined;

  it('⭐«고치기»는 «읽기 | 고치기» 한 쌍의 한쪽이고 편집기 주소로 간다 — 읽기 쪽이 지금 쪽(aria-current)', async () => {
    await mount();
    const group = container.querySelector('[data-slot="doc-mode-switch"]')!;
    expect(group.getAttribute('aria-label')).toBe(koMessages.docs.modeSwitchLabel);
    const [read, edit] = [...group.querySelectorAll('a')] as HTMLAnchorElement[];
    expect(read!.textContent).toBe('읽기');
    expect(edit!.textContent).toBe('고치기');
    expect(read!.getAttribute('href')).toBe('/ws1/proj1/docs/payments-v2/view');
    expect(edit!.getAttribute('href')).toBe('/ws1/proj1/docs/payments-v2');
    expect(read!.getAttribute('aria-current')).toBe('page');
    expect(edit!.getAttribute('aria-current')).toBeNull();
    expect(edit!.getAttribute('data-slot')).toBe('ds-button');
  });

  it('⭐읽기 화면에도 공유가 있다 — 공유 단추를 누르면 이 문서의 공유 창이 열린다', async () => {
    await mount();
    expect(container.querySelector('[data-testid="share-dialog"]')).toBeNull();
    const share = container.querySelector('[data-testid="docs-reader-share"]') as HTMLButtonElement;
    expect(share, 'the share button on the reading screen').toBeTruthy();
    expect(share.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(share.className.split(/\s+/)).toContain('hidden');
    expect(share.className.split(/\s+/)).toContain('lg:inline-flex');
    await act(async () => { share.click(); });
    expect(container.querySelector('[data-testid="share-dialog"]')?.getAttribute('data-doc-id')).toBe('d1');
  });

  it('⭐읽기 화면에도 ⋯ 메뉴가 있다 — 안에 공유(lg 미만 전용)와 삭제, 삭제는 같은 훅으로 간다', async () => {
    await mount();
    const trigger = container.ownerDocument.querySelector(`button[aria-label="${koMessages.docs.moreActions}"]`) as HTMLElement;
    expect(trigger, 'the ⋯ menu trigger').toBeTruthy();
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.click();
    });
    const doc = container.ownerDocument;
    const menuShare = doc.querySelector('[data-testid="docs-reader-menu-share"]') as HTMLElement;
    expect(menuShare.className.split(/\s+/)).toContain('lg:hidden');
    const del = doc.querySelector('[data-testid="docs-reader-menu-delete"]') as HTMLElement;
    expect(del.textContent).toContain('삭제');
    await act(async () => { del.click(); });
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('머리줄은 ds 선 · 바탕이고 뿌리 «지식» 링크는 목록으로 간다', async () => {
    await mount();
    const root = [...container.querySelectorAll('a')].find((a) => a.textContent === '지식') as HTMLAnchorElement;
    expect(root.getAttribute('href')).toBe('/ws1/proj1/docs');
    const bar = container.querySelector('[data-testid="docs-reader-head"]') as HTMLElement;
    const cls = bar.className.split(/\s+/);
    expect(cls).toContain('border-ds-line');
    expect(cls).toContain('bg-ds-background');
    expect(cls).not.toContain('bg-muted/20');
    expect(cls).not.toContain('h-10');                              // 고정 높이 아님 — 폰의 44 단추가 막대를 뚫지 않게 내용을 따른다
    expect(bar.contains(root)).toBe(true);                          // 경로는 머리줄 안(본문에 따로 서지 않는다)
  });

  it('⭐머리줄 = 1행(제목 h1 + 상태 · 오른쪽 동작) + 2행(경로 · 담당 · 갱신 · 읽기 분 · 버전) — 본문에는 제목 · 분류 · 메타가 다시 서지 않는다', async () => {
    await mount();
    const head = container.querySelector('[data-testid="docs-reader-head"]') as HTMLElement;
    const h1 = head.querySelector('h1')!;
    expect(h1.textContent).toBe('결제 스펙 v2');
    const status = head.querySelector('[data-testid="docs-reader-status"]')!;
    expect(status.textContent).toContain(koMessages.docs.docGatePending);             // DOC.status = pending
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();             // 상태 점
    const sub = head.querySelector('[data-testid="docs-reader-subline"]')!;
    for (const part of ['지식', '제품 스펙', '윤도선', 'v3']) expect(sub.textContent).toContain(part);
    expect(sub.textContent).toContain(koMessages.docs.readMinutes.replace('{minutes}', '1'));
    // 본문(article)엔 제목 · 분류 글 · 메타가 반복되지 않는다 — 머리줄에만
    const article = container.querySelector('article')!;
    expect(article.querySelector('h1')).toBeNull();
    expect(article.textContent).not.toContain('윤도선');
    expect(article.textContent).not.toContain('제품 스펙');
  });

  it('⭐머리는 줄바꿈 구조 — 제목 덩어리(바닥 폭)와 오른쪽 동작 무리가 따로이고, 좁으면 동작이 둘째 줄로 내려간다(320 · 360 · 390)', async () => {
    await mount();
    const head = container.querySelector('[data-testid="docs-reader-head"]') as HTMLElement;
    const row = head.firstElementChild as HTMLElement;
    const titleBlock = head.querySelector('h1')!.parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toContain('flex-wrap');
    expect(titleBlock.className.split(/\s+/)).toContain('basis-[11rem]');
    expect(titleBlock.className.split(/\s+/)).toContain('min-w-0');
    const actions = [...row.children].find((c) => c !== titleBlock) as HTMLElement;
    expect(actions.className.split(/\s+/)).toContain('ml-auto');
    expect(actions.className.split(/\s+/)).toContain('shrink-0');
    const sub = head.querySelector('[data-testid="docs-reader-subline"]') as HTMLElement;
    expect(sub.className.split(/\s+/)).toContain('flex-wrap');                         // 좁으면 메타가 다음 줄로 — 잘리지 않는다
  });

  it('오른쪽 레일의 선도 ds 선이다', async () => {
    await mount();
    const aside = container.querySelector('aside')!;
    expect(aside.className.split(/\s+/)).toContain('lg:border-ds-line');
  });
});

describe('DocViewPage — 읽기 전용 문서(스프린트 리포트)는 고치기 · 삭제를 내놓지 않는다 (4892)', () => {
  const REPORT = { ...DOC, doc_type: 'sprint_report' };

  it('⭐스프린트 리포트: «읽기 | 고치기» 한 쌍이 없고, 공유와 ⋯ 메뉴는 있되 메뉴에 삭제가 없다', async () => {
    await mount(REPORT as unknown as typeof DOC);
    expect(container.querySelector('[data-slot="doc-mode-switch"]')).toBeNull();
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === '고치기')).toBe(false);
    expect(container.querySelector('[data-testid="docs-reader-share"]')).toBeTruthy();
    const trigger = container.ownerDocument.querySelector(`button[aria-label="${koMessages.docs.moreActions}"]`) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(container.ownerDocument.querySelector('[data-testid="docs-reader-menu-share"]')).toBeTruthy();
    expect(container.ownerDocument.querySelector('[data-testid="docs-reader-menu-delete"]')).toBeNull();
  });

  it('보통 문서는 한 쌍도 삭제도 있다(위 가드가 일반 문서까지 지우지 않는다)', async () => {
    await mount();
    expect(container.querySelector('[data-slot="doc-mode-switch"]')).toBeTruthy();
  });
});

describe('DocViewPage — 에이전트가 ⋯ 메뉴를 열면 (4892)', () => {
  async function openMenu() {
    const trigger = container.ownerDocument.querySelector(`button[aria-label="${koMessages.docs.moreActions}"]`) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.click();
    });
  }
  afterEach(() => { humanOnly.current = true; });

  it('⭐사람: 공유 아래에 구분선과 삭제가 있다', async () => {
    humanOnly.current = true;
    await mount();
    await openMenu();
    expect(container.ownerDocument.querySelectorAll('[role="separator"]').length).toBe(1);
    expect(container.ownerDocument.querySelector('[data-testid="docs-reader-menu-delete"]')).toBeTruthy();
  });

  it('⭐에이전트: 삭제가 없으면 구분선도 없다(밑에 아무것도 없는 구분선 0)', async () => {
    humanOnly.current = false;
    await mount();
    await openMenu();
    expect(container.ownerDocument.querySelector('[data-testid="docs-reader-menu-share"]')).toBeTruthy();
    expect(container.ownerDocument.querySelector('[data-testid="docs-reader-menu-delete"]')).toBeNull();
    expect(container.ownerDocument.querySelectorAll('[role="separator"]').length).toBe(0);
  });
});

// story 4892 (UI-9 문서 상세 열) — 오른쪽 열 = 상태 · 목차 · 이력 패널(시안의 스레드 열처럼 본문 옆 상시 열). 상태 머리는 DOM에 한 번, 자리는 CSS 격자가 정한다(lg = 오른쪽 열 맨 위 · 그 아래 = 본문 위) —
// 미디어 쿼리 상태로 옮기면 첫 그림이 아래 폭으로 그려졌다 옮겨져 깜빡이고 이력 요청이 두 번 나갔다(codex).
describe('DocViewPage — 상태 머리 자리(CSS 격자 · 한 번만) · 목록 접힘 여백 (4892)', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

  it('⭐상태 머리는 DOM에 정확히 하나 · 본문(article) 앞에 서고(그 아래 폭에서 본문 위) lg에서는 오른쪽 열 1행에 앉는다', async () => {
    await mount();
    expect(container.querySelectorAll('[data-testid="status-header"]').length).toBe(1);
    const block = container.querySelector('[data-testid="docs-reader-status-block"]')!;
    const article = container.querySelector('article')!;
    expect(block.contains(container.querySelector('[data-testid="status-header"]'))).toBe(true);
    expect(block.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();   // DOM 순서: 상태 머리 → 본문
    expect(cls(block)).toEqual(expect.arrayContaining(['lg:col-start-2', 'lg:row-start-1', 'lg:border-l', 'lg:border-ds-line']));
    expect(article.contains(container.querySelector('[data-testid="status-header"]'))).toBe(false);
  });

  it('⭐lg 격자: 본문은 1열(2행에 걸침) · 오른쪽 열은 «상태(1행) → 목차 · 이력(2행)» — 같은 왼쪽 선이 이어진다', async () => {
    await mount();
    const article = container.querySelector('article')!;
    expect(cls(article)).toEqual(expect.arrayContaining(['lg:col-start-1', 'lg:row-span-2', 'lg:row-start-1']));
    const rail = container.querySelector('[data-testid="docs-reader-rail"]')!;
    expect(cls(rail)).toEqual(expect.arrayContaining(['lg:col-start-2', 'lg:row-start-2', 'lg:border-l', 'lg:border-ds-line']));
    expect(rail.querySelector('[data-testid="evidence-rail"]')).not.toBeNull();
    const grid = article.parentElement!;
    expect(cls(grid)).toEqual(expect.arrayContaining(['lg:grid-cols-[minmax(0,1fr)_316px]', 'lg:gap-y-0']));    // 행 사이 틈 0 → 선이 끊기지 않음
  });

  it('미디어 쿼리 상태로 옮기지 않는다(첫 그림 깜빡임 · 이력 요청 두 번 방지)', async () => {
    await mount();
    const src = (await import('./page.tsx?raw')).default as string;
    expect(src).not.toContain('use-media-query');
    expect(src).not.toMatch(/useMediaQuery/);
  });

  it('⭐목록 열을 접은 채일 때(펴기 단추가 머리 왼쪽 위로 뜸) 머리 왼쪽 여백이 늘어난다 — lg · 접힘 상태 클래스', async () => {
    await mount();
    const head = container.querySelector('[data-testid="docs-reader-head"]')!;
    expect(head.className.split(/\s+/)).toContain('lg:group-data-[collapsed=true]/docs:pl-14');
  });

  it('상태 칩은 공용 ds 칩(점 + 글) — 승인됨 · 검토 중 · 반려됨 · 초안이 각자 자기 톤으로', async () => {
    await mount({ ...DOC, status: 'confirmed' });
    const chip = container.querySelector('[data-testid="docs-reader-status"]')!;
    expect(chip.getAttribute('data-doc-status')).toBe('confirmed');
    expect(chip.textContent).toBe(koMessages.docs.docGateConfirmed);
    expect(chip.className).toContain('text-ds-done');
  });

  it('⋯ 메뉴는 ds Menu — 트리거는 이름 «더 보기»를 가진 단추(폰 touch:size-11) · 옛 DropdownMenu 아님', async () => {
    await mount();
    const trigger = container.querySelector(`button[aria-label="${koMessages.docs.moreActions}"]`)!;
    expect(trigger).not.toBeNull();
    expect(trigger.className.split(/\s+/)).toContain('touch:size-11');
    const src = (await import('./page.tsx?raw')).default as string;
    expect(src).toContain("from '@/components/ds/menu'");
    expect(src).not.toContain('ui/dropdown-menu');
  });
});
