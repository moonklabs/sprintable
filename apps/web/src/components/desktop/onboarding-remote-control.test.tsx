// @vitest-environment jsdom
// [SID:4656] the onboarding's «원격 제어» block: owner · off → shown; member / already on / 「나중에 하기」 / not read yet → nothing;
// the switch is the existing PUT (owner-only on the server); a failed PUT says so in place. Reverting the owner or the off condition
// turns the first or the member case red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchMock(...args) }));
const { OnboardingRemoteControl } = await import('./onboarding-remote-control');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// the org value is cached per org in the shared store: each case gets its own org id so no case reads another's answer
let caseNo = 0;
const orgOf = () => `11111111-1111-4111-8111-${String(++caseNo).padStart(12, '0')}`;
let ORG = orgOf();

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

/** the GET answers with this state; the PUT answers with `put` */
function server(state: Record<string, unknown>, put?: Response) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return put ?? json({ data: { ...state, enabled: true, enabled_at: '2026-10-12T03:00:00Z' } });
    return json({ data: state });
  });
}

beforeEach(() => {
  ORG = orgOf();
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('[4656] onboarding remote-control block', () => {
  it('owner · off → the title, the body and both buttons are there', async () => {
    server({ enabled: false, enabled_at: null, can_change: true });
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    expect(q('onboarding-remote-control')?.textContent).toContain(koMessages.onboarding.remoteControl.title);
    expect(button(koMessages.onboarding.remoteControl.enable)).toBeTruthy();
    expect(button(koMessages.onboarding.remoteControl.later)).toBeTruthy();
    expect(q('onboarding-remote-control')?.textContent).not.toContain('조작');
  });

  it('not read yet → nothing is drawn (no flash)', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // the read never answers
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    expect(q('onboarding-remote-control')).toBeNull();
  });

  it('a member (can_change false) → nothing', async () => {
    server({ enabled: false, enabled_at: null, can_change: false });
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    expect(q('onboarding-remote-control')).toBeNull();
  });

  it('already on → nothing', async () => {
    server({ enabled: true, enabled_at: '2026-10-01T00:00:00Z', can_change: true });
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    expect(q('onboarding-remote-control')).toBeNull();
  });

  it('「나중에 하기」 → gone, and no PUT is sent (the org stays off)', async () => {
    server({ enabled: false, enabled_at: null, can_change: true });
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    await act(async () => { button(koMessages.onboarding.remoteControl.later)!.click(); });
    await flush();
    expect(q('onboarding-remote-control')).toBeNull();
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('「원격 제어 켜기」 → the existing PUT with enabled:true, then the line «켜졌어요» in place', async () => {
    server({ enabled: false, enabled_at: null, can_change: true });
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    await act(async () => { button(koMessages.onboarding.remoteControl.enable)!.click(); });
    await flush();
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(put?.[0]).toBe(`/api/organizations/${ORG}/remote-control`);
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ enabled: true });
    expect(q('onboarding-remote-control-done')?.textContent).toBe(koMessages.onboarding.remoteControl.enabled);
  });

  it('a failed PUT → the failure line in place; the block stays so the person can try again', async () => {
    server({ enabled: false, enabled_at: null, can_change: true }, json({ error: { code: 'X' } }, false));
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={ORG} />)); });
    await flush();
    await act(async () => { button(koMessages.onboarding.remoteControl.enable)!.click(); });
    await flush();
    expect(q('onboarding-remote-control-failed')?.textContent).toBe(koMessages.onboarding.remoteControl.failed);
    expect(button(koMessages.onboarding.remoteControl.enable)).toBeTruthy();
  });

  it('no org yet → nothing', async () => {
    await act(async () => { root.render(wrap(<OnboardingRemoteControl orgId={null} />)); });
    await flush();
    expect(q('onboarding-remote-control')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
