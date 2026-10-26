// story #4762 (AC5) — the hint text of an input must be painted by the phone app's web view (Android System WebView = Chrome 113 there).
// 4758 measured the sign-up and login boxes EMPTY on the emulator while the placeholder existed: Tailwind's preflight colors it with
// `color-mix(in oklab, currentcolor 50%, transparent)`, which that engine paints as nothing; a plain token color made it appear (same page,
// measured over the web view's debug socket). jsdom paints nothing, so this pins what the fix is made of: an explicit, plain color rule in the base layer.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8');

/** the declarations of the `@layer base` rule that styles `input::placeholder` */
function placeholderRule(): string | null {
  const m = CSS.match(/@layer base\s*\{\s*input::placeholder,\s*textarea::placeholder\s*\{([^}]*)\}\s*\}/);
  return m ? m[1]! : null;
}

describe('globals.css — the placeholder is painted in an old web view', () => {
  it('has a base-layer rule for input and textarea placeholders', () => {
    expect(placeholderRule()).not.toBeNull();
  });

  it('colors it with a plain token — not color-mix, not currentcolor (what that engine does not paint)', () => {
    const decl = placeholderRule()!;
    expect(decl).toMatch(/color:\s*var\(--muted-foreground\)\s*;/);
    expect(decl).not.toMatch(/color-mix|currentcolor/i);
  });

  it('keeps the placeholder fully opaque (the preflight sets opacity 1; a lower value would thin it out again)', () => {
    expect(placeholderRule()!).toMatch(/opacity:\s*1\s*;/);
  });
});
