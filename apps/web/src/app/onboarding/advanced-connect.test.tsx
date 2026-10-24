// @vitest-environment jsdom
/**
 * story 4766 — the folded web way: one press makes the project + agent + key and copies the ONE line; the screen names where the key stays
 * (Kadir's lens); [키 폐기] is in the same place; the panel (4761) turns «connected» by itself. Nothing here runs anything on the computer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

// the key's prefix is built, not written: a literal `sk_live_…` reads as a Stripe key to the push-protection scanner
const KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_');
const NEW_KEY = ['sk', 'live', 'NEWKEYNEWKEYNEWKEYNEWKEY00000000WXYZ'].join('_');
const MCP = 'https://dev-mcp.sprintable.ai/mcp';
const ARTIFACT = JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: MCP, headers: { Authorization: 'Bearer <YOUR_AGENT_API_KEY>' } } } });

type Handler = (init?: RequestInit) => { ok: boolean; status?: number; body?: unknown } | Promise<{ ok: boolean; status?: number; body?: unknown }>;
const routes = new Map<string, Handler>();
const calls: { url: string; method: string; body: unknown }[] = [];

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const h = routes.get(`${method} ${url.split('?')[0]}`);
    const r = h ? await h(init) : { ok: false, status: 404, body: {} };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }),
  refreshAuthTokens: vi.fn(async () => ({ data: null, error: null })),
}));

const copied: string[] = [];
const promised: Promise<string>[] = []; // every line the press handed the clipboard a promise of
let copyOk = true;
vi.mock('@/lib/clipboard', () => ({
  copyTextSafely: vi.fn(async (text: string) => { copied.push(text); return copyOk ? { ok: true } : { ok: false }; }),
  // the press hands the clipboard a PROMISE of the line (the write starts inside the click) — settled here the way the browser would
  copyPromisedText: vi.fn(async (p: Promise<string>) => { promised.push(p); try { const text = await p; copied.push(text); return copyOk ? { ok: true } : { ok: false }; } catch { return { ok: false }; } }),
}));
vi.mock('@/components/desktop/desktop-setup', () => ({
  INSTALL: { claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'curl -fsSL https://example.test/codex/install.sh | sh' },
  RUNTIME_LABEL: { claude: 'Claude Code', codex: 'Codex' },
}));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));
vi.mock('./onboarding-telemetry', () => ({ emitOnboardingEvent: vi.fn(), beaconOnboardingEvent: vi.fn() }));

import { AdvancedConnect } from './advanced-connect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const ko = koMessages.onboarding.advanced;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => container.textContent ?? '';
const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
const press = async (id: string) => { await act(async () => { q(id)!.click(); }); await flush(); };

function happyRoutes(overrides: Record<string, Handler> = {}) {
  routes.clear();
  routes.set('GET /api/projects', () => ({ ok: true, body: { data: [] } }));
  routes.set('POST /api/projects', () => ({ ok: true, body: { data: { id: 'proj-1' } } }));
  routes.set('POST /api/current-project', () => ({ ok: true, body: {} }));
  routes.set('POST /api/team-members', () => ({ ok: true, body: { data: { id: 'agent-1', api_key: KEY } } }));
  routes.set('GET /api/agents/agent-1/connection-artifact', () => ({ ok: true, body: { data: { files: [{ filename: '.mcp.json', content: ARTIFACT }] } } }));
  routes.set('GET /api/agents/agent-1/verification-status', () => ({ ok: true, body: { data: { verified: false, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }] } } }));
  routes.set('GET /api/agents/agent-1/api-key', () => ({ ok: true, body: { data: [{ id: 'key-1', revoked_at: null }] } }));
  routes.set('DELETE /api/agents/agent-1/api-key/key-1', () => ({ ok: true, body: {} }));
  routes.set('POST /api/agents/agent-1/api-key', () => ({ ok: true, body: { data: { api_key: NEW_KEY } } }));
  for (const [k, v] of Object.entries(overrides)) routes.set(k, v);
}

async function mount(onFinish = vi.fn(), locale: 'ko' | 'en' = 'ko', onWorking?: (w: boolean) => void) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AdvancedConnect orgId="org-1" onFinish={onFinish} onWorking={onWorking} />
      </NextIntlClientProvider>,
    );
  });
  return onFinish;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls.length = 0; copied.length = 0; promised.length = 0; copyOk = true;
  happyRoutes();
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.clearAllMocks(); });

describe('AdvancedConnect — story 4766', () => {
  it('AC4 · before the press: the two programs it needs, the install lines (the app setup\'s constants), and «the app checks them» — no status, no run button', async () => {
    await mount();
    expect(q('advanced-prereq')?.textContent).toContain(ko.prereqTitle);
    expect(q('advanced-install-claude')?.textContent).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(q('advanced-install-codex')?.textContent).toContain('install.sh | sh');
    expect(q('advanced-prereq-app')?.textContent).toBe(ko.prereqApp);
    // the web cannot see this computer: nothing says «installed» / «signed in» as a fact, and nothing runs
    expect(q('advanced-prereq')?.textContent).not.toMatch(/깔렸어요|로그인했어요|확인됨/);
    expect(calls).toHaveLength(0); // nothing is made until the press
  });

  it('AC2: ONE press makes the project, the agent and its key, reads the hosted address, and copies the line — the screen shows it masked', async () => {
    await mount();
    await press('advanced-make');
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual(expect.arrayContaining([
      'GET /api/projects', 'POST /api/projects', 'POST /api/current-project', 'POST /api/team-members', 'GET /api/agents/agent-1/connection-artifact',
    ]));
    const agentBody = calls.find((c) => c.url === '/api/team-members')!.body as Record<string, unknown>;
    expect(agentBody).toMatchObject({ org_id: 'org-1', project_id: 'proj-1', type: 'agent', name: ko.defaultAgent });
    // the clipboard holds the real line — once, the only place the key is copied from
    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe(`claude mcp add --transport http --scope local sprintable-mcp ${MCP} --header 'Authorization: Bearer ${KEY}' && claude '${koMessages.onboarding.verifyExamplePrompt}'`);
    // the screen never holds the key in the clear
    expect(q('advanced-line')?.textContent).toContain('sk_live_••••ABCD');
    expect(text()).not.toContain(KEY);
    expect(q('advanced-line')?.textContent).not.toMatch(/--scope project/);
    expect(q('advanced-copy')?.textContent).toContain(ko.copied);
  });

  it('Kadir (1): the screen names shell history · clipboard · the settings file, with [키 폐기] in the same place', async () => {
    await mount();
    await press('advanced-make');
    const line = q('advanced-key-line')!;
    expect(line.textContent).toContain('터미널 명령 기록');
    expect(line.textContent).toContain('클립보드');
    expect(line.textContent).toContain('~/.claude.json');
    expect(line.contains(q('advanced-revoke'))).toBe(true);
    expect(line.textContent).not.toMatch(/앞에 공백|공백을 넣/); // Kadir (3): no «put a space before it»
  });

  it('Codex: a different runtime gives its own line — the key goes in an environment variable, and the screen says where that stays', async () => {
    await mount();
    await press('advanced-make');
    const before = copied.length;
    await press('advanced-runtime-codex');
    expect(copied.length).toBe(before); // switching the choice writes nothing to the clipboard (codex round 1: a secret-bearing write is the person's press)
    await press('advanced-copy');
    expect(copied.at(-1)).toContain(`export SPRINTABLE_AGENT_KEY='${KEY}' && codex mcp add sprintable-mcp --url ${MCP} --bearer-token-env-var SPRINTABLE_AGENT_KEY`);
    expect(q('advanced-key-line')?.textContent).toContain('SPRINTABLE_AGENT_KEY');
    expect(q('advanced-key-line')?.textContent).toContain('터미널 명령 기록');
    expect(q('advanced-line')?.textContent).not.toContain(KEY);
  });

  it('[키 폐기]: every live key of the agent is revoked, the line goes away, and a new key can be made again (the line is rebuilt and copied)', async () => {
    await mount();
    await press('advanced-make');
    await press('advanced-revoke');
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/agent-1/api-key/key-1')).toBe(true);
    expect(q('advanced-revoked')?.textContent).toBe(ko.revokedNote);
    expect(q('advanced-line')).toBeNull(); // the revoked command is not left on the screen
    await press('advanced-make'); // now «새 키로 다시 만들기»
    const created = calls.find((c) => c.method === 'POST' && c.url === '/api/agents/agent-1/api-key')!;
    expect((created.body as { scope: unknown; expires_at: string }).scope).toBeNull();
    expect(typeof (created.body as { expires_at: string }).expires_at).toBe('string'); // the key manager's rule: an expiry is always chosen
    expect(copied.at(-1)).toContain(NEW_KEY);
    expect(q('advanced-line')?.textContent).toContain('sk_live_••••WXYZ');
  });

  it('AC7 [키 폐기] fails → said, the key stays shown, nothing pretends it was revoked', async () => {
    happyRoutes({ 'DELETE /api/agents/agent-1/api-key/key-1': () => ({ ok: false, status: 500, body: {} }) });
    await mount();
    await press('advanced-make');
    await press('advanced-revoke');
    expect(q('advanced-revoke-failed')?.textContent).toBe(ko.revokeFailed);
    expect(q('advanced-revoked')).toBeNull();
    expect(q('advanced-line')).not.toBeNull();
  });

  it('AC7 failure branches each say one thing and make no half-state the person cannot retry', async () => {
    const cases: [string, Record<string, Handler>, string][] = [
      ['agent', { 'POST /api/team-members': () => ({ ok: false, status: 500, body: { error: { message: 'raw server text' } } }) }, ko.failure.agent],
      ['project', { 'POST /api/projects': () => ({ ok: false, status: 500, body: {} }) }, ko.failure.project],
      ['key', { 'POST /api/team-members': () => ({ ok: true, body: { data: { id: 'agent-1' } } }), 'POST /api/agents/agent-1/api-key': () => ({ ok: false, status: 500, body: {} }) }, ko.failure.key],
      ['hosted', { 'GET /api/agents/agent-1/connection-artifact': () => ({ ok: false, status: 400, body: {} }) }, ko.failure.hosted],
    ];
    for (const [, over, expected] of cases) {
      happyRoutes(over);
      calls.length = 0;
      await mount();
      await press('advanced-make');
      expect(q('advanced-failed')?.textContent).toBe(expected);
      expect(text()).not.toContain('raw server text'); // a made sentence, never the server's words
      expect(q('advanced-make')?.hasAttribute('disabled')).toBe(false); // the press can be made again
      await act(async () => { root.render(<div />); });
    }
  });

  it('AC7 the network drops in the middle → «네트워크가 끊겼어요», the press is open again', async () => {
    happyRoutes({ 'POST /api/team-members': () => { throw new Error('offline'); } });
    await mount();
    await press('advanced-make');
    expect(q('advanced-failed')?.textContent).toBe(ko.failure.network);
    expect(q('advanced-make')?.hasAttribute('disabled')).toBe(false);
  });

  it('AC7 pasting fails (the clipboard refuses) → said; the real line is NOT drawn until [명령 보기] is pressed, right under the key\'s warning', async () => {
    copyOk = false;
    await mount();
    await press('advanced-make');
    expect(text()).toContain(ko.copyFailed);
    // before the press: no raw line anywhere on the screen (the masked one is the only line drawn)
    expect(q('advanced-copy-failed-raw')).toBeNull();
    expect(container.innerHTML).not.toContain(KEY);
    expect(q('advanced-copy')?.textContent).not.toContain(ko.copied); // never «복사됨» for a copy that failed
    // the button sits after the warning box (same place, the warning first)
    const warn = q('advanced-key-line')!; const show = q('advanced-show-command')!;
    expect(show).not.toBeNull();
    expect(warn.compareDocumentPosition(show) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await press('advanced-show-command');
    expect((q('advanced-copy-failed-raw') as HTMLTextAreaElement).value).toContain(`Bearer ${KEY}`);
    expect(q('advanced-show-command')).toBeNull();
  });

  it('a failed copy that is shown, then a new key is made: the new line is hidden again until pressed for', async () => {
    copyOk = false;
    await mount();
    await press('advanced-make');
    await press('advanced-show-command');
    await press('advanced-revoke');
    await press('advanced-make'); // «다시 만들기» after the revoke → rekey
    expect(q('advanced-copy-failed-raw')).toBeNull();
    expect(container.innerHTML).not.toContain('sk_live_NEWKEY');
  });

  it('codex 5 / Kadir — «hidden until pressed» holds again after a toggle (Claude → Codex → Claude) and after a new refusal', async () => {
    copyOk = false;
    await mount();
    await press('advanced-make');
    await press('advanced-show-command');
    expect(q('advanced-copy-failed-raw')).not.toBeNull();
    await press('advanced-runtime-codex'); // the toggle withdraws the line and the reveal
    expect(q('advanced-copy-failed-raw')).toBeNull();
    await press('advanced-runtime-claude');
    await press('advanced-copy'); // refused again — the very same line as before
    expect(q('advanced-copy-failed-raw')).toBeNull(); // NOT shown without a new press
    expect(q('advanced-show-command')).not.toBeNull();
    expect(container.innerHTML).not.toContain(KEY);
    await press('advanced-show-command');
    expect((q('advanced-copy-failed-raw') as HTMLTextAreaElement).value).toContain(`Bearer ${KEY}`);
    await press('advanced-copy'); // and a second refusal while it is shown hides it again
    expect(q('advanced-copy-failed-raw')).toBeNull();
  });

  it('codex/Kadir — every failure branch REJECTS the promise the clipboard was handed (nothing half-written, no hanging write)', async () => {
    const branches: [string, Record<string, Handler>][] = [
      ['project', { 'POST /api/projects': () => ({ ok: false, status: 500, body: {} }) }],
      ['agent', { 'POST /api/team-members': () => ({ ok: false, status: 500, body: {} }) }],
      ['key', { 'POST /api/team-members': () => ({ ok: true, body: { data: { id: 'agent-1' } } }), 'POST /api/agents/agent-1/api-key': () => ({ ok: false, status: 500, body: {} }) }],
      ['hosted', { 'GET /api/agents/agent-1/connection-artifact': () => ({ ok: false, status: 400, body: {} }) }],
      ['network', { 'POST /api/team-members': () => { throw new Error('offline'); } }],
    ];
    for (const [name, over] of branches) {
      happyRoutes(over);
      promised.length = 0;
      await mount();
      await press('advanced-make');
      expect(promised, name).toHaveLength(1);
      const settled = await Promise.race([
        promised[0]!.then(() => 'resolved', () => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still pending'), 50)),
      ]);
      expect(settled, `${name}: the clipboard's promise`).toBe('rejected');
      await act(async () => { root.render(<div />); });
    }
  });

  it('an existing first project is used, not a second one made (a reload · a second visit)', async () => {
    happyRoutes({ 'GET /api/projects': () => ({ ok: true, body: { data: [{ id: 'proj-existing' }] } }) });
    await mount();
    await press('advanced-make');
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/projects')).toBe(false);
    expect((calls.find((c) => c.url === '/api/team-members')!.body as { project_id: string }).project_id).toBe('proj-existing');
  });

  it('the panel turns «connected» by itself, naming the first call; the first instruction button then goes to a new conversation', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => { q('advanced-make')!.click(); await vi.advanceTimersByTimeAsync(50); });
      routes.set('GET /api/agents/agent-1/verification-status', () => ({ ok: true, body: { data: { verified: true, first_call_at: '2026-10-23T23:24:04.418874+00:00', rail: [
        { state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' }, { state: 'mcp_reachable', status: 'done' }, { state: 'verified', status: 'done' }] } } }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(q('advanced-verified')?.textContent).toContain('처음 호출했어요');
      expect(q('advanced-verified')?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-23T23:24:04.418874+00:00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the finish button leaves the way the caller says (오늘 · 대시보드)', async () => {
    const onFinish = await mount();
    await press('advanced-make');
    await press('advanced-finish');
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('codex round 1 — a late failure (the agent was made, the hosted address was not readable) is RESUMED, not repeated: the retry makes no second agent', async () => {
    let artifactOk = false;
    happyRoutes({ 'GET /api/agents/agent-1/connection-artifact': () => (artifactOk ? { ok: true, body: { data: { files: [{ filename: '.mcp.json', content: ARTIFACT }] } } } : { ok: false, status: 500, body: {} }) });
    await mount();
    await press('advanced-make');
    expect(q('advanced-failed')?.textContent).toBe(ko.failure.hosted);
    artifactOk = true;
    await press('advanced-make');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/team-members')).toHaveLength(1); // one agent, however many presses
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/projects')).toHaveLength(1);
    expect(q('advanced-line')?.textContent).toContain('sk_live_••••ABCD');
  });

  it('codex round 1 — the agent was made but its answer carried no key: the retry asks for a key for THAT agent (no second agent)', async () => {
    happyRoutes({ 'POST /api/team-members': () => ({ ok: true, body: { data: { id: 'agent-1' } } }) });
    await mount();
    await press('advanced-make'); // the key comes from the key route right away
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/team-members')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/agents/agent-1/api-key')).toBe(true);
    expect(q('advanced-ready')).not.toBeNull();
  });

  it('codex round 1 — a project list that cannot be read is a failure (never «there is none», or a second project is made)', async () => {
    happyRoutes({ 'GET /api/projects': () => ({ ok: false, status: 500, body: {} }) });
    await mount();
    await press('advanced-make');
    expect(q('advanced-failed')?.textContent).toBe(ko.failure.project);
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/projects')).toBe(false);
  });

  it('codex round 1 — with several projects the OLDEST is the first project', async () => {
    happyRoutes({ 'GET /api/projects': () => ({ ok: true, body: { data: [{ id: 'p-new', created_at: '2026-10-24T01:00:00Z' }, { id: 'p-old', created_at: '2026-10-01T01:00:00Z' }] } }) });
    await mount();
    await press('advanced-make');
    expect((calls.find((c) => c.url === '/api/team-members')!.body as { project_id: string }).project_id).toBe('p-old');
  });

  it('codex round 1 — a key that is not plain characters is never put on a command line (the press says it did not get a key)', async () => {
    happyRoutes({ 'POST /api/team-members': () => ({ ok: true, body: { data: { id: 'agent-1', api_key: "sk_live_a'b$(x)000000" } } }), 'POST /api/agents/agent-1/api-key': () => ({ ok: true, body: { data: { api_key: 'also odd key' } } }) });
    await mount();
    await press('advanced-make');
    expect(q('advanced-failed')?.textContent).toBe(ko.failure.key);
    expect(q('advanced-line')).toBeNull();
    expect(copied).toHaveLength(0); // nothing reached the clipboard
  });

  it('codex round 2 — «oldest» is by the instant, whatever offset the times are written in; a project without a time comes last', async () => {
    happyRoutes({ 'GET /api/projects': () => ({ ok: true, body: { data: [
      { id: 'p-none' },
      { id: 'p-lexically-first', created_at: '2026-10-01T23:00:00-05:00' }, // = 10-02T04:00Z — the smaller STRING, the later instant
      { id: 'p-earliest-instant', created_at: '2026-10-02T01:00:00+09:00' }, // = 10-01T16:00Z — the larger string, the earlier instant
      { id: 'p-unreadable', created_at: 'not a time' },
    ] } }) });
    await mount();
    await press('advanced-make');
    expect((calls.find((c) => c.url === '/api/team-members')!.body as { project_id: string }).project_id).toBe('p-earliest-instant');
  });

  it('codex round 2 — a press that failed on the key (agent made) and is pressed again keeps the SAME agent and asks the key route', async () => {
    let keyOk = false;
    happyRoutes({
      'POST /api/team-members': () => ({ ok: true, body: { data: { id: 'agent-1' } } }),
      'POST /api/agents/agent-1/api-key': () => (keyOk ? { ok: true, body: { data: { api_key: KEY } } } : { ok: false, status: 500, body: {} }),
    });
    await mount();
    await press('advanced-make');
    expect(q('advanced-failed')?.textContent).toBe(ko.failure.key);
    keyOk = true;
    await press('advanced-make');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/team-members')).toHaveLength(1); // still one agent
    expect(q('advanced-line')?.textContent).toContain('sk_live_••••ABCD');
  });

  it('codex round 1 — the screen\'s other way out waits while the press is making things (an agent and key made with nothing left to revoke them)', async () => {
    const seen: boolean[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    happyRoutes({ 'POST /api/team-members': async () => { await gate; return { ok: true, body: { data: { id: 'agent-1', api_key: KEY } } }; } });
    await mount(vi.fn(), 'ko', (w) => seen.push(w));
    await act(async () => { q('advanced-make')!.click(); await Promise.resolve(); });
    expect(seen).toEqual([true]);
    await act(async () => { release(); await Promise.resolve(); });
    await flush();
    expect(seen).toEqual([true, false]);
  });

  it('Kadir — the key line also says the command shows in the process list for the moment it runs', async () => {
    await mount();
    await press('advanced-make');
    expect(q('advanced-key-line')?.textContent).toContain('프로세스 목록');
  });

  it('en reads too', async () => {
    await mount(vi.fn(), 'en');
    expect(q('advanced-prereq')?.textContent).toContain(enMessages.onboarding.advanced.prereqTitle);
    await press('advanced-make');
    expect(q('advanced-key-line')?.textContent).toContain('shell history');
  });
});
