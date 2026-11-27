// @vitest-environment jsdom
//
// story 5036 (C6 · 선생님 11-26 «온보딩 3단계 직선») — the structure of the first-run line, pinned so a revert turns it red:
//   ① the first project (only its name) → ② connect an agent (THREE ways side by side, the same weight, no «고급» fold: new · moved · by key)
//   → ③ once one has connected, the first conversation in THAT project.
// What stays as it was (no regression): the Mac app · the phone app · a workspace server host come through no project step; `?step=project` (a new project from
// elsewhere) is the project step alone and ends at home. Each test names the line that, reverted, turns it red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ONBOARDING_LINE, OnboardingForm, onboardingLineIndex } from './onboarding-form';
import { CONNECT_BRANCH_IDS } from './connect-branches';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';
import { readLineProject } from '@/lib/onboarding/line-project';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: true,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg',
};
const ARTIFACT = JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://dev-mcp.sprintable.ai/mcp', headers: { Authorization: 'Bearer <YOUR_AGENT_API_KEY>' } } } });
// built, not written: a literal `sk_live_…` reads as a Stripe key to the push-protection scanner
const KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_');

type ProjectRow = { id: string; created_at?: string };
interface Opts {
  /** what GET /api/projects answers: rows · 'fail' (a 500) · 'not-a-list' (a 200 that is not a list) */
  projects?: ProjectRow[] | 'fail' | 'not-a-list' | 'no-ids';
  /** POST /api/projects: ok · the plan's limit · another failure */
  createProject?: 'ok' | 'limit' | 'fail';
  /** the organization's activation: has an agent connected? */
  agentConnected?: boolean;
  /** the first N reads of the activation fail (a 500) — then they answer */
  activationFailsFirst?: number;
}
interface Call { method: string; url: string; body?: Record<string, unknown> }

let calls: Call[];
let container: HTMLDivElement;
let root: Root;
let opts: Opts;
let activationFails = 0;
let hrefs: string[];
const realUserAgent = navigator.userAgent;
const originalLocation = window.location;

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

function stubFetch(o: Opts = {}) {
  calls = [];
  opts = o;
  activationFails = o.activationFailsFirst ?? 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split('?')[0]!;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const ok = (json: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => json });
    const bad = (status = 500) => ({ ok: false, status, headers: new Headers(), json: async () => ({}) });
    if (path === '/api/onboarding/events') return ok({});
    if (path === '/api/auth/me') return ok({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '김지우' } });
    if (path === '/api/invites/mine') return ok({ invites: [] });
    if (path === '/api/organizations') return ok({ data: { id: 'org-1' } });
    if (path === '/api/auth/refresh') return ok({ data: { ok: true } });
    if (path === '/api/projects' && method === 'GET') {
      if (opts.projects === 'fail') return bad();
      if (opts.projects === 'not-a-list') return ok({ data: { id: 'p-1' } });
      if (opts.projects === 'no-ids') return ok({ data: [{}, { id: '' }] }); // rows that are not projects
      return ok({ data: opts.projects ?? [] });
    }
    if (path === '/api/projects' && method === 'POST') {
      if (opts.createProject === 'limit') return ok({ error: { code: 'PLAN_LIMIT_EXCEEDED', limit: 1 } }, 402);
      if (opts.createProject === 'fail') return bad();
      return ok({ data: { id: 'proj-new' } });
    }
    if (path === '/api/current-project') return ok({});
    if (path === '/api/activation/checklist') {
      if (activationFails > 0) { activationFails -= 1; return bad(); }
      const c = opts.agentConnected === true;
      return ok({ data: { steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: c, first_roundtrip: false }, completed: c ? 4 : 3, total: 5, all_complete: false, first_instruction_conversation_id: null } });
    }
    if (path === '/api/team-members' && method === 'POST') return ok({ data: { id: 'agent-1', api_key: KEY } });
    if (path === '/api/team-members' && method === 'GET') return ok({ data: [{ id: 'agent-1', runtime_type: 'claude' }] });
    if (path === '/api/agents/agent-1/connection-artifact') return ok({ data: { files: [{ filename: '.mcp.json', content: ARTIFACT }] } });
    if (path === '/api/agents/agent-1/verification-status') return ok({ data: { verified: false, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }] } });
    if (path === '/api/conversations' && method === 'POST') return ok({ id: 'conv-1' });
    if (path === '/desktop/downloads/macos.json') return { ok: true, json: async () => MANIFEST, headers: new Headers({ 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' }) };
    return bad(404);
  }));
}

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}
async function flush() {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}
async function mount(props: Partial<React.ComponentProps<typeof OnboardingForm>> = {}) {
  await act(async () => { root.render(wrap(<OnboardingForm todayHref="/today" chatsHref="/chats" {...props} />)); });
  await flush();
}
async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

const line = koMessages.onboarding.line;
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const h1 = () => container.querySelector('h1')?.textContent?.trim();
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.split('?')[0] === path);
/** the stepper's three steps: the state each is in, in order — done · current · upcoming */
const stepStates = () => [...container.querySelectorAll('[data-slot="ds-stepper-step"]')].map((li) => li.getAttribute('data-state'));
const stepLabels = () => [...container.querySelectorAll('[data-slot="ds-stepper-label"]')].map((l) => l.textContent?.replace(/^\s*(끝남|지금 단계|다음 단계)\s*/, '').trim());
/** the three branch cards' own roots (their inner links carry the same prefix) */
const branchRoots = () => [...container.querySelectorAll('[data-testid^="connect-branch-"]')].filter((e) => /^connect-branch-(new|move|key)$/.test(e.getAttribute('data-testid') ?? ''));

beforeEach(() => {
  setUserAgent(MAC_UA);
  hrefs = [];
  // the page's own navigation (step ③ opens the conversation by assigning `location.href`) is read, not performed
  const fake = { ...originalLocation, replace: vi.fn(), assign: vi.fn() } as Record<string, unknown>;
  Object.defineProperty(fake, 'href', { configurable: true, get: () => 'http://localhost/onboarding', set: (v: string) => { hrefs.push(v); } });
  Object.defineProperty(window, 'location', { configurable: true, value: fake });
  _resetActivationStatusCacheForTests();
  stubFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  setUserAgent(realUserAgent);
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  delete (window as { sprintableDesktop?: unknown }).sprintableDesktop;
  sessionStorage.clear(); // the first-run line's mark (story 5036) is the tab's: no test leaves one for the next
});

describe('[SID:5036] the line itself — three steps in this order, three ways in this order', () => {
  it('S1 the steps and the ways are named and ordered in the source of truth the screens read (reverted: a step or a way dropped / moved → red)', () => {
    expect([...ONBOARDING_LINE]).toEqual(['project', 'connect', 'chat']);
    expect([...CONNECT_BRANCH_IDS]).toEqual(['new', 'move', 'key']);
    expect(onboardingLineIndex('project')).toBe(0);
    expect(onboardingLineIndex('connect')).toBe(1);
    expect(onboardingLineIndex('chat')).toBe(2);
    // arrival · invites · the deleted screen are not steps of the line (no strip there)
    expect(onboardingLineIndex('arrive')).toBeNull();
    expect(onboardingLineIndex('invited')).toBeNull();
    expect(onboardingLineIndex('deleted')).toBeNull();
  });
});

describe('[SID:5036] ① the first project — right after the organization, only its name', () => {
  it('P1 no project yet → the project step is the first screen: the strip says 1 of 3, the name starts as «첫 프로젝트», no description field, nothing made yet', async () => {
    await mount();
    expect(h1()).toBe(koMessages.onboarding.createProject);
    // reverted (the first screen is the Mac screen again, the project made behind it) → another h1 here
    expect(stepLabels()).toEqual([line.stepProject, line.stepConnect, line.stepChat]);
    expect(stepStates()).toEqual(['current', 'upcoming', 'upcoming']);
    expect((byTestId('onboarding-project-name') as HTMLInputElement).value).toBe(line.defaultProjectName);
    expect(container.querySelector('textarea')).toBeNull();
    expect(byTestId('connect-branches')).toBeNull();
    expect(posts('/api/projects')).toHaveLength(0); // asked, not made behind the person's back
  });

  it('P2 [프로젝트 만들기] → one POST (the name · org) and the project becomes the session\'s current → step ② with the strip at 2 of 3', async () => {
    await mount();
    await click(byTestId('onboarding-project-create'));
    expect(posts('/api/projects')).toHaveLength(1);
    expect(posts('/api/projects')[0]!.body).toEqual({ org_id: 'org-1', name: line.defaultProjectName, description: null });
    expect(posts('/api/current-project')[0]!.body).toEqual({ project_id: 'proj-new' });
    expect(h1()).toBe(line.connectTitle);
    expect(stepStates()).toEqual(['done', 'current', 'upcoming']);
  });

  it('P3 the organization already has a project (a reload in the middle of the line) → no second project is asked for or made: the oldest is taken and step ② is the screen', async () => {
    stubFetch({ projects: [{ id: 'p-new', created_at: '2026-10-24T01:00:00Z' }, { id: 'p-old', created_at: '2026-10-01T01:00:00Z' }] });
    await mount();
    // reverted (step ① shown whatever the organization has) → the project form here, and a second project on the press
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(posts('/api/projects')).toHaveLength(0);
    expect(posts('/api/current-project')[0]!.body).toEqual({ project_id: 'p-old' });
    expect(h1()).toBe(line.connectTitle);
  });

  it('P3b «oldest» is by the instant, whatever offset the times are written in; a project without a time comes last', async () => {
    stubFetch({ projects: [
      { id: 'p-none' },
      { id: 'p-lexically-first', created_at: '2026-10-01T23:00:00-05:00' }, // = 10-02T04:00Z — the smaller STRING, the later instant
      { id: 'p-earliest-instant', created_at: '2026-10-02T01:00:00+09:00' }, // = 10-01T16:00Z — the larger string, the earlier instant
      { id: 'p-unreadable', created_at: 'not a time' },
    ] });
    await mount();
    expect(posts('/api/current-project')[0]!.body).toEqual({ project_id: 'p-earliest-instant' });
  });

  it.each([['a 500', 'fail'], ['a 200 that is not a list', 'not-a-list'], ['a 200 whose rows carry no usable id (codex 5036)', 'no-ids']] as const)('P4 the project list answers %s → NOT «there is none» (rule 4832): nothing is made, the line says so and [다시 확인] reads again', async (_label, kind) => {
    stubFetch({ projects: kind });
    await mount();
    // reverted (an unreadable list folded into «no project») → the project form (and a second project later) here
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(posts('/api/projects')).toHaveLength(0);
    expect(byTestId('onboarding-project-check-failed')?.textContent).toBe(line.projectCheckFailed);
    opts.projects = [{ id: 'p-1' }];
    await click(byTestId('onboarding-project-check-again'));
    expect(h1()).toBe(line.connectTitle);
    expect(posts('/api/projects')).toHaveLength(0);
  });

  it('P5 the plan\'s project limit → the upgrade window says it (the made sentence, never the server\'s words) and the form stays', async () => {
    stubFetch({ createProject: 'limit' });
    await mount();
    await click(byTestId('onboarding-project-create'));
    expect(document.body.textContent).toContain('무료 플랜은 프로젝트를 1개까지');
    expect(byTestId('onboarding-project-step')).not.toBeNull();
  });

  it('P6 another failure → «프로젝트 생성에 실패했어요» under the field and the press is open again', async () => {
    stubFetch({ createProject: 'fail' });
    await mount();
    await click(byTestId('onboarding-project-create'));
    expect(byTestId('onboarding-project-step')?.textContent).toContain(koMessages.onboarding.createProjectFailed);
    expect((byTestId('onboarding-project-create') as HTMLButtonElement).disabled).toBe(false);
  });

  it('P7 `?step=project` (a new project from elsewhere — the organization switcher) is the project step ALONE: no strip, and made → home (not step ②)', async () => {
    await mount({ initialStep: 'project', initialOrgId: 'org-9' });
    expect(h1()).toBe(koMessages.onboarding.createProject);
    // reverted (the strip drawn for every project step) → three steps here
    expect(stepStates()).toEqual([]);
    await click(byTestId('onboarding-project-create'));
    expect(posts('/api/projects')[0]!.body).toMatchObject({ org_id: 'org-9' });
    expect(h1()).not.toBe(line.connectTitle); // it did not go on to step ②
    expect(posts('/api/auth/refresh').length).toBeGreaterThan(0); // the home leg: the session is renewed, then the landing
    expect(hrefs.at(-1)).toBe('/chats?p=proj-new'); // the project made a moment ago goes along (the closure used to hand a null here)
  });
});

describe('[SID:5036] ② connect an agent — three ways side by side, the same weight, no «고급» fold', () => {
  async function toConnect(o: Opts = {}) {
    stubFetch({ projects: [{ id: 'proj-1' }], ...o });
    await mount();
  }

  it('C1 the three ways are drawn in the order new · moved · by key, each a card of its own — and nothing is folded', async () => {
    await toConnect();
    // reverted (the web way folded back under «고급», or a way dropped / reordered) → fewer cards, a <details>, or another order here
    expect(branchRoots().map((e) => e.getAttribute('data-testid'))).toEqual(['connect-branch-new', 'connect-branch-move', 'connect-branch-key']);
    expect(container.querySelector('details')).toBeNull();
    expect(byTestId('onboarding-first-advanced-summary')).toBeNull();
    expect(container.textContent).not.toContain('고급');
    // the same weight: one card each, one title each (the key way is not a smaller thing inside another)
    expect(branchRoots().map((e) => e.querySelector('h2')?.textContent)).toEqual([line.branchNewTitle, line.branchMoveTitle, line.branchKeyTitle]);
    expect(h1()).toBe(line.connectTitle);
  });

  it('C2 on a Mac the two app ways say «데스크톱 앱에서 해요» and open the app ON THAT WAY (new = the plain setup link · move = intent=move); the key way is whole in the browser', async () => {
    await toConnect();
    const chips = branchRoots().slice(0, 2).map((e) => e.textContent);
    expect(chips.every((t) => t?.includes(line.inApp))).toBe(true);
    expect(byTestId('connect-branch-new-open')?.getAttribute('href')).toMatch(/^ai\.sprintable(\.dev)?:\/desktop\/setup$/);
    // reverted (both ways open the same link, or the move intent dropped) → equal hrefs / no intent here
    expect(byTestId('connect-branch-move-open')?.getAttribute('href')).toMatch(/^ai\.sprintable(\.dev)?:\/desktop\/setup\?intent=move$/);
    expect(byTestId('advanced-make')).not.toBeNull(); // the key way: its press is on the screen, no app needed
    // not a dead end that only says «open it in the app»: the download is offered once, under the three
    expect(byTestId('desktop-download-button')?.textContent).toBe(koMessages.onboarding.first.macCta);
  });

  it('C3 not a Mac: the two app ways SAY why in plain words (no link, no silent gap) · the key way is the one that goes on · no download card', async () => {
    setUserAgent(PHONE_UA);
    await toConnect();
    for (const id of ['new', 'move']) {
      expect(byTestId(`connect-branch-${id}-reason`)?.textContent).toBe(line.notMacReason);
      expect(byTestId(`connect-branch-${id}-open`)).toBeNull();
    }
    expect(byTestId('advanced-make')).not.toBeNull();
    expect(byTestId('desktop-download-card')).toBeNull();
    expect(byTestId('onboarding-first-not-mac')).not.toBeNull();
  });

  it('C4 the key way puts its agent on THE project of step ① — and makes no project of its own (the made-name project is gone)', async () => {
    stubFetch({ projects: [] });
    await mount();
    await click(byTestId('onboarding-project-create')); // ① → proj-new
    await click(byTestId('advanced-make'));
    const agent = posts('/api/team-members')[0]!;
    // reverted (the old ensureProject back: a project of its own, or the oldest one) → another project_id / a second POST /api/projects
    expect(agent.body).toMatchObject({ org_id: 'org-1', project_id: 'proj-new', type: 'agent' });
    expect(posts('/api/projects')).toHaveLength(1);
  });

  it('C5 the download press counts the app way once (the 3983 funnel signal), as the first screen always did', async () => {
    await toConnect();
    expect(calls.filter((c) => c.url.endsWith('/api/onboarding/events') && c.body?.event === 'desktop_handoff_selected')).toHaveLength(0);
    await click(byTestId('desktop-download-button'));
    const sent = calls.filter((c) => c.url.endsWith('/api/onboarding/events') && c.body?.event === 'desktop_handoff_selected');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ agent_id: null, meta: { flow: 'onboarding' } });
    expect(byTestId('connect-branches-after-note')?.textContent).toBe(koMessages.onboarding.download.afterNote);
  });
});

describe('[SID:5036] ③ the first conversation — once an agent has connected, in that project, the same end for all three ways', () => {
  it('E1 no agent has connected → step ② stays (③ never comes early)', async () => {
    stubFetch({ projects: [{ id: 'proj-1' }], agentConnected: false });
    await mount();
    expect(h1()).toBe(line.connectTitle);
    expect(byTestId('onboarding-first-chat')).toBeNull();
  });

  it('E2 the organization\'s activation says an agent connected (the app made it) → step ③: the strip at 3 of 3, «첫 대화를 시작해 보세요», and [첫 지시 보내기] opens a DM in THAT project', async () => {
    stubFetch({ projects: [{ id: 'proj-1' }], agentConnected: true });
    await mount();
    // reverted (nothing watches the app ways) → still step ② here
    expect(byTestId('onboarding-first-chat')).not.toBeNull();
    expect(h1()).toBe(line.chatTitle);
    expect(container.textContent).toContain(line.chatLead);
    expect(stepStates()).toEqual(['done', 'done', 'current']);
    await click(byTestId('onboarding-first-chat-start'));
    // the app made the agent, so the page does not know it: the conversation opens with the project's first real agent
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/team-members?project_id=proj-1&type=agent')).toBe(true);
    expect(posts('/api/conversations')[0]!.body).toEqual({ type: 'dm', participant_ids: ['agent-1'], project_id: 'proj-1' });
    expect(hrefs.at(-1)).toBe('/chats/conv-1?p=proj-1'); // the project goes along to the chat
  });

  it('E4 the first read of the activation fails → it is asked AGAIN (the watcher keeps its own clock; a shared cache that kept the failure would leave the person on step ② for good — codex 5036)', async () => {
    vi.useFakeTimers();
    try {
      stubFetch({ projects: [{ id: 'proj-1' }], agentConnected: true, activationFailsFirst: 1 });
      await mount();
      // reverted (the shared hook: a failed first read is kept and nothing is scheduled) → still step ② after any wait
      expect(h1()).toBe(line.connectTitle);
      expect(byTestId('onboarding-first-chat')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_200); });
      await flush();
      expect(byTestId('onboarding-first-chat')).not.toBeNull();
      expect(h1()).toBe(line.chatTitle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('E3 the way out of ③ is the same landing as everywhere («대화로 가기»)', async () => {
    stubFetch({ projects: [{ id: 'proj-1' }], agentConnected: true });
    await mount();
    expect(byTestId('onboarding-first-chat-finish')?.textContent).toBe(koMessages.onboarding.dashboardCta);
    await click(byTestId('onboarding-first-chat-finish'));
    expect(hrefs.at(-1)).toBe('/chats?p=proj-1');
  });
});

describe('[SID:5036] the places that are not a browser: the phone app and a workspace server host keep their own first screen and NO project step; the Mac app takes the line for a NEW account only', () => {
  const bridge = () => ({
    inApp: true as const, device: { name: 'SYJ-MacBook-Pro' }, runtimes: [],
    pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }),
  });
  const replaced = () => (window.location.replace as unknown as ReturnType<typeof vi.fn>);

  it('R1 inside the Mac app, an account that ALREADY has a project: no project step, no strip, no second project — the app\'s own setup page, exactly as before (退行 0)', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = bridge();
    stubFetch({ projects: [{ id: 'proj-old' }] });
    await mount();
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(stepStates()).toEqual([]);
    expect(posts('/api/projects')).toEqual([]);
    expect(replaced()).toHaveBeenCalledWith('/desktop/setup');
    expect(readLineProject()).toBeNull(); // reverted (the line takes this person too) → a mark and no redirect here
  });

  it('R1b inside the Mac app, the project list cannot be read: that is not «none» — but it must not stop the app\'s own way either: the setup page, as before', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = bridge();
    stubFetch({ projects: 'fail' });
    await mount();
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(posts('/api/projects')).toEqual([]);
    expect(replaced()).toHaveBeenCalledWith('/desktop/setup');
  });

  it('R1d inside the Mac app, the standalone `?step=project` (a new project from elsewhere) writes NO mark — it is not the first-run project (codex 5036)', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = bridge();
    stubFetch({ projects: [{ id: 'proj-old' }] });
    await mount({ initialStep: 'project', initialOrgId: 'org-1' });
    expect(byTestId('onboarding-project-step')).not.toBeNull();
    await click(byTestId('onboarding-project-create'));
    expect(posts('/api/projects').length).toBe(1);
    expect(readLineProject()).toBeNull(); // reverted (every adopted project is marked) → a mark here that a later start screen would seat an agent in
  });

  it('R1c inside the Mac app, a NEW account (no project): the line — ① the first project (the strip at 1 of 3), no redirect; the project made is the line\'s mark for the start screen', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = bridge();
    stubFetch({ projects: [] });
    await mount();
    expect(byTestId('onboarding-project-step')).not.toBeNull();
    expect(stepStates()).toEqual(['current', 'upcoming', 'upcoming']);
    expect(replaced()).not.toHaveBeenCalled();
    await click(byTestId('onboarding-project-create'));
    expect(posts('/api/projects').length).toBe(1);
    // ② in the app: the three ways, the first two are done HERE (no «데스크톱 앱에서 해요» chip · no download · no phone card), their press is an ordinary link to the web's own start page
    expect(h1()).toBe(line.connectTitle);
    expect(branchRoots().map((e) => e.getAttribute('data-testid'))).toEqual(['connect-branch-new', 'connect-branch-move', 'connect-branch-key']);
    expect(container.textContent).not.toContain(line.inApp);
    expect(byTestId('connect-branches-download')).toBeNull();
    expect(byTestId('connect-branch-new-open')?.textContent).toBe(line.startNew);
    expect(byTestId('connect-branch-move-open')?.textContent).toBe(line.startMove);
    // the first real Mac walk (PO 11-27): an app-scheme link was never taken when pressed inside the window — the press is an ordinary link to THIS web's start page (the app's own arrival rule starts the setup there)
    expect(byTestId('connect-branch-new-open')?.getAttribute('href')).toMatch(/^\/desktop\/setup(\?p=[^&]+)?$/); // reverted (the app-scheme link) → "ai.sprintable:/desktop/setup"
    expect(byTestId('connect-branch-move-open')?.getAttribute('href')).toMatch(/^\/desktop\/setup\?(intent=move|.*[?&]intent=move)/);
    expect(byTestId('connect-branch-new-open')?.getAttribute('href')).not.toContain('ai.sprintable');
    expect(byTestId('connect-branch-move-open')?.getAttribute('href')).not.toContain('ai.sprintable');
    // the start screen is told which project is the line's — reverted (no mark) it would make a second project from the folder's name
    expect(readLineProject()).toEqual({ orgId: 'org-1', projectId: 'proj-new' });
    expect(replaced()).not.toHaveBeenCalled();
  });

  it('R2 the phone app: its own pairing screen, no project step, no strip', async () => {
    setUserAgent(PHONE_UA);
    await act(async () => {
      root.render(wrap(
        <PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall: (async () => ({ id: 'k', ok: false, code: 'no_screen_lock' })) as never }}>
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </PhoneBridgeContext.Provider>,
      ));
    });
    await flush();
    expect(byTestId('onboarding-phone-no-mac')).not.toBeNull();
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(stepStates()).toEqual([]);
    expect(calls.some((c) => c.url.split('?')[0] === '/api/projects')).toBe(false);
  });

  it('R3 a workspace server host: its own «attach an agent to this server» screen, no project step, no strip', async () => {
    await mount({ serverHostOrigin: 'https://sprintable.example.test' });
    expect(byTestId('onboarding-first-server-host')).not.toBeNull();
    expect(byTestId('onboarding-project-step')).toBeNull();
    expect(stepStates()).toEqual([]);
    expect(calls.some((c) => c.url.split('?')[0] === '/api/projects')).toBe(false);
  });
});
