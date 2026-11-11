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

  it('the old header is gone and the new words exist in both languages', () => {
    const src = readFileSync(join(__dirname, 'recruiter-client.tsx'), 'utf8');
    expect(src).not.toContain('function StepperHeader');
    expect(src).toContain("import { Stepper } from '@/components/ds/stepper'");
    for (const lang of ['ko', 'en']) {
      const m = JSON.parse(readFileSync(join(__dirname, `../../../../../../messages/${lang}.json`), 'utf8')) as { recruiter: Record<string, string> };
      for (const k of ['stepperLabel', 'stepStateDone', 'stepStateCurrent', 'stepStateUpcoming']) expect(m.recruiter[k]?.length ?? 0).toBeGreaterThan(1);
    }
  });
});
