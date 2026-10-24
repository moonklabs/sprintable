/**
 * story 4669 AC4 — «Google에서 돌아온 뒤 첫 화면까지 우리 쪽 손 ≤ 3» (코드와 OAuth 대역 e2e로 셈 · Google 자기 화면은 셈 밖).
 *
 * The OAuth stand-in: a person comes back from Google as a signed-in, verified account with no organization and no pending invite
 * (what `/api/auth/me` and `/api/invites/mine` answer after the callback made the account) and the REAL `OnboardingForm` is mounted
 * (bundled with esbuild, not copied) in Chromium — no server of ours; the page's API answers are made here, as in
 * `onboarding.4668.layout.spec.ts`. The test then COUNTS the hands: it presses nothing on its own; every time the first screen is not
 * yet there, it must press the first control the card offers, and each press is one hand. A page that asks for a name, an
 * organization, a fork, or any press before the first screen costs hands — more than 3 fails the test and prints the number.
 * The count today is 0: arrival finds the account has no organization, reads the invites (none) and makes the organization with a made
 * name by itself (name only — the server derives the address).
 *
 * Scope: from the mounted form on. What comes before it — the OAuth callback's redirect, the authenticated layout sending an org-less person
 * to /onboarding, and the page's e-mail gate (open for a provider-verified account, so it adds no hand) — is not exercised here.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');

/** AC4's bound */
const MAX_HANDS = 3;
const FIRST_SCREEN = { mac: '에이전트는 내 Mac에서 돌아가요' };

let built: string | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/hooks/use-flat-href': 'export function useFlatHref() { return (h) => h; } export function withProjectParam(h) { return h; }',
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const refreshAuthTokens = async () => ({ data: { ok: true }, error: null }); export const logoutUser = async () => {};',
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { OnboardingForm } from './src/app/onboarding/onboarding-form';
        window.__mount = () => {
          const root = createRoot(document.getElementById('root'));
          root.render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(OnboardingForm, { todayHref: '/today', chatsHref: '/chats', todayV3Enabled: true })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      {
        name: 'onboarding-4669-stubs',
        setup(b) {
          b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4669' }));
          b.onLoad({ filter: /.*/, namespace: 'stub4669' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
        },
      },
      layoutStubPlugin(),
    ],
  });
  built = out.outputFiles[0]!.text;
  return built;
}

/** what the backend answers a person who just came back from Google: signed in, mailbox verified by the provider, no organization yet */
const AFTER_GOOGLE: Record<string, unknown> = {
  'GET /api/auth/me': { data: { member_id: 'u-1', email_verified: true, email_verification_required: true, org_id: null, org_member_id: null, display_name: '송윤재' } },
  'GET /api/invites/mine': { invites: [] },
  'POST /api/organizations': { data: { id: 'org-1' } },
  'POST /api/auth/refresh': {},
  'POST /api/onboarding/events': {},
  'GET /desktop/downloads/macos.json': { product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: false, url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg' },
};

async function openAfterGoogle(page: Page, requests: { method: string; path: string; body: string | null }[], failFirst?: string) {
  let failed = false;
  const js = await build();
  await page.route('http://preview.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' });
    }
    requests.push({ method: req.method(), path: url.pathname, body: req.postData() });
    if (failFirst && !failed && `${req.method()} ${url.pathname}` === failFirst) { failed = true; return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); }
    const answer = AFTER_GOOGLE[`${req.method()} ${url.pathname}`];
    if (answer === undefined) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(answer),
      ...(url.pathname.endsWith('macos.json') ? { headers: { 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' } } : {}),
    });
  });
  await page.goto('http://preview.test/');
  await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', configurable: true }); });
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
}

/** The hands: presses needed before the first screen shows. The test never presses unless the first screen is not there. */
async function countHands(page: Page): Promise<number> {
  const heading = page.locator('h1');
  // the page's own offered action: the first visible button or link in the card (a retry, «초대와 따로 내 조직 만들기», a continue) — one press each
  // (the invited card's own press is its «내 조직을 새로 만들기» link — its [들어가기] takes the invite, which is another road: 4711 AC4)
  const primaries = page.locator(
    ['[data-testid="onboarding-card"] button:visible', '[data-testid="onboarding-card"] a:visible', '[data-testid="setup-invited-own-org"]:visible'].join(', '),
  );
  let hands = 0;
  for (;;) {
    const arrived = await expect(heading).toHaveText(FIRST_SCREEN.mac, { timeout: 4000 }).then(() => true, () => false);
    if (arrived) return hands;
    if (hands > MAX_HANDS) return hands; // already over — no need to look further
    // not there: the person has to do something. The first control the card offers is the next hand.
    if ((await primaries.count()) === 0) throw new Error(`stuck before the first screen after ${hands} hand(s): h1 = «${await heading.first().textContent().catch(() => '')}», no control to press`);
    await primaries.first().click();
    hands += 1;
  }
}

test('Google → first screen: the hands on our side (AC4: ≤ 3), counted by pressing only what the page demands', async ({ page }) => {
  const requests: { method: string; path: string; body: string | null }[] = [];
  await openAfterGoogle(page, requests);
  const hands = await countHands(page);
  test.info().annotations.push({ type: 'hands', description: String(hands) });
  console.log(`[4669 AC4] hands before the first screen: ${hands} (bound ${MAX_HANDS})`);
  expect(hands, `hands before the first screen: ${hands} (AC4 allows ${MAX_HANDS})`).toBeLessThanOrEqual(MAX_HANDS);

  // the count is honest only if nothing was typed: the organization was made by the page, with a made name, the name only
  const made = requests.filter((r) => r.method === 'POST' && r.path === '/api/organizations');
  expect(made, 'the organization is made once, by arrival').toHaveLength(1);
  expect(JSON.parse(made[0]!.body ?? '{}')).toEqual({ name: '송윤재의 조직' });
  // the invites were read BEFORE the organization was made (never make one while the invites are unknown)
  const order = requests.map((r) => `${r.method} ${r.path}`);
  expect(order.indexOf('GET /api/invites/mine')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('GET /api/invites/mine')).toBeLessThan(order.indexOf('POST /api/organizations'));
});

test('the counter is not blind: a page that asks for one more press before the first screen costs that hand', async ({ page }) => {
  // the same stand-in, but the person still has an invite → the invited card stands in the way: it is not the first screen, so the
  // counter must NOT report 0 and must find the press that is outside the card («초대와 따로 내 조직 만들기»)
  const requests: { method: string; path: string; body: string | null }[] = [];
  AFTER_GOOGLE['GET /api/invites/mine'] = { invites: [{ invite_id: 'inv-1', org_id: 'org-x', org_name: '문클랩스', role: 'member', expires_at: '2026-10-30T00:00:00Z' }] };
  try {
    await openAfterGoogle(page, requests);
    // the invited card's «초대와 따로 내 조직 만들기» is the one press (it makes the organization and lands on the first screen)
    expect(await countHands(page), 'with an invite pending the first screen costs exactly that one press').toBe(1);
  } finally {
    AFTER_GOOGLE['GET /api/invites/mine'] = { invites: [] };
  }
});

test('the counter counts a press: the account read fails once → arrival stops with one primary → one press, then the first screen = 1 hand', async ({ page }) => {
  const requests: { method: string; path: string; body: string | null }[] = [];
  await openAfterGoogle(page, requests, 'GET /api/auth/me');
  const hands = await countHands(page);
  expect(hands).toBe(1);
  expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/organizations'), 'still one organization').toHaveLength(1);
});
