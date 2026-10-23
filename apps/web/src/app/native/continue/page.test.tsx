// story 4712 — the page of «브라우저 이어받기»: signed in → the confirm card; not signed in → the ordinary sign-in and back to THIS page with the
// app's start; a start that is off in any part → "open this from the app" and no card. Rendering the page makes no code (Kadir v2 ②).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({ session: vi.fn(), redirect: vi.fn(), backendFetch: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.session }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: h.backendFetch }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { h.redirect(to); throw new Error(`REDIRECT:${to}`); } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/components/desktop/desktop-continue-card', () => ({
  DesktopContinueCard: (p: { account: string; here: string; failed?: boolean; start: { challenge: string; returnApp: string | null } }) => (
    <div data-card data-account={p.account} data-here={p.here} data-app={p.start.returnApp ?? ''} data-failed={p.failed ? '1' : ''} />
  ),
}));

import DesktopContinuePage from './page';

const CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const GOOD = { code_challenge: CH, cc_method: 'S256', callback_mode: 'custom_scheme' };
const render = async (sp: Record<string, string | string[] | undefined>) =>
  renderToStaticMarkup((await DesktopContinuePage({ searchParams: Promise.resolve(sp) })) as ReactElement);

beforeEach(() => {
  h.session.mockReset().mockResolvedValue({ user_id: 'u1', email: 'jay@example.com', access_token: 't', org_id: null, project_id: null });
  h.redirect.mockReset();
  h.backendFetch.mockReset();
});

describe('/native/continue', () => {
  it('signed in with a good start → the card with the account (a new account with no organization too — no onboarding redirect here)', async () => {
    const html = await render({ ...GOOD, return_app: 'dev' });
    expect(html).toContain('data-card');
    expect(html).toContain('data-account="jay@example.com"');
    expect(html).toContain('data-app="dev"');
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.backendFetch).not.toHaveBeenCalled(); // opening the page makes no code
  });

  it('the form route sent the person back with failed=1 → the card gets failed (and `here` stays without it, so a sign-in round trip does not keep the flag)', async () => {
    const html = await render({ ...GOOD, failed: '1' });
    expect(html).toContain('data-failed="1"');
    expect(html).toContain(`data-here="/native/continue?code_challenge=${CH}&amp;cc_method=S256&amp;callback_mode=custom_scheme"`);
    expect(await render(GOOD)).toContain('data-failed=""');
  });

  it('not signed in → the sign-in page with next = this page and the whole start (no "session expired" reason)', async () => {
    h.session.mockResolvedValue(null);
    await expect(render(GOOD)).rejects.toThrow('REDIRECT:');
    const to = h.redirect.mock.calls[0]![0] as string;
    expect(to.startsWith('/login?next=')).toBe(true);
    expect(to).not.toContain('reason=');
    const next = decodeURIComponent(to.slice('/login?next='.length));
    expect(next).toBe(`/native/continue?code_challenge=${CH}&cc_method=S256&callback_mode=custom_scheme`);
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no parameters', {}],
    ['a short challenge', { ...GOOD, code_challenge: CH.slice(0, 40) }],
    ['https mode', { ...GOOD, callback_mode: 'https' }],
    ['an app off the table', { ...GOOD, return_app: 'prod' }],
    ['a challenge given twice', { ...GOOD, code_challenge: [CH, CH] }],
    ['an optional app given twice (not «absent»)', { ...GOOD, return_app: ['dev', 'dev'] }],
  ])('%s → "open this from the app", no card, and no sign-in is asked for', async (_n, sp) => {
    const html = await render(sp);
    expect(html).toContain('invalidTitle');
    expect(html).not.toContain('data-card');
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
