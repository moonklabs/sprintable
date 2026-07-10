/**
 * E-CANVAS C2 — 요소 앵커 코멘트 + 전파 상태 FE 타입. 핸드오프
 * `e-canvas-c2-comment-propagation-handoff` §1/§3 미러. BE(디디 C0/C2, `comment`/
 * `activity_event`) 계약 미착지 상태라 잠정 — §3-5 매핑 표가 실 계약이 되면 이 파일의
 * `PropagationState`만 정정하면 됨(컴포넌트는 그대로).
 */

/** §3-2 수신자별 상태 lifecycle. */
export type PropagationState = 'pending' | 'delivered' | 'read' | 'acting' | 'responded';

/** §3-3 스레드 rollup(헤더 배지). */
export type ThreadRollup = 'open' | 'in_progress' | 'resolved';

export type AnchorKind = 'element' | 'coordinate';

/** §1-1 앵커 종류 2가지 — element 우선(버전 넘어 요소 따라감), coordinate는 fallback. */
export interface CommentAnchor {
  kind: AnchorKind;
  element_id?: string;
  /** coordinate 앵커 전용 — 스테이지 상대 좌표(%). */
  x?: number;
  y?: number;
  /** coordinate 앵커가 어느 버전 기준인지(§1-2 "v3 기준 위치" 라벨). */
  pinned_at_version?: number;
}

export interface CommentRecipient {
  member_id: string;
  state: PropagationState;
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
  /** mock 편의 필드 — 실 계약에선 anchor.element_id로 artifact tree에서 유도. */
  element_label: string;
  anchor: CommentAnchor;
  rollup: ThreadRollup;
  comments: ArtifactComment[];
  recipients: CommentRecipient[];
  resolved_by?: string | null;
  resolved_at?: string | null;
  /** §3-4 결과 연결 — 이 코멘트가 입력이 된 버전 번호. */
  linked_version?: number | null;
}

/** §4 요소별 spec(description pane) — mock 편의상 element_id→설명 맵. */
export type DescriptionMap = Record<string, string>;

// ─── mock 데이터 (핸드오프 부록A `e-canvas-c2-propagation-mockup-render` 4상태 그대로) ──

export const MOCK_THREADS: CommentThread[] = [
  {
    id: 't1', artifact_id: 'mock-artifact-1', pin_number: 1, element_label: '결제 버튼',
    anchor: { kind: 'coordinate', x: 82, y: 30 },
    rollup: 'open',
    comments: [{ id: 'c1', author_id: 'm2', body: '위계 낮은. primary로 키우고 정본 위치 유지 바라는.', created_at: '2026-07-10T08:00:00Z' }],
    recipients: [{ member_id: 'm1', state: 'pending' }],
  },
  {
    id: 't2', artifact_id: 'mock-artifact-1', pin_number: 2, element_label: '에러 토스트',
    anchor: { kind: 'coordinate', x: 10, y: 68 },
    rollup: 'open',
    comments: [{ id: 'c2', author_id: 'm4', body: '거절 사유별 카피 분기 확認 필요한.', created_at: '2026-07-10T07:40:00Z' }],
    recipients: [{ member_id: 'm5', state: 'read' }, { member_id: 'm1', state: 'delivered' }],
  },
  {
    id: 't3', artifact_id: 'mock-artifact-1', pin_number: 3, element_label: '결제 버튼',
    anchor: { kind: 'element', element_id: 'pay-btn' },
    rollup: 'in_progress',
    comments: [{ id: 'c3', author_id: 'm2', body: '위계 낮은. primary로 키우고 정본 위치 유지 바라는.', created_at: '2026-07-10T06:00:00Z' }],
    recipients: [{ member_id: 'm1', state: 'responded' }],
    linked_version: 4,
  },
  {
    id: 't4', artifact_id: 'mock-artifact-1', pin_number: 4, element_label: '여백 간격',
    anchor: { kind: 'coordinate', x: 50, y: 50 },
    rollup: 'resolved',
    comments: [{ id: 'c4', author_id: 'm3', body: '섹션 간격 8→16 조정 요청.', created_at: '2026-07-09T09:00:00Z' }],
    recipients: [{ member_id: 'm1', state: 'responded' }],
    resolved_by: 'm1',
    resolved_at: '2026-07-09T10:00:00Z',
  },
];

export const MOCK_DESCRIPTIONS: DescriptionMap = {
  'pay-btn': 'variant=primary · 정본 위치=우하단 · 클릭 시 재시도 API 호출 · disabled=처리중',
};
