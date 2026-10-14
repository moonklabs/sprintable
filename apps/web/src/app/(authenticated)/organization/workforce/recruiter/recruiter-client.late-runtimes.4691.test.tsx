// @vitest-environment jsdom
//
// story 4691 (UX-1 · D1/D2 follow-up) — the app's «found here» list can arrive AFTER the page loaded (detection takes seconds): the
// hire wizard must still show it and apply the found default, WITHOUT a reload — and a runtime a person already clicked stands.
// The bridge's fourth hand `subscribeRuntimes` calls back right away with the app's newest list, then on change (lib/desktop-app.ts).
// Harness: recruiter-client.in-app.4680 (the equip-skip way to the runtime picker).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RecruiterClient } from './recruiter-client';
import { RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';
import { __resetDesktopAppForTest, type DesktopRuntimeFound } from '@/lib/desktop-app';
import { emitOnboardingEvent, beaconOnboardingEvent } from '@/app/onboarding/onboarding-telemetry';

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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}
async function flush() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); }
const buttonsWithText = (c: HTMLElement, match: (t: string) => boolean) => Array.from(c.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }
async function toPicker(container: HTMLElement) {
  await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
  await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!);
  await flush();
}

const CODEX: DesktopRuntimeFound = { runtime: 'codex', version: '0.156.1', executable: '/opt/homebrew/bin/codex' };
const CLAUDE: DesktopRuntimeFound = { runtime: 'claude', version: '2.0.14', executable: '/Users/yoonjae/.local/bin/claude' };

/** the app's bridge: `runtimes` is the load-time snapshot; `subscribeRuntimes` (when `withSubscribe`) replays at once, then on `push` */
function appBridge(snapshot: DesktopRuntimeFound[], withSubscribe = true) {
  let current = snapshot;
  const callbacks = new Set<(r: readonly DesktopRuntimeFound[]) => void>();
  const base = {
    inApp: true as const, device: { name: 'yoonjae의 맥' }, runtimes: snapshot,
    pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })),
  };
  const subscribeRuntimes = (cb: (r: readonly DesktopRuntimeFound[]) => void) => { callbacks.add(cb); cb(current); return () => { callbacks.delete(cb); }; };
  return {
    bridge: Object.freeze(withSubscribe ? { ...base, subscribeRuntimes } : base),
    push: async (next: DesktopRuntimeFound[]) => { current = next; await act(async () => { for (const cb of [...callbacks]) cb(next); }); },
  };
}

const sent: string[] = []; // every request the page made: «METHOD url body»

describe('[SID:4691] RecruiterClient — the found list arrives after the page loaded', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    sent.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      sent.push(`${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`);
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: RUNTIME_CAPABILITIES_FALLBACK });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      throw new Error(`unmocked fetch: ${url}`);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop;
    __resetDesktopAppForTest();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    await flush();
  }
  const group = () => container.querySelector('[data-testid=recruiter-found-here]') as HTMLElement | null;
  const foundCards = () => [...(group()?.querySelectorAll('button') ?? [])];

  it('AC1 — loaded with nothing found, the app then finds codex + claude: the «found here» group appears in the app\'s order and the first is the default — no reload', async () => {
    const app = appBridge([]);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    expect(group()).toBeNull();
    expect(container.querySelector('[data-testid=recruiter-found-none]')).not.toBeNull(); // «nothing yet» is what the page said

    await app.push([CODEX, CLAUDE]);
    expect(group()).not.toBeNull(); // reverted (no subscription: read once) → still null → fails
    expect(foundCards().map((c) => c.getAttribute('data-testid'))).toEqual(['recruiter-found-codex', 'recruiter-found-claude']);
    expect(foundCards()[0]!.className).toContain('ring-1'); // the found default, applied once the list is known
    expect(foundCards()[1]!.className).not.toContain('ring-1');
    expect(container.querySelector('[data-testid=recruiter-found-none]')).toBeNull();
  });

  it('a runtime the person already clicked stands — the late list shows up but does not replace the pick with the found default', async () => {
    const app = appBridge([]);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    const cursor = buttonsWithText(container, (t) => t.endsWith('Cursor'))[0]!;
    await click(cursor);
    expect(buttonsWithText(container, (t) => t.endsWith('Cursor'))[0]!.className).toContain('ring-1');

    await app.push([CODEX, CLAUDE]);
    expect(foundCards()).toHaveLength(2); // the list is there …
    expect(foundCards().every((c) => !c.className.includes('ring-1'))).toBe(true); // … and neither found card took the selection
    expect(buttonsWithText(container, (t) => t.endsWith('Cursor'))[0]!.className).toContain('ring-1'); // the person's pick stands (reverted guard → fails)
  });

  it('a person who picks a found runtime after the late list keeps it (the default is applied once, not on every change)', async () => {
    const app = appBridge([]);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    await app.push([CODEX, CLAUDE]);
    await click(foundCards()[1]!); // the person takes the second
    expect(foundCards()[1]!.className).toContain('ring-1');
    await app.push([CODEX, CLAUDE, ]); // the same list again → no event
    await app.push([CLAUDE, CODEX]); // the app's order changed
    const cards = foundCards();
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['recruiter-found-claude', 'recruiter-found-codex']);
    expect(cards[0]!.className).toContain('ring-1'); // still claude — the person's pick, not the new first by accident of order
    expect(cards[1]!.className).not.toContain('ring-1');
  });

  it('the found default is applied once — a later change of the list (a re-scan in the app) does not move the selection under the person\'s eyes', async () => {
    const app = appBridge([]);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    await app.push([CODEX]);
    expect(foundCards()[0]!.className).toContain('ring-1'); // codex is the default
    await app.push([CLAUDE, CODEX]); // a re-scan: claude is now first
    const cards = foundCards();
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['recruiter-found-claude', 'recruiter-found-codex']);
    expect(cards[1]!.className).toContain('ring-1'); // still codex (reverted: applied on every change → claude) → fails
    expect(cards[0]!.className).not.toContain('ring-1');
  });

  it('an older app (no subscribeRuntimes): the first read is all there is — nothing found stays «nothing yet», as before', async () => {
    const app = appBridge([], false);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    expect(group()).toBeNull();
    expect(container.querySelector('[data-testid=recruiter-found-none]')).not.toBeNull();
    await app.push([CODEX]); // no hand → nothing listens
    expect(group()).toBeNull();
  });

  it('a browser (no bridge): the picker as before — nothing to subscribe to', async () => {
    await mount();
    await toPicker(container);
    expect(group()).toBeNull();
    expect(container.querySelector('[data-testid=recruiter-found-none]')).toBeNull();
  });

  // Kadir ⑥ — the app's `executable` (a path on THIS person's computer) is shown on the page and goes nowhere else: not in a request
  // (url · body), not in an onboarding/analytics event, not in a console line.
  it('⑥ the found runtimes\' paths stay on the page — no request body · analytics event · console line carries them', async () => {
    const logs: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); }));
    vi.mocked(emitOnboardingEvent).mockClear();
    vi.mocked(beaconOnboardingEvent).mockClear();
    const app = appBridge([]);
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = app.bridge;
    await mount();
    await toPicker(container);
    await app.push([CODEX, CLAUDE]);
    await click(foundCards()[1]!); // a person works with the found list
    await click(foundCards()[0]!);
    // the control: the paths ARE on the page (a card's title) — so the checks below are not vacuous
    const titles = [...(group()?.querySelectorAll('[title]') ?? [])].map((e) => e.getAttribute('title') ?? '').join(' ');
    expect(titles).toContain(CODEX.executable);
    expect(titles).toContain(CLAUDE.executable);
    await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0] ?? container); // and on to the next step
    await flush();
    const everywhereElse = JSON.stringify([sent, vi.mocked(emitOnboardingEvent).mock.calls, vi.mocked(beaconOnboardingEvent).mock.calls, logs]);
    expect(sent.length).toBeGreaterThan(0); // the page did talk to the server (capabilities · projects …)
    for (const path of [CODEX.executable, CLAUDE.executable, '/opt/homebrew/bin', '.local/bin']) expect(everywhereElse).not.toContain(path);
    spies.forEach((s) => s.mockRestore());
  });

  it('⑥ source pin — outside the bridge reader, only the found card\'s title reads `.executable`', () => {
    const root = join(__dirname, '../../../../..'); // apps/web/src
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => { if (/\.executable\b/.test(line)) hits.push(`${full.slice(root.length + 1)}:${i + 1}`); });
      }
    };
    walk(root);
    const outsideReader = hits.filter((h) => !h.startsWith('lib/desktop-app.ts:'));
    expect(outsideReader).toHaveLength(1); // a new reader of the path must come here on purpose
    expect(outsideReader[0]).toContain('recruiter-client.tsx');
  });
});
