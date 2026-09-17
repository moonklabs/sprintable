// story #4028(E-UX-OVERHAUL·v3 셸) AC3 — v3가 주소 `?compose=`를 입력창에 미리 채울
// 때의 순수 판정. 상한(2000)은 4021 first-instruction-redirect.tsx의 MAX_COMPOSE_LENGTH와
// 같은 값(레거시 미러). 넘으면 자르지 않고 시드 0 + 안내 플래그.
import { describe, expect, it } from 'vitest';
import { seedFromCompose, MAX_COMPOSE_LENGTH } from './chat-v3-compose';

describe('seedFromCompose', () => {
  it('일반 값은 그대로 시드(안내 0)', () => {
    expect(seedFromCompose('배포 상태 알려줘')).toEqual({ draft: '배포 상태 알려줘', tooLong: false });
  });

  it('없음(null)/undefined은 시드 0(안내 0) — 음성 대조', () => {
    expect(seedFromCompose(null)).toEqual({ draft: '', tooLong: false });
    expect(seedFromCompose(undefined)).toEqual({ draft: '', tooLong: false });
  });

  it('빈 문자열은 시드 0(안내 0)', () => {
    expect(seedFromCompose('')).toEqual({ draft: '', tooLong: false });
  });

  it('상한(2000) 경계까지는 그대로 시드', () => {
    const exact = 'x'.repeat(MAX_COMPOSE_LENGTH);
    expect(seedFromCompose(exact)).toEqual({ draft: exact, tooLong: false });
  });

  it('상한 초과는 자르지 않고 시드 0 + tooLong', () => {
    const over = 'x'.repeat(MAX_COMPOSE_LENGTH + 1);
    expect(seedFromCompose(over)).toEqual({ draft: '', tooLong: true });
  });

  it('상한 값은 4021과 같은 2000', () => {
    expect(MAX_COMPOSE_LENGTH).toBe(2000);
  });
});
