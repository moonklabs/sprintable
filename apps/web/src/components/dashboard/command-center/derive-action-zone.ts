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

// action-zone.tsx QueueRow가 실제로 그릴 줄 아는 타입(PO 지적 2026-07-29 가드와 짝) — 여기서도
// 같은 목록을 쓴다. 하나만 두 곳에 흩어지면 그 자체가 「한 개념에 두 기준」이 된다.
const RENDERABLE_TYPES = new Set<QueueItem['type']>(['gate_approval', 'review_merge', 'my_blockers']);

export interface RenderableQueueResult {
  renderable: QueueItem[];
  unrenderableCount: number;
}

/**
 * story #2288, PO 지시(2026-07-29) — #2265 ChatProofSection의 skippedCount와 같은 관례:
 * QueueRow가 인식 못하는 타입은 개별 자리표시 줄로 하나씩 그리지 않고(소음), 목록에서
 * 걷어내 「N건은 표시할 수 없음」 요약 한 줄로만 말한다. 잘림(cutCount, selectVisibleQueue)과
 * 다른 사실이다 — 잘림은 「안 보여준다」(재료는 있음), 이건 「못 알아본다」(재료 형상 모름).
 */
export function splitRenderableQueue(queue: QueueItem[]): RenderableQueueResult {
  const renderable = queue.filter((q) => RENDERABLE_TYPES.has(q.type));
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
