// story #3422(doc §11-3/§17-2/§17-10/§17-13) — 발행 실패 UX. 판단은 서버(publication_
// command)에 있다 — 화면이 error_code로 갈래를 다시 조립하지 않는다(§17-2 "화면이
// error_code로 이 갈래를 조립하면 안 된다" — BE 정책이 화면에 사는 것을 막는다).
//
// 필드 출처(story #3426 그라운딩으로 확認된 실물 계약, PR#3773 — ChannelPostDraftListItem):
//   command_status: 'pending'|'in_progress'|'completed'|'blocked'|'dead_letter'|'voided'|
//     'cancelled'|null(command 자체가 없음)
//   failure_kind: 'connection'|'needs_check'|'transient'|null
//   next_retry_at / command_reason_code: string|null
export type CommandStatus =
  | 'pending' | 'in_progress' | 'completed' | 'blocked' | 'dead_letter' | 'voided' | 'cancelled'
  // story #4264 ④ — 발행 직전 승인 필요 · 예산 초과로 막힘(재시도 없음 · 다시 승인하면 새 명령). 예전엔 이 값을 아는 갈래가 없어
  // 워커 경로는 배지 0, 즉시 발행 경로는 dead_letter로 저장돼 헛된 «다시 시도» 버튼이 떴다.
  | 'blocked_unapproved';
// story #4262 — `not_sent`(확실히 안 나감 · 곧바로 dead_letter). 판정은 dead_letter 갈래에서 «needs_check가 아님»으로 읽혀
// «자동 재시도를 멈췄어요»가 된다(아래 deriveFailureAction 무변).
export type FailureKind = 'connection' | 'needs_check' | 'transient' | 'not_sent';

// story #4290(까디르 QA ④ · PO 06:40Z) — `retryable`은 서버 한 판정(`command_retryable` = 보는 사람이 지금 다시 시도할 수 있는가)을
// 그대로 옮긴 값이다. 호출부가 넘길 때만 실린다(모르면 없음) — 배지는 이 값이 false면 버튼을 켜지 않는다(화면이 상태로 따로 가르지 않음).
export type FailureAction =
  | { kind: 'blocked'; retryable?: boolean }
  | { kind: 'needs_check'; retryable?: boolean }
  | { kind: 'auto_retry'; nextRetryAt: string | null }
  // story #3402 갭(유나 실측·PO 채택 ㉡, 2026-09-10) — BE가 needs_check를 즉시
  // dead_letter로 접어(publication_command.py:695-698) 위 kind:'needs_check' 갈래는
  // 라이브에서 사실상 도달 불가였다. 층 구분은 유지(command_status=dead_letter가
  // 버튼 유무·severity를 결정)하되, dead_letter 안에서 failure_kind가 원래
  // needs_check였는지(needsRecheck)로 문면·체크리스트·CTA만 needs_check 것을 쓴다
  // — 새 kind를 만들지 않는다(§17-2 두 열 표 그대로: command_status=버튼,
  // failure_kind=문면).
  // story #3815(배포 82 라이브 회차 실 결함, 페드루 PO 確定 2026-09-12) — reasonCode/
  // reasonResetAt 추가(voided와 동형 축, 새 kind 0). YOUTUBE_QUOTA_EXCEEDED는
  // command_status=dead_letter로 떨어지는데(failure_kind가 매핑표 밖이라 needs_
  // check→dead_letter, 재시도 대상 아님) 그동안 이 갈래는 reasonCode를 아예 안 봐
  // BE가 아는 사유(사용량 소진·리셋 시각)를 화면이 못 읽고 일반 dead_letter/
  // needs_check 문구만 보여줬다 — 원인은 아는데 모른다고 말하는 결함.
  | { kind: 'dead_letter'; needsRecheck: boolean; reasonCode: string | null; reasonResetAt: string | null; retryable?: boolean }
  | { kind: 'voided'; reasonCode: string | null }
  // story #4264 ④ — 사유 문장만 · 버튼 0(재시도 개념이 없다).
  | { kind: 'blocked_unapproved'; reasonCode: string | null }
  // 페드루 PO 정정(2026-09-04 09:49Z, BE #3425/PR#3776) — 이미지 글이 컨테이너 생성→
  // 완료 대기 중일 때. §17-15 "자동으로 이어서 처리 중"(중립·버튼 없음) — transient의
  // "다시 시도"(실패 후 재시도)와 뜻이 다르다(이건 실패가 아니라 진행 중), 같은 값으로
  // 묶지 않는다(§17-15 "모양은 같고 뜻은 다르다").
  | { kind: 'processing' };

// story #3422 N2(페드루 PO 지적, 2026-09-04 12:41Z) — command_reason_code 원시값을
// 화면에 그대로 노출하지 않는다(entity-status-labels.ts::STATUS_LABELS와 동형 규율 —
// "맵에 없는 값이 오면 칸을 비운다, 원시값을 그대로 노출하지 않는다"). 실측 3종
// (backend/app/services/channel_posts.py — 재승인 트리거 시 무엇이 바뀌었는지 그대로).
// CANCELLED_BY_HUMAN(cancelled 축)은 deriveFailureAction이 그 이전에 undefined로
// 걸러(commandStatus==='cancelled') 이 배지 경로엔 실제로 안 오지만, 실 BE 값이라 맵엔
// 올려 둔다(§17-10 정본이 늘어도 이 한 곳만 늘리면 되게).
//
// 유나 재판정(2026-09-04 13:08Z) — 처음엔 이 맵이 한글 리터럴이었다. en 로케일에서
// `channelPostsFailureVoidedWithReason`("Voided · {reason}")과 합성되면 "Voided ·
// 본문이 바뀜"처럼 문장은 영어인데 사유만 한글로 남는다. 값을 메시지 키로 바꿔
// 렌더 시점에 t(key)로 푼다 — «맵에 없으면 사유 없이» 규율은 그대로.
//
// 유나 기록(2026-09-04, blocking 아님) — 이 맵의 값(channelPostsVoidReason*) 4개는
// failure-action-badge.tsx에서 `t(voidReasonKey)`로 "동적으로" 소비된다. `t('literalKey')`
// 형태로 문자열 그대로 grep하는 죽은 i18n 키 정리(수동이든 자동이든)가 이 4키를
// "코드 어디에도 안 쓰인다"고 오판해 지울 수 있다 — 지우지 않는다. 소비처는 이 맵 하나뿐.
export const CHANNEL_POST_VOID_REASON_MESSAGE_KEYS: Record<string, string> = {
  CONTENT_CHANGED: 'channelPostsVoidReasonContentChanged',
  SCHEDULE_CHANGED: 'channelPostsVoidReasonScheduleChanged',
  MEDIA_CHANGED: 'channelPostsVoidReasonMediaChanged',
  CANCELLED_BY_HUMAN: 'channelPostsVoidReasonCancelledByHuman',
  // story #3500(PO REQUIRED③, 2026-09-05) — doc a0da40c9 §19-8-5: 발행 직전
  // 재검사(BE #3498 AC4, 승인 뒤 다른 지출로 잔량이 줄어든 경우)의 거부는 상신
  // 배너가 아니라 이 "발행 실패 사유" 표면에 코드로 온다. 값 4개(한도/사용/예상/
  // 남음)는 이 표면엔 없다 — §19-8의 사실 문장+행동 문장 둘만 재사용한다(같은
  // 사실이므로 같은 문구, 자리만 다르다). BE가 이 재검사를 실제로 어떤
  // command_status/reason_code로 실어 보내는지는 미착지라 미확認 — 이 매핑은
  // "reason_code가 이 값이면"이라는 계약을 가정한 스켈레톤이다(PR 본문 명시).
  GENERATION_BUDGET_EXCEEDED: 'channelPostsVoidReasonGenerationBudgetExceeded',
  // story #3808(PR5c, 페드루 PO 確定 2026-09-12) — 위와 같은 BE 예외(rule_key만
  // 다름, X api_usage_budget 축)가 별도 코드로 온다 — 문구도 X 축으로.
  API_USAGE_BUDGET_EXCEEDED: 'channelPostsVoidReasonApiUsageBudgetExceeded',
};

// story #4264 ④(까디르 codex P2 · PO 17:45Z) — blocked_unapproved 사유 → 문장. 예산 둘은 같은 사실이라 voided 문장 그대로, 승인
// 필요는 유나 문안. 사유가 비었으면(4264 전 워커 행 — 그 갈래만 사유를 안 채웠다) 승인 필요로 읽는다.
export const CHANNEL_POST_BLOCKED_REASON_MESSAGE_KEYS: Record<string, string> = {
  EXTERNAL_PUBLISH_APPROVAL_REQUIRED: 'channelPostsBlockedReasonApprovalRequired',
  GENERATION_BUDGET_EXCEEDED: 'channelPostsVoidReasonGenerationBudgetExceeded',
  API_USAGE_BUDGET_EXCEEDED: 'channelPostsVoidReasonApiUsageBudgetExceeded',
};

// story #3815(페드루 PO steer②, 2026-09-12 17:34Z) — voided의 REASON_MESSAGE_KEYS와
// 동형 축, dead_letter 전용. reason_code→문구 표: 맵에 있으면 그 정적 문구를
// 즉시 낸다(원인을 아는 채로 일반 dead_letter/needs_check 문구로 뭉개지 않는다),
// 맵에 없는(모르는) reason_code는 기존 제네릭 문장(needs_check/dead_letter)으로
// 폴백 — 코드 하나 늘 때마다 이 맵 한 줄만 늘면 된다(하드코딩된 단일 분기 금지,
// 클래스를 닫는다). failure-action-badge.tsx에서 `t(key)`로 소비 — 새 코드가
// 추가되면 여기 등재만 하면 된다(죽은 키 스윕 대상 아님, voided 맵과 동형 주의).
export const CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS: Record<string, string> = {
  YOUTUBE_QUOTA_EXCEEDED: 'channelPostsFailureYoutubeQuotaExceeded',
};

export interface FailureActionInput {
  commandStatus?: CommandStatus | null;
  failureKind?: FailureKind | string | null;
  nextRetryAt?: string | null;
  reasonCode?: string | null;
  /** story #3815 — reasonCode==='YOUTUBE_QUOTA_EXCEEDED'일 때만 BE가 채운다(그 외
   * reasonCode는 계속 null). */
  reasonResetAt?: string | null;
  /** BE #3425(PR#3776) 서버 파생 — 'awaiting_container'면 이미지 컨테이너 처리 중(§17-15). */
  processingKind?: 'awaiting_container' | string | null;
  /** story #4290(까디르 QA ④) — 서버 `command_retryable`. 넘기면 멈춤 갈래(blocked · needs_check · dead_letter)에 그대로 실린다. */
  retryable?: boolean | null;
}

/**
 * §17-10①의 command_status 값 중 「무엇을 할지가 이미 확定된」 것부터 우선순위를 매긴다
 * — voided(무효가 됨, §17-10 "누가 멈췄나" 축에서 시스템 판정)·dead_letter(자동 재시도
 * 끝남)·blocked(연결 문제)는 command_status 자체가 답을 갖고 있어 failure_kind를 볼
 * 필요가 없다. 그 외(pending·in_progress에서 실패가 진행 중인 경우)만 failure_kind로
 * needs_check/transient를 가른다 — 모르는 값(미지 failure_kind)은 needs_check로
 * fail-closed(§17-2 "transient로 열면 두 벌 나갈 위험, connection으로 막으면 고칠 수
 * 있는 것을 막는다 — 판단을 사람에게 넘기는 쪽이 어느 사고도 안 낸다").
 */
export function deriveFailureAction(input: FailureActionInput): FailureAction | undefined {
  const action = deriveFailureKind(input);
  if (!action || input.retryable == null) return action;
  if (action.kind === 'blocked' || action.kind === 'needs_check' || action.kind === 'dead_letter') {
    return { ...action, retryable: input.retryable };
  }
  return action;
}

function deriveFailureKind(input: FailureActionInput): FailureAction | undefined {
  if (input.commandStatus === 'voided') return { kind: 'voided', reasonCode: input.reasonCode ?? null };
  if (input.commandStatus === 'blocked_unapproved') return { kind: 'blocked_unapproved', reasonCode: input.reasonCode ?? null };
  // story #3402 갭(2026-09-10) — needsRecheck는 dead_letter로 접히기 直前의 failure_kind가
  // needs_check였는지만 본다(§17-2 층 구분: command_status가 이미 dead_letter를 확定했으니
  // 그 안에서 failure_kind는 "무엇을 보여줄지"만 고른다, "보여줄지 말지"는 안 건드린다).
  if (input.commandStatus === 'dead_letter') {
    return {
      kind: 'dead_letter', needsRecheck: input.failureKind === 'needs_check',
      reasonCode: input.reasonCode ?? null, reasonResetAt: input.reasonResetAt ?? null,
    };
  }
  if (input.commandStatus === 'blocked') return { kind: 'blocked' };
  if (input.commandStatus === 'completed' || input.commandStatus === 'cancelled' || !input.commandStatus) return undefined;
  // 페드루 PO 정정(2026-09-04 09:49Z) — pending ∧ processing_kind==='awaiting_container'
  // 는 failure_kind보다 먼저 잡는다. 실패가 아니라 "진행 중"이라 §17-2의 실패 갈래
  // 축과 아예 다르다(실패 여부를 먼저 걸러야 failure_kind 유무로 오판 안 함).
  if (input.commandStatus === 'pending' && input.processingKind === 'awaiting_container') return { kind: 'processing' };
  // pending·in_progress — 실패가 아직 자동 재시도 큐에 있는 상태. failure_kind가 없으면
  // (예: 아직 한 번도 실패한 적 없는 정상 대기) 표시할 실패 자체가 없다.
  if (!input.failureKind) return undefined;
  if (input.failureKind === 'transient') return { kind: 'auto_retry', nextRetryAt: input.nextRetryAt ?? null };
  // 'needs_check' 명시값 + 그 외 모르는 값(§17-2 fail-closed) 전부 이 갈래.
  return { kind: 'needs_check' };
}

/** story #4304 — 멈춘(blocked) 명령이 **연결 사유**인가. BE가 blocked로 세우는 길은 지금 둘이다: 연결 실패(`failure_kind=connection`)와 조직
 * 일시정지(`paused` — 연결과 무관, 정지를 풀면 서버가 다시 올림). «연결 확인» 링크는 앞의 것에만 단다(일시정지에 연결 화면을 가리키면 거짓 길).
 * 까디르 QA(PO 08:55Z) — **닫힌 판정**: `connection`일 때만 참. 없는 kind · 모르는 kind(앞으로 blocked 사유가 늘 때)는 링크를 받지 않는다. */
export function blockedByConnection(commandStatus: string | null | undefined, failureKind: string | null | undefined): boolean {
  return commandStatus === 'blocked' && failureKind === 'connection';
}
