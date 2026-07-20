/**
 * 조직 브리핑 "지금" 면(story ded31cb3) — BE 계약 SSOT = 디디군 라우터 실측(command_center.py:50-220).
 *
 * ⚠️ FE 기존 타입(`dashboard/command-center/types.ts`)은 BE 실제 산출과 어긋난다 — `QueueItem.type`은
 * `gate_approval|review_merge`만 선언하나 BE는 `my_blockers`도 낸다(라인 133), `AttentionItem.type`은
 * `agent_stuck`만 선언하나 BE는 `story_stalled`/`unanswered_blocker`도 낸다(라인 178/204). 그 타입을
 * 그대로 가져다 쓰면 두 종류가 조용히 드롭된다 — 여기서는 원시 payload를 직접 파싱해 전 종류를 반영한다
 * (parseAttentionQueueSignals와 동형: 형상 불일치는 throw 0·조용히 생략, no-fiction).
 *
 * 데이터 = `/api/dashboard/my-actions`(action_queue=caller org-wide 결정대기·attention=org 자동감지) +
 * `/api/notifications?type=task_completed`(완료 보고). 신규 BE 0 — 두 기존 BFF만 조합.
 */

export type NowKind = 'decide' | 'signal' | 'done';

export interface NowFaceItem {
  id: string;
  kind: NowKind;
  kindLabel: string;
  title: string;
  context: string;
  actionLabel: string;
  actionTone: 'primary' | 'ghost';
  href: string;
  /** 정렬용 내부 우선순위(작을수록 상단) — 화면에 노출되지 않음(시간 낙인 금지). */
  priority: number;
}

export interface NowFaceTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface RawQueueItem {
  type: string;
  priority: string | null;
  title: string | null;
  context: Record<string, unknown>;
}

interface RawAttentionItem {
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  gate_type: string | null;
}

export interface RawMyActions {
  queue: RawQueueItem[];
  attention: RawAttentionItem[];
}

/** 실 payload → 검증된 raw 항목. 핵심 식별자 없는 항목은 링크를 지어낼 수 없어 생략(no-fiction). */
export function parseMyActions(json: unknown): RawMyActions {
  const inner = unwrapEnvelope(json);
  const queueRaw = isRecord(inner) && isRecord(inner['action_queue'])
    ? (inner['action_queue'] as Record<string, unknown>)['items'] : null;

  const queue: RawQueueItem[] = [];
  if (Array.isArray(queueRaw)) {
    for (const raw of queueRaw) {
      if (!isRecord(raw)) continue;
      const type = str(raw['type']);
      if (!type) continue;
      queue.push({
        type,
        priority: str(raw['priority']),
        title: str(raw['title']),
        context: isRecord(raw['context']) ? (raw['context'] as Record<string, unknown>) : {},
      });
    }
  }

  const attention: RawAttentionItem[] = [];
  const attentionItemsRaw = isRecord(inner) && isRecord(inner['attention'])
    ? (inner['attention'] as Record<string, unknown>)['items'] : null;
  if (Array.isArray(attentionItemsRaw)) {
    for (const raw of attentionItemsRaw) {
      if (!isRecord(raw)) continue;
      const type = str(raw['type']);
      if (!type) continue;
      attention.push({
        type,
        entity_type: str(raw['entity_type']),
        entity_id: str(raw['entity_id']),
        gate_type: str(raw['gate_type']),
      });
    }
  }

  return { queue, attention };
}

export interface RawCompletionNotification {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
}

/** `/api/notifications?type=task_completed` 응답 → 완료 보고 원시 항목. title 없는 항목은 제외(no-fiction). */
export function parseCompletionNotifications(json: unknown): RawCompletionNotification[] {
  const inner = unwrapEnvelope(json);
  const rows = Array.isArray(inner) ? inner : [];
  const out: RawCompletionNotification[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const title = str(raw['title']);
    if (!id || !title) continue;
    out.push({ id, title, body: str(raw['body']), href: str(raw['href']) });
  }
  return out;
}

const PRIORITY_RANK: Record<string, number> = { danger: 0, warn: 1, info: 2 };

function ctxStr(context: Record<string, unknown>, key: string): string | null {
  return str(context[key]);
}

/**
 * 원시 항목 → NowFace 렌더 항목. 3종 매핑(doc §1.3): 결정 대기(게이트 승인·리뷰·블로커)/이상 신호
 * (에이전트 정체·스토리 정체·응답없는 블로커)/완료 보고(task_completed 알림). 액션 위계(§1.3): 결정
 * 대기 중 최우선 1건만 primary, 나머지 ghost — 우발 mutation 방지 위해 전부 상세 표면으로 네비게이션만
 * (즉시 mutation 0, action-zone.tsx의 동일 원칙 재사용).
 */
export function buildNowFace(raw: RawMyActions, notifications: RawCompletionNotification[], t: NowFaceTranslator): NowFaceItem[] {
  const items: NowFaceItem[] = [];

  for (const q of raw.queue) {
    if (q.type === 'gate_approval') {
      items.push({
        id: `gate_approval-${ctxStr(q.context, 'gate_id') ?? ctxStr(q.context, 'approval_group_id') ?? items.length}`,
        kind: 'decide', kindLabel: t('kindDecide'),
        title: t('decideGateTitle'),
        context: t('decideGateContext'),
        actionLabel: t('actionApprove'), actionTone: 'ghost',
        href: '/inbox?tab=gates',
        priority: PRIORITY_RANK[q.priority ?? 'info'] ?? 2,
      });
    } else if (q.type === 'review_merge') {
      const storyId = ctxStr(q.context, 'story_id');
      items.push({
        id: `review_merge-${storyId ?? items.length}`,
        kind: 'decide', kindLabel: t('kindDecide'),
        title: q.title ?? t('decideReviewGenericTitle'),
        context: t('decideReviewContext'),
        actionLabel: t('actionReview'), actionTone: 'ghost',
        href: storyId ? `/board?story=${storyId}` : '/board',
        priority: 10 + (PRIORITY_RANK[q.priority ?? 'info'] ?? 2),
      });
    } else if (q.type === 'my_blockers') {
      const blockedId = ctxStr(q.context, 'blocked_story_id');
      items.push({
        id: `my_blockers-${blockedId ?? items.length}`,
        kind: 'decide', kindLabel: t('kindDecide'),
        title: t('decideBlockerTitle'),
        context: t('decideBlockerContext'),
        actionLabel: t('actionReview'), actionTone: 'ghost',
        href: blockedId ? `/board?story=${blockedId}` : '/board',
        priority: -1, // danger — 내가 남을 막고 있음, 최우선.
      });
    }
  }

  for (const a of raw.attention) {
    if (a.type === 'agent_stuck') {
      items.push({
        id: `agent_stuck-${a.entity_id ?? items.length}`,
        kind: 'signal', kindLabel: t('kindSignal'),
        title: t('signalAgentStuckTitle'),
        // a.gate_type는 BE 내부 워크플로우 슬러그(예: merge/loop_decision) — 번역 사전이 없어 그대로
        // 노출하면 원시 enum 유출이 된다(카피 스윕 §3-4). 고정 문구만 쓴다(no-fiction).
        context: t('signalAgentStuckContext'),
        actionLabel: t('actionOpen'), actionTone: 'ghost',
        href: a.entity_type === 'story' && a.entity_id ? `/board?story=${a.entity_id}` : '/inbox?tab=gates',
        priority: 20,
      });
    } else if (a.type === 'story_stalled') {
      items.push({
        id: `story_stalled-${a.entity_id ?? items.length}`,
        kind: 'signal', kindLabel: t('kindSignal'),
        title: t('signalStalledTitle'),
        context: t('signalStalledContext'),
        actionLabel: t('actionOpen'), actionTone: 'ghost',
        href: a.entity_id ? `/board?story=${a.entity_id}` : '/board',
        priority: 21,
      });
    } else if (a.type === 'unanswered_blocker') {
      items.push({
        id: `unanswered_blocker-${a.entity_id ?? items.length}`,
        kind: 'signal', kindLabel: t('kindSignal'),
        title: t('signalBlockerTitle'),
        context: t('signalBlockerContext'),
        actionLabel: t('actionOpen'), actionTone: 'ghost',
        href: a.entity_id ? `/board?story=${a.entity_id}` : '/board',
        priority: 22,
      });
    }
  }

  for (const n of notifications) {
    items.push({
      id: `task_completed-${n.id}`,
      kind: 'done', kindLabel: t('kindDone'),
      title: n.title,
      context: n.body ?? t('doneGenericContext'),
      actionLabel: t('actionConfirm'), actionTone: 'ghost',
      href: n.href ?? '/inbox',
      priority: 30,
    });
  }

  const sorted = items.sort((x, y) => x.priority - y.priority);
  const firstDecideIdx = sorted.findIndex((it) => it.kind === 'decide');
  if (firstDecideIdx >= 0) {
    const first = sorted[firstDecideIdx];
    if (first) first.actionTone = 'primary';
  }
  return sorted;
}
