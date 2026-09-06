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
describe('ConceptCardSection — story #3560 ①-c', () => {
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

  it('참조 doc이 0건이면 블록 자체를 그리지 않는다(「없음」 문구 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => {
      root.render(wrap(<ConceptCardSection workItemId="s1" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="concept-card-section"]')).toBeNull();
  });

  it('doc 아닌 backlink(chat_message 등)만 있으면 여전히 안 그린다(doc만 거른다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'bl-1', source_type: 'chat_message', source_id: 'msg-1', relation: 'none', still_exists: true, doc: null }],
    }), { status: 200 })));
    await act(async () => {
      root.render(wrap(<ConceptCardSection workItemId="s1" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="concept-card-section"]')).toBeNull();
  });

  it('참조 doc이 있으면 블록이 뜨고 doc 제목이 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'bl-1', source_type: 'doc', source_id: 'doc-1', relation: 'none', still_exists: true,
        doc: { id: 'doc-1', title: '9월 릴스 컨셉안' },
      }],
    }), { status: 200 })));
    await act(async () => {
      root.render(wrap(<ConceptCardSection workItemId="s1" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const section = container.querySelector('[data-testid="concept-card-section"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('9월 릴스 컨셉안');
    expect(section?.textContent).toContain(koMessages.board.conceptCardTitle);
  });
});
