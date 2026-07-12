/**
 * E-CANVAS C3 — 편집 가능한 tree 포맷 노드. BE 계약 SSOT(`e-canvas-c1-be-contract` §3
 * `artifact_nodes`)와 동형: flat adjacency-list(`parent_id`+`sort_order`), `props: JSONB`.
 * 실 API 착지 시 이 파일의 fetch 어댑터만 새로 감싸면 됨 — 노드 조작 로직(add/delete/update)은
 * 이미 flat-list 위에서 동작해 그대로 재사용 가능.
 */

export interface ArtifactNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  parent_id: string | null;
  sort_order: number;
  /** E-CANVAS C2-S6 실 컬럼 — description pane("보이는 PRD"), 요소별 스펙 서술. */
  description?: string | null;
}

export interface ResolvedNode extends ArtifactNode {
  children: ResolvedNode[];
}

/** flat adjacency-list → 중첩 트리. BE가 항상 이 shape로 반환(전신 `/mockups` 패턴 계승). */
export function resolveNodeTree(nodes: ArtifactNode[]): ResolvedNode[] {
  const byParent = new Map<string | null, ArtifactNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parent_id) ?? [];
    list.push(n);
    byParent.set(n.parent_id, list);
  }
  const build = (parentId: string | null): ResolvedNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((n) => ({ ...n, children: build(n.id) }));
  return build(null);
}

/**
 * ⭐ E-CANVAS C1 계약(§3)이 C3로 defer한 결정: 편집으로 새 버전을 만들 때도 **살아있는 요소의
 * node.id는 보존**해야 C2 요소 앵커 코멘트가 버전을 넘어 같은 요소를 계속 가리킨다(핸드오프
 * §3/§10-6). 삭제된 노드의 id는 그냥 사라지고(재사용 안 함), 신규 추가 노드만 새 id를 받는다 —
 * 이 함수가 그 계약의 실제 구현: 인자로 받은 `nodes`를 그대로(id 변경 없이) 다음 버전의
 * snapshot으로 쓰면 되므로, 별도 "id 재발급" 로직 자체가 없다(재발급하지 않는 게 계약 준수).
 */
export function commitNodesToNextVersion(nodes: ArtifactNode[]): ArtifactNode[] {
  return nodes;
}

const now = () => new Date().toISOString();

function newNodeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `node-${Math.random().toString(36).slice(2)}`;
}

export function addNode(nodes: ArtifactNode[], type: string, parentId: string | null): ArtifactNode[] {
  const siblingCount = nodes.filter((n) => n.parent_id === parentId).length;
  const created: ArtifactNode = { id: newNodeId(), type, props: {}, parent_id: parentId, sort_order: siblingCount };
  return [...nodes, created];
}

/** 삭제 대상 + 하위 서브트리 전부 제거(고아 노드 방지). */
export function deleteNode(nodes: ArtifactNode[], id: string): ArtifactNode[] {
  const toRemove = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n.parent_id && toRemove.has(n.parent_id) && !toRemove.has(n.id)) {
        toRemove.add(n.id);
        changed = true;
      }
    }
  }
  return nodes.filter((n) => !toRemove.has(n.id));
}

export function updateNodeProp(nodes: ArtifactNode[], id: string, key: string, value: unknown): ArtifactNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, props: { ...n.props, [key]: value } } : n));
}

/** CommitBar의 "변경 N건" — 커밋되지 않은 로컬 변경 개수(추가+삭제+수정). raw 편집
 * 횟수(§4 감시-게이트에서 금지하는 지표)와 다르다 — 이건 "다음 버전에 뭐가 바뀌는지"의
 * 요약치일 뿐, 사람별/시간별로 쪼개거나 노출하지 않는다. */
export function countNodeChanges(baseline: ArtifactNode[], current: ArtifactNode[]): number {
  const baseMap = new Map(baseline.map((n) => [n.id, n]));
  const curMap = new Map(current.map((n) => [n.id, n]));
  let changes = 0;
  for (const id of curMap.keys()) if (!baseMap.has(id)) changes++;
  for (const id of baseMap.keys()) if (!curMap.has(id)) changes++;
  for (const [id, cur] of curMap) {
    const base = baseMap.get(id);
    if (base && JSON.stringify(base.props) !== JSON.stringify(cur.props)) changes++;
  }
  return changes;
}

export const PALETTE_TYPES = ['Container', 'Text', 'Button', 'Card', 'Image'] as const;

export const MOCK_EDITABLE_NODES: ArtifactNode[] = [
  { id: 'n-card', type: 'Card', props: {}, parent_id: null, sort_order: 0 },
  { id: 'n-title', type: 'Text', props: { text: '결제 복구' }, parent_id: 'n-card', sort_order: 0 },
  { id: 'n-btn', type: 'Button', props: { text: '다시 결제하기' }, parent_id: 'n-card', sort_order: 1 },
];

export { now as nowIso };
