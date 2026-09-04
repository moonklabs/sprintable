import { describe, expect, it } from 'vitest';
import { validateScheduledAt } from './validate-scheduled-at';

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
