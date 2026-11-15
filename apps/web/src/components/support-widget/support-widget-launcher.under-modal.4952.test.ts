// @vitest-environment jsdom
// story 4952 (S1) — the round support button steps aside while a modal is OPEN: in the Mac app's isolated run (1100 wide, real input) the storage file drawer's «삭제» was covered 25% by it
// and pressing the right end of «삭제» opened the support panel instead. The dock (toasts too) keeps its `z-50`; only this button hides under an open modal. A CLOSED drawer keeps role=dialog +
// aria-modal in the DOM (aria-hidden + inert), so it must not count (codex 4952 S1: the docs page and the storage folder drawer are always mounted).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from 'tailwindcss';
import { afterEach, describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, 'support-widget-launcher.tsx'), 'utf8');
const BUTTON = SRC.slice(SRC.indexOf('<button'), SRC.indexOf('</button>'));
// two variants: V1 = every OPEN modal that is not a responsive twin (`lg:hidden`); V2 = below lg only, the `lg:hidden` twins (a drawer opened on a narrow window then widened is only CSS-hidden, not closed)
const CLASS = BUTTON.match(/\[:root:has\([^\s]*?\)_&\]:invisible/)?.[0] ?? '';
const CLASS_NARROW = BUTTON.match(/max-lg:\[:root:has\([^\s]*?\)_&\]:invisible/)?.[0] ?? '';
const selectorOf = (cls: string) => cls.slice(cls.indexOf('[:root') + 1, cls.indexOf('_&]')); // the variant's selector, as the browser reads it (the `_&` is the descendant combinator)
const SELECTOR = selectorOf(CLASS);
const SELECTOR_NARROW = selectorOf(CLASS_NARROW);

const open = (html: string) => { document.body.innerHTML = html; return document.documentElement.matches(SELECTOR); };
// a narrow window (< lg): both variants are active (the media query is the browser's job — here only the selectors are matched)
const openNarrow = (html: string) => { document.body.innerHTML = html; return document.documentElement.matches(SELECTOR) || document.documentElement.matches(SELECTOR_NARROW); };
afterEach(() => { document.body.innerHTML = ''; });

describe('the support launcher hides under an open modal (4952 S1)', () => {
  it('⭐the launcher button carries the variant — and the dock itself is not lowered (toasts stay above a modal)', () => {
    expect(CLASS).not.toBe('');
    expect(CLASS_NARROW).not.toBe('');
    expect(SELECTOR.startsWith(':root:has(')).toBe(true);
    expect(SELECTOR_NARROW.startsWith(':root:has(')).toBe(true);
    const dock = readFileSync(join(__dirname, '..', 'nav', 'bottom-dock.tsx'), 'utf8');
    expect(dock).toContain('fixed right-4 z-50');
  });

  it('⭐Tailwind compiles that class into «visibility: hidden under the selector» — not an empty rule', async () => {
    const compiler = await compile('@tailwind utilities;');
    const css = compiler.build([CLASS]);
    expect(css).toContain(':root:has(');
    expect(css).toContain('aria-modal');
    expect(css).toMatch(/visibility:\s*hidden/);
  });

  it('⭐the narrow-only variant compiles inside a max-width media query (below lg) — not unconditionally', async () => {
    const compiler = await compile('@theme { --breakpoint-lg: 64rem; } @tailwind utilities;'); // lg = 1024px, the app's (no custom breakpoints in globals.css)
    const css = compiler.build([CLASS_NARROW]);
    expect(css).toMatch(/@media[^{]*width/);
    expect(css).toMatch(/visibility:\s*hidden/);
  });

  it('⭐a responsive twin (class lg:hidden: the docs / storage mobile drawers, the bell full-screen overlay) hides the button only below lg — on a wide window it is CSS-hidden, not an open modal', () => {
    const twin = '<div role="dialog" aria-modal="true" class="fixed inset-0 z-50 lg:hidden"></div>';
    expect(open(twin)).toBe(false); // wide
    expect(openNarrow(twin)).toBe(true); // narrow
    expect(openNarrow('<div role="dialog" aria-modal="true" aria-hidden="true" inert class="lg:hidden"></div>')).toBe(false); // …and a CLOSED twin never
  });

  it('⭐an OPEN drawer / dialog (role=dialog + aria-modal) matches — so the button is hidden', () => {
    expect(open('<div role="dialog" aria-modal="true" aria-label="스토리지"></div>')).toBe(true);
  });

  it('⭐an alertdialog (the sprint delete confirmation) matches too', () => {
    expect(open('<div role="alertdialog"></div>')).toBe(true);
  });

  it('⭐a CLOSED drawer — still in the DOM with role=dialog + aria-modal but aria-hidden and inert (the docs tree drawer · the storage folder drawer) — does NOT match: the button stays', () => {
    expect(open('<div role="dialog" aria-modal="true" aria-hidden="true" inert></div>')).toBe(false);
    expect(open('<div role="dialog" aria-modal="true" aria-hidden="true"></div>')).toBe(false);
    expect(open('<div role="dialog" aria-modal="true" inert></div>')).toBe(false);
  });

  it('the support panel itself (role=dialog, no aria-modal), a menu, a tooltip and a toast do NOT match', () => {
    expect(open('<div role="dialog" aria-label="문의"></div><div role="menu"></div><div role="tooltip"></div><div role="status"></div>')).toBe(false);
  });

  it('⭐the support panel in the launcher source is a plain role=dialog — it must never become aria-modal (the launcher that opens/closes it would hide while it is open)', () => {
    const panel = SRC.slice(SRC.indexOf('id={PANEL_ID}'), SRC.indexOf('id={PANEL_ID}') + 400);
    expect(panel).toContain('role="dialog"');
    expect(panel).not.toMatch(/aria-modal/);
  });

  it('nothing open: no match', () => {
    expect(open('<main></main>')).toBe(false);
  });
});
