// @vitest-environment jsdom
//
// story 4680 (UX-1 · D2 · AC1 · AC3) — the recruiter's runtime picker inside the desktop app: the runtimes the app found on this
// computer come first (bridge order) and the first is the default; nothing found → one line with the way to install; in a browser
// (no bridge) the picker is exactly as before. The bridge is `window.sprintableDesktop` (D1 · lib/desktop-app.ts); the picker is
// reached through the equip-skip form (the same renderRuntimePicker · #2433 B), the harness of recruiter-client.equip-codex-mount.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RecruiterClient, foundRuntimes, startHereMode } from './recruiter-client';
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}
async function flush() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); }
const buttonsWithText = (c: HTMLElement, match: (t: string) => boolean) => Array.from(c.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }

/** the equip-skip way to the runtime picker: «역할 없이» → [다음] */
async function toPicker(container: HTMLElement) {
  await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
  await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!);
  await flush();
}

const CAPS = RUNTIME_CAPABILITIES_FALLBACK; // claude-code → claude · codex → codex · the rest no desktop runtime
const bridgeWith = (runtimes: { runtime: 'claude' | 'codex'; version: string; executable: string }[]) => Object.freeze({
  inApp: true as const, device: { name: 'yoonjae의 맥' }, runtimes,
  pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })),
});

describe('[SID:4680] RecruiterClient — the runtime picker inside the desktop app', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: CAPS });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
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
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    await flush();
  }

  it('found (codex first · then claude): the «found here» group with device · version · path, the first found is the default · the supported grid leaves them out', async () => {
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = bridgeWith([
      { runtime: 'codex', version: '0.156.1', executable: '/opt/homebrew/bin/codex' },
      { runtime: 'claude', version: '2.0.14', executable: '/Users/yoonjae/.local/bin/claude' },
    ]);
    await mount();
    await toPicker(container);
    const group = container.querySelector('[data-testid=recruiter-found-here]') as HTMLElement;
    expect(group).not.toBeNull(); // reverted (no group) → fails
    expect(group.querySelector('[data-testid=recruiter-found-here-device]')?.textContent).toContain('yoonjae의 맥');
    const cards = [...group.querySelectorAll('button')];
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['recruiter-found-codex', 'recruiter-found-claude']); // bridge order
    expect(cards[0]!.textContent).toContain('Codex');
    expect(cards[0]!.textContent).toContain('recruiter.foundHereVersion({"version":"0.156.1"})');
    expect(cards[0]!.getAttribute('title') ?? cards[0]!.textContent).toContain('/opt/homebrew/bin/codex');
    // the default = the first found (reverted to the fixed claude-code default → this fails)
    expect(cards[0]!.className).toContain('ring-1');
    expect(cards[1]!.className).not.toContain('ring-1');
    // the supported grid no longer repeats them
    const supportedTexts = [...container.querySelectorAll('button')].filter((b) => !group.contains(b)).map((b) => b.textContent ?? '');
    expect(supportedTexts.some((t) => t.endsWith('Codex') || t.endsWith('Claude Code'))).toBe(false);
    expect(container.querySelector('[data-testid=recruiter-found-none]')).toBeNull();
  });

  it('in the app but nothing found: the list as before + one line with [설치 안내] (the app link)', async () => {
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = bridgeWith([]);
    await mount();
    await toPicker(container);
    expect(container.querySelector('[data-testid=recruiter-found-here]')).toBeNull();
    const none = container.querySelector('[data-testid=recruiter-found-none]') as HTMLElement;
    expect(none.textContent).toContain('recruiter.foundHereNone');
    expect((none.querySelector('[data-testid=recruiter-found-install]') as HTMLAnchorElement).getAttribute('href')).toBe('ai.sprintable:/desktop/setup');
    // the default stays the list's first (claude-code)
    const claude = buttonsWithText(container, (t) => t.endsWith('Claude Code'))[0]!;
    expect(claude.className).toContain('ring-1');
  });

  it('AC3 — a browser (no bridge): no group, no line, the picker as before', async () => {
    await mount();
    await toPicker(container);
    expect(container.querySelector('[data-testid=recruiter-found-here]')).toBeNull();
    expect(container.querySelector('[data-testid=recruiter-found-none]')).toBeNull();
    expect(buttonsWithText(container, (t) => t.endsWith('Claude Code'))).toHaveLength(1);
    expect(buttonsWithText(container, (t) => t.endsWith('Codex'))).toHaveLength(1);
  });
});

// PO 5065 ①: the end screen offers «start on this computer» only for a runtime the desktop app runs — the one judgement, as a pure
// function (the STEP 5 screen has no mount harness; this is its test). Reverted (the block for every runtime) → the null cases fail.
describe('[SID:4680] startHereMode — only a desktop runtime gets the start-here block', () => {
  const claude = CAPS.find((c) => c.slug === 'claude-code')!;
  const codex = CAPS.find((c) => c.slug === 'codex')!;
  const cursor = CAPS.find((c) => c.slug === 'cursor')!;
  const connector = CAPS.find((c) => c.slug === 'connector')!;
  it('in the app + claude-code → app (the bridge\'s hand) · browser + codex → link (the app link)', () => {
    expect(startHereMode(true, claude)).toBe('app');
    expect(startHereMode(false, codex)).toBe('link');
  });
  it('a runtime the app does not run (cursor · gemini · connector) → null, in the app or not · no capability yet → null', () => {
    expect(startHereMode(false, cursor)).toBeNull();
    expect(startHereMode(true, cursor)).toBeNull();
    expect(startHereMode(true, connector)).toBeNull();
    expect(startHereMode(true, undefined)).toBeNull();
  });
});

describe('[SID:4680] foundRuntimes — matched by the server\'s desktop_runtime, in the app\'s order', () => {
  it('maps claude → claude-code · codex → codex · drops a runtime the server has no capability for · keeps the order', () => {
    const out = foundRuntimes([
      { runtime: 'codex', version: '1', executable: '/c' },
      { runtime: 'claude', version: '2', executable: '/a' },
    ], CAPS);
    expect(out.map((o) => o.cap.slug)).toEqual(['codex', 'claude-code']);
    expect(foundRuntimes([{ runtime: 'claude', version: '2', executable: '/a' }], CAPS.filter((c) => c.slug !== 'claude-code'))).toEqual([]);
  });
});
