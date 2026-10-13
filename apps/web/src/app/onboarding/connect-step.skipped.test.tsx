// @vitest-environment jsdom
//
// story 4668 (AC2 · Yuna A-3 · design §4 T8~T9) — the connect step without an agent. Skipped (agentId null) is not a failure:
// the desktop way as the main one, [에이전트 만들기] back to the agent step, no «API Key 발급에 실패했어요» line, no web block
// (it needs an agent), no footer (the section's own button is the one way out — two «대시보드로» otherwise). A real key failure
// (agentId set, apiKey null) keeps the failure line as before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ConnectStep } from './connect-step';
import ko from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);

describe('[SID:4668] ConnectStep without an agent', () => {
  it('T8 skipped (agentId null · apiKey null): info line · desktop section · [에이전트 만들기] → onMakeAgent · no failure line · no web block · no footer', async () => {
    const onMakeAgent = vi.fn();
    const onFinish = vi.fn();
    await mount(<ConnectStep agentId={null} apiKey={null} projectId="proj-1" orgId="org-1" onFinish={onFinish} onMakeAgent={onMakeAgent} />);

    // reverted (the `agentId === null` branch gone) → the failure line comes back and this fails
    expect(byTestId('connect-step-no-agent')?.textContent).toBe(ko.onboarding.connectNoAgent);
    expect(container.textContent).not.toContain(ko.onboarding.apiKeyFailedMembers);
    expect(byTestId('connect-step-desktop-primary')).not.toBeNull();
    expect(byTestId('desktop-download-card')).not.toBeNull();
    expect(byTestId('connect-step-needs-agent')?.textContent).toContain(ko.onboarding.connectNeedsAgent);
    expect(container.textContent).not.toContain(ko.onboarding.transportHosted);
    expect(container.textContent).not.toContain(ko.onboarding.webConnectSecondaryLabel);
    expect(container.textContent).not.toContain(ko.onboarding.firstInstructionCta);
    // one «대시보드로» only — the desktop section's (todayV3 off); the footer's would be a second one (Yuna)
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === ko.onboarding.dashboardCta)).toHaveLength(1);

    await act(async () => { byTestId('connect-step-make-agent')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onMakeAgent).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('T9 a real key failure (agentId set · apiKey null) keeps the «발급 실패» line and no «에이전트 없이» line (regression pin)', async () => {
    await mount(<ConnectStep agentId="agent-1" apiKey={null} projectId="proj-1" orgId="org-1" onFinish={() => {}} onMakeAgent={() => {}} />);
    expect(container.textContent).toContain(ko.onboarding.apiKeyFailedMembers);
    expect(byTestId('connect-step-no-agent')).toBeNull();
    expect(byTestId('connect-step-make-agent')).toBeNull();
  });
});
