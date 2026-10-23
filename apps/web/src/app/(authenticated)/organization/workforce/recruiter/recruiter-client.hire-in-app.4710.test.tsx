// @vitest-environment jsdom
//
// story 4710 (UX-1 · 채용관) — hiring inside the desktop app is ONE screen («직무»): the role list, the access as a default line with [바꾸기],
// the hero [이 컴퓨터에서 시작] that hires and starts (no key, no .mcp.json, no verify step), and a text link to the screens as before for an
// agent that runs somewhere else. In a browser whose account has a Mac app connected the runtime step's primary is the same hero, and the key
// screens are the secondary link. Without a Mac app connected the browser is as it was. The bridge is `window.sprintableDesktop` (D1).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RecruiterClient } from './recruiter-client';
import { RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`);
    t.rich = (key: string) => `${ns}.${key}`;
    t.markup = (key: string) => `${ns}.${key}`;
    t.raw = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
  useLocale: () => 'ko',
}));
vi.mock('@/app/onboarding/onboarding-telemetry', () => ({ emitOnboardingEvent: vi.fn(), beaconOnboardingEvent: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyTextSafely: async () => ({ ok: true as const }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'sk_live_4710_SECRET_VALUE';
const ROLE = { id: 'r1', slug: 'designer', name: '디자이너', category: 'frontend', description: null, default_tool_groups: [] as string[], is_builtin: true, tier: 'full', version: 1, division: null, emoji: null };

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}
async function flush() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
const buttonsWithText = (c: HTMLElement, match: (t: string) => boolean) => Array.from(c.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); }
const testid = (c: HTMLElement, id: string) => c.querySelector(`[data-testid=${id}]`) as HTMLElement | null;

const bridgeWith = (startHere: () => Promise<{ ok: true } | { ok: false; code: string }>) => Object.freeze({
  inApp: true as const, device: { name: 'yoonjae의 맥' },
  runtimes: [{ runtime: 'claude' as const, version: '2.1.289', executable: '/Users/yoonjae/.local/bin/claude' }],
  pickFolder: vi.fn(async () => null), startHere: vi.fn(startHere), setProjectFolder: vi.fn(async () => ({ ok: true as const })),
});

interface Calls { method: string; url: string; body: unknown }

describe('[SID:4710] RecruiterClient — hiring starts the agent here', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Calls[];
  let recruitStatus: number;
  let connectedSetups: number;
  let teamMembers: Array<{ id: string; name: string; type: string }>;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    calls = [];
    recruitStatus = 200;
    connectedSetups = 0;
    teamMembers = [];
    assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }, { id: 'proj-2', name: 'Proj 2' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: RUNTIME_CAPABILITIES_FALLBACK });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: teamMembers });
      if (url === '/api/organizations/org-1/remote-control') return jsonResponse({ data: { enabled: false, enabled_at: null, can_change: false, owner_names: [], connected_setups: connectedSetups } });
      if (url === '/api/agents' && method === 'POST') return jsonResponse({ data: { id: '00000000-0000-4000-8000-000000000009' } });
      if (url === '/api/agents/00000000-0000-4000-8000-000000000009/recruit' && method === 'POST') {
        if (recruitStatus !== 200) return jsonResponse({}, false, recruitStatus);
        return jsonResponse({ data: { agent_id: '00000000-0000-4000-8000-000000000009', persona_id: 'p', role_template_slug: 'designer', system_prompt: 'x', tool_allowlist: [], api_key: KEY, default_transport: 'http', mcp_config: { mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: `Bearer ${KEY}` } } } }, mcp_config_alternatives: {} } });
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop;
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" orgId="org-1" showTopBar={false} />);
    });
    await flush();
    await flush();
  }
  const pickRole = async () => { await click(buttonsWithText(container, (t) => t.includes('디자이너'))[0]!); };
  const inApp = (b: ReturnType<typeof bridgeWith>) => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = b; };

  describe('inside the app — one screen', () => {
    it('AC1: the screen is the role + the access line + the hero + the elsewhere link — no stepper, no [다음]; the hero waits for a role (a visible line)', async () => {
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      expect(testid(container, 'recruiter-one-screen')).not.toBeNull(); // reverted (the five steps) → fails
      expect(container.textContent).not.toContain('recruiter.stepBundle'); // no stepper at all
      expect(container.textContent).not.toContain('recruiter.stepVerify');
      expect(buttonsWithText(container, (t) => t === 'recruiter.next')).toHaveLength(0);
      expect(testid(container, 'recruiter-scope-line')!.textContent).toBe('recruiter.scopeLine({"project":"Proj 1"})'); // the default scope = this project
      const hero = testid(container, 'recruiter-start-here-button') as HTMLButtonElement;
      expect(hero.textContent).toBe('recruiter.startHere');
      expect(hero.disabled).toBe(true);
      expect(testid(container, 'recruiter-hero-line')!.textContent).toBe('recruiter.startHereNeedRole');
      expect(testid(container, 'recruiter-connect-elsewhere')).not.toBeNull();
      await pickRole();
      expect((testid(container, 'recruiter-start-here-button') as HTMLButtonElement).disabled).toBe(false);
      expect(testid(container, 'recruiter-hero-line')!.textContent).toBe('recruiter.startHereLine({"role":"디자이너"})');
    });

    it('AC1: the hero hires (no key issued ahead) and hands the agent to the app — no kit, no verify, the key is nowhere in the page', async () => {
      const b = bridgeWith(async () => ({ ok: true }));
      inApp(b);
      await mount();
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/agents')!;
      expect(post.body).toMatchObject({ scope_mode: 'projects', project_ids: ['proj-1'], defer_key_issuance: true });
      const recruit = calls.find((c) => c.method === 'POST' && c.url === '/api/agents/00000000-0000-4000-8000-000000000009/recruit')!;
      expect(recruit.body).toMatchObject({ role_template_slug: 'designer', issue_key: false }); // hired without a key (Kadir · reverted → fails)
      expect(b.startHere).toHaveBeenCalledTimes(1);
      expect(b.startHere).toHaveBeenCalledWith({ agentId: '00000000-0000-4000-8000-000000000009' });
      // the key the recruit answer carries is never drawn (AC3) — nor is the kit or the verify step
      expect(container.innerHTML).not.toContain(KEY);
      expect(container.textContent).not.toContain('recruiter.keyOnceTitle');
      expect(container.textContent).not.toContain('recruiter.stepBundle');
      expect(container.textContent).not.toContain('recruiter.stepVerify');
    });

    it('[바꾸기] opens today\'s scope choices in place; the line shows the choice (several projects → the count line)', async () => {
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      expect(container.textContent).not.toContain('recruiter.scopeQuestion');
      await click(testid(container, 'recruiter-scope-change')!);
      expect(container.textContent).toContain('recruiter.scopeQuestion');
      await click(buttonsWithText(container, (t) => t.includes('Proj 2'))[0]!);
      expect(testid(container, 'recruiter-scope-line')!.textContent).toBe('recruiter.scopeLineMany({"n":2,"projects":"Proj 1, Proj 2"})');
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/agents')!.body).toMatchObject({ project_ids: ['proj-1', 'proj-2'] });
    });

    it('zero projects chosen: the hero is off and the line says why (not the hire line); the whole-organization choice reads as the other lines do', async () => {
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      await pickRole();
      expect(testid(container, 'recruiter-hero-line')!.textContent).toBe('recruiter.startHereLine({"role":"디자이너"})');
      await click(testid(container, 'recruiter-scope-change')!);
      await click(buttonsWithText(container, (t) => t.includes('Proj 1'))[0]!); // Proj 1 off → nothing chosen
      expect((testid(container, 'recruiter-start-here-button') as HTMLButtonElement).disabled).toBe(true);
      expect(testid(container, 'recruiter-hero-line')!.textContent).toBe('recruiter.startHereNeedProject'); // reverted → the hire line stays and fails here
      await click(buttonsWithText(container, (t) => t.startsWith('settings.agentScopeAllProjects'))[0]!);
      expect(testid(container, 'recruiter-scope-line')!.textContent).toBe('recruiter.scopeLineOrg'); // «…에서 일해요», not the bare label
      expect((testid(container, 'recruiter-start-here-button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a hire that fails: the one line (role=alert), the hero stays, nothing is handed to the app', async () => {
      recruitStatus = 500;
      const b = bridgeWith(async () => ({ ok: true }));
      inApp(b);
      await mount();
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(testid(container, 'recruiter-hire-failed')!.textContent).toBe('recruiter.hireFailedHero');
      expect(testid(container, 'recruiter-start-here-button')).not.toBeNull();
      expect(b.startHere).not.toHaveBeenCalled();
    });

    it('a hire that fails AFTER the agent was made: pressing the hero again hires THAT agent — no second agent (codex 5123 · reverted → two creates)', async () => {
      recruitStatus = 500;
      const b = bridgeWith(async () => ({ ok: true }));
      inApp(b);
      await mount();
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(testid(container, 'recruiter-hire-failed')).not.toBeNull();
      recruitStatus = 200;
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/agents')).toHaveLength(1); // one agent made
      expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/agents/00000000-0000-4000-8000-000000000009/recruit')).toHaveLength(2); // recruited twice
      expect(b.startHere).toHaveBeenCalledTimes(1);
      expect(testid(container, 'recruiter-hire-failed')).toBeNull();
    });

    it('the retry knows its agent by the id this tab was handed — an older agent of the SAME NAME is never recruited (Kadir · key lens)', async () => {
      const OTHER = '00000000-0000-4000-8000-0000000000aa';
      teamMembers = [{ id: OTHER, name: 'recruiter.agentNameAutoFill({"role":"디자이너"})', type: 'agent' }];
      recruitStatus = 500;
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      recruitStatus = 200;
      await click(testid(container, 'recruiter-start-here-button')!);
      const posted = calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/agents/')).map((c) => c.url);
      expect(posted).toEqual(Array(2).fill('/api/agents/00000000-0000-4000-8000-000000000009/recruit')); // only the agent this tab made
      expect(calls.some((c) => c.url.includes(OTHER))).toBe(false); // the same-named one is not even touched or read
    });

    it('the app could not open the setup: the line + the hero again STARTS — it never hires a second agent', async () => {
      let first = true;
      const b = bridgeWith(async () => { if (first) { first = false; return { ok: false, code: 'ignored' }; } return { ok: true }; });
      inApp(b);
      await mount();
      await pickRole();
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(testid(container, 'recruiter-start-here-failed')!.textContent).toBe('recruiter.startHereFailed');
      await click(testid(container, 'recruiter-start-here-button')!);
      expect(b.startHere).toHaveBeenCalledTimes(2);
      expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/agents')).toHaveLength(1); // one hire
      expect(calls.filter((c) => c.url === '/api/agents/00000000-0000-4000-8000-000000000009/recruit')).toHaveLength(1);
    });

    it('«다른 곳에서 돌고 있는 에이전트로 연결하기» → the screens as before: the stepper (renamed) and [다음]; the hero is gone', async () => {
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      await click(testid(container, 'recruiter-connect-elsewhere')!);
      expect(testid(container, 'recruiter-one-screen')).toBeNull();
      expect(container.textContent).toContain('recruiter.stepBundle');
      expect(container.textContent).toContain('recruiter.stepVerify');
      expect(buttonsWithText(container, (t) => t === 'recruiter.next')).toHaveLength(1);
    });

    it('«역할 없이(키만)» is not the one screen\'s way: choosing it brings [다음] back', async () => {
      inApp(bridgeWith(async () => ({ ok: true })));
      await mount();
      await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
      expect(testid(container, 'recruiter-one-screen')).toBeNull();
      expect(buttonsWithText(container, (t) => t === 'recruiter.next')).toHaveLength(1);
    });
  });

  describe('in a browser', () => {
    async function toRuntimeStep() {
      await mount();
      await pickRole();
      await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!); // role → access
      await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!); // access → runtime
    }

    it('AC2: a Mac app is connected to the account → [이 컴퓨터에서 시작] is the primary; the key path is the secondary link', async () => {
      connectedSetups = 1;
      await toRuntimeStep();
      expect(testid(container, 'recruiter-browser-hero')).not.toBeNull(); // reverted (no hero) → fails
      expect(testid(container, 'recruiter-connect-elsewhere')!.textContent).toBe('recruiter.connectElsewhere');
      expect(buttonsWithText(container, (t) => t === 'recruiter.recruitCta')).toHaveLength(0); // no key-path button beside it
      await click(testid(container, 'recruiter-start-here-link-button')!);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(String(assign.mock.calls[0]![0])).toContain('agent=00000000-0000-4000-8000-000000000009');
      expect(container.innerHTML).not.toContain(KEY);
      expect(container.textContent).not.toContain('recruiter.keyOnceTitle'); // the kit step (where the key is drawn) is never reached
    });

    it('AC2: the secondary link is today\'s key path — the recruit goes on to the connection-info step', async () => {
      connectedSetups = 1;
      await toRuntimeStep();
      await click(testid(container, 'recruiter-connect-elsewhere')!);
      expect(assign).not.toHaveBeenCalled();
      const recruit = calls.find((c) => c.method === 'POST' && c.url === '/api/agents/00000000-0000-4000-8000-000000000009/recruit')!;
      expect(recruit.body).not.toHaveProperty('issue_key'); // the key path keeps the server's default (a key, shown once)
      expect(container.textContent).toContain('recruiter.keyOnceTitle'); // step 4, the kit: the key is drawn here, as before
    });

    it('no Mac app connected (or the count could not be read): the browser is exactly as before — [채용하기], no hero', async () => {
      connectedSetups = 0;
      await toRuntimeStep();
      expect(testid(container, 'recruiter-browser-hero')).toBeNull();
      expect(buttonsWithText(container, (t) => t === 'recruiter.recruitCta')).toHaveLength(1);
    });
  });
});
