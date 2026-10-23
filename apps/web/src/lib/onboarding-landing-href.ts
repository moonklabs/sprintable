// The onboarding's end address — ONE rule for every screen that ends «the way in»: TODAY_V3_ENABLED on → the Today address, off → the chat list (both come
// from the server's nav-flag destinations, never a literal here · story #4017). The onboarding's own finish button (app/onboarding/onboarding-form.tsx) and the
// phone app's start screen way out (app/phone-start/page.tsx · story 4714) both call it, so they cannot drift apart.
//
// Lives in a module WITHOUT 'use client': a server page cannot call a function exported by a client module (it answers 500 — see
// scripts/server-page-client-call.guard.test.ts).
// story #3983(PO 확定 2026-09-17 01:41Z) — 끝 착지 결정을 순수함수로 뽑아 pin한다 · story #4017 CHANGES 2 — todayHref · chatsHref는 부모가
// resolveNavV3Destinations(flags)로 구해 넘기는 값(목적지 모듈 한 곳에서만).
export function resolveOnboardingLandingHref(todayV3Enabled: boolean, todayHref: string, chatsHref: string): string {
  return todayV3Enabled ? todayHref : chatsHref;
}
