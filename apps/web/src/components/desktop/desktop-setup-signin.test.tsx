// @vitest-environment jsdom
// story 4658 (Kadir 5046 ①): the sign-in band is drawn — the sentence and each runtime's own command on its own line; nothing for none
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { SignInBand } from './desktop-setup-progress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(runtimes: Parameters<typeof SignInBand>[0]['runtimes'], locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC"><SignInBand runtimes={runtimes} /></NextIntlClientProvider>);
  });
  return host;
}

describe('[SID:4658] the sign-in band is drawn', () => {
  it('claude: the sentence, and «claude auth login» on its own line', async () => {
    const h = await draw(['claude']);
    const band = h.querySelector('[data-testid="setup-agent-sign-in"]');
    expect(band, 'the band is drawn').not.toBeNull();
    expect(band!.querySelector('p')!.textContent).toBe('에이전트에 로그인돼 있지 않아요 — 이 명령으로 로그인해 주세요');
    expect([...band!.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['claude auth login']);
  });

  it('codex: «codex login»; both runtimes: each command, in the order given', async () => {
    let h = await draw(['codex']);
    expect([...h.querySelectorAll('[data-testid="setup-agent-sign-in"] code')].map((c) => c.textContent)).toEqual(['codex login']);
    h = await draw(['claude', 'codex']);
    expect([...h.querySelectorAll('[data-testid="setup-agent-sign-in"] code')].map((c) => c.textContent)).toEqual(['claude auth login', 'codex login']);
  });

  it('English: the English sentence with the same command', async () => {
    const h = await draw(['codex'], 'en');
    expect(h.querySelector('[data-testid="setup-agent-sign-in"] p')!.textContent).toBe("The agent isn't signed in — sign in with this command");
  });

  it('none → nothing is drawn: no band, no command', async () => {
    const h = await draw([]);
    expect(h.querySelector('[data-testid="setup-agent-sign-in"]')).toBeNull();
    expect(h.querySelector('code')).toBeNull();
  });
});
