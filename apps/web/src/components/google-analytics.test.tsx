// @vitest-environment jsdom
//
// story #3204(acquisition 계측) — sign_up 전환 이벤트 발화 SSOT. 가입 경로 2개(email/pw는
// register/page.tsx, OAuth는 서버 리다이렉트)가 둘 다 같은 `?signup=1` 파라미터로 수렴하고,
// 여기 한 곳에서만 gtag('event','sign_up')을 쏜다(billing-tab.tsx의 Toss checkout 성공
// 쿼리파라미터 소비 패턴과 동형). 처리 直後 파라미터를 제거해 새로고침 시 재발화되지 않는지도 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { pushMock, replaceMock, usePathnameMock, useSearchParamsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  usePathnameMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useSearchParams: useSearchParamsMock,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

// story 4719: the script tags are rendered as plain <script> so a test can see WHETHER the tag is loaded and WHAT the init script says
// (the init script's mount defines window.gtag, as the real inline script does — child effects run before the parent's)
vi.mock('next/script', async () => {
  const { useEffect } = await import('react');
  function ScriptMock({ id, src, children }: { id?: string; src?: string; children?: string }) {
    useEffect(() => { if (id === 'ga4-init') (window as unknown as { gtag?: unknown }).gtag ??= vi.fn(); }, [id]);
    return <script data-ga-id={id ?? ''} data-ga-src={src ?? ''}>{children}</script>;
  }
  return { default: ScriptMock };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetModules(); // GA_ID는 모듈 최상단 const라 env를 바꾼 뒤엔 재-import가 필요.
  process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST123';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { gtag: (...args: unknown[]) => void }).gtag = vi.fn();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
  delete (window as { gtag?: unknown }).gtag;
  delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
});

async function mount() {
  const { GoogleAnalytics } = await import('./google-analytics');
  await act(async () => { root.render(<GoogleAnalytics />); });
}

async function navigate(path: string, query: string) {
  usePathnameMock.mockReturnValue(path);
  useSearchParamsMock.mockReturnValue(new URLSearchParams(query));
  const { GoogleAnalytics } = await import('./google-analytics');
  await act(async () => { root.render(<GoogleAnalytics />); });
}

describe('GoogleAnalytics — sign_up 전환 이벤트(story #3204)', () => {
  it('?signup=1이 있으면 gtag(event, sign_up)을 발화하고 파라미터를 제거한다', async () => {
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    // story 4719: the event now also carries a clean path / location / referrer (never the query) — the conversion itself is unchanged
    expect(gtag).toHaveBeenCalledWith('event', 'sign_up', expect.objectContaining({ page_path: '/onboarding' }));
    expect(replaceMock).toHaveBeenCalledWith('/onboarding');
  });

  it('다른 쿼리파라미터가 같이 있으면 signup만 지우고 나머지는 보존한다', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1&from=proj-1'));
    await mount();

    expect(replaceMock).toHaveBeenCalledWith('/inbox?from=proj-1');
  });

  it('signup 파라미터가 없으면 sign_up 이벤트를 발화하지 않는다', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const signUpCalls = gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up');
    expect(signUpCalls.length).toBe(0);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('GA_ID 미설정(dev 음성대조)이면 signup=1이 있어도 이벤트를 발화하지 않는다', async () => {
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).not.toHaveBeenCalled();
  });
});


// ── story 4719 (Kadir · PO 10-16): a one-time value in an address never reaches Analytics ───────────────────────────────────────────────────
const HOLD_MS_FOR_TEST = 1500; // = HOLD_MS of the component (a literal here so a change of it shows up as a failing test)
const TOKEN_SCREENS = ['/share/abc-secret-share-token', '/native/oauth-return', '/native/continue', '/reset-password', '/set-password/confirm', '/verify-email', '/invite', '/unsubscribe', '/desktop/setup', '/desktop/remote', '/desktop/remote-on', '/desktop/pair'];

describe('GoogleAnalytics — one-time values in the address (story 4719)', () => {
  it.each(TOKEN_SCREENS)('%s: Analytics is not called at all, the tag is switched off and not even loaded', async (path) => {
    usePathnameMock.mockReturnValue(path);
    useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET&code=SECRET'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(true);
    expect(container.querySelector('script[data-ga-id="ga4-init"]')).toBeNull();
  });

  it('a path below a listed one is listed too, whatever its case; a look-alike is not', async () => {
    const { isAnalyticsExcluded } = await import('./google-analytics');
    expect(isAnalyticsExcluded('/Reset-Password', null)).toBe(true);
    expect(isAnalyticsExcluded('/native/anything/deeper', null)).toBe(true);
    expect(isAnalyticsExcluded('/invite/abc', null)).toBe(true);
    expect(isAnalyticsExcluded('/invites', null)).toBe(false); // a segment match, not a prefix of letters
    expect(isAnalyticsExcluded('/nativeish', null)).toBe(false);
    expect(isAnalyticsExcluded('/inbox', new URLSearchParams('from=proj-1'))).toBe(false);
  });

  it.each(['token=abc', 'code=abc', 'invite_token=abc', 'Token=abc', 'OTP=123456', 'access_token=abc', 'code_verifier=abc'])(
    'a screen NOT on the list whose address carries %s is not reported either', async (query) => {
      usePathnameMock.mockReturnValue('/settings');
      useSearchParamsMock.mockReturnValue(new URLSearchParams(query));
      await mount();

      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      expect(gtag).not.toHaveBeenCalled();
      expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(true);
    });

  it('a reported screen sends path, location and referrer with no query at all (path-level analysis stays)', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('from=proj-1&view=unread'));
    await mount();
    await navigate('/inbox', 'from=proj-2'); // a second render with another query reports the new path

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const configs = gtag.mock.calls.filter((c) => c[0] === 'config');
    expect(configs.length).toBeGreaterThan(0);
    for (const [, , params] of configs) {
      const p = params as Record<string, string>;
      expect(p.page_path).toBe('/inbox');
      expect(p.page_location).toBe(`${window.location.origin}/inbox`);
      for (const v of [p.page_path, p.page_location, p.page_referrer ?? '']) expect(v).not.toMatch(/[?#]/);
    }
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(false);
    expect(container.querySelector('script[data-ga-id="ga4-init"]')).not.toBeNull();
  });

  it('the init script gives Analytics a location and a referrer without query from the very first configuration', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('from=x'));
    await mount();

    const init = container.querySelector('script[data-ga-id="ga4-init"]')?.textContent ?? '';
    expect(init).toContain('page_location: location.origin + location.pathname');
    expect(init).toContain('r.origin + r.pathname'); // the referrer: origin + path
    expect(init).not.toContain('location.href');
    expect(init).not.toContain('document.referrer,'); // never the raw referrer
  });

  it('coming from a token screen to the next screen: no referrer is claimed at all — not even the path of the screen that was not reported', async () => {
    usePathnameMock.mockReturnValue('/reset-password');
    useSearchParams_token();
    await mount();
    await navigate('/inbox', '');

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const last = gtag.mock.calls.filter((c) => c[0] === 'config').at(-1)?.[2] as Record<string, string>;
    expect(last.page_referrer).toBe('');
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('reset-password');
  });

  it('a public share link carries its secret in the PATH: the screen is not reported and the next screen does not get it as its referrer', async () => {
    usePathnameMock.mockReturnValue('/share/abc-secret-share-token');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    await navigate('/inbox', '');

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('abc-secret-share-token');
    const last = gtag.mock.calls.filter((c) => c[0] === 'config').at(-1)?.[2] as Record<string, string>;
    expect(last.page_path).toBe('/inbox');
    expect(last.page_referrer).toBe('');
  });

  it('the first screen of a visit keeps the (cleaned) referrer of the document; a later screen reports the screen before it', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://mail.example.com/inbox/open?x=1#y', configurable: true });
    try {
      usePathnameMock.mockReturnValue('/inbox');
      useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
      await mount();
      await navigate('/board', '');
      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      const configs = gtag.mock.calls.filter((c) => c[0] === 'config').map((c) => c[2] as Record<string, string>);
      expect(configs[0]!.page_referrer).toBe('https://mail.example.com/inbox/open');
      expect(configs.at(-1)!.page_referrer).toBe(`${window.location.origin}/inbox`);
    } finally {
      delete (document as unknown as { referrer?: string }).referrer;
    }
  });

  it('a raw referrer is cleaned: query and # removed; not an address → empty', async () => {
    const { analyticsReferrer, analyticsLocation } = await import('./google-analytics');
    expect(analyticsReferrer('https://app.example/reset-password?token=SECRET#frag')).toBe('https://app.example/reset-password');
    expect(analyticsReferrer('https://other.example/p?a=1')).toBe('https://other.example/p');
    expect(analyticsReferrer('')).toBe('');
    expect(analyticsReferrer('not a url')).toBe('');
    expect(analyticsLocation('https://app.example', '/inbox')).toBe('https://app.example/inbox');
  });

  it('the sign_up event carries a clean location and referrer too; on a token screen it is not sent', async () => {
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParams_signup();
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const ev = gtag.mock.calls.find((c) => c[0] === 'event' && c[1] === 'sign_up')?.[2] as Record<string, string>;
    expect(ev.page_path).toBe('/onboarding');
    expect(ev.page_location).toBe(`${window.location.origin}/onboarding`);
    expect(ev.page_location).not.toMatch(/[?#]/);
  });

  it('a FIRST load on /onboarding?signup=1 (the tag is defined only after it is armed): the conversion is still sent, once', async () => {
    delete (window as { gtag?: unknown }).gtag; // nothing is loaded yet, as on a real first visit
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParams_signup();
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).toBeDefined();
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(1);
    expect(replaceMock).toHaveBeenCalledWith('/onboarding');
  });

  it('a FIRST load on an ordinary screen: the screen is reported once the tag exists (config after `armed`), with a clean path', async () => {
    delete (window as { gtag?: unknown }).gtag;
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('from=x'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const configs = gtag.mock.calls.filter((c) => c[0] === 'config');
    expect(configs).toHaveLength(1);
    expect((configs[0]![2] as { page_path: string }).page_path).toBe('/inbox');
  });

  it('the conversion is sent exactly once even when the tag was already there (the effect runs again when armed flips)', async () => {
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParams_signup();
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(1);
  });

  it('back / forward and a changed # move the address without pushState: the flag follows location at once', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(false);

    window.history.pushState(null, '', '/reset-password?token=SECRET');
    window.history.pushState(null, '', '/inbox'); // leaving a token screen: the flag is HELD on through the move …
    expect(flag()).toBe(true);
    await navigate('/inbox', ''); // … and released by the route effect, right before our own clean hit
    expect(flag()).toBe(false);
    // the browser goes back to the token address: jsdom moves location, then popstate fires
    const original = window.history.pushState;
    expect(original).toBeDefined();
    const locationBefore = Object.getOwnPropertyDescriptor(window, 'location');
    vi.useFakeTimers();
    try {
      Object.defineProperty(window, 'location', { value: new URL('http://localhost:3000/reset-password?token=SECRET'), writable: true, configurable: true });
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(flag()).toBe(true);
      Object.defineProperty(window, 'location', { value: new URL('http://localhost:3000/inbox'), writable: true, configurable: true });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(flag()).toBe(true); // leaving the token address by hashchange / popstate: held too
      vi.advanceTimersByTime(HOLD_MS_FOR_TEST);
      expect(flag()).toBe(false); // … and, with no route change to follow, released by the timer
    } finally {
      vi.useRealTimers();
      if (locationBefore) Object.defineProperty(window, 'location', locationBefore);
    }
  });

  it.each(['/desktop', '/desktop/setup', '/desktop/remote', '/desktop/remote-on', '/desktop/pair'])('%s (no query, no #): the app screens that take codes in the # part are on the list by path', async (path) => {
    const { isAnalyticsExcluded } = await import('./google-analytics');
    expect(isAnalyticsExcluded(path, new URLSearchParams(''), '')).toBe(true);
    usePathnameMock.mockReturnValue(path);
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    expect((window.gtag as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(true);
  });

  it('back / forward to an address with a code in its # (popstate) and a # change (hashchange): the flag follows the fragment too', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(false);
    const locationBefore = Object.getOwnPropertyDescriptor(window, 'location');
    vi.useFakeTimers();
    try {
      Object.defineProperty(window, 'location', { value: new URL('http://localhost:3000/inbox#code=SECRET'), writable: true, configurable: true });
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(flag()).toBe(true);
      Object.defineProperty(window, 'location', { value: new URL('http://localhost:3000/inbox#section'), writable: true, configurable: true });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(flag()).toBe(true); // leaving an address with a code in its #: held …
      vi.advanceTimersByTime(HOLD_MS_FOR_TEST);
      expect(flag()).toBe(false); // … then released
      Object.defineProperty(window, 'location', { value: new URL('http://localhost:3000/inbox#token=SECRET'), writable: true, configurable: true });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(flag()).toBe(true);
    } finally {
      vi.useRealTimers();
      if (locationBefore) Object.defineProperty(window, 'location', locationBefore);
    }
  });

  it('a one-time value in the # part excludes the screen too — on any path (the setup / remote-control codes ride there)', async () => {
    const { isAnalyticsExcluded } = await import('./google-analytics');
    expect(isAnalyticsExcluded('/inbox', null, '#code=SECRET&setup=s-1')).toBe(true);
    expect(isAnalyticsExcluded('/inbox', null, 'token=SECRET')).toBe(true); // with or without the #
    expect(isAnalyticsExcluded('/inbox', null, '#progress=s-1')).toBe(false); // a plain anchor / progress marker is not a secret
    expect(isAnalyticsExcluded('/inbox', null, '#section-2')).toBe(false);
    expect(isAnalyticsExcluded('/inbox', new URLSearchParams(''), '')).toBe(false);
  });

  it('an ordinary screen opened with a code in its # part: nothing is reported and the tag is switched off; moves with one in the destination # follow it', async () => {
    window.history.replaceState(null, '', '/inbox#code=SECRET');
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag.mock.calls.filter((c) => c[0] === 'config')).toHaveLength(0);
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(true);

    window.history.replaceState(null, '', '/inbox'); // (armed only on an allowed screen — this one never armed the wrapper)
    await navigate('/inbox', 'x=1');
    expect(flag()).toBe(false);
    window.history.pushState(null, '', '/inbox#code=SECRET');
    expect(flag()).toBe(true);
    window.history.pushState(null, '', '/inbox');
    expect(flag()).toBe(true); // leaving: held, released by the route effect (or the timer)
    await navigate('/inbox', 'x=2');
    expect(flag()).toBe(false);
  });

  it('the card-payment return (authKey / paymentKey / customerKey in the address) is not reported', async () => {
    for (const q of ['authKey=SECRET&customerKey=c1', 'paymentKey=SECRET&orderId=o1']) {
      usePathnameMock.mockReturnValue('/settings/billing');
      useSearchParamsMock.mockReturnValue(new URLSearchParams(q));
      const { isAnalyticsExcluded } = await import('./google-analytics');
      expect(isAnalyticsExcluded('/settings/billing', new URLSearchParams(q))).toBe(true);
    }
  });

  it('a client-side move: the opt-out flag follows the DESTINATION address at once — before any effect — and back', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount(); // armed: the tag is loaded and pushState / replaceState are wrapped
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(false);

    window.history.pushState(null, '', '/reset-password?token=SECRET');
    expect(flag()).toBe(true);
    window.history.pushState(null, '', '/inbox');
    expect(flag()).toBe(true); // LEAVING a token screen: GA's own history hit (referrer = the token address) fires at this move — the flag is held on
    await navigate('/inbox', ''); // the route effect releases it right before our own clean hit
    expect(flag()).toBe(false);
    window.history.replaceState(null, '', '/native/oauth-return?code=SECRET');
    expect(flag()).toBe(true);
    window.history.replaceState(null, '', '/inbox?x=1');
    expect(flag()).toBe(true);
    await navigate('/inbox', 'x=1');
    expect(flag()).toBe(false);
  });

  it('the referrer after a screen that was not reported is empty even when the document has a referrer of its own (no fallback to it)', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://mail.example.com/inbox/open?x=1#y', configurable: true });
    try {
      usePathnameMock.mockReturnValue('/reset-password');
      useSearchParams_token();
      await mount();
      await navigate('/inbox', '');
      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      const last = gtag.mock.calls.filter((c) => c[0] === 'config').at(-1)?.[2] as Record<string, string>;
      expect(last.page_referrer).toBe(''); // not the document's old referrer, and not the token screen
    } finally {
      delete (document as unknown as { referrer?: string }).referrer;
    }
  });

  it('the sign_up event carries the SAME referrer as the screen it belongs to: cleaned document referrer on a first screen, empty after an unreported screen', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://mail.example.com/inbox/open?x=1#y', configurable: true });
    try {
      usePathnameMock.mockReturnValue('/onboarding');
      useSearchParams_signup();
      await mount();
      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      const first = gtag.mock.calls.find((c) => c[0] === 'event' && c[1] === 'sign_up')?.[2] as Record<string, string>;
      expect(first.page_referrer).toBe('https://mail.example.com/inbox/open');
      expect(first.page_referrer).not.toMatch(/[?#]/);
    } finally {
      delete (document as unknown as { referrer?: string }).referrer;
    }
  });

  it('the sign_up event after a token screen: its referrer is empty (the unreported screen leaves nothing behind)', async () => {
    usePathnameMock.mockReturnValue('/invite');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET'));
    await mount();
    await navigate('/onboarding', 'signup=1');
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const ev = gtag.mock.calls.find((c) => c[0] === 'event' && c[1] === 'sign_up')?.[2] as Record<string, string>;
    expect(ev.page_referrer).toBe('');
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('/invite');
  });

  it('a first screen excluded only by a # code, then a move that only drops the #: the flag is held, then released, and the screen is reported (the tag arms after the release)', async () => {
    window.history.replaceState(null, '', '/inbox#code=SECRET');
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(true);
    expect(container.querySelector('script[data-ga-id="ga4-init"]')).toBeNull(); // not armed: the tag is not even loaded

    vi.useFakeTimers();
    try {
      window.history.replaceState(null, '', '/inbox'); // same path, no query, the # is gone: no route change follows
      expect(flag()).toBe(true); // held through the move (the wrapper is there from the start, not only once armed)
      await act(async () => { vi.advanceTimersByTime(HOLD_MS_FOR_TEST); });
    } finally {
      vi.useRealTimers();
    }
    expect(flag()).toBe(false);
    expect(container.querySelector('script[data-ga-id="ga4-init"]')).not.toBeNull(); // armed after the release
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const configs = gtag.mock.calls.filter((c) => c[0] === 'config');
    expect(configs.length).toBeGreaterThan(0);
    expect(JSON.stringify(configs)).not.toContain('SECRET');
  });

  it('a referrer that is an unreported screen of THIS site is dropped whole (a full page load that came from a share link or a token screen)', async () => {
    const { analyticsReferrer } = await import('./google-analytics');
    const own = 'https://app.example';
    expect(analyticsReferrer('https://app.example/share/abc-secret-share-token', own)).toBe('');
    expect(analyticsReferrer('https://app.example/reset-password?token=SECRET', own)).toBe('');
    expect(analyticsReferrer('https://app.example/inbox?code=SECRET', own)).toBe('');
    expect(analyticsReferrer('https://app.example/inbox#token=SECRET', own)).toBe('');
    expect(analyticsReferrer('https://app.example/inbox?x=1#y', own)).toBe('https://app.example/inbox');
    // another site's address is its own business: origin + path, never a query
    expect(analyticsReferrer('https://other.example/p?token=SECRET#y', own)).toBe('https://other.example/p');
  });

  it('a first screen that the browser says came from this site\'s share link: neither the page hit nor the sign_up event names it', async () => {
    Object.defineProperty(document, 'referrer', { value: `${window.location.origin}/share/abc-secret-share-token`, configurable: true });
    try {
      usePathnameMock.mockReturnValue('/onboarding');
      useSearchParams_signup();
      await mount();
      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      expect(JSON.stringify(gtag.mock.calls)).not.toContain('abc-secret-share-token');
      const configs = gtag.mock.calls.filter((c) => c[0] === 'config').map((c) => c[2] as Record<string, string>);
      expect(configs[0]!.page_referrer).toBe('');
      const ev = gtag.mock.calls.find((c) => c[0] === 'event' && c[1] === 'sign_up')?.[2] as Record<string, string>;
      expect(ev.page_referrer).toBe('');
    } finally {
      delete (document as unknown as { referrer?: string }).referrer;
    }
  });

  it('the inline init script\'s referrer expression follows the same rule (evaluated against a fake document and location)', async () => {
    const { initReferrerExpression } = await import('./google-analytics');
    const run = (referrer: string) =>
      new Function('document', 'location', 'URL', 'URLSearchParams', `return ${initReferrerExpression()};`)(
        { referrer }, { origin: 'https://app.example' }, URL, URLSearchParams,
      ) as string;
    expect(run('https://app.example/share/abc-secret-share-token')).toBe('');
    expect(run('https://app.example/Reset-Password?token=SECRET')).toBe('');
    expect(run('https://app.example/native/continue')).toBe('');
    expect(run('https://app.example/desktop/setup#code=SECRET')).toBe('');
    expect(run('https://app.example/inbox?authKey=SECRET')).toBe('');
    expect(run('https://app.example/inbox#token=SECRET')).toBe('');
    expect(run('https://app.example/inbox?x=1#section')).toBe('https://app.example/inbox');
    expect(run('https://other.example/p?token=SECRET#y')).toBe('https://other.example/p');
    expect(run('')).toBe('');
    expect(run('not an address')).toBe('');
  });

  it('the sign_up event after a token screen carries the screen\'s own (empty) referrer — not the document\'s old one', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://mail.example.com/inbox/open?x=1#y', configurable: true });
    try {
      usePathnameMock.mockReturnValue('/invite');
      useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET'));
      await mount();
      await navigate('/onboarding', 'signup=1');
      const gtag = window.gtag as ReturnType<typeof vi.fn>;
      const ev = gtag.mock.calls.find((c) => c[0] === 'event' && c[1] === 'sign_up')?.[2] as Record<string, string>;
      expect(ev.page_referrer).toBe('');
    } finally {
      delete (document as unknown as { referrer?: string }).referrer;
    }
  });

  it('a token nested in a value of the query (/login?next=/invite/accept?token=…) excludes the screen too; a plain next does not', async () => {
    const { isAnalyticsExcluded } = await import('./google-analytics');
    expect(isAnalyticsExcluded('/login', new URLSearchParams('next=%2Finvite%2Faccept%3Ftoken%3DSECRET'))).toBe(true);
    expect(isAnalyticsExcluded('/login', new URLSearchParams('next=/invite/accept?token=SECRET&reason=x'))).toBe(true);
    expect(isAnalyticsExcluded('/login', new URLSearchParams('next=%2Fdesktop%2Fsetup%23code%3DSECRET'))).toBe(false); // the # inside a value is not parsed as a query (the path /desktop is on the list anyway)
    expect(isAnalyticsExcluded('/login', new URLSearchParams('next=%2Finbox&reason=expired'))).toBe(false);
    expect(isAnalyticsExcluded('/inbox', null, '#a=1&redirect=/x?code=SECRET')).toBe(true);
  });

  it('a hash-only move INTO an address that is not reported clears the screen-before: the next screen names neither', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount(); // armed on /inbox
    window.history.pushState(null, '', '/inbox#code=SECRET'); // the address changes, the route does not
    window.history.pushState(null, '', '/board'); // … and then the person moves on (the address follows the route, as the router does)
    await navigate('/board', '');
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const last = gtag.mock.calls.filter((c) => c[0] === 'config').at(-1)?.[2] as Record<string, string>;
    expect(last.page_path).toBe('/board');
    expect(last.page_referrer).toBe('');
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
  });

  it('the inline init expression and the helper make the SAME decision on a table of referrers (nested values included) — one rule, two places', async () => {
    const { initReferrerExpression, analyticsReferrer } = await import('./google-analytics');
    const own = 'https://app.example';
    const run = (referrer: string) =>
      new Function('document', 'location', 'URL', 'URLSearchParams', `return ${initReferrerExpression()};`)({ referrer }, { origin: own }, URL, URLSearchParams) as string;
    const table = [
      `${own}/login?next=%2Finvite%2Faccept%3Ftoken%3DSECRET`,                       // nested, one level
      `${own}/login?next=/a?redirect=/b?continue=/c?token=SECRET`,                  // nested, three levels
      `${own}/login?next=%2Fdesktop%2Fsetup%23code%3DSECRET`,                       // a # inside a value is not a query
      `${own}/login?next=%2Finbox&reason=expired`,
      `${own}/inbox?x=1#section`,
      `${own}/inbox#redirect=/x?code=SECRET`,
      `${own}/share/abc-secret-share-token`,
      `${own}/Reset-Password?token=SECRET`,
      `${own}/inbox?AuthKey=SECRET`,
      'https://other.example/p?token=SECRET#y',
      '', 'not an address',
    ];
    for (const ref of table) expect(run(ref), ref).toBe(analyticsReferrer(ref, own));
    expect(run(table[0]!)).toBe(''); expect(run(table[1]!)).toBe('');
  });

  it('nesting is read down to NEST_DEPTH_MAX levels, and not forever', async () => {
    const { isAnalyticsExcluded, NEST_DEPTH_MAX } = await import('./google-analytics');
    const nested = (levels: number) => `a=${Array.from({ length: levels }, (_, i) => `/p${i}?k${i}=`).join('')}token=SECRET`.replace(/^a=\/p0\?k0=/, 'next=');
    expect(NEST_DEPTH_MAX).toBeGreaterThanOrEqual(3);
    expect(isAnalyticsExcluded('/login', new URLSearchParams('next=/a?redirect=/b?continue=/c?token=SECRET'))).toBe(true); // three levels
    expect(isAnalyticsExcluded('/login', new URLSearchParams(nested(NEST_DEPTH_MAX)))).toBe(true);
    expect(isAnalyticsExcluded('/login', new URLSearchParams(nested(NEST_DEPTH_MAX + 6)))).toBe(false); // far beyond the cap: not followed (and not an endless loop)
  });

  it('an ARMED screen: a code arrives in the # and goes away again with no route change — the screen is reported again after the release (nothing leaks meanwhile)', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const before = gtag.mock.calls.filter((c) => c[0] === 'config').length;
    expect(before).toBeGreaterThan(0);

    vi.useFakeTimers();
    try {
      window.history.pushState(null, '', '/inbox#code=SECRET'); // the address changes, the route does not
      window.history.pushState(null, '', '/inbox'); // … and the # goes away: nothing re-runs the route effect by itself
      await act(async () => { vi.advanceTimersByTime(HOLD_MS_FOR_TEST); });
    } finally {
      vi.useRealTimers();
    }
    const after = gtag.mock.calls.filter((c) => c[0] === 'config');
    expect(after.length).toBe(before + 1);
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(false);
  });

  it('a first screen /onboarding?signup=1 with a code in its # that goes away: the conversion is sent once, after the release, with no code in it', async () => {
    window.history.replaceState(null, '', '/onboarding?signup=1#code=SECRET');
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParams_signup();
    await mount();
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(0); // held back while the code is in the address
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, '', '/onboarding?signup=1');
      await act(async () => { vi.advanceTimersByTime(HOLD_MS_FOR_TEST); });
    } finally {
      vi.useRealTimers();
    }
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(1);
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
  });

  it('an ARMED screen that arrives with ?signup=1 while a code is in its # : the conversion is held back, then sent once when the # goes away (no route change, tag already armed)', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount(); // armed on an ordinary screen
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    window.history.replaceState(null, '', '/onboarding?signup=1#code=SECRET'); // the address now carries a code …
    await navigate('/onboarding', 'signup=1'); // … and the route arrives with the conversion marker
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(0);
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, '', '/onboarding?signup=1'); // the # goes away: same path, same query
      await act(async () => { vi.advanceTimersByTime(HOLD_MS_FOR_TEST); });
    } finally {
      vi.useRealTimers();
    }
    expect(gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up')).toHaveLength(1);
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
  });

  it('a history call the browser REFUSES (a cross-origin address) leaves the opt-out flag as it was — not stuck on', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    expect(flag()).toBe(false);
    expect(() => window.history.pushState(null, '', 'https://other.example/reset-password?token=SECRET')).toThrow();
    expect(flag()).toBe(false);
    // and the same after a refused move AWAY from a token screen (the held flag goes back to what it was: on)
    window.history.pushState(null, '', '/reset-password?token=SECRET');
    expect(flag()).toBe(true);
    expect(() => window.history.pushState(null, '', 'https://other.example/inbox')).toThrow();
    expect(flag()).toBe(true);
  });

  it('a refused history call into an address that would not be reported leaves the screen-before and the reported mark as they were', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount(); // /inbox is reported
    expect(() => window.history.pushState(null, '', 'https://other.example/reset-password?token=SECRET')).toThrow(); // refused: no move happened
    await navigate('/board', '');
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const last = gtag.mock.calls.filter((c) => c[0] === 'config').at(-1)?.[2] as Record<string, string>;
    expect(last.page_path).toBe('/board');
    expect(last.page_referrer).toBe(`${window.location.origin}/inbox`); // not '' — the refused call changed nothing
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
  });

  it('the hold time is the one the tests assume (a change of it must be a deliberate edit of both)', async () => {
    const { HOLD_MS } = await import('./google-analytics');
    expect(HOLD_MS).toBe(HOLD_MS_FOR_TEST);
  });

  it('the flag stays on through the move away from a token screen and is off BEFORE our own hit for the new screen is sent', async () => {
    usePathnameMock.mockReturnValue('/reset-password');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET'));
    await mount();
    await navigate('/inbox', ''); // first an allowed screen so the tag is armed (the person came from the token screen)
    const flag = (): unknown => (window as unknown as Record<string, unknown>)['ga-disable-G-TEST123'];
    // record the flag at the instant each hit is sent
    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const flagAtHit: unknown[] = [];
    gtag.mockImplementation((...a: unknown[]) => { if (a[0] === 'config') flagAtHit.push(flag()); });
    window.history.pushState(null, '', '/reset-password?token=SECRET2');
    await navigate('/reset-password', 'token=SECRET2');
    window.history.pushState(null, '', '/inbox');
    expect(flag()).toBe(true); // GA's automatic history hit would fall here: dropped
    await navigate('/inbox', '');
    expect(flagAtHit.at(-1)).toBe(false); // our own hit for /inbox goes out with the flag released
  });

  it('A → a token screen → A: the second A is reported again (a view is not lost to the de-duplication)', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    await navigate('/reset-password', 'token=SECRET');
    await navigate('/inbox', '');

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const inboxConfigs = gtag.mock.calls.filter((c) => c[0] === 'config' && (c[2] as { page_path?: string })?.page_path === '/inbox');
    expect(inboxConfigs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('SECRET');
  });

  it('the wrapping is undone when the component goes away (history is the browser\'s again)', async () => {
    const original = window.history.pushState;
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();
    expect(window.history.pushState).not.toBe(original);
    await act(async () => { root.unmount(); });
    expect(window.history.pushState).toBe(original);
    root = createRoot(container); // afterEach unmounts it
  });

  it('a token screen that also carries signup=1 sends no conversion and does not rewrite the address', async () => {
    usePathnameMock.mockReturnValue('/invite');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET&signup=1'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

function useSearchParams_token() { useSearchParamsMock.mockReturnValue(new URLSearchParams('token=SECRET')); }
function useSearchParams_signup() { useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1')); }
