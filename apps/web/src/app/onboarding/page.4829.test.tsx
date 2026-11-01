// story 4829 (공개 2-⑥ (나)) — the onboarding page (a server component) tells the form whether this is the app's own server (local mode): only the exact `SPRINTABLE_EMBEDDED=1`.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('./onboarding-form', () => ({ OnboardingForm: () => null }));
vi.mock('@/components/auth/email-verify-gate', () => ({ EmailVerifyGate: ({ children }: { children: unknown }) => children }));

import OnboardingPage from './page';

const saved = process.env.SPRINTABLE_EMBEDDED;
afterEach(() => { if (saved === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = saved; });

async function localModeOf(embedded: string | undefined): Promise<unknown> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  const el = (await OnboardingPage({ searchParams: Promise.resolve({ step: 'project', orgId: 'o-1' }) })) as { props: Record<string, unknown> };
  return el.props.localMode;
}

describe('[SID:4829] the onboarding page and local mode', () => {
  it('local mode (SPRINTABLE_EMBEDDED=1) → the form is told', async () => {
    expect(await localModeOf('1')).toBe(true);
  });
  it('hosted (unset · 0 · empty · anything but 1) → it is not', async () => {
    for (const v of [undefined, '0', '', 'true']) expect(await localModeOf(v), String(v)).toBe(false);
  });
});
