// @vitest-environment jsdom
//
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

describe('[SID:4889 W3] RecruiterClient — the header is the ds Stepper', () => {
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
  const list = () => container.querySelector('[data-slot="ds-stepper"]') as HTMLElement | null;
  const steps = () => Array.from(container.querySelectorAll('[data-slot="ds-stepper-step"]')) as HTMLElement[];
  const labels = () => steps().map((s) => (s.querySelector('[data-slot="ds-stepper-label"]')?.textContent ?? '').replace(/^recruiter\.stepState\w+ /, ''));

  it('⭐the full way: five steps in order, the first is now (aria-current=step), the others upcoming; the list is named', async () => {
    await mount();
    expect(list()).not.toBeNull();
    expect(list()!.getAttribute('aria-label')).toBe('recruiter.stepperLabel');
    expect(labels()).toEqual(['recruiter.stepRole', 'recruiter.stepScope', 'recruiter.stepRuntime', 'recruiter.stepBundle', 'recruiter.stepVerify']);
    expect(steps().map((s) => s.dataset.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(steps()[0]!.getAttribute('aria-current')).toBe('step');
    expect(container.querySelectorAll('[data-slot="ds-stepper-label"] .sr-only')[0]!.textContent).toContain('recruiter.stepStateCurrent');
  });

  it('⭐the equip-skip way («역할 없이»): three steps (role › scope › done); after «다음» the first is done and the second is now', async () => {
    await mount();
    await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
    expect(labels()).toEqual(['recruiter.stepRole', 'recruiter.stepScope', 'recruiter.stepComplete']);
    await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!);
    await flush();
    expect(steps().map((s) => s.dataset.state)).toEqual(['done', 'current', 'upcoming']);
    expect(steps()[0]!.querySelector('svg')).not.toBeNull(); // the done step wears the check
    expect(container.querySelectorAll('[data-slot="ds-stepper-label"] .sr-only')[0]!.textContent).toContain('recruiter.stepStateDone');
  });

  const summary = () => container.querySelector('[data-testid="recruit-summary"]') as HTMLElement | null;
  const summaryItem = (k: string) => summary()?.querySelector(`[data-summary-key="${k}"]`) as HTMLElement | null;

  it('⭐the screen\'s composition (W3): the Stepper is the PAGE\'s strip above (not inside the step card), the step is one panel, and «지금까지 고른 것» stands beside it in a wide grid — the page is wide (max-w-5xl), not the old 672px column', async () => {
    await mount();
    const strip = container.querySelector('[data-testid="recruit-progress"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.querySelector('[data-slot="ds-stepper"]')).not.toBeNull();
    const grid = summary()!.parentElement as HTMLElement;
    expect(grid.contains(strip)).toBe(false); // the strip is the PAGE's strip: it is not inside the grid that holds the step panel and the side column
    expect(strip.parentElement).toBe(container.firstElementChild); // a direct child of the page
    expect(grid.className).toContain('lg:grid-cols-[minmax(0,1fr)_16rem]');
    expect(grid.children).toHaveLength(2); // the summary and the step panel
    expect((container.firstElementChild as HTMLElement).className).toContain('max-w-5xl');
    expect((container.firstElementChild as HTMLElement).className).not.toContain('max-w-2xl');
  });

  it('⭐the side column only SHOWS what was chosen: titled and named for a screen reader, role · scope · runtime · agent, each «not chosen yet» at the start, nothing pressable in it', async () => {
    await mount();
    expect(summary()!.getAttribute('aria-label')).toBe('recruiter.summaryTitle');
    expect(Array.from(summary()!.querySelectorAll('[data-summary-key]')).map((e) => (e as HTMLElement).dataset.summaryKey)).toEqual(['role', 'scope', 'runtime', 'agent']);
    expect(Array.from(summary()!.querySelectorAll('[data-summary-key]')).every((e) => (e as HTMLElement).dataset.filled === 'false')).toBe(true);
    expect(summary()!.textContent).toContain('recruiter.summaryEmpty');
    expect(summary()!.querySelectorAll('button, a, input, select').length).toBe(0);
    // a phone shows nothing here until something is chosen (the first question stays near the top); a wide screen keeps the column
    expect(summary()!.className).toContain('max-lg:hidden');
    expect(summary()!.className).toContain('lg:sticky');
  });

  it('the «역할 없이» way: the role line says so, there is no runtime line, and the scope is not claimed before the scope step is done', async () => {
    await mount();
    await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
    expect(summaryItem('role')!.textContent).toContain('recruiter.summaryNoRole');
    expect(summaryItem('role')!.dataset.filled).toBe('true');
    expect(summaryItem('runtime')).toBeNull();
    expect(summary()!.className).not.toContain('max-lg:hidden'); // once something is chosen the phone shows the chips
    expect(summaryItem('scope')!.dataset.filled).toBe('false');
  });

  it('the summary rules (source pins): the runtime line fills from step 4 even while the capability list is still loading (the slug is the fallback); the equip way shows the AUTHORITATIVE name the server returned', () => {
    const src = readFileSync(join(__dirname, 'recruiter-client.tsx'), 'utf8');
    expect(src).toContain("value: step >= 4 ? currentRuntimeDisplayName : null");
    expect(src).toContain("equipResult ? equipResult.name || null : null");
    expect(src).not.toContain('equipName || null : null');
  });

  it('the old header is gone and the new words exist in both languages', () => {
    const src = readFileSync(join(__dirname, 'recruiter-client.tsx'), 'utf8');
    expect(src).not.toContain('function StepperHeader');
    expect(src).toContain("import { Stepper } from '@/components/ds/stepper'");
    for (const lang of ['ko', 'en']) {
      const m = JSON.parse(readFileSync(join(__dirname, `../../../../../../messages/${lang}.json`), 'utf8')) as { recruiter: Record<string, string> };
      for (const k of ['stepperLabel', 'stepStateDone', 'stepStateCurrent', 'stepStateUpcoming', 'summaryTitle', 'summaryEmpty', 'summaryNoRole', 'summaryScopeOrg', 'summaryScopeProjects', 'summaryAgent']) expect(m.recruiter[k]?.length ?? 0).toBeGreaterThan(1);
    }
  });
});
