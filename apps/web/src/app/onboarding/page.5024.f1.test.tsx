// story 5024 (F1) — the onboarding page hands the form what a server host is told: with its address · without it yet (the first owner has just signed up) · or that it is none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('./onboarding-form', () => ({ OnboardingForm: () => null }));
vi.mock('@/components/auth/email-verify-gate', () => ({ EmailVerifyGate: ({ children }: { children: unknown }) => children }));

const KEYS = ['SPRINTABLE_EMBEDDED', 'SPRINTABLE_PUBLIC_ORIGIN', 'SPRINTABLE_API_ORIGIN'] as const;
let saved: Record<string, string | undefined>;
let stateAnswer: unknown = null;
const asked: string[] = [];
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SPRINTABLE_API_ORIGIN = 'http://127.0.0.1:43111';
  stateAnswer = null; asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(String(url)); return { ok: stateAnswer !== null, json: async () => stateAnswer }; }));
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.unstubAllGlobals(); vi.resetModules(); });

async function formProps(embedded: string | undefined, origin?: string): Promise<Record<string, unknown>> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  if (origin === undefined) delete process.env.SPRINTABLE_PUBLIC_ORIGIN; else process.env.SPRINTABLE_PUBLIC_ORIGIN = origin;
  vi.resetModules();
  const { default: Page } = await import('./page');
  // `step=project` returns the form element itself (no email gate): its props are what the page hands the form
  return ((await Page({ searchParams: Promise.resolve({ step: 'project' }) })) as { props: Record<string, unknown> }).props;
}

describe('[SID:5024 F1] the onboarding page and the server host', () => {
  it('right after the first owner signs up (no public address yet): a server host WITHOUT an address — the first screen says «set the address first»', async () => {
    stateAnswer = { owner_exists: true, signup_open: false };
    const p = await formProps('1');
    expect(p.serverHostOrigin).toBeNull();
    expect(p.serverHostPending).toBe(true);
  });

  it('with its public address: the address goes down, nothing is pending, and the backend is not even asked', async () => {
    stateAnswer = { owner_exists: true, signup_open: false };
    const p = await formProps('1', 'https://team.example.com');
    expect(p.serverHostOrigin).toBe('https://team.example.com');
    expect(p.serverHostPending).toBe(false);
    expect(asked).toEqual([]);
  });

  it('the desktop app\'s own server (sign-up open) · a server that does not answer · a hosted deployment: no server host — the Mac screen stays', async () => {
    for (const [embedded, answer] of [['1', { owner_exists: true, signup_open: true }], ['1', null], [undefined, { owner_exists: true, signup_open: false }]] as const) {
      stateAnswer = answer;
      const p = await formProps(embedded);
      expect(p.serverHostOrigin, `${String(embedded)} ${JSON.stringify(answer)}`).toBeNull();
      expect(p.serverHostPending).toBe(false);
    }
  });
});
