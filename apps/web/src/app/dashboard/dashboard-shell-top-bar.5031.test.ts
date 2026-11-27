// story 5031 (C1 step 5a · PO 11-27, follow-up 11-27) — from lg EVERY screen of the shell has the top bar, /settings included; a PHONE's settings keeps no bar (as before 5a).
// The shell used to hide it on /settings at every width (`showTopBar = !pathname.startsWith('/settings')` + `data-topbar-hidden`, which made --shell-chrome-h drop the bar's share at every width). Now: the decision lives in lib/top-bar-phone.ts, the provider carries
// `data-topbar-hidden-phone` (globals.css narrows it to below lg) and the bar is hidden by class until the width is known, then not mounted — only on a phone. Source pin of the shell (the measured widths are e2e/shell-chrome-bands.4913 · top-bar-zones.5031).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(path.join(__dirname, 'dashboard-shell.tsx'), 'utf8');
// comments out (block comments incl. JSX `{/* … */}`, then whole-line `//` comments): the comments here explain the old switch by name
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const CSS = readFileSync(path.join(__dirname, '..', 'globals.css'), 'utf8');

describe('dashboard-shell — the bar on every width but a phone\'s settings (story 5031 · 5a)', () => {
  it('⭐the old all-width switch is gone: no `showTopBar`, no all-width `data-topbar-hidden`, no inline `startsWith(\'/settings\')`', () => {
    expect(code).not.toMatch(/showTopBar/);
    expect(code).not.toMatch(/data-topbar-hidden(?!-phone)/);
    expect(code).not.toMatch(/startsWith\('\/settings'\)/);
  });

  it('⭐the provider is marked `data-topbar-hidden-phone` by the one helper (so --shell-chrome-h drops the bar below lg only)', () => {
    expect(code).toMatch(/data-topbar-hidden-phone=\{barHiddenOnPhone\(pathname\) \? '' : undefined\}/);
  });

  it('⭐the bar is left out ONLY for a phone\'s settings (helper AND below lg) and carries the below-lg hiding class meanwhile; every other case draws it', () => {
    expect(code).toMatch(/phoneNoBar && isBelowLg \? null : \(\s*<TopBar\s+className=\{phoneNoBar \? BAR_HIDDEN_ON_PHONE_CLASS : undefined\}/);
    expect(code).toMatch(/const phoneNoBar = barHiddenOnPhone\(usePathname\(\)\)/);
  });

  it('globals.css counts the bar out of --shell-chrome-h for that mark INSIDE the below-lg media query only', () => {
    const rule = CSS.indexOf('.dashboard-shell-root[data-topbar-hidden-phone]');
    expect(rule).toBeGreaterThan(0);
    const media = CSS.lastIndexOf('@media (max-width: 1023px)', rule);
    expect(media).toBeGreaterThan(0);
    // no rule closes the media block between its opening and the phone rule: it sits inside
    const between = CSS.slice(media, rule);
    expect((between.match(/{/g) ?? []).length - (between.match(/}/g) ?? []).length).toBe(1);
  });
});
