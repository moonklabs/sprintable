// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ConceptCardSection } from './concept-card-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// story #3560(제작 작업대 컨셉 카드, 페드루 PO 確定 2026-09-06) — 참조 doc이 있을 때만
// 그린다(「없음」 문구 X — 블록 자체를 안 그리는 쪽).
//
// story #3584(페드루 PO 確定 2026-09-06, 3573 라이브 표본 GET에서 발견) — 데이터
// 소스가 backlinks doc ∪ concept_approval 게이트의 sealed_doc_id/sealed_doc_title로
// 넓어져 두 엔드포인트(`/backlinks`·`/gates`)를 URL별로 갈라 스텁한다.
function stubFetch(opts: {
  backlinks?: { id: string; source_type: string; doc: { id: string; title: string } | null }[];
  gates?: { gate_type: string; sealed_doc_id?: string | null; sealed_doc_title?: string | null }[];
}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/backlinks')) {
      return new Response(JSON.stringify({ data: opts.backlinks ?? [] }), { status: 200 });
    }
    if (url.includes('/gates')) {
      return new Response(JSON.stringify(opts.gates ?? []), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null }), { status: 404 });
  }));
}

describe('ConceptCardSection — story #3560 ①-c · #3584 데이터 소스 확장', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      root.render(wrap(<ConceptCardSection workItemId="s1" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('참조 doc이 0건이면 블록 자체를 그리지 않는다(「없음」 문구 없음)', async () => {
    stubFetch({ backlinks: [], gates: [] });
    await mount();
    expect(container.querySelector('[data-testid="concept-card-section"]')).toBeNull();
  });

  it('doc 아닌 backlink(chat_message 등)만 있으면 여전히 안 그린다(doc만 거른다)', async () => {
    stubFetch({ backlinks: [{ id: 'bl-1', source_type: 'chat_message', doc: null }], gates: [] });
    await mount();
    expect(container.querySelector('[data-testid="concept-card-section"]')).toBeNull();
  });

  it('참조 doc이 있으면 블록이 뜨고 doc 제목이 보인다', async () => {
    stubFetch({
      backlinks: [{ id: 'bl-1', source_type: 'doc', doc: { id: 'doc-1', title: '9월 릴스 컨셉안' } }],
      gates: [],
    });
    await mount();
    const section = container.querySelector('[data-testid="concept-card-section"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('9월 릴스 컨셉안');
    expect(section?.textContent).toContain(koMessages.board.conceptCardTitle);
  });

  // story #3584 — 3573 표본이 실제로 이 모양이었다: backlinks 0건인데 concept_approval
  // 게이트가 sealed_doc_id/title을 물고 있는 경우.
  it('⭐backlinks가 0건이어도 concept_approval 게이트의 sealed_doc가 있으면 블록이 뜬다', async () => {
    stubFetch({
      backlinks: [],
      gates: [{ gate_type: 'concept_approval', sealed_doc_id: 'doc-g1', sealed_doc_title: '컨셉 v3' }],
    });
    await mount();
    const section = container.querySelector('[data-testid="concept-card-section"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('컨셉 v3');
  });

  it('concept_approval이 아닌 다른 게이트 타입의 sealed_doc는 무시한다', async () => {
    stubFetch({
      backlinks: [],
      gates: [{ gate_type: 'structure_approval', sealed_doc_id: 'doc-g1', sealed_doc_title: '구조안' }],
    });
    await mount();
    expect(container.querySelector('[data-testid="concept-card-section"]')).toBeNull();
  });

  it('⭐같은 doc이 backlinks·게이트 둘 다에 잡히면 중복 제거돼 한 번만 뜬다', async () => {
    stubFetch({
      backlinks: [{ id: 'bl-1', source_type: 'doc', doc: { id: 'doc-shared', title: '공유 컨셉안' } }],
      gates: [{ gate_type: 'concept_approval', sealed_doc_id: 'doc-shared', sealed_doc_title: '공유 컨셉안' }],
    });
    await mount();
    const section = container.querySelector('[data-testid="concept-card-section"]');
    const items = section?.querySelectorAll('li') ?? [];
    expect(items.length).toBe(1);
  });
});
