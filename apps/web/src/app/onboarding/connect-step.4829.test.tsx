// @vitest-environment jsdom
//
// story 4829 (공개 2-⑥ (나)) — the connect step in the app's own server (local mode): the phone relay's «원격 제어» switch is not offered (nothing to relay through, and a first run
// is not met by a switch that does nothing). Hosted mode offers it as before (AC2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import ko from '../../../messages/ko.json';

vi.mock('@/components/desktop/onboarding-remote-control', () => ({ OnboardingRemoteControl: () => <div data-testid="remote-control-offer-stub" /> }));
const { ConnectStep } = await import('./connect-step');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchSpy = vi.fn(async (_input?: unknown) => ({ ok: false, status: 404, json: async () => ({}) }));
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(localMode: boolean | undefined) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ConnectStep agentId={null} apiKey={null} projectId="proj-1" orgId="org-1" onFinish={() => undefined} {...(localMode === undefined ? {} : { localMode })} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const offer = () => container.querySelector('[data-testid="remote-control-offer-stub"]');

describe('[SID:4829] ConnectStep — the «원격 제어» offer in local mode', () => {
  it('local mode: the offer is not drawn (the rest of the desktop section is)', async () => {
    await mount(true);
    expect(offer()).toBeNull();
    expect(container.querySelector('[data-testid="connect-step-desktop-primary"]')).not.toBeNull();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('remote-control'))).toBe(false);
  });
  it('hosted mode (AC2): the offer is drawn, whether the prop is false or not given', async () => {
    await mount(false);
    expect(offer()).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount(undefined);
    expect(offer()).not.toBeNull();
  });
});
