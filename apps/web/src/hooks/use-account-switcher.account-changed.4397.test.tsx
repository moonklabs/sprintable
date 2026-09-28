// @vitest-environment jsdom
//
// story #4397 — an account switch (and «log out only this account» with another account left) changes the active account
// without passing /login, so the web tells the native shell `account-changed` before navigating: the shell re-registers its
// push device for the new account. A full logout goes to /login instead, where the shell switches its device off itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { useAccountSwitcher, type Account } from './use-account-switcher';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const events: string[] = [];

const other: Account = { account_id: 'acc-2', name: 'B', email: 'b@x.test', org_name: 'O', avatar_url: null, status: 'inactive' };

function Harness() {
  const acc = useAccountSwitcher('나');
  return (
    <div>
      <button type="button" data-testid="switch" onClick={() => void acc.handleSwitch(other)}>switch</button>
      <button type="button" data-testid="out-this" onClick={() => void acc.handleSignOut('this')}>this</button>
      <button type="button" data-testid="out-all" onClick={() => void acc.handleSignOut('all')}>all</button>
    </div>
  );
}

async function press(id: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

beforeEach(async () => {
  events.length = 0;
  window.ReactNativeWebView = { postMessage: (m: string) => events.push(`post ${JSON.parse(m).type}`) };
  vi.stubGlobal('location', { ...window.location, assign: (to: string) => events.push(`go ${to}`) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness /></NextIntlClientProvider>);
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete window.ReactNativeWebView;
  vi.unstubAllGlobals();
});

function answer(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe('[SID:4397] account-changed to the native shell', () => {
  it('an account switch signals before going to /inbox', async () => {
    answer({ data: { ok: true } });
    await press('switch');
    expect(events).toEqual(['post account-changed', 'go /inbox']);
  });

  it('«log out only this account» with another account left signals before /inbox', async () => {
    answer({ data: { next: 'acc-2' } });
    await press('out-this');
    expect(events).toEqual(['post account-changed', 'go /inbox']);
  });

  it('a full logout goes to /login without the signal (the shell switches its device off there)', async () => {
    answer({ data: { next: null } });
    await press('out-all');
    expect(events).toEqual(['go /login']);
  });
});
