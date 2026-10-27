// @vitest-environment jsdom
//
// story 4794 (Kadir lens on 5255) — the runtime card's mark is the first LETTER of the runtime's name, read from the render: a name that starts with an emoji
// (a ZWJ sequence) is drawn whole, never as «�». (A regex over the source cannot see a call result before the cut; this reads what is on the screen.)
// Harness: recruiter-client.late-runtimes.4691 (the equip-skip way to the runtime picker).
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

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const EMOJI_NAME = '\u{1F469}\u200D\u{1F4BB} Dev';

describe('[SID:4794] RecruiterClient — a runtime card\'s mark is a whole letter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') {
        return jsonResponse({ data: [...RUNTIME_CAPABILITIES_FALLBACK, { ...RUNTIME_CAPABILITIES_FALLBACK[0]!, slug: 'emoji-first', display_name: EMOJI_NAME, supported: true, icon: null }] });
      }
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

  it('a runtime named «👩‍💻 Dev» (no icon) gets the whole emoji as its mark — read from the DOM; an ordinary name keeps its capital', async () => {
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = appBridge([]).bridge;
    await act(async () => { root = createRoot(container); root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />); });
    await flush();
    await toPicker(container);
    const card = buttonsWithText(container, (t) => t.includes(EMOJI_NAME))[0];
    expect(card, 'the emoji-named runtime card is drawn').toBeTruthy();
    const mark = card!.querySelector('span')!.textContent ?? '';
    expect(mark).toBe('\u{1F469}\u200D\u{1F4BB}');
    expect(LONE_SURROGATE.test(mark)).toBe(false);
    const cursor = buttonsWithText(container, (t) => t.endsWith('Cursor'))[0]!;
    expect(cursor.querySelector('span')!.textContent).toBe('C');
  });
});
