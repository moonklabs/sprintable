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
  | 'pending' | 'in_progress' | 'completed' | 'blocked' | 'dead_letter' | 'voided' | 'cancelled';
export type FailureKind = 'connection' | 'needs_check' | 'transient';

export type FailureAction =
  | { kind: 'blocked' }
  | { kind: 'needs_check' }
  | { kind: 'auto_retry'; nextRetryAt: string | null }
  | { kind: 'dead_letter' }
  | { kind: 'voided'; reasonCode: string | null }
  // 페드루 PO 정정(2026-09-04 09:49Z, BE #3425/PR#3776) — 이미지 글이 컨테이너 생성→
  // 완료 대기 중일 때. §17-15 "자동으로 이어서 처리 중"(중립·버튼 없음) — transient의
  // "다시 시도"(실패 후 재시도)와 뜻이 다르다(이건 실패가 아니라 진행 중), 같은 값으로
  // 묶지 않는다(§17-15 "모양은 같고 뜻은 다르다").
  | { kind: 'processing' };

export interface FailureActionInput {
  commandStatus?: CommandStatus | null;
  failureKind?: FailureKind | string | null;
  nextRetryAt?: string | null;
  reasonCode?: string | null;
  /** BE #3425(PR#3776) 서버 파생 — 'awaiting_container'면 이미지 컨테이너 처리 중(§17-15). */
  processingKind?: 'awaiting_container' | string | null;
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
  if (input.commandStatus === 'voided') return { kind: 'voided', reasonCode: input.reasonCode ?? null };
  if (input.commandStatus === 'dead_letter') return { kind: 'dead_letter' };
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
