// story #3983(PO 확定 2026-09-17 01:41Z) — 끝 착지: TODAY_V3_ENABLED ON이면
// 「오늘」(/today)·OFF면 chatsHref(부모가 resolveChatsHref로 구해 넘기는 값 —
// story #4017 rebase 시점 재정정, 2026-09-22). onboarding-form.tsx의 closure
// 안 finishToHome을 통째로 못 도는(org→project→agent→connect 왕복 필요) 대신
// 결정 로직만 뽑아 pin.
import { describe, expect, it } from 'vitest';
import { resolveOnboardingLandingHref } from './onboarding-form';

describe('resolveOnboardingLandingHref(story #3983 AC3)', () => {
  it('⭐ON이면 chatsHref 무관 /today', () => {
    expect(resolveOnboardingLandingHref(true, '/chat')).toBe('/today');
  });

  it('⭐OFF면 주어진 chatsHref 그대로(레거시 /chats)', () => {
    expect(resolveOnboardingLandingHref(false, '/chats')).toBe('/chats');
  });

  it('⭐OFF·chatV3 ON이면 chatsHref가 /chat(4017 계약)', () => {
    expect(resolveOnboardingLandingHref(false, '/chat')).toBe('/chat');
  });
});
