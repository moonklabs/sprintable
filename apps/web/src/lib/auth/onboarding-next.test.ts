// story 4427 — `next` for a desktop sign-up: exactly `/desktop/setup`, nothing else (no open redirect).
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopOnboardingNext, onboardingRedirect, staysForNewOrgSetup, APP_FIRST_RUN_PATH, setupHandsAppNewAccountToOnboarding } from './onboarding-next';

describe('desktopOnboardingNext — only /desktop/setup itself', () => {
  it('accepts the setup path', () => {
    expect(desktopOnboardingNext('/desktop/setup')).toBe('/desktop/setup');
  });
  it.each([
    undefined, null, '', '/', '/chats', '/desktop', '/desktop/setupx', '/desktop/setup/', '/desktop/setup?x=1', '/desktop/setup#code=abc',
    '/desktop/setup/../chats', '//evil.com', '//evil.com/desktop/setup', 'https://evil.com/desktop/setup', '/\\evil.com',
    '\\\\evil.com', 'javascript:alert(1)', ' /desktop/setup', '/DESKTOP/SETUP', '%2Fdesktop%2Fsetup',
  ])('ignores %j', (value) => {
    expect(desktopOnboardingNext(value as string | null | undefined)).toBeNull();
  });
});

describe('onboardingRedirect — the layout keeps the desktop destination, nothing else', () => {
  it('carries next for the setup page (query ignored — the code lives in the fragment)', () => {
    expect(onboardingRedirect('/desktop/setup')).toBe('/onboarding?next=%2Fdesktop%2Fsetup');
    expect(onboardingRedirect('/desktop/setup?p=abc')).toBe('/onboarding?next=%2Fdesktop%2Fsetup');
  });
  it.each(['', null, undefined, '/chats', '/today', '/desktop', '/desktop/setupx', '//desktop/setup', '/x/desktop/setup'])(
    'plain /onboarding for %j (every other sign-up unchanged)',
    (path) => {
      expect(onboardingRedirect(path as string | null | undefined)).toBe('/onboarding');
    },
  );
});

describe('staysForNewOrgSetup — only the setup page itself (its query or fragment aside)', () => {
  it.each(['/desktop/setup', '/desktop/setup?p=abc', '/desktop/setup#code=abc'])('stays on %j', (path) => {
    expect(staysForNewOrgSetup(path)).toBe(true);
  });
  it.each([
    undefined, null, '', '/', '/chats', '/desktop', '/desktop/setupx', '/desktop/setup/', '/desktop/setup/other',
    '/desktop/setup/../chats', '//evil.com', '//evil.com/desktop/setup', 'https://evil.com/desktop/setup', '/\\evil.com',
    '\\\\evil.com', 'javascript:alert(1)', ' /desktop/setup', '/DESKTOP/SETUP', '%2Fdesktop%2Fsetup', '/x/desktop/setup',
  ])('not for %j', (value) => {
    expect(staysForNewOrgSetup(value as string | null | undefined)).toBe(false);
  });
});


// story 5036 (C6 · PO 11-27, the walk's finding): an account with no organization in the Mac app is handed from the setup card to the first-run line — in ONE place, and in one move (no loop).
describe('[SID:5036] setupHandsAppNewAccountToOnboarding — the Mac app, no organization, no invitation, not a server host', () => {
  it('the one yes', () => {
    expect(setupHandsAppNewAccountToOnboarding({ inMacApp: true, invites: 0, serverHost: false })).toBe(true);
  });
  it.each([
    ['the web (not the Mac app)', { inMacApp: false, invites: 0, serverHost: false }],
    ['an invitation waiting (the person joins that organization on the card)', { inMacApp: true, invites: 1, serverHost: false }],
    ['several invitations', { inMacApp: true, invites: 3, serverHost: false }],
    ['a server host (its onboarding has no first-run line)', { inMacApp: true, invites: 0, serverHost: true }],
  ])('not for %s', (_n, i) => {
    expect(setupHandsAppNewAccountToOnboarding(i)).toBe(false);
  });
});

describe('[SID:5036] the hand-over is one move — the two pages cannot push the person back and forth', () => {
  it('the address carries no `next` and is the plain onboarding path — the onboarding page does not send the person back to the setup page', () => {
    expect(APP_FIRST_RUN_PATH).toBe('/onboarding');
    expect(APP_FIRST_RUN_PATH).not.toContain('?');
    expect(desktopOnboardingNext(null)).toBeNull(); // onboarding/page.tsx redirects only when `next` is the setup path
    expect(desktopOnboardingNext(undefined)).toBeNull();
  });

  it('/onboarding is NOT under the (authenticated) layout that keeps an organization-less person on the setup page (reverted — the page moved under it → the person is held there and the two push each other)', () => {
    const app = resolve(__dirname, '../../app');
    expect(existsSync(resolve(app, 'onboarding/page.tsx'))).toBe(true);
    expect(existsSync(resolve(app, '(authenticated)/onboarding'))).toBe(false);
    // …and the layout holds only the setup page itself: /onboarding is not «the setup page»
    expect(staysForNewOrgSetup(APP_FIRST_RUN_PATH)).toBe(false);
  });
});
