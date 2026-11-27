// story 5031 (C1 step 5a, PO follow-up 11-27) — the top bar is on every screen from lg up (settings included), but a PHONE's settings screen stays as it was: no bar (its list / back row already names the screen).
// ONE place says which screens those are; the shell reads it for three things — the `data-topbar-hidden-phone` mark on the provider (globals.css then drops the bar's 3rem from `--shell-chrome-h` below lg only), the class that hides the bar before
// the client knows its width (no first-paint flash), and not mounting the bar at all once the width is known (no hidden bell polling).
export function barHiddenOnPhone(pathname: string): boolean {
  return pathname.startsWith('/settings');
}

/** The class that hides the bar below lg while the bar is mounted (a literal so Tailwind sees it). */
export const BAR_HIDDEN_ON_PHONE_CLASS = 'max-lg:hidden';
