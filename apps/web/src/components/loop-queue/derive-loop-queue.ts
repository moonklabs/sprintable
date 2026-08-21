/**
 * story #2858(loop-closure P2, BE PR#3274) — 「닫히지 않은 루프」 전량 큐 페이지. BE
 * `GET /api/v2/loop-measure-due/queue`(detect_unclosed_loops()와 동일 3축 union, 발행
 * 부작용 0)를 그대로 소비한다 — org-briefing 클러스터(타입당 top-20 요약)와 달리 이 페이지는
 * «전부»가 목적이라 BE가 이미 페이지네이션(limit/offset)까지 낸다.
 *
 * href/cross-project 규율은 story #2842 정의분을 그대로 재사용한다(derive-attention-clusters.ts
 * export분) — 별도 이원화 금지.
 */
import { projectHref, crossProjectLabel, type ViewerContext } from '../org-briefing/derive-attention-clusters';

export type LoopQueueReason = 'measure_after_overdue' | 'done_without_outcome';
export type LoopQueueWorkItemType = 'hypothesis' | 'epic';

export interface RawLoopQueueItem {
  work_item_type: LoopQueueWorkItemType;
  work_item_id: string;
  title: string | null;
  owner_member_id: string | null;
  overdue_days: number | null;
  reason: LoopQueueReason | null;
  project_id: string | null;
}

export interface LoopQueuePage {
  items: RawLoopQueueItem[];
  total: number;
  limit: number;
  offset: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function workItemType(v: unknown): LoopQueueWorkItemType | null {
  return v === 'hypothesis' || v === 'epic' ? v : null;
}

function reason(v: unknown): LoopQueueReason | null {
  return v === 'measure_after_overdue' || v === 'done_without_outcome' ? v : null;
}

/** 실 payload → 검증된 페이지. work_item_type/work_item_id 없는 항목은 no-fiction상 표시 불가라 생략. */
export function parseLoopQueuePage(json: unknown): LoopQueuePage {
  const inner = isRecord(json) ? (json['data'] ?? json) : json;
  const itemsRaw = isRecord(inner) ? inner['items'] : null;
  const items: RawLoopQueueItem[] = [];
  if (Array.isArray(itemsRaw)) {
    for (const raw of itemsRaw) {
      if (!isRecord(raw)) continue;
      const type = workItemType(raw['work_item_type']);
      const id = str(raw['work_item_id']);
      if (!type || !id) continue;
      items.push({
        work_item_type: type,
        work_item_id: id,
        title: str(raw['title']),
        owner_member_id: str(raw['owner_member_id']),
        overdue_days: num(raw['overdue_days']),
        reason: reason(raw['reason']),
        project_id: str(raw['project_id']),
      });
    }
  }
  const meta = isRecord(inner) ? inner : {};
  return {
    items,
    total: num(meta['total']) ?? items.length,
    limit: num(meta['limit']) ?? items.length,
    offset: num(meta['offset']) ?? 0,
  };
}

// org-briefing 클러스터(derive-attention-clusters.ts)의 LoopKind와 동형 3분류 — 같은
// i18n 배지/일수 키를 재사용하기 위해 이름을 그대로 맞춘다.
export type LoopQueueKind = 'overdueHypothesis' | 'overdueGoal' | 'outcomeMissing';

function deriveKind(type: LoopQueueWorkItemType, r: LoopQueueReason | null): LoopQueueKind | null {
  if (type === 'hypothesis') return 'overdueHypothesis';
  if (type === 'epic' && r === 'measure_after_overdue') return 'overdueGoal';
  if (type === 'epic' && r === 'done_without_outcome') return 'outcomeMissing';
  return null; // BE 계약 밖 조합 — no-fiction, 행을 지어내지 않는다.
}

export interface LoopQueueItem {
  id: string;
  kind: LoopQueueKind;
  workItemType: LoopQueueWorkItemType;
  workItemId: string;
  title: string;
  overdueDays: number | null;
  ownerMemberId: string | null;
  href: string;
  crossProjectLabel: string | null;
}

// story #2830(유나 스티어③)와 동형 — 딥링크가 실제 outcome 판정 UI(flow 캔버스의 가설/goal
// 판정 표면)에 닿는다. goal href는 view=flow를 반드시 동반(PR#3257 근거 — 데스크톱
// parseView 기본값이 'hypothesis'라 focusGoalId가 조용히 드롭됨).
function bareHref(type: LoopQueueWorkItemType, id: string): string {
  return type === 'hypothesis' ? `/flow?hypothesis=${id}` : `/flow?view=flow&goal=${id}`;
}

/** `GET /api/projects` 응답(id/slug 등) → project_id→slug 맵. slug 없는(legacy) 프로젝트는 생략. */
export function parseProjectSlugMap(json: unknown): Record<string, string> {
  const inner = isRecord(json) ? (json['data'] ?? json) : json;
  const rows = Array.isArray(inner) ? inner : [];
  const out: Record<string, string> = {};
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const slug = str(raw['slug']);
    if (id && slug) out[id] = slug;
  }
  return out;
}

/**
 * raw 페이지 → 렌더 항목. viewer 미제공(구 호출부·테스트)이면 href는 bare path로 폴백
 * (#2842 규율). ⚠️이 BE 계약(§loop_measure_due.py)은 `project_id`만 낸다(my-actions처럼
 * project_slug를 함께 안 줌) — 그래서 FE가 별도로 `/api/projects`를 조회해 슬러그 맵을
 * 만들어 넘긴다(projectSlugById). 맵에 없는 project_id는 접근권 밖이거나 아직 못 불러온
 * 것이라 슬러그 없이 취급(bare path 폴백 — 지어내지 않음, no-fiction).
 */
export function deriveLoopQueueItems(
  items: RawLoopQueueItem[],
  t: (key: string) => string,
  viewer?: ViewerContext,
  projectSlugById: Record<string, string> = {},
): LoopQueueItem[] {
  const out: LoopQueueItem[] = [];
  items.forEach((it, idx) => {
    const kind = deriveKind(it.work_item_type, it.reason);
    if (!kind) return;
    const slug = it.project_id ? (projectSlugById[it.project_id] ?? null) : null;
    out.push({
      id: `${it.work_item_type}-${it.work_item_id}-${idx}`,
      kind,
      workItemType: it.work_item_type,
      workItemId: it.work_item_id,
      title: it.title ?? t('loopQueueUntitled'),
      overdueDays: it.overdue_days,
      ownerMemberId: it.owner_member_id,
      href: projectHref(viewer, slug, bareHref(it.work_item_type, it.work_item_id)),
      crossProjectLabel: crossProjectLabel(viewer, it.project_id, slug),
    });
  });
  return out;
}
