/**
 * story 4427 (PO 2026-09-30 01:04Z · grounding doc 382d7915 option (가)) — a signed-in user with no organization is sent to
 * /onboarding. When they were on their way to the desktop setup page, that destination rides along as `next` so the
 * one-screen «조직 만들기» can send them back to it.
 *
 * Only one destination is ever accepted: `/desktop/setup` itself. Anything else — another path, an absolute or
 * protocol-relative URL, a backslash form, a path with a query or hash — is ignored (no open redirect). The setup code is
 * never part of it: the desktop app keeps the code in the fragment and puts it back itself (09:58Z rule).
 */
/** `next` from the query → the desktop setup path, or null for anything else. The one screen navigates there with the new
 * project attached (`withProjectParam`), like the usual onboarding's first landing. */
export function desktopOnboardingNext(value: string | null | undefined): string | null {
  return value === '/desktop/setup' ? value : null;
}

/** Where the (authenticated) layout sends an organization-less user, given the path they were on (`x-pathname`). */
export function onboardingRedirect(currentPath: string | null | undefined): string {
  const pathOnly = (currentPath ?? '').split(/[?#]/, 1)[0];
  return pathOnly === '/desktop/setup' ? '/onboarding?next=%2Fdesktop%2Fsetup' : '/onboarding';
}

/**
 * story 5036 (C6 · PO 11-27, the walk's finding) — an account with NO organization that opens the Mac app lands on the setup card (`staysForNewOrgSetup` keeps it there), so it never met the first-run
 * line: ① first project → ② the three ways → ③ the project's channel. The line is the onboarding page's (it makes the organization BEHIND the scene — no «조직 만들기» screen, story 4711 AC4 — then asks for the
 * project), so this is the ONE place that says when the setup card hands such a person to it: in the Mac app, no organization, no invitation waiting (an invited person joins that organization on the card), and
 * not a server host (its onboarding keeps the old way: the line does not apply there).
 *
 * No loop: `/onboarding` is NOT under the (authenticated) layout that holds an organization-less person on the setup page (app/onboarding sits beside it, not in it), and the address sent carries no `next`
 * (`desktopOnboardingNext(null)` is null — the onboarding page does not send the person back to the setup page). One move, and it ends there. An onboarding that finds an organization with projects goes on
 * to the setup page as before — now WITH an organization, where this answer is never asked.
 */
export const APP_FIRST_RUN_PATH = '/onboarding';
export function setupHandsAppNewAccountToOnboarding(i: { inMacApp: boolean; invites: number; serverHost: boolean }): boolean {
  return i.inMacApp && i.invites === 0 && !i.serverHost;
}

/** story 4427 (나): an organization-less person on the desktop setup page stays there — the page shows the «새 조직» mode
 * (or sends them to the one screen when an invite exists or the check fails). Only this exact path. */
export function staysForNewOrgSetup(currentPath: string | null | undefined): boolean {
  return (currentPath ?? '').split(/[?#]/, 1)[0] === '/desktop/setup';
}
