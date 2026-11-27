// story 5031 (C1 step 5a · PO 11-27) — every screen of the shell has the same top bar, /settings included. The shell used to hide it there (`showTopBar = !pathname.startsWith('/settings')` + `data-topbar-hidden` on the provider, which made --shell-chrome-h drop the bar's share).
// Source pin: the shell draws <TopBar> unconditionally and puts no `data-topbar-hidden` on the provider. (globals.css keeps the `[data-topbar-hidden]` branch as a handle for a future bar-less screen; nothing sets it.)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(path.join(__dirname, 'dashboard-shell.tsx'), 'utf8');
// comments out (block comments incl. JSX `{/* … */}`, then whole-line `//` comments): the comments here explain the old switch by name
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('dashboard-shell — the bar is on every screen (story 5031 · 5a)', () => {
  it('⭐no screen hides the bar: no `showTopBar` switch and no `data-topbar-hidden` attribute set by the shell', () => {
    expect(code).not.toMatch(/showTopBar/);
    expect(code).not.toMatch(/data-topbar-hidden/);
    expect(code).not.toMatch(/startsWith\('\/settings'\)/);
  });

  it('⭐<TopBar …/> is drawn directly in the scroller (not behind a condition)', () => {
    const at = code.indexOf('<TopBar');
    expect(at).toBeGreaterThan(0);
    expect(code.slice(Math.max(0, at - 40), at)).not.toMatch(/&&\s*\(?\s*$/);
    expect(code.slice(Math.max(0, at - 40), at)).not.toMatch(/\?\s*\(?\s*$/);
  });
});
