// @vitest-environment jsdom
//
// story e38d634f(doc resource-view-firsttouch-identity-pattern §4 "문서" 행): tree.length===0
// (진짜 빈 프로젝트)일 때만 지식 정체성 explainer가 뜨고, tree.length>0(문서 있음·미선택)이면
// 기존 "문서를 선택하세요" 카피가 완전 무변화로 유지되는지(가장 흔한 케이스라 이게 깨지면
// 임팩트가 큼) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDocsLayoutMock } = vi.hoisted(() => ({
  useDocsLayoutMock: vi.fn(),
}));

vi.mock('./docs-context', () => ({
  useDocsLayout: () => useDocsLayoutMock(),
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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount() {
  const { DocsEmptyView } = await import('./docs-empty-view');
  await act(async () => { root.render(wrap(<DocsEmptyView />)); });
}

describe('DocsEmptyView — 문서 first-touch 정체성', () => {
  it('tree가 진짜 빈 프로젝트(0건)면 지식 정체성 explainer가 렌더된다', async () => {
    useDocsLayoutMock.mockReturnValue({ handleNewDoc: vi.fn(), tree: [] });
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 쌓인 문서가 없어요');
    expect(html).toContain('문서는 조직의 지식과 결정, 맥락이 쌓이는 곳입니다');
    expect(html).toContain('새 문서');
    expect(html).not.toContain('문서를 선택하세요'); // 이 케이스에선 안 뜸
  });

  it('tree에 문서가 있으면(미선택 상태) 기존 "문서를 선택하세요" 카피가 완전 무변화로 유지된다 — 가장 흔한 케이스', async () => {
    useDocsLayoutMock.mockReturnValue({
      handleNewDoc: vi.fn(),
      tree: [{ id: 'd1', parent_id: null, title: '기획 문서', slug: 'plan', icon: null, sort_order: 0 }],
    });
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('문서를 선택하세요');
    // 정체성 explainer(진짜빈 전용 카피)는 여기 새면 안 됨 — 문서가 실재하는데 "아직 없어요"는 거짓.
    expect(html).not.toContain('아직 쌓인 문서가 없어요');
  });

  it('CTA(새 문서) 클릭 시 기존 handleNewDoc이 호출된다(신규 다이얼로그 없음) — 진짜빈 케이스', async () => {
    const handleNewDoc = vi.fn();
    useDocsLayoutMock.mockReturnValue({ handleNewDoc, tree: [] });
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('새 문서'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(handleNewDoc).toHaveBeenCalledOnce();
  });
});
