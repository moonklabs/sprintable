// @vitest-environment jsdom
//
// story 5048 ⑤ (① organization) — the recruiter's two «could not load» spots (the role list · the runtime list) are a ds Banner `failed` with a ds Button retry
// (they were hand-drawn boxes with a ghost-sm retry). They are PARTS of the screen, not the whole area, so they stay a Banner (the whole-area error is ds ErrorState).
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}
async function flush() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); }
const buttonsWithText = (c: HTMLElement, match: (t: string) => boolean) => Array.from(c.querySelectorAll('button')).filter((b) => match(b.textContent ?? ''));
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }

describe('[SID:5048] RecruiterClient — load errors are a ds Banner failed + ds Button retry', () => {
  let container: HTMLDivElement;
  let root: Root;
  let roleFails: boolean;
  let capsFails: boolean;
  let roleCalls: number;
  let capsCalls: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    roleFails = false; capsFails = false; roleCalls = 0; capsCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) { roleCalls += 1; return roleFails ? jsonResponse({}, false, 500) : jsonResponse({ data: [] }); }
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') { capsCalls += 1; return capsFails ? jsonResponse({}, false, 500) : jsonResponse({ data: RUNTIME_CAPABILITIES_FALLBACK }); }
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      throw new Error(`unmocked fetch: ${method} ${url}`);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    await flush();
  }
  const banners = () => Array.from(container.querySelectorAll('[data-slot="ds-banner"][data-tone="failed"]')) as HTMLElement[];

  it('the role list fails → a Banner failed (role=alert) with the message and a ds Button «다시 시도»; pressing it asks again and the Banner goes when it works', async () => {
    roleFails = true;
    await mount();
    expect(banners()).toHaveLength(1);
    const banner = banners()[0]!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('recruiter.roleLoadError');
    const retry = buttonsWithText(banner, (t) => t === 'recruiter.retry')[0]!;
    expect(retry.getAttribute('data-slot')).not.toBe('ghost'); // reverted to the ghost-sm ui Button → the ds look is gone
    expect(retry.className).toContain('h-ds-control-sm'); // ds Button (40) — not the 28/32 ui sm
    const before = roleCalls;
    roleFails = false;
    await click(retry);
    await flush();
    expect(roleCalls).toBeGreaterThan(before);
    expect(banners()).toHaveLength(0);
  });

  it('the runtime list fails → a Banner failed with title + note and the same retry; it asks again', async () => {
    capsFails = true;
    await mount();
    await click(buttonsWithText(container, (t) => t.includes('recruiter.equipSkipCardTitle'))[0]!);
    await click(buttonsWithText(container, (t) => t === 'recruiter.next')[0]!);
    await flush();
    const banner = banners().find((b) => b.textContent?.includes('recruiter.runtimeLoadError'))!;
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain('recruiter.runtimeLoadErrorNote');
    const retry = buttonsWithText(banner, (t) => t === 'recruiter.retry')[0]!;
    expect(retry.className).toContain('h-ds-control-sm');
    const before = capsCalls;
    capsFails = false;
    await click(retry);
    await flush();
    expect(capsCalls).toBeGreaterThan(before);
    expect(banners().some((b) => b.textContent?.includes('recruiter.runtimeLoadError'))).toBe(false);
  });
});
