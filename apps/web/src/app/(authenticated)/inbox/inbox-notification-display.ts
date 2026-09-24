import { composeEventPreviewLine, type EventPreviewHelpers } from '@/components/chat/event-block-card';
import { unescapeReferenceLabel, toPlainPreview } from '@/components/chat/entity-ref';
import { gateTypeLabel } from '@/lib/gate-type-label';

// story #3760(가드) — page.tsx(App Router 라우트 파일)는 Next.js export 화이트리스트 밖의
// named export를 가지면 tsc/vitest는 안 죽고 next build에서만 죽는다. 순수 로직은 이 파일로
// 뽑아 자유롭게 export한다(inbox-generic-notification-grouping.ts와 동일 관례).

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  reference_type: string | null;
  reference_id: string | null;
  href?: string | null;
  // story #3903(migration 0378, additive) — conversation.mention/conversation.message·
  // gate.pending_approval(story #4316 CHANGES1, payload.gate_type)만 채움. 렌더 시점에
  // 3888 eventCard 조합·제목 조합 재료로 쓴다. 없으면(옛 행·다른 발행 경로) title/body 폴백.
  event?: {
    sender_name?: string;
    event_key?: string;
    payload?: Record<string, unknown>;
    refs?: Record<string, string | null | { found: boolean; token?: string; type?: string; name?: string }>;
  } | null;
  created_at: string;
}

/**
 * story #3903 AC2 — 알림의 title/body를 렌더 시점에 조합한다(발행 시점 BE 고정 문구
 * 대신). `notification.event`(migration 0378)가 있을 때만 조합, 없으면(옛 행·다른 발행
 * 경로) 기존 title/body 그대로 — 과잉 일반화 금지(3888 composeEventPreviewLine의 기존
 * 계약과 동형).
 * - title: conversation.mention/conversation.message는 `event.sender_name`+`type`으로
 *   `inbox.mentionTitle`/`messageTitle`(신규 어간 0, BE 폴백 문구를 그대로 i18n 키로
 *   옮긴 것) 조합.
 * - body: `event.event_key`가 preset.*(이벤트 발행 메시지)면 composeEventPreviewLine
 *   (3888/3893과 완전히 같은 재료·같은 함수) 재사용 — raw preset 키·slug 0.
 * - gate.pending_approval(story #4316 CHANGES1, PO 라이브 실측 2026-09-15) — 결재함
 *   BE 고정 title/body 中 유일하게 합니다체가 남아 있던 자리(29곳 중 2곳). `event.payload.
 *   gate_type`이 있으면 gateTypeLabel(dashboard.ccGateType*, 기존 게이트 상세·결재함
 *   재사용 — 신규 어간 0)로 사람 낱말을 조합. reopen/신규 두 BE 문구를 FE 한 문장으로
 *   합친다(재제출 여부는 폴백 title/body에만 남고 FE 조합에선 구분 0 — 과잉 세분화 방지).
 */
// story #3940(PO 라이브 재잼 2026-09-16 06:05Z) — 2026-09-15 前(migration 0378 前) dispatch된
// 알림은 event가 없어 위 composeEventPreviewLine 경로를 못 타고, BE가 그 시절 저장한 body
// 원문(`[이벤트] {preset key}\n- work item: [라벨](entity:story:uuid)\n- 게이트: …\n- gate_id: …`,
// conversations.py의 옛 발행부가 만든 디버그성 문자열 — 200자에서 절삭 저장됨)이 그대로 노출된다
// (raw preset 키·마크다운 이스케이프·entity: 링크 안 raw UUID까지 전부 샌다). 실 API 재실측
// (/api/notifications?limit=50, 2026-09-16) 기준 표본 3+ 전부 이 정확한 2줄 머리 모양이었다 —
// «work item» 줄의 엔티티 참조 토큰만 파싱해 라벨을 뽑는다(entity-ref.ts의 unescapeReferenceLabel
// 재사용 — BE reference_token.py의 이스케이프와 정확히 대칭인 유일 SSOT, 새 이스케이프 규칙
// 발명 금지). 라벨을 못 뽑으면(모양이 다르거나 절삭으로 링크가 안 닫혔으면) null → 호출부가
// 기존 title/body 그대로 폴백(과잉 일반화 금지, 3888 계약과 동형). 이 폴백이 통째로 새 body
// 텍스트를 만들어 원문을 버리므로 entity: 링크 안 raw UUID·gate_id 뒤 raw UUID 전부 함께 걷힌다
// (3940 AC1 그라운딩 — "raw UUID 15건"은 이 body들 안의 entity:/gate_id UUID였음, 별도 표면 아님).
const LEGACY_EVENT_BODY_HEADER_KEY: Record<string, 'gateVerdictHeader' | 'statusChangedHeader' | 'workAssignedHeader' | 'goalMeasuredHeader'> = {
  'preset.gate.verdict': 'gateVerdictHeader',
  'preset.work.status_changed': 'statusChangedHeader',
  'preset.work.assigned': 'workAssignedHeader',
  'preset.goal.measured': 'goalMeasuredHeader',
};

const LEGACY_EVENT_BODY_RE = /^\[이벤트\]\s+(preset\.[a-z_.]+)\s*\n-\s*work item:\s*\[((?:\\.|[^[\]\\])*)\]\(entity:\w+:[0-9a-f-]+\)/i;

export function composeLegacyEventBodyFallback(body: string | null, tEventCard: EventPreviewHelpers['tEventCard']): string | null {
  if (!body) return null;
  const m = LEGACY_EVENT_BODY_RE.exec(body);
  if (!m) return null;
  const presetKey = m[1]!;
  const label = unescapeReferenceLabel(m[2]!);
  const headerKey = LEGACY_EVENT_BODY_HEADER_KEY[presetKey];
  return headerKey ? `${tEventCard(headerKey)} · ${label}` : label;
}

// story #4281 — 사람에게 가는 dispatched 알림(`agent_dispatch.py` `title=f"[{entity_type}] {title}"` · body = L2 휴리스틱의 기계 사유
// `l2_heuristics.py` · `l2_trigger_worker.py`)은 종류 키와 «743h 초과됨» 같은 원문 시간이 사람에게 그대로 갔다(ko 문자열이라 en에도).
// 저장된 문자열이라 옛 행 · 새 행 모두 **표시 시점**에 한 자리에서 바꾼다. 모양을 못 알아보면 원문 그대로(과잉 일반화 금지).
const DISPATCH_KIND_PREFIX_RE = /^\[(story|epic|sprint|doc|hypothesis)\]\s+/;
const HEURISTIC_DEADLINE_PASSED_RE = /^(sprint|epic|hypothesis) 마감이 (\d+)h 초과됨$/;
const HEURISTIC_DEADLINE_LEFT_RE = /^(sprint|epic|hypothesis) 마감까지 (\d+)h 남음\(임계 \d+h\)$/;
const HEURISTIC_IDLE_RE = /^(story|sprint)(?:\/([a-z-]+))? (\d+)h 무활동\(임계 \d+h\)$/;
const HEURISTIC_STATUS_CHANGED_RE = /^([a-z_]+) 상태 변경(?: → ([a-z-]+))?$/;

type HeuristicT = (key: string, values?: Record<string, string | number>) => string;

// 유나 확정(4281 스토리 본문 «디자인 확정» 표) — 종류 · 상태 낱말은 기존 화면 낱말(epic은 «목표» — v3 내비 `nav.goals`). 표 값으로
// 둬야 죽은 키 가드가 소비로 읽는다.
const HEURISTIC_KIND_KEYS: Record<string, string> = {
  story: 'heuristicKindStory', epic: 'heuristicKindGoal', sprint: 'heuristicKindSprint',
  hypothesis: 'heuristicKindHypothesis', doc: 'heuristicKindDoc',
};
const HEURISTIC_STATUS_KEYS: Record<string, string> = {
  'story:backlog': 'heuristicStatusStoryBacklog', 'story:ready-for-dev': 'heuristicStatusStoryReadyForDev',
  'story:in-progress': 'heuristicStatusStoryInProgress', 'story:in-review': 'heuristicStatusStoryInReview',
  'story:done': 'heuristicStatusStoryDone',
  'sprint:planning': 'heuristicStatusSprintPlanning', 'sprint:active': 'heuristicStatusSprintActive',
  'sprint:closed': 'heuristicStatusSprintClosed',
  'epic:active': 'heuristicStatusGoalActive', 'epic:done': 'heuristicStatusGoalDone', 'epic:archived': 'heuristicStatusGoalArchived',
};

/** 시간 원문(h)을 사람 단위로 — 1시간 미만 «1시간 미만» · 48시간 미만 시간 · 그 이상 일(÷24 반올림). */
export function humanizeHours(hours: number, t: HeuristicT): string {
  if (hours < 1) return t('heuristicDurationUnderHour');
  return hours < 48 ? t('heuristicDurationHours', { count: hours }) : t('heuristicDurationDays', { count: Math.round(hours / 24) });
}

// 유나 선검토(PO 전달) — 종류 · 상태 낱말은 조직 커스텀 라벨이 먼저(4281 본문 §5 «보드와 같은 순서»), 없으면 위 키 표.
// 상태 커스텀은 story에만 — 도메인 라벨의 status slug는 엔티티 구분이 없어 epic `done` 같은 겹치는 slug에 story 라벨이 붙는다.
export function composeDispatchedHeuristicDisplay(
  title: string, body: string | null, t: HeuristicT, domainLabels?: EventPreviewHelpers['domainLabels'],
): { title: string; body: string | null } {
  const titleMatch = DISPATCH_KIND_PREFIX_RE.exec(title);
  // 유나 — 제목은 앞 `[종류] `만 뗀다(종류는 본문 문장이 필요한 곳에서만 말한다).
  const nextTitle = titleMatch ? title.slice(titleMatch[0].length) : title;
  if (!body) return { title: nextTitle, body };
  const kindWord = (k: string) => {
    const key = HEURISTIC_KIND_KEYS[k];
    return key ? (domainLabels?.entityTypeLabel?.(k) ?? t(key)) : null;
  };
  const statusWord = (k: string, st: string | undefined) => {
    if (!st) return null;
    const custom = k === 'story' ? domainLabels?.statusLabel(st) : undefined;
    const key = HEURISTIC_STATUS_KEYS[`${k}:${st}`];
    return custom ?? (key ? t(key) : null);
  };
  let m = HEURISTIC_DEADLINE_PASSED_RE.exec(body);
  if (m && kindWord(m[1]!)) return { title: nextTitle, body: t('heuristicDeadlinePassed', { kind: kindWord(m[1]!)!, duration: humanizeHours(Number(m[2]), t) }) };
  m = HEURISTIC_DEADLINE_LEFT_RE.exec(body);
  if (m && kindWord(m[1]!)) return { title: nextTitle, body: t('heuristicDeadlineLeft', { kind: kindWord(m[1]!)!, duration: humanizeHours(Number(m[2]), t) }) };
  m = HEURISTIC_IDLE_RE.exec(body);
  if (m && kindWord(m[1]!)) {
    const duration = humanizeHours(Number(m[3]), t);
    const status = statusWord(m[1]!, m[2]);
    return {
      title: nextTitle,
      body: status
        ? t('heuristicIdleWithStatus', { duration, kind: kindWord(m[1]!)!, status })
        : t('heuristicIdle', { duration, kind: kindWord(m[1]!)! }),
    };
  }
  m = HEURISTIC_STATUS_CHANGED_RE.exec(body);
  if (m && kindWord(m[1]!)) {
    const status = statusWord(m[1]!, m[2]);
    // 유나 — 새 상태가 없거나 낱말표에 없으면 «…바뀌었어요.»에서 끝낸다(slug 노출 0).
    return {
      title: nextTitle,
      body: status
        ? t('heuristicStatusChangedTo', { kind: kindWord(m[1]!)!, status })
        : t('heuristicStatusChanged', { kind: kindWord(m[1]!)! }),
    };
  }
  return { title: nextTitle, body };
}

export function composeNotificationDisplay(
  notification: Notification,
  t: (key: string, values?: Record<string, string | number>) => string,
  eventPreviewHelpers: EventPreviewHelpers,
): { title: string; body: string | null } {
  const event = notification.event;
  let title = notification.title;
  let body = notification.body;

  if (event?.sender_name) {
    if (notification.type === 'conversation.mention') {
      title = t('mentionTitle', { name: event.sender_name });
    } else if (notification.type === 'conversation.message') {
      title = t('messageTitle', { name: event.sender_name });
    }
  }

  if (notification.type === 'dispatched') {
    ({ title, body } = composeDispatchedHeuristicDisplay(title, body, t, eventPreviewHelpers.domainLabels));
  }

  if (notification.type === 'gate.pending_approval' && typeof event?.payload?.['gate_type'] === 'string') {
    const gateTypeLbl = gateTypeLabel(eventPreviewHelpers.tDashboard, event.payload['gate_type']);
    title = t('gatePendingApprovalTitle');
    body = t('gatePendingApprovalBody', { gateType: gateTypeLbl });
  }

  if (event?.event_key && event.payload) {
    const composed = composeEventPreviewLine(event.event_key, event.payload, eventPreviewHelpers, event.refs);
    if (composed) body = composed;
  } else if (event == null) {
    // 카디르 QA 적발(PR#4344, codex 뮤테이션 6건 中 5건 발산) — 원래 `else`였던 이 분기가
    // event_key 없이도 event 자체는 있는 케이스(gate.pending_approval, 위 94-98행이 이미
    // gatePendingApprovalBody로 정상 조합)까지 잡아 legacy 파싱으로 되돌려썼다. "event 있으면
    // legacy 폴백 절대 안 돈다"는 계약(no-op)을 event==null로 명시해 강제한다 — event가
    // 있는데 이 preset만 못 다루는 경우는 legacy 취급이 아니라 위에서 이미 처리된 것.
    const legacyComposed = composeLegacyEventBodyFallback(notification.body, eventPreviewHelpers.tEventCard);
    if (legacyComposed) body = legacyComposed;
  }

  // story #3949 — event/legacy 조합이 전부 안 걸리면(예: 일반 conversation.message가
  // event 페이로드 없이 도착) body는 위에서 손 안 댄 raw notification.body 그대로다 —
  // 마크다운 링크/entity 참조 토큰이 샐 수 있어 평문화한다. 이미 조합된 body(위 두
  // 분기)는 entity 문법이 없어 이 함수가 no-op으로 통과한다.
  return { title, body: body ? toPlainPreview(body) : body };
}
