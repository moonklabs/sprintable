// @vitest-environment jsdom
//
// story 4891 (UI-8 U8 · PO 11-10) — the login card keeps ONE main action and the helpers a person comes for (two fields · [로그인] · [Google] · «비밀번호 찾기» · «가입»); what used to stand above it (the Mac app's way in + the web
// sign-up) and inside it (the terms line under Google) now stands UNDER it, as the same links in a quiet block. Measured on dev before: 10 presses on the first screen (the card's own 6 + 4 side paths). Each test names the line that,
// reverted, turns it red. (Harness as page.test.tsx.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pushMock, searchParamsRef } = vi.hoisted(() => ({ pushMock: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
let container: HTMLDivElement;
let root: Root;
const originalFlag = process.env['NEXT_PUBLIC_OAUTH_ENABLED'];

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); searchParamsRef.current = new URLSearchParams(); });
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.restoreAllMocks(); vi.resetModules();
  if (originalFlag === undefined) delete process.env['NEXT_PUBLIC_OAUTH_ENABLED']; else process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = originalFlag;
});

async function mount(oauth: boolean) {
  if (oauth) process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true'; else delete process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => MAC);
  const { default: LoginPage } = await import('./page');
  const { MacAppOfferProvider } = await import('./mac-app-offer');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><MacAppOfferProvider enabled><LoginPage /></MacAppOfferProvider></NextIntlClientProvider>); });
}
const card = () => container.querySelector('.rounded-2xl') as HTMLElement;
const bottom = () => container.querySelector('[data-testid="login-bottom"]') as HTMLElement;
const presses = (el: ParentNode) => [...el.querySelectorAll('input, button, a[href]')];
const hrefs = (el: ParentNode) => [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

describe('[SID:4891] LoginPage — what stands above the card, in it, and under it', () => {
  it('⭐the card has six ACTIONS — two fields · [로그인] · [Google] · «비밀번호 찾기» · «가입» — plus the terms notice right under Google; none of the Mac app paths', async () => {
    await mount(true);
    const notice = card().querySelector('[data-testid="login-terms-line"]') as HTMLElement;
    const actions = presses(card()).filter((el) => !notice.contains(el));
    // reverted (the Mac app card above the fields) → 8 actions here
    expect(actions).toHaveLength(6);
    const h = hrefs(card());
    expect(h).not.toContain('/desktop/get/macos');
    expect(h).toContain('/forgot-password');
    expect(h.some((x) => x?.startsWith('/register'))).toBe(true);
    expect(h.some((x) => x?.startsWith('/auth/login?provider=google'))).toBe(true);
    // the notice's two links are the card's only /terms and /privacy
    expect(hrefs(notice)).toEqual(['/terms', '/privacy']);
  });

  it('⭐the terms notice is the NEXT SIBLING of the Google button — nothing stands between the button that records the consent and the sentence that tells it (PO 11-10)', async () => {
    await mount(true);
    const google = container.querySelector('a[href^="/auth/login?provider=google"]') as HTMLAnchorElement;
    const notice = card().querySelector('[data-testid="login-terms-line"]') as HTMLElement;
    // reverted (the notice moved under the card, or anything put between) → not the next sibling
    expect(google.nextElementSibling).toBe(notice);
    expect(notice.textContent).toContain(koMessages.login.termsPrefix);
    expect(notice.hasAttribute('hidden') || notice.closest('[hidden]') !== null, 'the notice is drawn, not hidden').toBe(false);
  });

  it('under the card: only the Mac app block (the pitch · the file · the web sign-up · the hint), after the card', async () => {
    await mount(true);
    expect(card().compareDocumentPosition(bottom()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hrefs(bottom())).toEqual(['/desktop/get/macos', '/register']);
    const offer = bottom().querySelector('[data-testid="login-mac-app-offer"]') as HTMLElement;
    expect(offer.textContent).toContain(koMessages.login.macAppPitch);
    expect(bottom().querySelector('[data-testid="login-terms-line"]')).toBeNull();
  });

  it('Google carries tos_accepted=true · a build with no OAuth has no Google and no notice, and the Mac app block still stands under the card', async () => {
    await mount(true);
    expect((container.querySelector('a[href^="/auth/login?provider=google"]') as HTMLAnchorElement).getAttribute('href')).toContain('tos_accepted=true');
    root.unmount(); root = createRoot(container);
    await mount(false);
    expect(container.querySelector('[data-testid="login-terms-line"]')).toBeNull();
    expect(container.querySelector('a[href^="/auth/login?provider=google"]')).toBeNull();
    expect(presses(card())).toHaveLength(5); // two fields · [로그인] · «비밀번호 찾기» · «가입»
    expect(bottom().querySelector('[data-testid="login-mac-app-offer"]')).not.toBeNull();
  });
});
