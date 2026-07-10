import { describe, expect, it } from 'vitest';
import {
  resolveNodeTree, addNode, deleteNode, updateNodeProp, countNodeChanges, commitNodesToNextVersion,
  type ArtifactNode,
} from './canvas-nodes';

const BASE: ArtifactNode[] = [
  { id: 'root', type: 'Card', props: {}, parent_id: null, sort_order: 0 },
  { id: 'child-a', type: 'Text', props: { text: 'a' }, parent_id: 'root', sort_order: 0 },
  { id: 'child-b', type: 'Button', props: { text: 'b' }, parent_id: 'root', sort_order: 1 },
];

describe('resolveNodeTree', () => {
  it('builds a nested tree from a flat adjacency list, sorted by sort_order', () => {
    const tree = resolveNodeTree(BASE);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('root');
    expect(tree[0]!.children.map((c) => c.id)).toEqual(['child-a', 'child-b']);
  });

  it('respects sort_order even when the input array is out of order', () => {
    const shuffled = [BASE[2]!, BASE[0]!, BASE[1]!];
    const tree = resolveNodeTree(shuffled);
    expect(tree[0]!.children.map((c) => c.id)).toEqual(['child-a', 'child-b']);
  });
});

describe('addNode', () => {
  it('appends a new node with a fresh id as the last sibling under the given parent', () => {
    const result = addNode(BASE, 'Image', 'root');
    expect(result).toHaveLength(4);
    const added = result[3]!;
    expect(added.type).toBe('Image');
    expect(added.parent_id).toBe('root');
    expect(added.sort_order).toBe(2);
    expect(added.id).not.toBe('root');
  });

  it('supports adding a root-level node (parent_id null)', () => {
    const result = addNode(BASE, 'Card', null);
    const added = result[3]!;
    expect(added.parent_id).toBeNull();
    expect(added.sort_order).toBe(1); // one existing root ('root')
  });
});

describe('deleteNode', () => {
  it('removes the node and its entire subtree (no orphans)', () => {
    const withGrandchild: ArtifactNode[] = [
      ...BASE,
      { id: 'grandchild', type: 'Text', props: {}, parent_id: 'child-a', sort_order: 0 },
    ];
    const result = deleteNode(withGrandchild, 'child-a');
    expect(result.map((n) => n.id)).toEqual(['root', 'child-b']);
  });

  it('leaves unrelated nodes untouched', () => {
    const result = deleteNode(BASE, 'child-b');
    expect(result.map((n) => n.id)).toEqual(['root', 'child-a']);
  });
});

describe('updateNodeProp', () => {
  it('updates only the targeted node prop, leaving id/type/parent_id untouched', () => {
    const result = updateNodeProp(BASE, 'child-a', 'text', 'updated');
    const updated = result.find((n) => n.id === 'child-a')!;
    expect(updated.props['text']).toBe('updated');
    expect(updated.type).toBe('Text');
    expect(updated.parent_id).toBe('root');
  });
});

describe('countNodeChanges (CommitBar "변경 N건" — 활동량 아님)', () => {
  it('returns 0 when nothing changed', () => {
    expect(countNodeChanges(BASE, BASE)).toBe(0);
  });

  it('counts an add, a delete, and a prop edit as 3 total changes', () => {
    let current = addNode(BASE, 'Image', 'root');
    current = deleteNode(current, 'child-b');
    current = updateNodeProp(current, 'child-a', 'text', 'edited');
    expect(countNodeChanges(BASE, current)).toBe(3);
  });
});

describe('commitNodesToNextVersion (⭐node.id 버전 간 안정성 — C1 계약 §3이 C3로 defer)', () => {
  it('preserves the ids of untouched nodes across a commit (C2 앵커 생존의 전제)', () => {
    const edited = updateNodeProp(BASE, 'child-a', 'text', 'edited');
    const committed = commitNodesToNextVersion(edited);
    const survivor = committed.find((n) => n.id === 'child-a');
    expect(survivor).toBeDefined();
    expect(survivor!.props['text']).toBe('edited');
  });

  it('newly-added nodes keep their freshly-assigned id through commit (no reassignment)', () => {
    const withNew = addNode(BASE, 'Image', 'root');
    const newId = withNew[3]!.id;
    const committed = commitNodesToNextVersion(withNew);
    expect(committed.some((n) => n.id === newId)).toBe(true);
  });
});
