import type { QueueItem, AttentionItem } from './types';

/**
 * story #2288 — 명세(`me-axis-screen-spec-2288`) §7-4·§8-4·§8-8 중 «재료 없이도 서는» 셋:
 * 잘림 표시 · 자르는 순서 · 자리를 비운 사이. 「사람 칸이 빈 세 뜻」·「태스크 줄」은
 * BE 재료(assignee_id·gate_type·Task 조인) 착지 후 별도 슬라이스로 간다(스토리 본문 참조).
 */

export interface VisibleQueueResult {
  visible: QueueItem[];
  cutCount: number;
}

/**
 * §8-4: 「남이 나를 기다리는 것」(결재 대기 gate_approval · 내가 막고 있음 my_blockers)은
 * 자를 때 제일 마지막이다 — 내 담당(review_merge)부터 자른다. 보호 항목이 cap을 넘으면
 * (구조적으로 드문 경우) 보호 항목은 자르지 않는다 — 「자르지 않는다」 규칙이 cap보다 우선.
 * cuttable(review_merge) 안에서는 BE가 이미 danger>warn>info로 정렬해 왔으므로 «뒤쪽부터»
 * 자른다(앞쪽=더 급한 것을 보존) — 원래 상대 순서는 그대로 유지, 재정렬은 하지 않는다.
 */
export function selectVisibleQueue(queue: QueueItem[], cap: number): VisibleQueueResult {
  if (queue.length <= cap) return { visible: queue, cutCount: 0 };
  const protectedItems = queue.filter((q) => q.type !== 'review_merge');
  const cuttableItems = queue.filter((q) => q.type === 'review_merge');
  const remainingSlots = Math.max(0, cap - protectedItems.length);
  const keptCuttable = new Set(cuttableItems.slice(0, remainingSlots));
  const visible = queue.filter((q) => q.type !== 'review_merge' || keptCuttable.has(q));
  return { visible, cutCount: queue.length - visible.length };
}

// ⛔세 목록 중 하나 — types.ts의 QueueItem.type 주석 참조(BE 실제 type ↔ 이 목록 ↔
// action-zone.tsx QueueRow의 렌더 분기, 셋이 같이 움직여야 한다 · PO 지적 2026-07-29).
// PO 재질문(2026-07-29): 코멘트는 "읽어야" 서는데, 타입으로 묶으면 "안 읽어도" 빨개진다 —
// Record<QueueItem['type'], true>는 TS가 모든 키를 요구하므로, QueueItem.type에 새 값이
// 추가되는데 여기 안 채우면 "Property '…' is missing" 컴파일 에러가 즉시 난다(Set이었을
// 때는 안 그랬다 — 조용히 새 값을 놓쳐도 컴파일이 통과했다).
const RENDERABLE_TYPES: Record<QueueItem['type'], true> = {
  gate_approval: true,
  review_merge: true,
  my_blockers: true,
  waiting_on_others: true,
};

export interface RenderableQueueResult {
  renderable: QueueItem[];
  unrenderableCount: number;
}

// PO 지적(2026-07-29): gate_type 원시값(BE enum 문자열)이 한국어 화면에 날것으로 나오던
// 결함 — 닫힌 집합(GATE_TYPES, backend/app/models/hitl_config.py: pr_review·qa·merge·deploy·
// workflow_config_publish + doc_approval은 backend/app/services/doc.py DOC_GATE_TYPE)이라
// 번역 맵을 둔다. i18n 키만 반환 — 실제 문구는 action-zone.tsx가 next-intl로 그린다.
const GATE_TYPE_LABEL_KEYS: Record<string, string> = {
  qa: 'ccGateTypeQa',
  pr_review: 'ccGateTypePrReview',
  merge: 'ccGateTypeMerge',
  deploy: 'ccGateTypeDeploy',
  workflow_config_publish: 'ccGateTypeWorkflowConfigPublish',
  doc_approval: 'ccGateTypeDocApproval',
};

/**
 * gate_type → i18n 키. 맵에 없는 값(미래 확장·오타 등)은 null — 호출부가 null일 때와
 * «같은 자리»(일반 라벨)로 떨어뜨린다. 원시값을 폴백으로 내보내지 않는다(PO 지적).
 */
export function gateTypeLabelKey(gateType: string | null | undefined): string | null {
  if (!gateType) return null;
  return GATE_TYPE_LABEL_KEYS[gateType] ?? null;
}

/**
 * story #2288, PO 지시(2026-07-29) — #2265 ChatProofSection의 skippedCount와 같은 관례:
 * QueueRow가 인식 못하는 타입은 개별 자리표시 줄로 하나씩 그리지 않고(소음), 목록에서
 * 걷어내 「N건은 표시할 수 없음」 요약 한 줄로만 말한다. 잘림(cutCount, selectVisibleQueue)과
 * 다른 사실이다 — 잘림은 「안 보여준다」(재료는 있음), 이건 「못 알아본다」(재료 형상 모름).
 */
export function splitRenderableQueue(queue: QueueItem[]): RenderableQueueResult {
  const renderable = queue.filter((q) => q.type in RENDERABLE_TYPES);
  return { renderable, unrenderableCount: queue.length - renderable.length };
}

const LAST_SEEN_KEY = 'sprintable:command-center:v1:last-seen-actions';

function readLastSeenMs(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeLastSeenMs(nowMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, String(nowMs));
  } catch {
    // 쓰기 실패(용량초과/프라이빗모드) — 조용히 무시, 다음 방문에서 다시 잰다.
  }
}

function countChangedSinceGeneric<T>(items: T[], lastSeenMs: number | null, getIso: (item: T) => string | null): number {
  if (lastSeenMs === null) return 0;
  return items.filter((item) => {
    const iso = getIso(item);
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t > lastSeenMs;
  }).length;
}

/**
 * §8-8 — 자리를 비운 사이 action_queue(담당·결재자·내가 막고 있음) 중 몇 건이 바뀌었는지.
 * 처음 방문(기준점 없음)은 0으로 — 「모름」을 「전부 새것」으로 지어내지 않는다.
 */
export function countChangedSince(queue: QueueItem[], lastSeenMs: number | null): number {
  return countChangedSinceGeneric(queue, lastSeenMs, (q) => q.created_at);
}

/**
 * story #2288, PO 확認(2026-07-29) — §8-8을 action_queue 3관계 밖으로 넓힌다: attention(감지
 * 신호, org-scope이나 「지금 볼 것」에 나와 이미 내가 보는 것)도 같은 자로 잰다. `stuck_since`를
 * 「생겨난 시점」으로 쓴다(created_at 없음 — 감지 시각이 그 역할). 별도 함수인 이유:
 * attention은 action_queue와 다른 배열·다른 타임스탬프 필드라 하나로 합칠 근거가 약하고,
 * 호출부(ActionZone)가 둘을 더해 하나의 배너로 보인다(계산은 분리, 표시만 합침 — §7-0 층3).
 */
export function countAttentionChangedSince(attention: AttentionItem[], lastSeenMs: number | null): number {
  return countChangedSinceGeneric(attention, lastSeenMs, (a) => a.stuck_since);
}

/** 방문 시 1회 호출 — 「지금」을 다음 방문의 기준점으로 남긴다. */
export function markSeenNow(nowMs: number): void {
  writeLastSeenMs(nowMs);
}

/** 렌더 전 읽기 전용 조회 — 쓰기와 분리해 사이드이펙트 시점을 호출부가 통제한다. */
export function getLastSeenMs(): number | null {
  return readLastSeenMs();
}

/**
 * `types.ts`의 `minutesSince`와 같은 이유로 별도 함수로 뺀다 — `Date.now()`를 컴포넌트
 * 렌더 본문에 직접 쓰면 react-hooks/purity가 "불순 함수 호출"로 막는다.
 */
export function minutesAgo(ms: number | null): number | null {
  if (ms === null) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}
