// @vitest-environment jsdom
// story #4226 — 더보기의 flat(static) 링크는 useFlatHref(`?p=`)를 거치고, resource 항목(bare 폴백)은 거치지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 1024 }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('MorePage — flat 링크 `?p=`(story #4226)', () => {
  it('⭐static 항목(/org-briefing · /settings · /organization/…)은 `?p=` · resource bare 폴백은 안 붙임', async () => {
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><MorePage /></TopBarProvider></NextIntlClientProvider>);
    });
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/org-briefing?p=P');
    expect(hrefs).toContain('/settings?p=P');
    expect(hrefs.filter((h) => h.startsWith('/organization/')).every((h) => h.endsWith('p=P'))).toBe(true);
    expect(hrefs.some((h) => h === '/org-briefing' || h === '/settings')).toBe(false);
  });
});
