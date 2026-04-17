/**
 * Tests for S-DOCS2 cross-parent D&D helpers
 *
 * isDescendant: pure function — safe to unit-test directly.
 * Drag guard logic mirrored by pure helpers below.
 */
import { describe, expect, it } from 'vitest';
import { isDescendant } from './doc-tree';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function doc(id: string, parent_id: string | null, sort_order = 0) {
  return { id, parent_id, title: id, slug: id, icon: null, sort_order };
}

// Tree:
//   root-a
//     child-a1
//       grandchild-a1a
//     child-a2
//   root-b
const DOCS = [
  doc('root-a', null, 0),
  doc('child-a1', 'root-a', 0),
  doc('grandchild-a1a', 'child-a1', 0),
  doc('child-a2', 'root-a', 1),
  doc('root-b', null, 1),
];

// ---------------------------------------------------------------------------
// isDescendant tests
// ---------------------------------------------------------------------------

describe('isDescendant', () => {
  it('returns true for direct child', () => {
    expect(isDescendant(DOCS, 'root-a', 'child-a1')).toBe(true);
  });

  it('returns true for grandchild (multi-level)', () => {
    expect(isDescendant(DOCS, 'root-a', 'grandchild-a1a')).toBe(true);
  });

  it('returns false for sibling', () => {
    expect(isDescendant(DOCS, 'child-a1', 'child-a2')).toBe(false);
  });

  it('returns false for ancestor (reverse direction)', () => {
    // child-a1 is NOT a descendant of grandchild-a1a
    expect(isDescendant(DOCS, 'child-a1', 'root-a')).toBe(false);
  });

  it('returns false for completely unrelated node', () => {
    expect(isDescendant(DOCS, 'root-a', 'root-b')).toBe(false);
  });

  it('returns false when nodeId does not exist', () => {
    expect(isDescendant(DOCS, 'root-a', 'nonexistent')).toBe(false);
  });

  it('returns false when ancestorId does not exist', () => {
    expect(isDescendant(DOCS, 'nonexistent', 'child-a1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drag guard helpers — mirror handleDragEnd logic in DocTree
// ---------------------------------------------------------------------------

type DragResult =
  | { action: 'same-parent-reorder' }
  | { action: 'cross-parent-move'; newParentId: string | null }
  | { action: 'blocked-circular' }
  | { action: 'blocked-no-permission' };

function simulateDrag(
  docs: ReturnType<typeof doc>[],
  activeId: string,
  overId: string,
  hasOnMove: boolean,
): DragResult {
  if (activeId === overId) throw new Error('same id — caller should skip');

  const activeDoc = docs.find((d) => d.id === activeId)!;
  const overDoc = docs.find((d) => d.id === overId)!;

  if (activeDoc.parent_id !== overDoc.parent_id) {
    if (isDescendant(docs, activeDoc.id, overDoc.id)) return { action: 'blocked-circular' };
    if (!hasOnMove) return { action: 'blocked-no-permission' };
    return { action: 'cross-parent-move', newParentId: overDoc.id };
  }

  return { action: 'same-parent-reorder' };
}

describe('drag guard logic', () => {
  it('same-parent drag → reorder', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'child-a2', true);
    expect(result.action).toBe('same-parent-reorder');
  });

  it('cross-parent drag with onMove → move to new parent', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'root-b', true);
    expect(result).toEqual({ action: 'cross-parent-move', newParentId: 'root-b' });
  });

  it('cross-parent drag without onMove → blocked (no-permission)', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'root-b', false);
    expect(result.action).toBe('blocked-no-permission');
  });

  it('circular drag (drop into own subtree) → blocked', () => {
    // Dragging root-a into grandchild-a1a (a descendant)
    const result = simulateDrag(DOCS, 'root-a', 'grandchild-a1a', true);
    expect(result.action).toBe('blocked-circular');
  });

  it('dragging leaf into sibling subtree root → cross-parent move', () => {
    // child-a2 into root-b (different parent); root-b becomes the new parent
    const result = simulateDrag(DOCS, 'child-a2', 'root-b', true);
    expect(result).toEqual({ action: 'cross-parent-move', newParentId: 'root-b' });
  });
});
