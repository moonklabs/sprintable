// story #4763 (H6) — the onboarding page hands «came from deleting the organization» to the form (a page that is not past the organization step only).
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen: Array<Record<string, unknown>> = [];
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('./onboarding-form', () => ({ OnboardingForm: (props: Record<string, unknown>) => { seen.push(props); return null; } }));
vi.mock('@/components/auth/email-verify-gate', () => ({ EmailVerifyGate: ({ children }: { children: unknown }) => children }));

import OnboardingPage from './page';

async function formProps(searchParams: { step?: string; orgId?: string; next?: string; after?: string }) {
  const el = (await OnboardingPage({ searchParams: Promise.resolve(searchParams) })) as { props: { children?: { props: Record<string, unknown> } } & Record<string, unknown> };
  // the form is the element itself (step=project) or the gate's child
  return (el.props.children ? el.props.children.props : el.props) as Record<string, unknown>;
}

describe('[SID:4763 H6] the onboarding page', () => {
  it('after=org-deleted → the form is told · without it, or on step=project, it is not', async () => {
    expect((await formProps({ after: 'org-deleted' })).afterOrgDelete).toBe(true);
    expect((await formProps({})).afterOrgDelete).toBe(false);
    expect((await formProps({ after: 'something' })).afterOrgDelete).toBe(false);
    expect((await formProps({ after: 'org-deleted', step: 'project', orgId: 'o-1' })).afterOrgDelete).toBe(false);
  });
});

describe('[SID:5024 AC4] the onboarding page hands the server host\'s own address to the form', () => {
  const KEYS = ['SPRINTABLE_EMBEDDED', 'SPRINTABLE_PUBLIC_ORIGIN'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('a server host: its public address · the desktop app\'s server and a hosted deployment: null (the Mac screen stays)', async () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1'; process.env['SPRINTABLE_PUBLIC_ORIGIN'] = 'https://team.example.com';
    expect((await formProps({})).serverHostOrigin).toBe('https://team.example.com');
    delete process.env['SPRINTABLE_PUBLIC_ORIGIN'];
    expect((await formProps({})).serverHostOrigin).toBeNull();
    delete process.env['SPRINTABLE_EMBEDDED'];
    expect((await formProps({})).serverHostOrigin).toBeNull();
  });
});
