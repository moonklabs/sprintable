// @vitest-environment jsdom
//
// story 5023 (e) — a workspace server has no mail: it says `email_verification_required: false` on `/auth/me`, and the onboarding arrival must not stop at «check your inbox» for a person
// that server can never verify. The arrival's own «unverified → say so and make nothing» holds only when the server asks for the verification (or says nothing: the old behaviour).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: string[];

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); calls = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

function arriveAs(meData: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', org_id: null, org_member_id: null, ...meData } }) } as Response;
    if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) } as Response;
    if (url === '/api/auth/refresh') return { ok: true, json: async () => ({ data: {} }) } as Response;
    if (url === '/api/organizations') return { ok: true, status: 201, json: async () => ({ data: { id: 'org-1', name: 'x' } }) } as Response;
    return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
  }));
}
async function render() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OnboardingForm todayHref="/today" chatsHref="/chats" /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}
const wall = () => container.textContent?.includes('이메일 받은편지함') === true;

describe('OnboardingForm arrival — the e-mail wall follows what the server asks (story 5023 e)', () => {
  it('the server does NOT ask for verification (a server with no mail): an unverified person is not stopped, and the organization is made', async () => {
    arriveAs({ email_verified: false, email_verification_required: false });
    await render();
    expect(wall()).toBe(false);
    expect(calls).toContain('/api/organizations');
  });
  it('the server asks for it: the wall stands and nothing is made (the arrival says so first)', async () => {
    arriveAs({ email_verified: false, email_verification_required: true });
    await render();
    expect(wall()).toBe(true);
    expect(calls).not.toContain('/api/organizations');
  });
  it('the server says nothing about it (an older server): the old behaviour — the wall stands', async () => {
    arriveAs({ email_verified: false });
    await render();
    expect(wall()).toBe(true);
    expect(calls).not.toContain('/api/organizations');
  });
  it('a verified person is never stopped', async () => {
    arriveAs({ email_verified: true, email_verification_required: true });
    await render();
    expect(wall()).toBe(false);
    expect(calls).toContain('/api/organizations');
  });
});
