/**
 * E-CANVAS C2 — 요소/좌표 앵커 코멘트 FE 타입.
 *
 * 실 BE(C2-S6, `26ebb7df`)를 직접 읽고 확인 — 이전 핸드오프 가설(§3 수신자별
 * pending/delivered/read/acting/responded 전파 상태)은 **실 데이터가 없다**: BE는
 * `comment.created` 이벤트를 fire-and-forget 알림 발송만 하고 수신/읽음/응답 상태를
 * 추적하지 않는다(진짜 아는 건 `resolved`(bool)·`resolved_by`·`resolved_at`뿐). 그 상태를
 * 그대로 흉내 내면 "읽었다/응답 중"을 꾸며내는 게 되고, 수신자별 읽음 추적 자체가 §1
 * 감시 리트머스에도 걸린다(오르테가/PO 승인, 2026-07-10) — 그래서 `PropagationState`/
 * `CommentRecipient`/`linked_version`/`pinned_at_version`은 이번에 전부 걷어냈다.
 * `ThreadRollup`도 실 데이터가 2단계(open/resolved)뿐이라 'in_progress'를 뺐다.
 */

export type ThreadRollup = 'open' | 'resolved';

export type AnchorKind = 'element' | 'coordinate';

/** 앵커 종류 2가지 — element(node_id, 버전 넘어 요소 따라감) 우선, coordinate는 fallback. */
export interface CommentAnchor {
  kind: AnchorKind;
  element_id?: string;
  /** coordinate 앵커 전용 — 스테이지 상대 좌표(%). */
  x?: number;
  y?: number;
}

export interface ArtifactComment {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface CommentThread {
  id: string;
  artifact_id: string;
  pin_number: number;
  /** element 앵커면 노드 타입/텍스트에서 유도, coordinate면 일반 라벨. */
  element_label: string;
  anchor: CommentAnchor;
  rollup: ThreadRollup;
  comments: ArtifactComment[];
  resolved_by?: string | null;
  resolved_at?: string | null;
  /** C3-S7 결과 연결(closed-loop) — 이 코멘트에 응답해 만들어진 버전 번호(있으면).
   * 주어=결과("이 피드백이 vN을 낳았다") — 누가/언제 응답했는지는 노출 안 함(§1). */
  resultVersion?: number | null;
}

// ─── mock 데이터 (컴포넌트 개발용 — 실 라우트에 노출 금지, mock-preview-slop 교훈) ──────

export const MOCK_THREADS: CommentThread[] = [
  {
    id: 't1', artifact_id: 'mock-artifact-1', pin_number: 1, element_label: '결제 버튼',
    anchor: { kind: 'coordinate', x: 82, y: 30 },
    rollup: 'open',
    comments: [{ id: 'c1', author_id: 'm2', body: '위계 낮은. primary로 키우고 정본 위치 유지 바라는.', created_at: '2026-07-10T08:00:00Z' }],
  },
  {
    id: 't2', artifact_id: 'mock-artifact-1', pin_number: 2, element_label: '에러 토스트',
    anchor: { kind: 'coordinate', x: 10, y: 68 },
    rollup: 'open',
    comments: [{ id: 'c2', author_id: 'm4', body: '거절 사유별 카피 분기 확認 필요한.', created_at: '2026-07-10T07:40:00Z' }],
  },
  {
    id: 't3', artifact_id: 'mock-artifact-1', pin_number: 3, element_label: '결제 버튼',
    anchor: { kind: 'element', element_id: 'pay-btn' },
    rollup: 'open',
    comments: [{ id: 'c3', author_id: 'm2', body: '위계 낮은. primary로 키우고 정본 위치 유지 바라는.', created_at: '2026-07-10T06:00:00Z' }],
  },
  {
    id: 't4', artifact_id: 'mock-artifact-1', pin_number: 4, element_label: '여백 간격',
    anchor: { kind: 'coordinate', x: 50, y: 50 },
    rollup: 'resolved',
    comments: [{ id: 'c4', author_id: 'm3', body: '섹션 간격 8→16 조정 요청.', created_at: '2026-07-09T09:00:00Z' }],
    resolved_by: 'm1',
    resolved_at: '2026-07-09T10:00:00Z',
  },
];

// ─── 실 API 어댑터 (BE `visual_artifacts.py` comments 엔드포인트, C2-S6) ──────────────

/** BE `ArtifactCommentResponse`(schemas/visual_artifact.py) 미러 — flat 응답. */
export interface BeArtifactComment {
  id: string;
  artifact_id: string;
  node_id: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  content: string;
  parent_id: string | null;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_by: string;
  created_at: string;
}

/** BE엔 anchor "kind" 필드가 없다 — node_id 유무로 클라이언트가 유도(C1 deriveFormat과 동형). */
export function deriveAnchorKind(comment: Pick<BeArtifactComment, 'node_id'>): AnchorKind {
  return comment.node_id != null ? 'element' : 'coordinate';
}

interface NodeLabelLookup {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

/** node.props.text가 있으면 그걸, 없으면 type을 라벨로 — PropertyPanel과 동일 관례. */
function labelForNode(node: NodeLabelLookup | undefined, fallback: string): string {
  if (!node) return fallback;
  const text = node.props['text'];
  return typeof text === 'string' && text.trim() ? text : node.type;
}

interface VersionSourceLookup {
  version_number: number;
  source_comment_id: string | null;
}

/**
 * C3-S7 결과 연결(closed-loop) — 버전 요약 목록만으로 "이 코멘트가 어느 버전을 낳았나"
 * 유도(신규 fetch 0, `ArtifactVersionSummary.source_comment_id`가 이미 읽기에 노출돼있음).
 * 같은 코멘트를 응답한 버전이 여럿이면 가장 최신(version_number 최대)만 표시.
 */
export function deriveResultLinks(versions: VersionSourceLookup[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const v of versions) {
    if (!v.source_comment_id) continue;
    const existing = result.get(v.source_comment_id);
    if (existing === undefined || v.version_number > existing) result.set(v.source_comment_id, v.version_number);
  }
  return result;
}

/**
 * flat 코멘트 목록(parent_id 얕은 1단 스레드 — 답글은 항상 루트에 붙는 UI 계약) →
 * pin 번호가 매겨진 스레드 목록. 루트(parent_id=null)만 pin_number를 받고 생성시각 순.
 * `versions`를 넘기면 결과 연결(resultVersion)도 같이 유도(생략 시 undefined).
 */
export function adaptComments(
  comments: BeArtifactComment[], nodes: NodeLabelLookup[] = [], versions: VersionSourceLookup[] = [],
): CommentThread[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const resultLinks = deriveResultLinks(versions);
  const roots = comments
    .filter((c) => c.parent_id === null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const repliesByParent = new Map<string, BeArtifactComment[]>();
  for (const c of comments) {
    if (c.parent_id === null) continue;
    const list = repliesByParent.get(c.parent_id) ?? [];
    list.push(c);
    repliesByParent.set(c.parent_id, list);
  }

  return roots.map((root, i) => {
    const kind = deriveAnchorKind(root);
    const replies = (repliesByParent.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const allComments = [root, ...replies].map((c) => ({ id: c.id, author_id: c.created_by, body: c.content, created_at: c.created_at }));
    return {
      id: root.id,
      artifact_id: root.artifact_id,
      pin_number: i + 1,
      element_label: kind === 'element'
        ? labelForNode(root.node_id ? nodeById.get(root.node_id) : undefined, root.node_id ?? '—')
        : '',
      anchor: kind === 'element'
        ? { kind, element_id: root.node_id ?? undefined }
        : { kind, x: root.anchor_x ?? undefined, y: root.anchor_y ?? undefined },
      rollup: root.resolved ? 'resolved' : 'open',
      comments: allComments,
      resolved_by: root.resolved_by,
      resolved_at: root.resolved_at,
      resultVersion: resultLinks.get(root.id) ?? null,
    };
  });
}
