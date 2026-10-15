// @vitest-environment jsdom
//
// story 4693 (UX-1 · D4 · AC1 · AC2) — the recruiter's top card inside the desktop app. The app tells (folderTraces) whether the project's folder on this
// computer carries a CLAUDE.md / AGENTS.md, and which of THIS project's agents already work in it there:
//  · a trace → «이 프로젝트 폴더에 {file} 파일이 있어요» + [이 폴더의 에이전트로 채용] first; pressing it skips choosing a role (the «역할 없이» way, second step,
//    that file's runtime already chosen) · none → the page exactly as it was;
//  · an agent already there → «이 컴퓨터에서 … 일하는 에이전트가 있어요» + [이 컴퓨터에서 시작] per agent (never a second recruit for the same folder).
// Copy keys come from Yuna's 4693-copy.md; the harness is the 4680 one (mocked t → `ns.key({vars})`).
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) { return { ok, status, json: async () => body } as Response; }
async function flush() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }
let heroClass = '';
const HERO = () => heroClass;
const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const CAPS = RUNTIME_CAPABILITIES_FALLBACK;
const CL = { runtime: 'claude' as const, version: '2.1.0', executable: '/b/claude' };
const CX = { runtime: 'codex' as const, version: '0.1.0', executable: '/b/codex' };
const bridgeWith = (runtimes: unknown[], folderTraces?: unknown) => Object.freeze({
  inApp: true as const, device: { name: 'yoonjae의 맥' }, runtimes,
  pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })),
  ...(folderTraces ? { folderTraces } : {}),
});

describe('[SID:4693] RecruiterClient — the folder trace card inside the desktop app', () => {
  let container: HTMLDivElement;
  let root: Root;
  let agents: Array<{ id: string; name: string; type: string }>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    agents = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: CAPS });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: agents });
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
    await act(async () => { root = createRoot(container); root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />); });
    await flush();
  }
  const useApp = (b: unknown) => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = b; };

  it('a CLAUDE.md in the project\'s folder: the card (title with the file · body with the runtime and the file) and [이 폴더의 에이전트로 채용] — drawn above the role question', async () => {
    const ask = vi.fn(async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] }));
    useApp(bridgeWith([CL], ask));
    await mount();
    const card = q(container, 'folder-trace-card')!;
    expect(card).not.toBeNull(); // reverted (no card) → fails
    expect(card.textContent).toContain('recruiter.folderTraceTitle({"file":"CLAUDE.md"})');
    expect(card.textContent).toContain('recruiter.folderTraceBody({"runtime":"Claude Code","file":"CLAUDE.md"})');
    expect(q(container, 'folder-trace-recruit')!.textContent).toBe('recruiter.folderTraceRecruit');
    expect(container.textContent!.indexOf('recruiter.folderTraceTitle')).toBeLessThan(container.textContent!.indexOf('recruiter.roleQuestion')); // first choice on the page
    expect(q(container, 'folder-agent-card')).toBeNull();
    // the app is asked about THIS project (its kept folder — never a path from the page) and about this project's agents only
    expect(ask).toHaveBeenCalledWith({ projectId: 'proj-1', agentIds: [] });
  });

  it('[이 폴더의 에이전트로 채용] → the «역할 없이» way at its second step: no role to pick, the file\'s runtime already the chosen one (AGENTS.md → codex even when claude comes first)', async () => {
    useApp(bridgeWith([CL, CX], async () => ({ traces: [{ file: 'AGENTS.md', runtime: 'codex' }], agents: [] })));
    await mount();
    expect(q(container, 'folder-trace-card')!.textContent).toContain('"file":"AGENTS.md"');
    await click(q(container, 'folder-trace-recruit')!);
    await flush();
    expect(q(container, 'folder-trace-card')).toBeNull(); // we are past step 1
    expect(container.textContent).not.toContain('recruiter.roleQuestion');
    expect(container.textContent).toContain('recruiter.equipCreateCta'); // the key-only form's create button (name · role · runtime on this step)
    const codex = q(container, 'recruiter-found-codex')!;
    const claude = q(container, 'recruiter-found-claude')!;
    expect(codex.className).toContain('ring-1'); // chosen by the file, not the default (claude first)
    expect(claude.className).not.toContain('ring-1');
  });

  it('both files and the app found codex first → the card names AGENTS.md · the file whose runtime the app found first (design §2)', async () => {
    useApp(bridgeWith([CX, CL], async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'codex' }], agents: [] })));
    await mount();
    expect(q(container, 'folder-trace-card')!.textContent).toContain('"file":"AGENTS.md"');
  });

  it('nothing to offer → the page exactly as before: no trace · a trace of a runtime that is not on this computer · an empty answer · an older app (no hand) · a browser', async () => {
    const nothing = async () => ({ traces: [], agents: [] });
    useApp(bridgeWith([CL], nothing)); await mount(); expect(q(container, 'folder-trace-card')).toBeNull(); expect(q(container, 'folder-agent-card')).toBeNull(); expect(container.textContent).toContain('recruiter.roleQuestion');
    act(() => root.unmount());
    useApp(bridgeWith([CX], async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] }))); root = createRoot(container); await mount(); expect(q(container, 'folder-trace-card')).toBeNull();
    act(() => root.unmount());
    useApp(bridgeWith([CL])); root = createRoot(container); await mount(); expect(q(container, 'folder-trace-card')).toBeNull(); // an older app: no folderTraces hand
    act(() => root.unmount());
    delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop; root = createRoot(container); await mount(); expect(q(container, 'folder-trace-card')).toBeNull(); expect(container.textContent).toContain('recruiter.roleQuestion');
  });

  it('an agent of this project already works in that folder: ③ replaces the card — its name · [이 컴퓨터에서 시작] → startHere({agentId}) · opened line · no second recruit offered', async () => {
    agents = [{ id: 'a1', name: 'Rin', type: 'agent' }, { id: 'a2', name: 'Sol', type: 'agent' }];
    const ask = vi.fn(async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: ['a1', 'intruder-from-another-org'] }));
    const b = bridgeWith([CL], ask);
    useApp(b);
    await mount();
    expect(ask.mock.calls).toEqual([[{ projectId: 'proj-1', agentIds: ['a1', 'a2'] }]]); // asked ONCE, when this project's agents were known — and about them only
    expect(q(container, 'folder-trace-card')).toBeNull(); // not a second recruit for the same folder
    const card = q(container, 'folder-agent-card')!;
    expect(card.textContent).toContain('recruiter.folderAgentTitle');
    expect(card.textContent).toContain('recruiter.folderAgentBody');
    const rows = [...card.querySelectorAll('[data-testid=folder-agent-row]')];
    expect(rows).toHaveLength(1); // the id this project does not have is dropped; a2 has no profile there
    expect(rows[0]!.textContent).toContain('Rin');
    await click(rows[0]!.querySelector('[data-testid=folder-agent-start]')!);
    await flush();
    expect(b.startHere).toHaveBeenCalledWith({ agentId: 'a1' });
    expect(q(container, 'folder-agent-opened')!.textContent).toBe('recruiter.startHereOpened');
    heroClass = q(container, 'folder-agent-start')!.className; // one agent → the hero button (the next test compares)
    expect(heroClass).toContain('bg-'); expect(heroClass).not.toBe('');
  });

  it('the start failed → the failed line (an alert) · two agents → one row each, no two heroes', async () => {
    agents = [{ id: 'a1', name: 'Rin', type: 'agent' }, { id: 'a2', name: '', type: 'agent' }];
    const b = bridgeWith([CL], async () => ({ traces: [], agents: ['a1', 'a2'] }));
    (b.startHere as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: 'ignored' });
    useApp(b);
    await mount();
    const rows = [...container.querySelectorAll('[data-testid=folder-agent-row]')];
    expect(rows).toHaveLength(2); // an agent in the folder with no trace in it still tells
    expect(rows[1]!.textContent).toContain('common.agentUnnamed');
    const buttons = rows.map((r) => r.querySelector('button')!);
    expect(buttons[0]!.className).toBe(buttons[1]!.className);
    expect(buttons[0]!.className).not.toBe(HERO()); // two agents → both outline: the page never has two heroes
    await click(buttons[0]!);
    await flush();
    expect(q(container, 'folder-agent-failed')!.getAttribute('role')).toBe('alert');
    expect(q(container, 'folder-agent-opened')).toBeNull();
  });
});
