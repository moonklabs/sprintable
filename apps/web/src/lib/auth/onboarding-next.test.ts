// story 4427 — `next` for a desktop sign-up: exactly `/desktop/setup`, nothing else (no open redirect).
import { describe, expect, it } from 'vitest';
import { desktopOnboardingNext, onboardingRedirect } from './onboarding-next';

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
