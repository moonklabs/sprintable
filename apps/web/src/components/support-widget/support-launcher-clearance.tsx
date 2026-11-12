import type { ReactNode } from 'react';

/**
 * story 4906 — the round support button (support-widget-launcher.tsx · 48px · fixed 16px from the bottom-right corner of the window) is drawn only while the
 * onboarding is not finished, and while it is drawn `<html>` carries `data-support-launcher` (the launcher's SUPPORT_LAUNCHER_ATTR). A composer row whose
 * [Send] sits in the same corner (the chat room's and a thread's composer at 1100px — the Mac app's default window) was covered by it: the mouse could not
 * press [Send] (Enter still sent).
 *
 * This wrapper keeps 64px free on the right of whatever it holds, but ONLY while the button is drawn — a person who finished the onboarding has no button and
 * loses no width, and the button itself stays where it is (its way to the support panel is untouched). 64px = 48px button + 16px offset from the window edge,
 * which is exactly how far the button reaches in from the right edge. The class is a literal on purpose (Tailwind reads it as written); it is the same
 * `[:root[data-support-launcher]_&]:` variant the chat list rows already use (story 4853).
 */
export function SupportLauncherClearance({ children }: { children: ReactNode }) {
  return <div data-testid="support-launcher-clearance" className="shrink-0 [:root[data-support-launcher]_&]:pr-16">{children}</div>;
}
