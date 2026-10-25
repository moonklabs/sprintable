// @vitest-environment jsdom
//
// story 4780 (AC4) — the checklist finishes and the person gets to see it finish: a browser that showed an OPEN checklist for the organization says «다 됐어요» once when it is complete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ACTIVATION_DONE_LINE_MS, ActivationChecklistBanner } from './activation-checklist-banner';
import { ACTIVATION_REFRESH_MS, _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';

const mockOrg = { orgId: 'org-1' };
const mockPath = { current: '/today' as string | null };
const mockCollapsed = { value: undefined as boolean | undefined }; // the server's word on the collapsed state (a session cookie it reads)
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    projectId: 'proj-1', orgId: mockOrg.orgId, activationOrgId: mockOrg.orgId, activationSeedFromHint: false,
    initialActivationComplete: undefined, initialActivationCollapsed: mockCollapsed.value,
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => mockPath.current }));
vi.mock('@/lib/onboarding/first-instruction', () => ({ createFirstInstructionConversation: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEEN = (org: string) => `sprintable_activation_seen_open:${org}`;

let localStore: Map<string, string>;
let refuse = false; // localStorage refused (private window · blocked) — the session store keeps working (other code of the page reads it unguarded)
function stubStorages() {
  localStore = new Map<string, string>();
  const make = (store: Map<string, string>) => ({
    getItem: (k: string) => { if (refuse) throw new Error('denied'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (refuse) throw new Error('denied'); store.set(k, v); },
    removeItem: (k: string) => { if (refuse) throw new Error('denied'); store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('localStorage', make(localStore));
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  refuse = false;
  stubStorages();
  _resetActivationStatusCacheForTests();
  mockOrg.orgId = 'org-1';
  mockPath.current = '/today';
  mockCollapsed.value = undefined;
  document.cookie = 'sp_activation_hint=; Path=/; Max-Age=0';
  document.cookie = 'sp_activation_collapsed=; Path=/; Max-Age=0';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const wrap = () => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ActivationChecklistBanner /></NextIntlClientProvider>
);
const done = () => container.querySelector('[data-testid="activation-done"]');
const PARTIAL = {
  steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: false },
  completed: 4, total: 5, all_complete: false, first_instruction_conversation_id: null,
};
const COMPLETE = { ...PARTIAL, steps: { ...PARTIAL.steps, first_roundtrip: true }, completed: 5, all_complete: true };
const answers = (...list: Array<Record<string, unknown>>) => {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: list[Math.min(i++, list.length - 1)] }) })));
};

describe('[SID:4780] ActivationChecklistBanner — the finish is shown once', () => {
  it('the open checklist is on screen, then it completes while the person is looking → «다 됐어요» for a while, then nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    answers(PARTIAL, COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(container.textContent).toContain('4/5단계 완료');
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // the open checklist was shown here
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(container.textContent).not.toContain('단계 완료'); // the checklist itself is gone, as before
    expect(done()?.textContent).toContain(koMessages.activation.doneTitle); // reverted (no line) → null
    expect(done()?.textContent).toContain(koMessages.activation.doneBody);
    expect(localStore.has(SEEN('org-1'))).toBe(false); // once
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_DONE_LINE_MS); });
    expect(done()).toBeNull();
  });

  it('a browser that showed it open earlier, back after the reply: the line is there on the first sight of «complete» — and not again on the next mount', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // the mark went with the first showing
  });

  it('a browser that never showed it open (a new device · a long-finished account): nothing, as before', async () => {
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the line for every complete) → shown here
    expect(container.textContent).toBe('');
  });

  it('the mark is per organization: org-1\'s mark does not show the line for org-2', async () => {
    localStore.set(SEEN('org-1'), '1');
    mockOrg.orgId = 'org-2';
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull();
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // and org-1's own mark is still there for org-1
  });

  it('an answer that judged another organization leaves no mark', async () => {
    answers({ ...PARTIAL, scope_is_requested_org: false });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(localStore.has(SEEN('org-1'))).toBe(false);
  });

  it('storage refused (private window · blocked): nothing is thrown, nothing is shown, the checklist still draws', async () => {
    refuse = true;
    answers(PARTIAL, COMPLETE);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(container.textContent).toContain('4/5단계 완료');
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(done()).toBeNull();
  });

  it('on the desktop setup page (the banner is hidden there) nothing is marked and no line is shown or consumed (codex)', async () => {
    mockPath.current = '/desktop/setup';
    answers(PARTIAL, COMPLETE);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(localStore.has(SEEN('org-1'))).toBe(false); // an open checklist that is not drawn is not «shown»
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(done()).toBeNull();
    // a mark made elsewhere is neither shown nor consumed here
    localStore.set(SEEN('org-1'), '1');
    await act(async () => { root.unmount(); });
    _resetActivationStatusCacheForTests();
    root = createRoot(container);
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull();
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // still there for the next page that draws the banner
  });

  it('an organization switch takes the line down (it is derived, not left behind by a cleanup) and does not show it for the other organization', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    mockOrg.orgId = 'org-2';
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the line kept in a bare flag) → still up for org-2
  });

  it('under React StrictMode (effects run twice) the line still shows once', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    const { StrictMode } = await import('react');
    await act(async () => { root.render(<StrictMode>{wrap()}</StrictMode>); });
    await flush();
    expect(done()).not.toBeNull(); // the first effect run clears the mark; the second must not lose the line
  });

  it('the checklist drawn as its collapsed chip counts as shown: the mark is made, and the line comes when it completes', async () => {
    mockCollapsed.value = true;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    answers(PARTIAL, COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(container.querySelector('[data-testid="activation-chip"]')).not.toBeNull();
    expect(localStore.get(SEEN('org-1'))).toBe('1');
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(done()).not.toBeNull();
  });

  it('the line is up and the person goes to the desktop setup page (the banner is hidden there): the line goes with it', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    mockPath.current = '/desktop/setup';
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the line ignores where it stands) → still up on the page that hides the banner
  });

  it('an answer that judged ANOTHER organization is not this one\'s finish: it neither shows the line nor spends the mark (codex)', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers({ ...COMPLETE, scope_is_requested_org: false });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (no scope check on the completion path) → the line
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // the mark is still there for the real finish
  });

  it('after the line was taken down (an organization switch, or a hidden page) coming back within the 10 s does not show it again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    mockPath.current = '/desktop/setup';
    await act(async () => { root.render(wrap()); });
    await flush();
    mockPath.current = '/today';
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the state survives the hidden page) → the line is back
  });

  it('under StrictMode with the checklist already complete on the first render (no fetch: the browser knows it is complete) the line shows once', async () => {
    localStore.set('sprintable_activation_checklist_complete:org-1', '1');
    localStore.set(SEEN('org-1'), '1');
    const noFetch = vi.fn(async () => { throw new Error('no fetch expected'); });
    vi.stubGlobal('fetch', noFetch);
    const { StrictMode } = await import('react');
    await act(async () => { root.render(<StrictMode>{wrap()}</StrictMode>); });
    await flush();
    expect(noFetch).not.toHaveBeenCalled(); // the browser already knows it is complete: nothing is asked
    expect(done()).not.toBeNull(); // the first effect run spends the mark; the replay must find the state already set
  });

  it('after an organization switch and back within the 10 s the line is not shown again (the switch took it down, the mark is spent)', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    mockOrg.orgId = 'org-2';
    await act(async () => { root.render(wrap()); });
    await flush();
    mockOrg.orgId = 'org-1';
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the organization branch of the clearing effect removed) → the line returns for org-1
  });
});
