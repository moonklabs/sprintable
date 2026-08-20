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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

interface RawQueueItem {
  type: string;
  priority: string | null;
  title: string | null;
  context: Record<string, unknown>;
}

export interface RawAttentionItem {
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  gate_type: string | null;
  // ⛔PO 실측 결함(2026-08-09, 디디 그라운딩) — story_stalled/unanswered_blocker는
  // entity_type/entity_id를 아예 안 낸다(backend/app/routers/command_center.py:379-406).
  // story_stalled = {story_id, stalled_days} · unanswered_blocker = {blocked_story_id,
  // blocker_id, age_days} — 별개 키명이라 위 entity_id 파싱은 이 둘에선 항상 null이었고,
  // href가 매번 제네릭 /board로 떨어지고 id도 배열 index로 새 렌더마다 안 안정됐다.
  story_id: string | null;
  // story #2541 — 정체 클러스터 "일수순" 정렬·"N일째" 표시에 필요(BE가 이미 낸다,
  // command_center.py:379-406). 옛 NowFace 플랫 행은 감시-프레이밍 금지(§1.5/§1.7)로
  // 경과시간을 일부러 숨겼지만, 클러스터 보드는 유나 v4(PO (가) 결정, f01fa94a)가 "정체 N건"
  // dedup·정렬축으로 명시 채택 — «개별 신호마다 경과를 드러내 감시처럼 읽힌다»는 옛 금지의
  // 근거가, «묶어서 하나의 정체 지표로 보여준다»는 이 클러스터 형태에는 적용되지 않는다.
  stalled_days: number | null;
  blocked_story_id: string | null;
  // title은 story_stalled/unanswered_blocker(#2938)가 이미 배선함 — 없으면 폴백 문구.
  title: string | null;
  // story #2539(BE PR#2939) — 4번째 attention type `hypothesis_falsified`. "진행 중 가설이
  // 어긋나는 조짐"(in-flight)은 데이터 구조상 불가로 확認됐다(hypothesis_scorer.py가
  // outcome_result를 종결 분기에서만 채움) — 그래서 스코프는 "방금 반증으로 종결된 가설"
  // 결과 통보 하나뿐이다. severity=info(경고 아님), "이상감지" 뉘앙스 배제.
  hypothesis_id: string | null;
  statement: string | null;
  outcome_result: Record<string, unknown> | null;
  falsified_days: number | null;
  superseded_by_hypothesis_id: string | null;
  // story #2829(loop-closure P0, BE PR#3253) — 3번째 attention 유형군 `loop_overdue_hypothesis`
  // (hypothesis_id 재사용)·`loop_overdue_goal`/`loop_outcome_missing_goal`(goal_id 신규).
  // overdue_days/done_days는 stalled_days와 동형 정렬축(오래 묵은 것 먼저) — 별개 키인 이유는
  // 세 타입이 서로 다른 엔티티(가설/goal 2종)를 가리켜 도과일수와 done경과일수 의미가 갈려서다.
  goal_id: string | null;
  overdue_days: number | null;
  done_days: number | null;
}

export interface RawMyActions {
  queue: RawQueueItem[];
  attention: RawAttentionItem[];
  // story #2829 — attention 객체 최상위 스칼라 4종(items[] top-20 cap과 무관한 참값·doc a8e73bdb).
  loopOverdueHypothesisCount: number;
  loopOverdueGoalCount: number;
  loopOutcomeMissingGoalCount: number;
  measurePlanMissingGoalCount: number;
  // story #2843/#2844 — 명시 "측정 불가" 선언 goal 수(N 비포함·집계만, measure_plan_missing과
  // 동형 성격 — §4 위조 채널 감시용). 카드 하단 보조 텍스트 전용.
  unmeasurableGoalCount: number;
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

  const attentionObj = isRecord(inner) && isRecord(inner['attention'])
    ? (inner['attention'] as Record<string, unknown>) : null;

  const attention: RawAttentionItem[] = [];
  const attentionItemsRaw = attentionObj ? attentionObj['items'] : null;
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
        story_id: str(raw['story_id']),
        stalled_days: num(raw['stalled_days']),
        blocked_story_id: str(raw['blocked_story_id']),
        title: str(raw['title']),
        hypothesis_id: str(raw['hypothesis_id']),
        statement: str(raw['statement']),
        outcome_result: record(raw['outcome_result']),
        falsified_days: num(raw['falsified_days']),
        superseded_by_hypothesis_id: str(raw['superseded_by_hypothesis_id']),
        goal_id: str(raw['goal_id']),
        overdue_days: num(raw['overdue_days']),
        done_days: num(raw['done_days']),
      });
    }
  }

  return {
    queue,
    attention,
    loopOverdueHypothesisCount: (attentionObj && num(attentionObj['loop_overdue_hypothesis_count'])) ?? 0,
    loopOverdueGoalCount: (attentionObj && num(attentionObj['loop_overdue_goal_count'])) ?? 0,
    loopOutcomeMissingGoalCount: (attentionObj && num(attentionObj['loop_outcome_missing_goal_count'])) ?? 0,
    measurePlanMissingGoalCount: (attentionObj && num(attentionObj['measure_plan_missing_goal_count'])) ?? 0,
    unmeasurableGoalCount: (attentionObj && num(attentionObj['unmeasurable_goal_count'])) ?? 0,
  };
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
    } else if (a.type === 'unanswered_blocker') {
      items.push({
        id: `unanswered_blocker-${a.blocked_story_id ?? items.length}`,
        kind: 'signal', kindLabel: t('kindSignal'),
        title: t('signalBlockerTitle'),
        context: t('signalBlockerContext'),
        actionLabel: t('actionOpen'), actionTone: 'ghost',
        href: a.blocked_story_id ? `/board?story=${a.blocked_story_id}` : '/board',
        priority: 22,
      });
    }
    // story #2541 — story_stalled·hypothesis_falsified는 여기서 더는 flat 행으로 안 올린다.
    // 20줄 flood(story_stalled) 원인이 바로 이 자리였다 — 이제 attention-cluster-board.tsx
    // (deriveAttentionClusters)가 같은 raw.attention을 별도로 읽어 유형별 클러스터로 묶는다.
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
