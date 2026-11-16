// @vitest-environment jsdom
//
// story 4973 (선생님 11-16 · 동료 제보) — inside the app the recruit is one screen with no runtime step: a computer with Claude Code AND Codex always got Claude Code. The found tools are
// chosen right above the start button (two or more), named on one line (one), absent (none); the last choice is the next default; a pick stands against a list that arrives later (4691).
// (scaffolding below is the 4710 test's)
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


import type { DesktopRuntimeFound } from '@/lib/desktop-app';
const CLAUDE: DesktopRuntimeFound = { runtime: 'claude', version: '2.1.289', executable: '/Users/yoonjae/.local/bin/claude' };
const CODEX: DesktopRuntimeFound = { runtime: 'codex', version: '0.158.0', executable: '/opt/homebrew/bin/codex' };
const AGENT = '00000000-0000-4000-8000-000000000009';

/** the app's bridge: `runtimes` is the load-time snapshot; `push` delivers a later list (4691) */
function appBridge(snapshot: DesktopRuntimeFound[]) {
  let current = snapshot;
  const callbacks = new Set<(r: readonly DesktopRuntimeFound[]) => void>();
  const startHere = vi.fn(async () => ({ ok: true as const }));
  const subscribeRuntimes = (cb: (r: readonly DesktopRuntimeFound[]) => void) => { callbacks.add(cb); cb(current); return () => { callbacks.delete(cb); }; };
  return {
    startHere,
    bridge: Object.freeze({ inApp: true as const, device: { name: 'yoonjae의 맥' }, runtimes: snapshot, pickFolder: vi.fn(async () => null), startHere, setProjectFolder: vi.fn(async () => ({ ok: true as const })), subscribeRuntimes }),
    push: async (next: DesktopRuntimeFound[]) => { current = next; await act(async () => { for (const cb of [...callbacks]) cb(next); }); },
  };
}

interface Calls { method: string; url: string; body: unknown }

describe('[SID:4973] RecruiterClient — the one screen chooses among the tools found on this computer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Calls[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    calls = [];
    // this test runtime has no usable localStorage (node's experimental one is off): a small in-memory one, replaced per test
    const mem = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: RUNTIME_CAPABILITIES_FALLBACK });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      if (url === '/api/organizations/org-1/remote-control') return jsonResponse({ data: { enabled: false, enabled_at: null, can_change: false, owner_names: [], connected_setups: 0 } });
      if (url === '/api/agents' && method === 'POST') return jsonResponse({ data: { id: AGENT } });
      if (url === `/api/agents/${AGENT}/recruit` && method === 'POST') {
        return jsonResponse({ data: { agent_id: AGENT, persona_id: 'p', role_template_slug: 'designer', system_prompt: 'x', tool_allowlist: [], api_key: KEY, default_tool_groups: [], mcp_config: null } });
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
    await act(async () => { root = createRoot(container); root.render(<RecruiterClient projectId="proj-1" orgId="org-1" showTopBar={false} />); });
    await flush(); await flush();
  }
  const inApp = (b: ReturnType<typeof appBridge>) => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = b.bridge; };
  const pickRole = async () => { await click(buttonsWithText(container, (t) => t.includes('디자이너'))[0]!); };
  const recruitBody = () => calls.find((c) => c.method === 'POST' && c.url === `/api/agents/${AGENT}/recruit`)!.body as { runtime?: string };
  const pressed = (slug: string) => testid(container, `recruiter-found-${slug}`)!.getAttribute('aria-pressed');

  it('AC2/AC3 — two found: the choice sits ABOVE the start button; the first found is the default; picking Codex hires a Codex agent (the recruit body says so)', async () => {
    const b = appBridge([CLAUDE, CODEX]); inApp(b);
    await mount();
    const picker = testid(container, 'recruiter-one-screen-runtime');
    expect(picker).not.toBeNull(); // reverted (no choice on the one screen) → fails
    const hero = testid(container, 'recruiter-start-here-button')!;
    expect(picker!.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // right above the start button
    expect(testid(container, 'recruiter-one-screen-runtime-one')).toBeNull();
    expect([pressed('claude'), pressed('codex')]).toEqual(['true', 'false']); // default = the first found
    await click(testid(container, 'recruiter-found-codex')!);
    expect([pressed('claude'), pressed('codex')]).toEqual(['false', 'true']);
    await pickRole();
    await click(hero);
    expect(recruitBody().runtime).toBe('codex'); // what the server stores as runtime_type (AC2)
    expect(b.startHere).toHaveBeenCalledWith({ agentId: AGENT });
  });

  it('AC2 — without a pick the default hires the first found (Claude Code) — the screen as it was for a person who never touches the choice', async () => {
    inApp(appBridge([CLAUDE, CODEX]));
    await mount(); await pickRole();
    await click(testid(container, 'recruiter-start-here-button')!);
    expect(recruitBody().runtime).toBe('claude-code');
  });

  it('AC2 — one found: its name on one line (title · name · version), no choice; none found: neither', async () => {
    inApp(appBridge([CODEX]));
    await mount();
    expect(testid(container, 'recruiter-one-screen-runtime')).toBeNull();
    expect(testid(container, 'recruiter-one-screen-runtime-one')!.textContent).toBe('recruiter.foundHereTitle · Codex · recruiter.foundHereVersion({"version":"0.158.0"})');
    await pickRole(); await click(testid(container, 'recruiter-start-here-button')!);
    expect(recruitBody().runtime).toBe('codex'); // the only found tool is the one hired
    act(() => root.unmount()); container.innerHTML = ''; calls = [];
    inApp(appBridge([]));
    await mount();
    expect(testid(container, 'recruiter-one-screen-runtime')).toBeNull();
    expect(testid(container, 'recruiter-one-screen-runtime-one')).toBeNull();
  });

  it('AC2 — the tool chosen last is the default of the NEXT recruit; a remembered tool the app no longer finds is never forced', async () => {
    inApp(appBridge([CLAUDE, CODEX]));
    await mount();
    await click(testid(container, 'recruiter-found-codex')!);
    act(() => root.unmount()); container.innerHTML = '';
    inApp(appBridge([CLAUDE, CODEX]));
    await mount();
    expect([pressed('claude'), pressed('codex')]).toEqual(['false', 'true']); // remembered (reverted → claude is the default again)
    act(() => root.unmount()); container.innerHTML = '';
    inApp(appBridge([CLAUDE])); // Codex was uninstalled
    await mount();
    expect(testid(container, 'recruiter-one-screen-runtime-one')!.textContent).toContain('Claude');
    await pickRole(); await click(testid(container, 'recruiter-start-here-button')!);
    expect(recruitBody().runtime).toBe('claude-code');
  });

  it('AC3 (4691) — a list that arrives AFTER the person chose never replaces the choice', async () => {
    const b = appBridge([CLAUDE]); inApp(b);
    await mount(); // only Claude at load → one line
    await b.push([CLAUDE, CODEX]); // the app finds Codex a moment later → the choice appears
    expect(testid(container, 'recruiter-one-screen-runtime')).not.toBeNull();
    await click(testid(container, 'recruiter-found-codex')!);
    await b.push([CODEX, CLAUDE]); // a re-scan in another order
    expect([pressed('claude'), pressed('codex')]).toEqual(['false', 'true']); // the pick stands (reverted → the found default replaces it)
    await pickRole(); await click(testid(container, 'recruiter-start-here-button')!);
    expect(recruitBody().runtime).toBe('codex');
  });

  it('a storage that refuses (private window · blocked) is no error: there is simply no memory, the first found is the default and picking still works', async () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    inApp(appBridge([CLAUDE, CODEX]));
    await mount();
    expect([pressed('claude'), pressed('codex')]).toEqual(['true', 'false']);
    await click(testid(container, 'recruiter-found-codex')!);
    expect(pressed('codex')).toBe('true');
  });

  it('AC3 (4691) — with no memory at all (storage blocked) a re-scan that lists the tools in another order still never moves the pick', async () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    const b = appBridge([CLAUDE, CODEX]); inApp(b);
    await mount();
    await click(testid(container, 'recruiter-found-codex')!);
    await b.push([CLAUDE, CODEX]); // the same tools listed again: the default (the first found) must not be applied a second time
    await b.push([CODEX, CLAUDE]);
    await b.push([CLAUDE, CODEX]);
    expect([pressed('claude'), pressed('codex')]).toEqual(['false', 'true']); // reverted (the found default applied on every change) → claude
  });

  it('a browser (no bridge) is as it was: no choice on the screen', async () => {
    await mount();
    expect(testid(container, 'recruiter-one-screen-runtime')).toBeNull();
    expect(testid(container, 'recruiter-one-screen-runtime-one')).toBeNull();
  });
});
