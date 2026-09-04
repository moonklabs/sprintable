import { describe, expect, it } from 'vitest';
import { validateScheduledAt, parseScheduledAtServerError } from './validate-scheduled-at';

// story #3422 ②-d — BE 실물 규칙(_scheduled_at_must_be_tz_aware_future) 그대로 재현.
describe('validateScheduledAt', () => {
  const now = new Date('2026-09-04T10:00:00.000Z');

  it('⭐미래 값이면 유효, UTC ISO(Z 표기, tz 정보 있음)로 낸다(BE 규칙① 항상 충족)', () => {
    const result = validateScheduledAt('2026-09-05T14:30', now);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.iso.endsWith('Z')).toBe(true);
      expect(new Date(result.iso).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('⭐과거 값이면 무효(BE 규칙② "현재 시각 이후여야 한다")', () => {
    expect(validateScheduledAt('2020-01-01T00:00', now)).toEqual({ valid: false, reason: 'past' });
  });

  it('현재 시각과 정확히 같으면(경계) 무효 — BE는 <=를 거부한다(엄격 미래)', () => {
    // now를 브라우저 로컬로 해석한 문자열이 필요 — 이 테스트 환경 tz(Asia/Seoul)에서
    // now(UTC)를 로컬 datetime-local 문자열로 정확히 만들어 경계를 재현한다.
    const localSameInstant = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    expect(validateScheduledAt(localSameInstant, now)).toEqual({ valid: false, reason: 'past' });
  });

  it('빈 문자열은 invalid(입력 자체가 없다)', () => {
    expect(validateScheduledAt('', now)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('파싱 불가 문자열은 invalid', () => {
    expect(validateScheduledAt('not-a-date', now)).toEqual({ valid: false, reason: 'invalid' });
  });
});

// story #3422 ②-d(페드루 PO 지적 2026-09-04 10:49Z) — 클라 검증 통과 뒤에도 상신
// 사이 시각이 흘러(느린 네트워크·시계 차이) 서버 pydantic validator가 422로 거부하는
// 실제 경로가 있다. FastAPI 기본 검증 오류 shape(detail 배열)를 감지해 사람 문장 1개로
// 접기 위한 판정 — 원문(Value error, ...)을 그대로 노출하지 않는다.
describe('parseScheduledAtServerError', () => {
  it('⭐FastAPI pydantic 검증오류(detail 배열, loc에 scheduled_at)를 감지한다', () => {
    const body = { detail: [{ loc: ['body', 'scheduled_at'], msg: 'Value error, scheduled_at은 현재 시각 이후여야 합니다', type: 'value_error' }] };
    expect(parseScheduledAtServerError(body)).toBe('past_or_invalid');
  });

  it('scheduled_at이 아닌 다른 필드의 검증오류면 null(이 오류가 아니다)', () => {
    const body = { detail: [{ loc: ['body', 'text'], msg: '...', type: 'value_error' }] };
    expect(parseScheduledAtServerError(body)).toBeNull();
  });

  it('이 프로젝트 앱 오류 shape({detail: {code, message}}, 배열 아님)면 null — 소비부가 다른 처리로 넘긴다', () => {
    expect(parseScheduledAtServerError({ detail: { code: 'CHANNEL_PUBLISH_HUMAN_ONLY', message: '...' } })).toBeNull();
  });

  it('body 자체가 없거나 이상하면 null(방어)', () => {
    expect(parseScheduledAtServerError(null)).toBeNull();
    expect(parseScheduledAtServerError(undefined)).toBeNull();
    expect(parseScheduledAtServerError('not an object')).toBeNull();
  });
});
