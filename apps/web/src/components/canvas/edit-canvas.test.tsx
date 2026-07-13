import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { EditCanvas } from './edit-canvas';
import type { ResolvedNode } from '@/services/canvas-nodes';
import koMessages from '../../../messages/ko.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('EditCanvas (C3 §2 — 클릭 선택만, 중첩 트리 재귀 렌더, story 1948d19d §3 — CanvasViewport 통합)', () => {
  it('renders nested children indented under their parent', () => {
    const tree: ResolvedNode[] = [
      {
        id: 'root', type: 'Container', props: {}, parent_id: null, sort_order: 0,
        children: [
          { id: 'child1', type: 'Text', props: { text: '안내 문구' }, parent_id: 'root', sort_order: 0, children: [] },
        ],
      },
    ];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('Container');
    expect(markup).toContain('Text');
    expect(markup).toContain('안내 문구');
  });

  it('falls back to the node type as the label when props.text is missing', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('Card');
  });

  it('applies the selected ring style only to the node matching selectedId', () => {
    const tree: ResolvedNode[] = [
      { id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] },
      { id: 'n2', type: 'Button', props: {}, parent_id: null, sort_order: 1, children: [] },
    ];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId="n2" onSelect={vi.fn()} />));
    const buttons = markup.split('<button').slice(1);
    expect(buttons[0]).not.toContain('ring-primary/40');
    expect(buttons[1]).toContain('ring-primary/40');
  });

  it('mounts the node tree on the shared CanvasViewport engine (edit mode — no duplicate inert TreeStageContent)', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('data-artifact-canvas-viewport');
    expect(markup).toContain('data-artifact-canvas-overlay');
    // fit/actual-size chrome renders too (edit mode still gets pan/zoom, per §3 "큰 뷰포트").
    expect(markup).toContain('전체 보기');
    expect(markup).toContain('실제 크기');
  });

  it('marks the node list as data-canvas-scrollable (PR#2138 — 긴 트리 내부 스크롤을 캔버스 pan에서 양보받는 마커)', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('data-canvas-scrollable');
  });
});
