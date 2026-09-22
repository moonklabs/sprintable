// story #3983(PO 확定 2026-09-17 01:41Z) — 끝 착지: TODAY_V3_ENABLED ON이면
// 「오늘」(/today)·OFF면 현행 그대로(/chats). onboarding-form.tsx의 closure
// 안 finishToHome을 통째로 못 도는(org→project→agent→connect 왕복 필요) 대신
// 결정 로직만 뽑아 pin.
import { describe, expect, it } from 'vitest';
import { resolveOnboardingLandingHref } from './onboarding-form';

describe('resolveOnboardingLandingHref(story #3983 AC3)', () => {
  it('⭐ON이면 /today', () => {
    expect(resolveOnboardingLandingHref(true)).toBe('/today');
  });

  it('⭐OFF면 현행 그대로 /chats', () => {
    expect(resolveOnboardingLandingHref(false)).toBe('/chats');
  });
});
