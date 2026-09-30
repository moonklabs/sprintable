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

/** story 4427 (나): an organization-less person on the desktop setup page stays there — the page shows the «새 조직» mode
 * (or sends them to the one screen when an invite exists or the check fails). Only this exact path. */
export function staysForNewOrgSetup(currentPath: string | null | undefined): boolean {
  return (currentPath ?? '').split(/[?#]/, 1)[0] === '/desktop/setup';
}
