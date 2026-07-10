import { describe, expect, it } from 'vitest';
import { adaptComments, deriveAnchorKind, type BeArtifactComment } from './canvas-comments';

const BASE = {
  artifact_id: 'a1', anchor_x: null, anchor_y: null, node_id: null, parent_id: null,
  resolved: false, resolved_by: null, resolved_at: null,
};

describe('deriveAnchorKind (BE엔 anchor "kind"가 없다 — node_id 유무로 유도)', () => {
  it('returns element when node_id is present', () => {
    expect(deriveAnchorKind({ node_id: 'n1' })).toBe('element');
  });
  it('returns coordinate when node_id is null (좌표 핀)', () => {
    expect(deriveAnchorKind({ node_id: null })).toBe('coordinate');
  });
});

describe('adaptComments (flat parent_id 1단 스레드 → pin 번호 매긴 CommentThread[])', () => {
  it('groups root comments and their direct replies into a single thread, assigning pin_number by created_at order', () => {
    const comments: BeArtifactComment[] = [
      { ...BASE, id: 'c2', content: '두번째 스레드', created_by: 'm2', created_at: '2026-07-10T09:00:00Z' },
      { ...BASE, id: 'c1', content: '첫 스레드', created_by: 'm1', created_at: '2026-07-10T08:00:00Z' },
      { ...BASE, id: 'r1', content: '답글', created_by: 'm3', created_at: '2026-07-10T08:30:00Z', parent_id: 'c1' },
    ];
    const threads = adaptComments(comments);
    expect(threads).toHaveLength(2);
    expect(threads[0]!.pin_number).toBe(1);
    expect(threads[0]!.id).toBe('c1');
    expect(threads[0]!.comments).toHaveLength(2);
    expect(threads[0]!.comments[1]!.body).toBe('답글');
    expect(threads[1]!.pin_number).toBe(2);
  });

  it('derives rollup from the real resolved boolean only (no fabricated in_progress state)', () => {
    const comments: BeArtifactComment[] = [
      { ...BASE, id: 'c1', content: 'x', created_by: 'm1', created_at: '2026-07-10T08:00:00Z', resolved: true, resolved_by: 'm2', resolved_at: '2026-07-10T09:00:00Z' },
    ];
    const [thread] = adaptComments(comments);
    expect(thread!.rollup).toBe('resolved');
    expect(thread!.resolved_by).toBe('m2');
  });

  it('renames BE field names (content/created_by) to the FE-facing shape (body/author_id) without changing values', () => {
    const comments: BeArtifactComment[] = [
      { ...BASE, id: 'c1', content: '실 계약 내용', created_by: 'm4', created_at: '2026-07-10T08:00:00Z' },
    ];
    const [thread] = adaptComments(comments);
    expect(thread!.comments[0]).toMatchObject({ body: '실 계약 내용', author_id: 'm4' });
  });

  it('derives the element label from the anchored node (props.text over type), falling back to node type', () => {
    const comments: BeArtifactComment[] = [
      { ...BASE, id: 'c1', content: 'x', created_by: 'm1', created_at: '2026-07-10T08:00:00Z', node_id: 'n1' },
    ];
    const nodes = [{ id: 'n1', type: 'Button', props: { text: '다시 결제하기' } }];
    const [thread] = adaptComments(comments, nodes);
    expect(thread!.anchor.kind).toBe('element');
    expect(thread!.element_label).toBe('다시 결제하기');
  });

  it('builds a coordinate anchor from anchor_x/anchor_y when node_id is absent', () => {
    const comments: BeArtifactComment[] = [
      { ...BASE, id: 'c1', content: 'x', created_by: 'm1', created_at: '2026-07-10T08:00:00Z', anchor_x: 82, anchor_y: 30 },
    ];
    const [thread] = adaptComments(comments);
    expect(thread!.anchor).toMatchObject({ kind: 'coordinate', x: 82, y: 30 });
  });
});
