// story 4714 — the wiring of the two new route pages: what the SERVER hands the screens (the nav flags decide the chat list's address, the way out's address and its
// words; the proxy's `next` reaches the landing). The screens themselves are tested with their props in components/desktop/phone-landing.4714.test.tsx.
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import PhoneLandingPage from './phone-landing/page';
import PhoneStartRoute from './phone-start/page';

const FLAGS = ['TODAY_V3_ENABLED', 'CHAT_V3_ENABLED', 'DESKTOP_DOWNLOAD_ENABLED'];
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });
const propsOf = (el: ReactElement) => el.props as Record<string, unknown>;

describe('[4714] /phone-landing hands the landing the proxy\'s `next` and the chat list\'s own address', () => {
  it('next is passed on as given (a string) and null when it is absent or not one string', async () => {
    expect(propsOf(await PhoneLandingPage({ searchParams: Promise.resolve({ next: '/moonklabs/sprintable/flow' }) })).next).toBe('/moonklabs/sprintable/flow');
    expect(propsOf(await PhoneLandingPage({ searchParams: Promise.resolve({}) })).next).toBeNull();
    expect(propsOf(await PhoneLandingPage({ searchParams: Promise.resolve({ next: ['/a', '/b'] }) })).next).toBeNull();
  });
  it('the chat list\'s address follows the chat flag (the server\'s nav flags, never a literal in the screen)', async () => {
    const off = propsOf(await PhoneLandingPage({ searchParams: Promise.resolve({}) })).chatsHref;
    process.env['CHAT_V3_ENABLED'] = 'true';
    const on = propsOf(await PhoneLandingPage({ searchParams: Promise.resolve({}) })).chatsHref;
    expect(off).not.toBe(on);
  });
});

describe('[4714] /phone-start hands the screen the way out\'s address and words by the Today flag, and the Mac app flag', () => {
  it('Today off → the chat list and the dashboard words; Today on → the Today address and words', () => {
    const off = propsOf(PhoneStartRoute());
    expect(off.todayV3Enabled).toBe(false);
    expect(off.homeHref).toBe(off.chatsHref);
    process.env['TODAY_V3_ENABLED'] = 'true';
    const on = propsOf(PhoneStartRoute());
    expect(on.todayV3Enabled).toBe(true);
    expect(on.homeHref).not.toBe(on.chatsHref);
  });
  it('the Mac app is offered only where the server says so (DESKTOP_DOWNLOAD_ENABLED)', () => {
    expect(propsOf(PhoneStartRoute()).macDownloadEnabled).toBe(false);
    process.env['DESKTOP_DOWNLOAD_ENABLED'] = 'true';
    expect(propsOf(PhoneStartRoute()).macDownloadEnabled).toBe(true);
  });
});
