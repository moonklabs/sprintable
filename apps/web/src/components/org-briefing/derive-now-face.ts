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

// story #2852 — BE가 아는 사실 3종만 유효(AC3 raw enum 화면 노출 금지의 전제: 파싱 단계부터
// 화이트리스트로 걸러 알 수 없는 값을 조용히 지어내지 않는다, no-fiction).
function authFailureReason(v: unknown): 'expired' | 'revoked' | 'invalid' | null {
  return v === 'expired' || v === 'revoked' || v === 'invalid' ? v : null;
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
  // story #2842(0b17472c, BE PR#3263) — 항목의 실제 소속 프로젝트. bare href(예: `/flow?...`)는
  // 미들웨어가 뷰어의 "활성" 프로젝트 쿠키로 해석해버려, 다른 프로젝트 소속 항목을 클릭하면
  // 엉뚱한 프로젝트 캔버스로 떨어진다 — slug가 있어야 `/{orgSlug}/{projectSlug}/...` 완전
  // 경로를 지어 항목의 진짜 소속으로 못박을 수 있다.
  project_id: string | null;
  project_slug: string | null;
  // story #2852(2836 FE 조각, BE PR#3266) — `agent_auth_failure` 전용. windowed COUNT로
  // 판정된 (member_id, reason) 그룹 1건 = 항목 1건. member_id는 귀속 가능할 때만(없으면 이름
  // 폴백). reason은 서버가 아는 사실만(expired|revoked|invalid) — 화면엔 raw enum 노출 금지,
  // 유저 어휘로 매핑해서 보여준다(AC3).
  member_id: string | null;
  reason: 'expired' | 'revoked' | 'invalid' | null;
  failure_count: number | null;
  first_failed_at: string | null;
  last_failed_at: string | null;
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
        project_id: str(raw['project_id']),
        project_slug: str(raw['project_slug']),
        member_id: str(raw['member_id']),
        reason: authFailureReason(raw['reason']),
        failure_count: num(raw['failure_count']),
        first_failed_at: str(raw['first_failed_at']),
        last_failed_at: str(raw['last_failed_at']),
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

