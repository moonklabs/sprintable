// @vitest-environment jsdom
//
// story #2955 §2/§6(doc docs-index-reader-redesign-handoff) — 셸 A "지식 인덱스" 회귀가드.
// docs-empty-view.test.tsx(이 스토리로 대체·삭제됨)와 동형 관례: useDocsLayout()을 모킹해
// tree만 바꿔가며 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDocsLayoutMock, pushMock } = vi.hoisted(() => ({
  useDocsLayoutMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('./docs-context', () => ({
  useDocsLayout: () => useDocsLayoutMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount() {
  const { DocsIndex } = await import('./docs-index');
  await act(async () => { root.render(wrap(<DocsIndex />)); });
}

const BASE_CTX = { wsSlug: 'ws1', projSlug: 'proj1', handleNewDoc: vi.fn() };

describe('DocsIndex — 빈 프로젝트(문서 0건)', () => {
  it('"문서를 선택하세요" 대신 지식 정체성 explainer + 새 문서 CTA가 뜬다(§6 PO 요건②)', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree: [] });
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 쌓인 문서가 없어요');
    expect(html).not.toContain('문서를 선택하세요');
    expect(html).toContain('새 문서');
  });
});

describe('DocsIndex — 문서 있음(§2 마스트헤드+목록)', () => {
  const tree = [
    { id: 'f1', parent_id: null, title: '제품 스펙', slug: 'f1', icon: null, sort_order: 0, is_folder: true },
    { id: 'd1', parent_id: 'f1', title: '결제 스펙 v2', slug: 'payments-v2', icon: null, sort_order: 0, status: 'confirmed', updated_at: '2026-08-21T00:00:00Z' },
    { id: 'd2', parent_id: null, title: 'API 계약', slug: 'api-contract', icon: null, sort_order: 1, status: 'pending', updated_at: '2026-08-22T00:00:00Z' },
    { id: 'd3', parent_id: 'f1', title: '반려된 문서', slug: 'denied-doc', icon: null, sort_order: 2, status: 'denied', updated_at: '2026-08-18T00:00:00Z' },
  ];

  it('미선택 죽은 화면("문서를 선택하세요")을 재현하지 않고 인덱스가 뜬다', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    expect(container.textContent).not.toContain('문서를 선택하세요');
    expect(container.textContent).toContain('지식 · KNOWLEDGE BASE');
  });

  // story #2974 §1/§3(PR-D0) — Display 헤딩(마스트헤드 h1·리드 카드 h2)이 font-display
  // 토큰 경유(family)로 페이스를 받는다(D0 값=Pretendard·시각 무변화, 세리프 전환 전제조건).
  // delta(PO/유나 지적 2026-08-24) — font-editorial-heading(무게 유틸, 820)도 같이
  // 있어야 한다(family-only 치환이 무게 820→400을 조용히 지웠던 회귀 재발 방지).
  it('마스트헤드 h1·리드 h2가 font-display+font-editorial-heading 둘 다 경유한다(#2974 D0 배선)', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.className).toContain('font-display');
    expect(h1?.className).toContain('font-editorial-heading');
    const h2 = container.querySelector('h2');
    expect(h2?.className).toContain('font-display');
    expect(h2?.className).toContain('font-editorial-heading');
  });

  it('폴더(is_folder)는 목록 항목에서 제외되고 카테고리 필터로만 뜬다', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    const categoryButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('제품 스펙'));
    expect(categoryButtons.length).toBeGreaterThan(0); // 카테고리 필터엔 등장.
    // 목록 쪽엔 폴더 자체가 항목으로 안 뜬다(제목이 곧 카테고리명과 같은 우연 배제 위해 카운트로 확認).
    expect(container.textContent).toContain('3'); // 전체 문서 3건(폴더 제외).
  });

  it('가장 최근(updated_at) 문서가 리드(핀) 항목으로 상단에 뜬다', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    expect(container.textContent).toContain('핀');
    const leadButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('API 계약'));
    expect(leadButton?.textContent).toContain('핀'); // 가장 최근(8/22)인 API 계약이 리드.
  });

  it('상태 칩을 누르면 해당 상태 문서만 남는다(토글)', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    expect(container.textContent).toContain('결제 스펙 v2');
    expect(container.textContent).toContain('반려된 문서');

    const deniedChipButton = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') !== null && b.textContent?.includes('반려됨'));
    await act(async () => { deniedChipButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).not.toContain('결제 스펙 v2'); // confirmed — 필터링됨.
    expect(container.textContent).toContain('반려된 문서'); // denied — 유지.
  });

  it('카테고리를 누르면 그 폴더 산하 문서만 남는다', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    const categoryButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('제품 스펙'));
    await act(async () => { categoryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).not.toContain('API 계약'); // parent_id=null — 미분류, 이 카테고리 아님.
    expect(container.textContent).toContain('결제 스펙 v2');
    expect(container.textContent).toContain('반려된 문서');
  });

  // story #2967(선생님 실사용 판정 ⑤) — 원래는 리더(docViewUrl)로 갔으나, 트리 사이드바
  // (에디터 직행)와 목적지가 갈려 편집까지 2스텝이 되는 문제가 실사용에서 적발됐다. 인덱스도
  // 에디터 직행으로 되돌려 트리와 동선을 통일한다(리더는 에디터의 opt-in "미리보기" 링크로만).
  it('항목을 클릭하면 트리 사이드바와 동일하게 에디터(docUrl)로 직행한다', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    const item = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('결제 스펙 v2'));
    await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/ws1/proj1/docs/payments-v2');
  });

  it('격자 보기로 전환해도 문서 항목이 그대로 보인다(뷰 전환만, 데이터 손실 없음)', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    const gridToggle = container.querySelector('button[aria-label="격자"]') as HTMLElement;
    await act(async () => { gridToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('API 계약');
    expect(container.textContent).toContain('결제 스펙 v2');
  });

  it('필터 결과가 0건이면 "조건에 맞는 문서가 없습니다"를 보여준다(전체 0건과는 다른 문구)', async () => {
    useDocsLayoutMock.mockReturnValue({ ...BASE_CTX, tree });
    await mount();
    // confirmed+denied 둘 다 눌러 상호배타 아님을 이용해 존재 안 하는 조합(pending은 유지)이 아니라,
    // 카테고리를 "미분류"로 좁히고 draft 상태(존재 안 함)를 걸어 교집합 0을 만든다.
    const uncategorized = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('미분류'));
    await act(async () => { uncategorized!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const draftChip = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') !== null && b.textContent?.includes('초안'));
    await act(async () => { draftChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('조건에 맞는 문서가 없습니다');
  });
});
