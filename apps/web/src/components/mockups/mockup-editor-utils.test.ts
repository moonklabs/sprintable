import { describe, expect, it } from 'vitest';
import {
  alignSelectedComponents,
  componentCanContainChildren,
  distributeSelectedComponents,
  duplicateSelectedComponents,
  ensureSelectedIds,
  extractSelectedComponents,
  removeComponentsByIds,
  resolveMockupLayout,
  updateSelectedLayerOrder,
  type MockupComponent,
} from './mockup-editor-utils';

function component(overrides: Partial<MockupComponent> & Pick<MockupComponent, 'id' | 'component_type'>): MockupComponent {
  return {
    id: overrides.id,
    parent_id: overrides.parent_id ?? null,
    component_type: overrides.component_type,
    props: overrides.props ?? {},
    spec_description: overrides.spec_description ?? null,
    sort_order: overrides.sort_order ?? 0,
  };
}

describe('mockup-editor-utils', () => {
  it('extracts and duplicates a selected subtree', () => {
    const source = [
      component({ id: 'root', component_type: 'Container', props: { x: 0, y: 0, w: 200, h: 140, padding: 16 }, sort_order: 0 }),
      component({ id: 'child', parent_id: 'root', component_type: 'Button', props: { x: 12, y: 18, w: 40, h: 20, zIndex: 1 }, sort_order: 0 }),
      component({ id: 'sibling', component_type: 'Button', props: { x: 260, y: 0, w: 40, h: 20 }, sort_order: 1 }),
    ];

    const extracted = extractSelectedComponents(source, ['root']);
    expect(extracted.selectedIds).toEqual(['root']);
    expect(extracted.components.map((item) => item.id)).toEqual(['root', 'child']);

    const layout = resolveMockupLayout(extracted.components);
    const duplicated = duplicateSelectedComponents(extracted.components, layout.boxesById, extracted.selectedIds, {
      idFactory: (sourceId, index) => `copy-${sourceId}-${index}`,
    });

    expect(duplicated.selectedIds).toEqual(['copy-root-0']);
    expect(duplicated.components.map((item) => item.id)).toEqual(['root', 'child', 'copy-root-0', 'copy-child-1']);
    expect(duplicated.components.find((item) => item.id === 'copy-root-0')?.props.x).toBe(24);
    expect(duplicated.components.find((item) => item.id === 'copy-root-0')?.props.y).toBe(24);
    expect(duplicated.components.find((item) => item.id === 'copy-child-1')?.parent_id).toBe('copy-root-0');
    expect(duplicated.components.find((item) => item.id === 'copy-child-1')?.props.x).toBe(12);
    expect(duplicated.components.find((item) => item.id === 'copy-child-1')?.props.y).toBe(18);
  });

  it('aligns, distributes, and reorders sibling layers', () => {
    const source = [
      component({ id: 'a', component_type: 'Button', props: { x: 10, y: 10, w: 40, h: 20, zIndex: 0 }, sort_order: 0 }),
      component({ id: 'b', component_type: 'Button', props: { x: 60, y: 30, w: 40, h: 20, zIndex: 1 }, sort_order: 1 }),
      component({ id: 'c', component_type: 'Button', props: { x: 180, y: 50, w: 40, h: 20, zIndex: 10 }, sort_order: 2 }),
    ];
    const layout = resolveMockupLayout(source);

    const aligned = alignSelectedComponents(source, layout.boxesById, ['a', 'b'], 'left');
    expect(aligned.find((item) => item.id === 'a')?.props.x).toBe(10);
    expect(aligned.find((item) => item.id === 'b')?.props.x).toBe(10);

    const distributed = distributeSelectedComponents(source, layout.boxesById, ['a', 'b', 'c'], 'horizontal');
    expect(distributed.find((item) => item.id === 'a')?.props.x).toBe(10);
    expect(distributed.find((item) => item.id === 'b')?.props.x).toBe(95);
    expect(distributed.find((item) => item.id === 'c')?.props.x).toBe(180);

    const layeredFront = updateSelectedLayerOrder(source, layout.boxesById, ['a', 'b'], 'bringToFront');
    expect(layeredFront.find((item) => item.id === 'a')?.props.zIndex).toBe(11);
    expect(layeredFront.find((item) => item.id === 'b')?.props.zIndex).toBe(12);
    expect(layeredFront.find((item) => item.id === 'c')?.props.zIndex).toBe(10);

    const layeredBack = updateSelectedLayerOrder(source, layout.boxesById, ['a', 'b'], 'sendToBack');
    expect(layeredBack.find((item) => item.id === 'a')?.props.zIndex).toBe(-2);
    expect(layeredBack.find((item) => item.id === 'b')?.props.zIndex).toBe(-1);
    expect(layeredBack.find((item) => item.id === 'c')?.props.zIndex).toBe(10);
  });

  it('removes selected components with descendants and filters ids safely', () => {
    const source = [
      component({ id: 'root', component_type: 'Container', props: { x: 0, y: 0, w: 200, h: 140, padding: 16 }, sort_order: 0 }),
      component({ id: 'child', parent_id: 'root', component_type: 'Button', props: { x: 12, y: 18, w: 40, h: 20 }, sort_order: 0 }),
      component({ id: 'other', component_type: 'Button', props: { x: 260, y: 0, w: 40, h: 20 }, sort_order: 1 }),
    ];

    expect(componentCanContainChildren('Container')).toBe(true);
    expect(componentCanContainChildren('Button')).toBe(false);
    expect(ensureSelectedIds(['root', 'missing', 'other'], ['root', 'other'])).toEqual(['root', 'other']);
    expect(removeComponentsByIds(source, ['root']).map((item) => item.id)).toEqual(['other']);
  });
});
