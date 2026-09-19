import { describe, expect, it } from 'vitest';
import type { MaterialLineageEdge } from '@/services/material-lineage';
import type { MaterialCollectionSheetHook } from '@/services/verify';
import {
  buildLineageTree, findLineageEdgeForDerived, filterLineageByHookKey, indexHooksByKey,
} from './material-lineage-tree';

// story #4058(doc c7991109 v3)/#4061 — #4046(recipe-role-slots.ts) 방식 순수 함수 테스트.
// material_lineage API가 아직 없어(doc §5 미착지) edges는 전부 합성 픽스처.

function edge(overrides: Partial<MaterialLineageEdge>): MaterialLineageEdge {
  return {
    id: 'edge-1', org_id: 'org-1', project_id: null,
    source_evidence_id: 'master-1', derived_kind: 'channel_post_draft', derived_id: 'draft-1',
    relation_kind: 'platform_cut', variant_axis: null, hook_key: null,
    work_item_id: 'story-1', created_by: null, created_at: '2026-09-19T00:00:00Z',
    ...overrides,
  };
}

describe('buildLineageTree', () => {
  it('source_evidence_id별로 묶고, 그 안에서 relation_kind별로 다시 가른다', () => {
    const edges = [
      edge({ id: 'e1', source_evidence_id: 'master-1', relation_kind: 'platform_cut', variant_axis: 'reels' }),
      edge({ id: 'e2', source_evidence_id: 'master-1', relation_kind: 'platform_cut', variant_axis: 'shorts' }),
      edge({ id: 'e3', source_evidence_id: 'master-1', relation_kind: 'hook_variant', hook_key: 'hook_a' }),
      edge({ id: 'e4', source_evidence_id: 'master-2', relation_kind: 'aspect_adapt' }),
    ];
    const tree = buildLineageTree(edges);
    expect(tree).toHaveLength(2);

    const master1 = tree.find((n) => n.sourceEvidenceId === 'master-1')!;
    expect(master1.variantsByRelationKind.platform_cut?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(master1.variantsByRelationKind.hook_variant?.map((e) => e.id)).toEqual(['e3']);
    expect(master1.variantsByRelationKind.aspect_adapt).toBeUndefined();

    const master2 = tree.find((n) => n.sourceEvidenceId === 'master-2')!;
    expect(master2.variantsByRelationKind.aspect_adapt?.map((e) => e.id)).toEqual(['e4']);
  });

  it('빈 목록이면 빈 트리(지어내지 않음)', () => {
    expect(buildLineageTree([])).toEqual([]);
  });
});

describe('findLineageEdgeForDerived', () => {
  it('derived_kind+derived_id로 정확히 하나를 찾는다', () => {
    const edges = [
      edge({ id: 'e1', derived_kind: 'channel_post_draft', derived_id: 'd1' }),
      edge({ id: 'e2', derived_kind: 'channel_publication', derived_id: 'p1' }),
    ];
    expect(findLineageEdgeForDerived(edges, 'channel_publication', 'p1')?.id).toBe('e2');
  });

  it('매치가 없으면 null(지어내지 않음)', () => {
    expect(findLineageEdgeForDerived([], 'channel_post_draft', 'ghost')).toBeNull();
  });
});

describe('filterLineageByHookKey', () => {
  it('hook_key가 일치하는 edge만 남긴다', () => {
    const edges = [
      edge({ id: 'e1', hook_key: 'hook_a' }),
      edge({ id: 'e2', hook_key: 'hook_b' }),
      edge({ id: 'e3', hook_key: null }),
    ];
    expect(filterLineageByHookKey(edges, 'hook_a').map((e) => e.id)).toEqual(['e1']);
  });
});

describe('indexHooksByKey', () => {
  it('key로 O(1) 조회 가능한 Map을 만든다', () => {
    const hooks: MaterialCollectionSheetHook[] = [
      { key: 'hook_a', text: '이거 안 써봤죠?', target: '20대' },
      { key: 'hook_b', text: '오늘만 이 가격', target: '전체' },
    ];
    const indexed = indexHooksByKey(hooks);
    expect(indexed.get('hook_a')?.text).toBe('이거 안 써봤죠?');
    expect(indexed.get('missing')).toBeUndefined();
  });
});
