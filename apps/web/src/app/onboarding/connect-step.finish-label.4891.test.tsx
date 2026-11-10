// @vitest-environment jsdom
//
// story 4891 (codex, PR D) — every way out of the connect step says where it lands, like the first screen's: flag OFF → «대화로 가기» (the chats page), flag ON → «오늘로 가기» (Today).
// Three buttons carry that word in ConnectStep; one (the desktop section's) already followed the flag, two said the dashboard word whatever the flag was. The failure-fallback one is
// drawn here (agent set, key failed); all three are pinned in the source text so a button that goes back to the fixed word turns this red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function finishLabels(todayV3Enabled: boolean) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><ConnectStep agentId="agent-1" apiKey={null} projectId="proj-1" orgId="org-1" onFinish={() => {}} onMakeAgent={() => {}} todayV3Enabled={todayV3Enabled} /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
  return [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((t) => t === ko.onboarding.dashboardCta || t === ko.onboarding.desktopFinishToToday);
}

describe('ConnectStep — the way-out word follows the landing (story 4891)', () => {
  it('⭐key-failure fallback, flag OFF → the chats word; flag ON → the Today word', async () => {
    expect(await finishLabels(false)).toEqual([ko.onboarding.dashboardCta]);
  });
  it('flag ON → the Today word (and not the chats word)', async () => {
    expect(await finishLabels(true)).toEqual([ko.onboarding.desktopFinishToToday]);
  });
  it('⭐all three buttons choose the word by the flag (no fixed dashboardCta left)', () => {
    const src = readFileSync(resolve(__dirname, './connect-step.tsx'), 'utf8');
    const all = src.match(/t\('dashboardCta'\)/g)?.length ?? 0;
    const byFlag = src.match(/todayV3Enabled \? t\('desktopFinishToToday'\) : t\('dashboardCta'\)/g)?.length ?? 0;
    expect(all).toBe(3);
    expect(byFlag).toBe(3);
  });
});
