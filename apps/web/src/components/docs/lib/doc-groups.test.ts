import { describe, expect, it } from 'vitest';
import { computeDocGroups, type GroupableDoc } from './doc-groups';

function doc(id: string, slug: string, parent_id: string | null = null): GroupableDoc {
  return { id, slug, parent_id, title: id };
}

describe('computeDocGroups', () => {
  it('2-토큰 접두어(e-canvas-*)가 3개 이상이면 그 접두어로 묶는다', () => {
    const docs = [
      doc('1', 'e-canvas-c4-handoff'),
      doc('2', 'e-canvas-c1-mockup'),
      doc('3', 'e-canvas-export-fix'),
      doc('4', 'unrelated-single-doc'),
    ];
    const { groups, ungrouped } = computeDocGroups(docs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('e-canvas');
    expect(groups[0]!.looseAtRoot.map((d) => d.id).sort()).toEqual(['1', '2', '3']);
    expect(ungrouped.map((d) => d.id)).toEqual(['4']);
  });

  it('2-토큰이 최소크기 미달이면 1-토큰 접두어로 재시도한다', () => {
    // "policy-kanban"·"policy-sprint"·"policy-story" — 2-토큰 키가 전부 달라 2-토큰으로는
    // 안 뭉치지만, 1-토큰 "policy"로는 3개 다 모인다.
    const docs = [
      doc('1', 'policy-kanban'),
      doc('2', 'policy-sprint'),
      doc('3', 'policy-story'),
    ];
    const { groups } = computeDocGroups(docs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('policy');
    expect(groups[0]!.looseAtRoot).toHaveLength(3);
  });

  it('최소 크기(3) 미만이면 그룹을 만들지 않고 ungrouped로 떨어진다', () => {
    const docs = [doc('1', 'onlyone-here'), doc('2', 'onlyone-there')];
    const { groups, ungrouped } = computeDocGroups(docs);
    expect(groups).toHaveLength(0);
    expect(ungrouped).toHaveLength(2);
  });

  it('AC5 — 같은 접두어면 parent_id(폴더 소속) 여부와 무관하게 한 그룹에 모이되, inFolder/looseAtRoot로 나뉜다', () => {
    const docs = [
      doc('1', 'policy-kanban', 'some-folder-id'),
      doc('2', 'policy-sprint', 'some-folder-id'),
      doc('3', 'policy-story', null), // 폴더 밖
    ];
    const { groups } = computeDocGroups(docs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.inFolder.map((d) => d.id).sort()).toEqual(['1', '2']);
    expect(groups[0]!.looseAtRoot.map((d) => d.id)).toEqual(['3']);
  });

  it('그룹은 멤버 수 내림차순으로 정렬된다', () => {
    const docs = [
      doc('a1', 'aaa-one'), doc('a2', 'aaa-two'), doc('a3', 'aaa-three'),
      doc('b1', 'bbb-one'), doc('b2', 'bbb-two'), doc('b3', 'bbb-three'), doc('b4', 'bbb-four'),
    ];
    const { groups } = computeDocGroups(docs);
    expect(groups.map((g) => g.key)).toEqual(['bbb', 'aaa']);
  });

  it('토큰이 하나뿐인 slug(하이픈 없음)도 1-토큰 그룹 대상이 된다', () => {
    const docs = [doc('1', 'research'), doc('2', 'research'), doc('3', 'research')];
    const { groups } = computeDocGroups(docs);
    expect(groups[0]!.key).toBe('research');
  });
});
