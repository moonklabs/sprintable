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
const { publicHostOf } = await import('@/lib/embedded-api-origin');

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

const render = async (props: { serverHostOrigin?: string | null; serverHostPending?: boolean; locale?: 'ko' | 'en'; onFinish?: () => void } = {}) => {
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
    expect(text('onboarding-first-server-host-card-command')).toBe('mkdir -p ~/work && sprintable-host pair --folder ~/work --server https://team.example.com');
    expect(has('onboarding-first-server-host-card-copy')).toBe(true);
    // the person reading this is a teammate who never saw the server's install guide: where the Linux download is listed is on the card (a literal line) — not «the guide you followed»
    expect(text('onboarding-first-server-host-card-install-list')).toBe('https://storage.googleapis.com/sprintable-desktop-releases/linux-server-host/latest/manifest.json');
    expect(text('onboarding-first-server-host-card-install-note')).not.toContain('서버를 세울 때');
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
    expect(text('onboarding-first-server-host-card-command')).toBe('mkdir -p ~/work && sprintable-host pair --folder ~/work --server https://team.example.com:8443');
    expect(window.location.origin).not.toContain('team.example.com');
  });

  it('the copy button puts the whole command on the clipboard; a failure is said in words and the command stays selectable', async () => {
    await render({ serverHostOrigin: 'https://team.example.com' });
    const press = () => act(async () => { (container.querySelector('[data-testid="onboarding-first-server-host-card-copy"]') as HTMLButtonElement).click(); });
    await press();
    expect(copied).toEqual(['mkdir -p ~/work && sprintable-host pair --folder ~/work --server https://team.example.com']);
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
    expect(text('onboarding-first-server-host-card-command')).toBe('mkdir -p ~/work && sprintable-host pair --folder ~/work --server https://team.example.com');
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

describe('[SID:5024 F1] FirstScreen on a server host that has no public address yet', () => {
  it('says «set the public address first» with the one command that sets it — not the Mac app, and not a pair command (there is no address to give it)', async () => {
    await render({ serverHostOrigin: null, serverHostPending: true } as never);
    expect(has('onboarding-first-server-host')).toBe(true);
    expect(container.textContent).toContain('먼저 이 서버의 공개 주소를 정해 주세요');
    expect(text('onboarding-first-server-host-card-command')).toBe('sprintable-host server set-public-origin https://YOUR-SERVER-DOMAIN --restart');
    expect(container.textContent).not.toContain('sprintable-host pair');
    expect(text('onboarding-first-server-host-card-pending-note')).toContain('대문자로 쓴 자리를');
    // the host prints its refusal in English, so the note describes it in words and never quotes a Korean sentence that is not on any screen
    expect(text('onboarding-first-server-host-card-pending-note')).toContain('이름에 점이 있어야 한다는 안내');
    expect(text('onboarding-first-server-host-card-pending-note')).not.toContain('점이 있는 이름이 필요해요');
    expect(has('onboarding-first-server-host-card-pending-note')).toBe(true);
    expect(has('onboarding-first-server-host-card-pending-after')).toBe(true);
    expect(has('onboarding-first-server-host-card-install-list')).toBe(false);
    expect(has('onboarding-first-mac')).toBe(false);
    expect(has('onboarding-first-not-mac')).toBe(false);
    expect(container.textContent).not.toContain('에이전트는 내 Mac에서 돌아가요');
    expect(container.textContent).not.toContain('지금은 받을 수 없어요');
    expect(has('onboarding-first-org')).toBe(true);
    expect(has('onboarding-first-finish')).toBe(true);
  });

  it('the command is a literal on its own line (no sentence around it), it copies whole, and English says the same', async () => {
    await render({ serverHostOrigin: null, serverHostPending: true, locale: 'en' } as never);
    expect(container.textContent).toContain('First set this server');
    const press = () => act(async () => { (container.querySelector('[data-testid="onboarding-first-server-host-card-copy"]') as HTMLButtonElement).click(); });
    await press();
    expect(copied).toEqual(['sprintable-host server set-public-origin https://YOUR-SERVER-DOMAIN --restart']);
    expect(text('onboarding-first-server-host-card-pending-note')).toContain('upper-case part');
  });

  // a person copies this line and runs it as it is: it must NOT be a command that works. A believable example name would restart the server on that name and fill the next card's pair command with it.
  it('what is copied has no believable domain in it and is a plain word with no shell meaning, which the web\'s copy of the host\'s address rule refuses (both languages; the host\'s own refusal — before it writes or restarts anything — is checked by hand and in the VM lap, not here)', async () => {
    for (const locale of ['ko', 'en'] as const) {
      copied.length = 0;
      await render({ serverHostOrigin: null, serverHostPending: true, locale } as never);
      await act(async () => { (container.querySelector('[data-testid="onboarding-first-server-host-card-copy"]') as HTMLButtonElement).click(); });
      const line = copied[0] ?? '';
      expect(line, locale).toContain('sprintable-host server set-public-origin https://YOUR');
      expect(line, locale).not.toMatch(/example\.(com|org|net)|team\.|\.(com|org|net|io|dev|app|kr)\b/);
      // a plain word, with nothing in it any shell gives a meaning to (so no shell reads a file, runs a command or expands a variable) …
      expect(line, locale).toMatch(/^[A-Za-z0-9 :/._=-]+$/);
      // … that the host refuses BEFORE it writes or restarts anything: the host's own rule («a DNS name with at least one dot, https only», `parsePublicOrigin` → exit 2; the same rule as `publicHostOf`, which a test holds
      // equal to the host's) — checked here with the web's copy of the rule, and by hand against the host's own `parsePublicOrigin` (the PR says so)
      const address = /https:\/\/\S+/.exec(line)?.[0] ?? '';
      expect(publicHostOf({ SPRINTABLE_PUBLIC_ORIGIN: address } as unknown as NodeJS.ProcessEnv), `${locale}: ${address}`).toBeNull();
      expect(publicHostOf({ SPRINTABLE_PUBLIC_ORIGIN: address.toLowerCase() } as unknown as NodeJS.ProcessEnv)).toBeNull();
      expect(publicHostOf({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' } as unknown as NodeJS.ProcessEnv)).toBe('team.example.com'); // (the rule itself still accepts a real name)
    }
  });

  it('once an address is given the card is the pair command again (an address wins over pending)', async () => {
    await render({ serverHostOrigin: 'https://team.example.com', serverHostPending: true } as never);
    expect(text('onboarding-first-server-host-card-command')).toBe('mkdir -p ~/work && sprintable-host pair --folder ~/work --server https://team.example.com');
    expect(has('onboarding-first-server-host-card-pending-note')).toBe(false);
  });

  it('pending false and no address: exactly the Mac screen it was', async () => {
    await render({ serverHostOrigin: null, serverHostPending: false } as never);
    expect(has('onboarding-first-mac')).toBe(true);
    expect(has('onboarding-first-server-host')).toBe(false);
  });
});

describe('[SID:5024 AC4] the form carries the address to the first screen', () => {
  it('onboarding-form.tsx hands `serverHostOrigin` to <FirstScreen> (the form\'s own test would need the whole sign-up path: the pass-through is pinned in the source)', () => {
    const src = readFileSync(join(__dirname, 'onboarding-form.tsx'), 'utf8');
    const first = /<FirstScreen\b[^>]*>/.exec(src)?.[0] ?? '';
    expect(first).toContain('serverHostOrigin={serverHostOrigin}');
    expect(first).toContain('serverHostPending={serverHostPending}'); // story 5024 F1
  });
});
