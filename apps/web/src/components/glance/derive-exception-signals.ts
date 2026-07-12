import type { ProofState } from '@/components/proof-capsule/proof-capsule';
import {
  buildAttentionQueue,
  type AttentionQueueItem,
} from '@/components/attention-queue/derive-attention-queue';

/**
 * E-GLANCE 2D 예외 스트림 실신호 배선(story 0441a197) — BE `GET /api/v2/glance/attention`(#2097·
 * 594694dd)의 3신호를 예외 스트림 렌더 shape로 매핑한다.
 *
 * ⚠️ **AC1 크럭스(shape-safety)**: BE 응답은 flat 배열이 아니라 `AttentionResponse{items:[…]}`
 * envelope다(glance.py:38). 게다가 FE 프록시(app/api/glance/attention)가 `apiSuccess`로 한 번 더
 * 감싸 실제 payload는 `{data:{items:[…]}}`가 된다 — `/api/activity-logs {items,total,…}`를 배열인
 * 척 `.filter()` 호출해 매번 throw했던 로드맵 blank 전례와 동형(load-glance-data.ts 참고).
 * 따라서 unwrap을 방어적으로 하고, 형상 불일치(배열 아님·item 누락·미지 kind·title 없음)는
 * crash가 아니라 "그 항목 생략"으로 명시 처리한다(no-fiction: 지어내지 않고 빈 배열로 정직).
 */

export type ExceptionKind = 'gate_pending' | 'blocked' | 'merge_ready';

const KNOWN_KINDS = new Set<string>(['gate_pending', 'blocked', 'merge_ready']);

/** BE `AttentionItem`(glance.py:31) 미러 — 소비에 필요한 필드만·전부 nullable로 정직 취급. */
export interface BeAttentionSignal {
  kind: ExceptionKind;
  story_id: string | null;
  title: string;
  ref: Record<string, unknown>;
}

/** kind별 렌더 라벨(i18n·glance 네임스페이스). 순수 매퍼가 React 밖이라 값으로 주입받는다. */
export interface ExceptionLabels {
  kind: Record<ExceptionKind, string>;
  action: Record<ExceptionKind, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{data:{items}}`(프록시 wrap) → `{items}`(raw BE) → 둘 다 아니면 그대로. load-glance-data unwrap과 동형. */
function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

/**
 * 실 payload → 검증된 신호 배열. 형상 불일치는 전부 조용히 생략(throw 0). 미지 kind·title 없는
 * 항목은 claim을 지어낼 수 없으니 제외(no-fiction — deriveGateAttentionItems 규율 재사용).
 */
export function parseAttentionSignals(json: unknown): BeAttentionSignal[] {
  const inner = unwrapEnvelope(json);
  const rawItems = Array.isArray(inner) ? inner : isRecord(inner) ? inner['items'] : null;
  if (!Array.isArray(rawItems)) return [];

  const signals: BeAttentionSignal[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw)) continue;
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) continue;
    const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
    if (!title) continue; // 제목 없으면 정직한 claim 불가 → 생략
    const rawStory = raw['story_id'];
    const story_id = typeof rawStory === 'string' && rawStory ? rawStory : null;
    const ref = isRecord(raw['ref']) ? (raw['ref'] as Record<string, unknown>) : {};
    signals.push({ kind: kind as ExceptionKind, story_id, title, ref });
  }
  return signals;
}

const PROOF_BY_KIND: Record<ExceptionKind, ProofState> = {
  gate_pending: 'amber',
  blocked: 'amber',
  merge_ready: 'green',
};

const TONE_BY_KIND: Record<ExceptionKind, AttentionQueueItem['actionTone']> = {
  gate_pending: 'primary',
  blocked: 'neutral',
  merge_ready: 'ready',
};

/**
 * href 목적지 = "손을 대는 곳". gate_pending은 승인 표면인 게이트 인박스(`/inbox?tab=gates` —
 * GateInbox가 진짜 승인 경로·개별 게이트 딥링크는 doc 게이트만 가능), story 기반 신호는 보드의
 * 해당 스토리. story_id 없는 방어 케이스는 보드 루트로.
 */
function hrefFor(sig: BeAttentionSignal): string {
  if (sig.kind === 'gate_pending') return '/inbox?tab=gates';
  return sig.story_id ? `/board?story=${sig.story_id}` : '/board';
}

function idFor(sig: BeAttentionSignal, idx: number): string {
  if (sig.kind === 'gate_pending') {
    const approvalId = sig.ref['approval_id'];
    return `gate-${typeof approvalId === 'string' && approvalId ? approvalId : idx}`;
  }
  const key = sig.story_id ?? idx;
  return sig.kind === 'blocked' ? `blocked-${key}` : `merge-${key}`;
}

/**
 * 검증된 신호 → 예외 스트림 렌더 항목. actor는 이 엔드포인트가 담지 않으므로 null(assignee
 * 지어내지 않음)·sortKey=0(BE 타임스탬프 없음 — 위조 최신순 금지). buildAttentionQueue로 amber
 * (gate_pending·blocked) → green(merge_ready) 정렬만 재사용(cap=전량이라 drop 0).
 */
export function toExceptionQueueItems(
  signals: BeAttentionSignal[],
  labels: ExceptionLabels,
): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = signals.map((sig, idx) => ({
    id: idFor(sig, idx),
    kind: sig.kind,
    kindLabel: labels.kind[sig.kind],
    proofState: PROOF_BY_KIND[sig.kind],
    claim: sig.title,
    actor: null,
    actionLabel: labels.action[sig.kind],
    actionTone: TONE_BY_KIND[sig.kind],
    href: hrefFor(sig),
    sortKey: 0,
  }));
  return buildAttentionQueue(items, items.length).shown;
}
