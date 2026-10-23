// @vitest-environment jsdom
//
// story 4713 AC3 (Yuna `4713-ac3-web-copy-1017.md` form B) — the block at the top of the browser's «새 프로젝트» dialog: three forms by the
// count of connected setups, none in the desktop app / phone app / while the count is unknown, and no button on a browser that is not a Mac's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { appSetupLink } from '@/lib/auth/native-return-app';

const { rc, app } = vi.hoisted(() => ({ rc: { value: null as { connected_setups?: number } | null }, app: { on: false } }));
vi.mock('@/lib/org-remote-control', () => ({
  useOrgRemoteControl: () => [rc.value, () => {}, false],
  connectedSetupsOf: (s: { connected_setups?: number }) => s.connected_setups ?? 0,
}));
vi.mock('@/lib/desktop-app', () => ({ desktopApp: () => (app.on ? {} : undefined) }));
vi.mock('@/components/desktop/desktop-download-card', async (orig) => ({
  ...(await orig<typeof import('@/components/desktop/desktop-download-card')>()),
  DesktopDownloadCard: (p: { ctaLabel?: string; ctaVariant?: string; hideTitle?: boolean }) => <div data-testid="download-card">{p.ctaLabel}|{p.ctaVariant}|{String(p.hideTitle)}</div>,
}));

import { NewProjectMacBlock } from './new-project-mac-block';
import { NEW_PROJECT_LINK } from './new-project-entry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  rc.value = { connected_setups: 1 }; app.on = false;
  Object.defineProperty(navigator, 'userAgent', { value: MAC, configurable: true });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(o: { locale?: 'ko' | 'en'; phone?: boolean } = {}) {
  const locale = o.locale ?? 'ko';
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <PhoneBridgeContext.Provider value={{ inPhoneApp: !!o.phone, phoneCall: async () => ({ id: '', ok: false }) }}>
          <NewProjectMacBlock orgId="o-1" />
        </PhoneBridgeContext.Provider>
      </NextIntlClientProvider>,
    );
  });
}
const block = () => container.querySelector('[data-testid=new-project-mac-block]');
const text = () => block()?.textContent ?? '';

describe('story 4713 AC3 — the Mac block in the browser\'s «새 프로젝트» dialog', () => {
  it('one connected Mac: title · body · [Mac 앱에서 이어서] (outline link to the app\'s own setup link) · the always-visible «앱이 안 열리면» line', async () => {
    await render();
    expect(text()).toContain('Mac 앱에서 폴더로 시작할 수도 있어요');
    expect(text()).toContain('폴더를 고르면 프로젝트와 에이전트가 한 번에 만들어져요.');
    const a = container.querySelector('[data-testid=new-project-mac-open]') as HTMLAnchorElement;
    expect(a.textContent).toBe('Mac 앱에서 이어서');
    expect(a.getAttribute('href')).toBe(appSetupLink(null));
    expect(a.getAttribute('href')).toBe(NEW_PROJECT_LINK);
    expect(a.className).not.toMatch(/bg-primary/); // outline: the dialog keeps exactly one filled primary, its own [만들기]
    expect(text()).toContain('앱이 안 열리면 Mac에서 Sprintable 앱을 켜고 «새 프로젝트»를 눌러 주세요.');
    expect(container.querySelector('[data-testid=download-card]')).toBeNull();
  });

  it('several: the count sentence replaces the body (the link still opens THIS computer\'s app — no list, no «어느»)', async () => {
    rc.value = { connected_setups: 3 };
    await render();
    expect(text()).toContain('연결된 Mac이 3대예요 — 지금 이 컴퓨터의 앱에서 열려요. 폴더를 고르면 프로젝트와 에이전트가 한 번에 만들어져요.');
    expect(text()).not.toContain('어느');
    expect(container.querySelector('[data-testid=new-project-mac-open]')).not.toBeNull();
  });

  it('en: one and several (plural), none', async () => {
    await render({ locale: 'en' });
    expect(text()).toContain('You can also start from a folder in the Mac app');
    expect(container.querySelector('[data-testid=new-project-mac-open]')!.textContent).toBe('Continue in the Mac app');
    rc.value = { connected_setups: 2 };
    await render({ locale: 'en' });
    expect(text()).toContain('2 Macs are connected — the app on this computer opens.');
    rc.value = { connected_setups: 0 };
    await render({ locale: 'en' });
    expect(text()).toContain('With the Mac app you can start from a folder');
  });

  it('none connected: «Mac 앱을 받으면 …» + the web first screen\'s line by key (one source) + the download card with [Mac 앱 받기] as outline, no title', async () => {
    rc.value = { connected_setups: 0 };
    await render();
    expect(text()).toContain('Mac 앱을 받으면 폴더로 바로 시작할 수 있어요');
    expect(text()).toContain((koMessages.onboarding as unknown as { first: { macLead: string } }).first.macLead);
    expect(container.querySelector('[data-testid=download-card]')!.textContent).toBe('Mac 앱 받기|outline|true');
    expect(container.querySelector('[data-testid=new-project-mac-open]')).toBeNull();
  });

  it('the count is not known (not read / failed): no block — never a promise from an unknown count', async () => {
    rc.value = null;
    await render();
    expect(block()).toBeNull();
  });

  it('inside the desktop app and in the phone app: no block', async () => {
    app.on = true;
    await render();
    expect(block()).toBeNull();
    app.on = false;
    await render({ phone: true });
    expect(block()).toBeNull();
  });

  it('a browser that is not a Mac\'s: no button (the link would open nothing) — the line «Mac에서 이 계정으로 열면 …» stands in place, with no «앱이 안 열리면»', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: WIN, configurable: true });
    await render();
    expect(container.querySelector('[data-testid=new-project-mac-open]')).toBeNull();
    expect(container.querySelector('[data-testid=new-project-mac-elsewhere]')!.textContent).toBe('Mac에서 이 계정으로 열면 폴더로 바로 시작할 수 있어요');
    expect(text()).not.toContain('앱이 안 열리면');
    // several setups, still not a Mac: the count alone — «이 컴퓨터의 앱에서 열려요» would promise an opening that cannot happen (Yuna's note)
    rc.value = { connected_setups: 3 };
    await render();
    expect(text()).toContain('연결된 Mac이 3대예요.');
    expect(text()).not.toContain('이 컴퓨터의 앱');
    await render({ locale: 'en' });
    expect(text()).toContain('3 Macs are connected.');
    expect(text()).not.toContain('app on this computer');
    rc.value = { connected_setups: 0 };
    await render();
    expect(container.querySelector('[data-testid=download-card]')).toBeNull(); // not a Mac: nothing to install here
    expect(container.querySelector('[data-testid=new-project-mac-elsewhere]')).not.toBeNull();
  });
});
