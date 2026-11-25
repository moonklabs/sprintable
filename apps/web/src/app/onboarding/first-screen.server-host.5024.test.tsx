// @vitest-environment jsdom
// story 5024 (AC4) — a workspace SERVER HOST's onboarding «에이전트» step. Before: «에이전트는 내 Mac에서 돌아가요 · Mac 앱 받기 · 지금은 받을 수 없어요» — a Linux server has no Mac app, so the person who set it up
// learned nothing about how an agent gets attached. Now: «이 서버에 에이전트 연결하기» with the one command for the computer that will run the agent (this server's own address filled in) and a copy button;
// the Mac screens are not drawn. Any other deployment (no `serverHostOrigin`) is exactly what it was. Taking the `serverHostOrigin` branch out of first-screen.tsx turns the first test red.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('./advanced-connect', () => ({ AdvancedConnect: () => <div data-testid="stub-advanced" /> }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const copied: string[] = [];
let copyOk = true;
vi.mock('@/lib/clipboard', () => ({
  copyTextSafely: async (text: string) => { if (!copyOk) return { ok: false }; copied.push(text); return { ok: true }; },
  copyPromisedText: async () => ({ ok: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FirstScreen } = await import('./first-screen');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  copied.length = 0; copyOk = true;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })));
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete (navigator as { userAgent?: string }).userAgent; vi.unstubAllGlobals(); });

const render = async (props: { serverHostOrigin?: string | null; locale?: 'ko' | 'en'; onFinish?: () => void } = {}) => {
  const { locale = 'ko', onFinish = vi.fn(), ...rest } = props;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <FirstScreen orgId="org-1" chatsHref="/chats" orgName="우리 팀" onFinish={onFinish} {...rest} />
      </NextIntlClientProvider>,
    );
  });
};
const has = (id: string) => !!container.querySelector(`[data-testid="${id}"]`);
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

describe('[SID:5024 AC4] FirstScreen on a workspace server host', () => {
  it('says how to attach an agent to THIS server: the title, the command with this server\'s address, a copy button — and draws none of the Mac screens', async () => {
    await render({ serverHostOrigin: 'https://team.example.com' });
    expect(has('onboarding-first-server-host')).toBe(true);
    expect(container.textContent).toContain('이 서버에 에이전트 연결하기');
    expect(text('onboarding-first-server-host-card-command')).toBe('sprintable-host pair --folder ~/work --server https://team.example.com');
    expect(has('onboarding-first-server-host-card-copy')).toBe(true);
    // none of the Mac screens: not the Mac title, not the download card, not «앱 열기», not the not-Mac fork
    expect(has('onboarding-first-mac')).toBe(false);
    expect(has('onboarding-first-not-mac')).toBe(false);
    expect(has('onboarding-first-open-app')).toBe(false);
    expect(container.textContent).not.toContain('에이전트는 내 Mac에서 돌아가요');
    expect(container.textContent).not.toContain('지금은 받을 수 없어요');
    // the organization and the way out stay
    expect(has('onboarding-first-org')).toBe(true);
    expect(has('onboarding-first-finish')).toBe(true);
  });

  it('the address in the command is the one given (a port stays) — never read from the browser\'s own location', async () => {
    await render({ serverHostOrigin: 'https://team.example.com:8443' });
    expect(text('onboarding-first-server-host-card-command')).toBe('sprintable-host pair --folder ~/work --server https://team.example.com:8443');
    expect(window.location.origin).not.toContain('team.example.com');
  });

  it('the copy button puts the whole command on the clipboard; a failure is said in words and the command stays selectable', async () => {
    await render({ serverHostOrigin: 'https://team.example.com' });
    const press = () => act(async () => { (container.querySelector('[data-testid="onboarding-first-server-host-card-copy"]') as HTMLButtonElement).click(); });
    await press();
    expect(copied).toEqual(['sprintable-host pair --folder ~/work --server https://team.example.com']);
    expect(container.querySelector('[data-testid="onboarding-first-server-host-card-copy"]')?.textContent).toBe('복사됨');
    copyOk = false;
    await press();
    expect(has('onboarding-first-server-host-card-copy-failed')).toBe(true);
    expect(text('onboarding-first-server-host-card-copy-failed')).toContain('직접 선택해 복사');
  });

  it('the way out is the page\'s own finish (one press, once)', async () => {
    const onFinish = vi.fn();
    await render({ serverHostOrigin: 'https://team.example.com', onFinish });
    await act(async () => { (container.querySelector('[data-testid="onboarding-first-finish"]') as HTMLButtonElement).click(); });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('English reads the same story (title · the command is the same literal)', async () => {
    await render({ serverHostOrigin: 'https://team.example.com', locale: 'en' });
    expect(container.textContent).toContain('Attach an agent to this server');
    expect(text('onboarding-first-server-host-card-command')).toBe('sprintable-host pair --folder ~/work --server https://team.example.com');
  });

  it('no server host (null · absent): exactly the Mac screen it was', async () => {
    await render({ serverHostOrigin: null });
    expect(has('onboarding-first-mac')).toBe(true);
    expect(has('onboarding-first-server-host')).toBe(false);
    expect(container.textContent).toContain('에이전트는 내 Mac에서 돌아가요');
    await render({});
    expect(has('onboarding-first-mac')).toBe(true);
    expect(has('onboarding-first-server-host')).toBe(false);
  });
});

describe('[SID:5024 AC4] the form carries the address to the first screen', () => {
  it('onboarding-form.tsx hands `serverHostOrigin` to <FirstScreen> (the form\'s own test would need the whole sign-up path: the pass-through is pinned in the source)', () => {
    const src = readFileSync(join(__dirname, 'onboarding-form.tsx'), 'utf8');
    const first = /<FirstScreen\b[^>]*>/.exec(src)?.[0] ?? '';
    expect(first).toContain('serverHostOrigin={serverHostOrigin}');
  });
});
