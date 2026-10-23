// story 4711 AC4 — `/onboarding?next=/desktop/setup` has no «조직 만들기» screen any more: the desktop sign-up goes straight back to the setup
// page (which makes the organization itself from the folder). Any other `next` is ignored; `step=project` and every other sign-up are the usual onboarding.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('./onboarding-form', () => ({ OnboardingForm: () => null }));
vi.mock('@/components/auth/email-verify-gate', () => ({ EmailVerifyGate: ({ children }: { children: unknown }) => children }));

import OnboardingPage from './page';

async function run(searchParams: { step?: string; orgId?: string; next?: string }): Promise<string> {
  try {
    await OnboardingPage({ searchParams: Promise.resolve(searchParams) });
  } catch (e) {
    return String((e as Error).message);
  }
  return 'no redirect';
}

describe('[SID:4711 AC4] the onboarding page', () => {
  it('next=/desktop/setup (no step) → back to the setup page, no screen of our own', async () => {
    expect(await run({ next: '/desktop/setup' })).toBe('redirect:/desktop/setup');
  });

  it('any other next is ignored (no open redirect) · step=project is the usual onboarding · plain sign-ups are untouched', async () => {
    for (const next of ['/chats', '//evil.example', 'https://evil.example', '/desktop/setup?x=1', '/desktop/setup#a', '\\desktop\\setup']) {
      expect(await run({ next })).toBe('no redirect');
    }
    expect(await run({ next: '/desktop/setup', step: 'project', orgId: 'o-1' })).toBe('no redirect');
    expect(await run({})).toBe('no redirect');
  });
});
