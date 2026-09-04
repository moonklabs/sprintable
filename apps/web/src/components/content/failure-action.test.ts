import { describe, expect, it } from 'vitest';
import { deriveFailureAction } from './failure-action';

// story #3422 ②-c(doc §11-3/§17-2/§17-10/§17-13) — 우선순위 진리표. voided/dead_letter/
// blocked는 command_status 자체가 답이라 failure_kind를 안 본다.
describe('deriveFailureAction', () => {
  it('⭐voided — reasonCode를 실어 낸다(§17-10 "누가 멈췄나" 축)', () => {
    expect(deriveFailureAction({ commandStatus: 'voided', reasonCode: 'draft_edited', failureKind: 'transient' }))
      .toEqual({ kind: 'voided', reasonCode: 'draft_edited' });
  });

  it('voided인데 reasonCode가 없으면 null로 낸다(지어내지 않는다)', () => {
    expect(deriveFailureAction({ commandStatus: 'voided' })).toEqual({ kind: 'voided', reasonCode: null });
  });

  it('⭐dead_letter — failureKind와 무관하게 dead_letter(자동 재시도 끝남, §17-13 수동 재시도 버튼 대상)', () => {
    expect(deriveFailureAction({ commandStatus: 'dead_letter', failureKind: 'transient' })).toEqual({ kind: 'dead_letter' });
  });

  it('⭐blocked — failureKind와 무관하게 blocked(연결 문제, §17-13 버튼 없음)', () => {
    expect(deriveFailureAction({ commandStatus: 'blocked', failureKind: 'needs_check' })).toEqual({ kind: 'blocked' });
  });

  it('⭐pending+processing_kind=awaiting_container — processing이 failure_kind보다 먼저(§17-15, BE #3425/PR#3776)', () => {
    expect(deriveFailureAction({ commandStatus: 'pending', processingKind: 'awaiting_container', failureKind: 'transient' }))
      .toEqual({ kind: 'processing' });
  });

  it('⭐pending+failureKind=transient — auto_retry(§17-13 "자동 재시도가 예정되면 수동 버튼 없음"), nextRetryAt을 실어 냄', () => {
    expect(deriveFailureAction({ commandStatus: 'pending', failureKind: 'transient', nextRetryAt: '2026-09-05T00:00:00Z' }))
      .toEqual({ kind: 'auto_retry', nextRetryAt: '2026-09-05T00:00:00Z' });
  });

  it('in_progress+failureKind=transient도 auto_retry(pending과 동형)', () => {
    expect(deriveFailureAction({ commandStatus: 'in_progress', failureKind: 'transient' })?.kind).toBe('auto_retry');
  });

  it('⭐pending+failureKind=needs_check — needs_check(§17-13 2단계 버튼 대상)', () => {
    expect(deriveFailureAction({ commandStatus: 'pending', failureKind: 'needs_check' })).toEqual({ kind: 'needs_check' });
  });

  it('🚨블로커 재현 — pending+failureKind=미지 값은 needs_check로 fail-closed(§17-2, transient로 잘못 열면 두 벌 나갈 위험)', () => {
    expect(deriveFailureAction({ commandStatus: 'pending', failureKind: 'some_new_unlisted_kind' })).toEqual({ kind: 'needs_check' });
  });

  it('command_status=completed면 표시할 실패가 없다(undefined)', () => {
    expect(deriveFailureAction({ commandStatus: 'completed', failureKind: 'transient' })).toBeUndefined();
  });

  it('command_status=cancelled면 표시할 실패가 없다(예약 취소는 실패가 아니다)', () => {
    expect(deriveFailureAction({ commandStatus: 'cancelled' })).toBeUndefined();
  });

  it('command_status 자체가 없으면(command 없음) 표시할 실패가 없다', () => {
    expect(deriveFailureAction({})).toBeUndefined();
  });

  it('pending인데 failureKind가 없으면(아직 실패한 적 없는 정상 대기) 표시할 실패가 없다', () => {
    expect(deriveFailureAction({ commandStatus: 'pending' })).toBeUndefined();
  });
});
