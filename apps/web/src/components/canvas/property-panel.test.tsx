import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PropertyPanel } from './property-panel';
import type { ArtifactNode } from '@/services/canvas-nodes';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('PropertyPanel (C3 §2 — 선택 요소 없으면 중립 안내, 낙인 문구 금지)', () => {
  it('renders a neutral empty-state message when no node is selected', () => {
    const markup = renderToStaticMarkup(wrap(<PropertyPanel node={null} onChangeText={vi.fn()} onDelete={vi.fn()} />));
    expect(markup).toContain('요소를 선택하면 속성이 여기 표시됩니다');
    expect(markup).not.toContain('<input');
  });

  it('renders the node type, text field pre-filled from node.props.text, and a delete action when a node is selected', () => {
    const node: ArtifactNode = { id: 'n1', type: 'Button', props: { text: '다시 결제하기' }, parent_id: null, sort_order: 0 };
    const markup = renderToStaticMarkup(wrap(<PropertyPanel node={node} onChangeText={vi.fn()} onDelete={vi.fn()} />));
    expect(markup).toContain('Button');
    expect(markup).toContain('다시 결제하기');
    expect(markup).toContain('삭제');
  });

  it('falls back to an empty text field (not a crash) when props.text is missing or non-string', () => {
    const node: ArtifactNode = { id: 'n2', type: 'Card', props: {}, parent_id: null, sort_order: 0 };
    const markup = renderToStaticMarkup(wrap(<PropertyPanel node={node} onChangeText={vi.fn()} onDelete={vi.fn()} />));
    expect(markup).toContain('value=""');
  });
});
