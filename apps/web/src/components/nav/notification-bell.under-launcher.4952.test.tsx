// @vitest-environment jsdom
//
// story 4952 (S1) — the support launcher hides while a modal is OPEN. The notification bell mounts its full-screen overlay (role=dialog + aria-modal) next to the wide-screen dropdown and only hides it with
// `lg:hidden`: on a wide screen that CSS-hidden twin must not count (codex 4952 S1 round 2) — the launcher's narrow-only variant carries it, below lg the real full-screen overlay must. Real mount of the bell + the launcher's real selector.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAUNCHER = readFileSync(join(__dirname, '../support-widget/support-widget-launcher.tsx'), 'utf8');
const BUTTON = LAUNCHER.slice(LAUNCHER.indexOf('<button'), LAUNCHER.indexOf('</button>'));
const selectorOf = (cls: string) => cls.slice(cls.indexOf('[:root') + 1, cls.indexOf('_&]'));
const SELECTOR = selectorOf(BUTTON.match(/\[:root:has\([^\s]*?\)_&\]:invisible/)?.[0] ?? '');
const SELECTOR_NARROW = selectorOf(BUTTON.match(/max-lg:\[:root:has\([^\s]*?\)_&\]:invisible/)?.[0] ?? '');
const hides = (wide: boolean) => document.documentElement.matches(SELECTOR) || (!wide && document.documentElement.matches(SELECTOR_NARROW));

let container: HTMLDivElement;
let root: Root;

function stubViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      return new Response(JSON.stringify({ data: [], meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openBell() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
  });
  const bell = document.body.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => { bell.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('the support launcher and the notification bell (4952 S1)', () => {
  it('the launcher selector was read from the source (not an empty string)', () => {
    expect(SELECTOR).toContain(':root:has(');
    expect(SELECTOR_NARROW).toContain(':root:has(');
  });

  it('⭐wide screen: the bell open → only the dropdown shows; the CSS-hidden full-screen twin does NOT hide the launcher', async () => {
    stubViewport(true);
    await openBell();
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull(); // the twin is in the DOM …
    expect(hides(true)).toBe(false); // … but it is the `lg:hidden` twin: not an open modal on a wide window
  });

  it('⭐narrow screen: the bell open → the real full-screen overlay hides the launcher', async () => {
    stubViewport(false);
    await openBell();
    expect(hides(false)).toBe(true);
  });
});
