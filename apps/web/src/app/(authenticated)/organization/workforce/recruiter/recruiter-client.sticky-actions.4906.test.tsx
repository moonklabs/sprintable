// @vitest-environment jsdom
//
// story 4906 (customer lap ②) — the step's progress row is sticky and the role list is no second scroller (boilerplate as recruiter-client.stepper.4889.test.tsx)
// story 4889 (W3 · UI-3 ds Stepper): the recruit screen's header is the ds Stepper — 5 steps (role › scope › runtime › bundle › verify), the equip-skip way ("역할 없이") 3 (role › scope › done);
// done = check, now = ring + number (aria-current=step), upcoming = hollow dot + number; the hidden state words are read by a screen reader. Nothing else in the screen changes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RecruiterClient } from './recruiter-client';
import { RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';
import { __resetDesktopAppForTest } from '@/lib/desktop-app';

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

function jsonResponse(body: unknown) { return { ok: true, status: 200, json: async () => body } as Response; }
async function flush() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); }
const buttonsWithText = (c: HTMLElement, match: (t: string) => boolean) => Array.from(c.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }

describe('[SID:4906 ②] RecruiterClient — the progress row is on the first screen; one scroll', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: RUNTIME_CAPABILITIES_FALLBACK });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      throw new Error(`unmocked fetch: ${url}`);
    }));
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetDesktopAppForTest();
    vi.unstubAllGlobals();
  });
  async function mount() {
    await act(async () => { root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />); });
    await flush();
  }
  const actionRows = () => Array.from(container.querySelectorAll('[data-testid="recruiter-step-actions"]')) as HTMLElement[];

  it('⭐step 1: the «다음» row sticks to the bottom of the viewport (sticky bottom-0, on the card surface) and the role list is NOT a second scroller', async () => {
    await mount();
    const rows = actionRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.className).toContain('sticky');
    expect(rows[0]!.className).toContain('bottom-0');
    expect(rows[0]!.className).toContain('bg-card'); // the card's own surface: no band when it sticks
    expect(rows[0]!.textContent).toContain('recruiter.next');
    const list = container.querySelector('[data-testid="recruiter-role-list"]') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.className).not.toContain('overflow-y-auto');
    expect(list.className).not.toMatch(/max-h-/);
  });

  it('⭐step 2: the «다음» row is sticky too', async () => {
    await mount();
    await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
    await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!);
    await flush();
    const rows = actionRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.className).toContain('sticky');
    expect(rows[0]!.className).toContain('bottom-0');
  });

  it('source pin: the five progress rows (step 1 «다음» · step 2 «다음» · step 3 «채용하기» · the two hero blocks) all carry STEP_ACTIONS_STICKY — the step 3 and hero rows need a chosen role / a bridge to draw, so they are pinned in the source (the hero ones also in recruiter-client.hire-in-app.4710.test.tsx)', () => {
    const src = readFileSync(join(__dirname, 'recruiter-client.tsx'), 'utf8');
    expect((src.match(/\$\{STEP_ACTIONS_STICKY\}/g) ?? []).length).toBe(5); // + the two hero blocks (the desktop-app one screen, and the browser hero with a Mac app connected)
    expect((src.match(/data-testid="recruiter-step-actions"/g) ?? []).length).toBe(5);
    expect(src).toContain('pe-14 lg:pe-0'); // the phone's round support button stays clear of the right-hand CTA
  });

  it('⭐focus clearance: every control inside the step panel carries a bottom scroll-margin taller than the sticky row (Tab near the bottom stops above the bar, not under it) — scoped to the panel (no shell-wide scroll-padding)', async () => {
    await mount();
    const panel = container.querySelector('[data-testid="recruiter-step-panel"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.className).toContain('scroll-mb-32');
    expect(panel.className).toContain('input,select,textarea,button,a[href],[tabindex]');
    // the margin must outweigh the sticky row (py-3 + a 36px button ≈ 64px; the hero rows add a line or two of text): scroll-mb-32 = 128px
    const sticky = actionRows()[0]!;
    expect(sticky.className).toContain('py-3');
  });
});

