import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditCanvas } from './edit-canvas';
import type { ResolvedNode } from '@/services/canvas-nodes';

describe('EditCanvas (C3 §2 — 클릭 선택만, 중첩 트리 재귀 렌더)', () => {
  it('renders nested children indented under their parent', () => {
    const tree: ResolvedNode[] = [
      {
        id: 'root', type: 'Container', props: {}, parent_id: null, sort_order: 0,
        children: [
          { id: 'child1', type: 'Text', props: { text: '안내 문구' }, parent_id: 'root', sort_order: 0, children: [] },
        ],
      },
    ];
    const markup = renderToStaticMarkup(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />);
    expect(markup).toContain('Container');
    expect(markup).toContain('Text');
    expect(markup).toContain('안내 문구');
  });

  it('falls back to the node type as the label when props.text is missing', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />);
    expect(markup).toContain('Card');
  });

  it('applies the selected ring style only to the node matching selectedId', () => {
    const tree: ResolvedNode[] = [
      { id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] },
      { id: 'n2', type: 'Button', props: {}, parent_id: null, sort_order: 1, children: [] },
    ];
    const markup = renderToStaticMarkup(<EditCanvas tree={tree} selectedId="n2" onSelect={vi.fn()} />);
    const buttons = markup.split('<button').slice(1);
    expect(buttons[0]).not.toContain('ring-primary/40');
    expect(buttons[1]).toContain('ring-primary/40');
  });
});
