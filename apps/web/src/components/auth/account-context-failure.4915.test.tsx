// @vitest-environment jsdom
//
// story 4915 — the screen the authenticated layout hands back when it could not read the account (rejected request · 5xx): the retry button asks the server again, the sign-in is only a secondary link,
// and the copy is the app's existing error copy (no new words).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { AccountContextFailure } = await import('@/components/auth/account-context-failure');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AccountContextFailure', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    refresh.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('shows the app\'s error copy, a retry button that refreshes the page data, and the sign-in as a secondary link', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AccountContextFailure /></NextIntlClientProvider>);
    });
    const common = (koMessages as { common: { error: string; errorDescription: string; retry: string; login: string } }).common;
    expect(container.textContent).toContain(common.error);
    expect(container.textContent).toContain(common.errorDescription);
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === common.retry)!;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    expect(refresh).toHaveBeenCalledTimes(1);
    const signIn = [...container.querySelectorAll('a')].find((a) => a.textContent === common.login)!;
    expect(signIn.getAttribute('href')).toBe('/login');
  });
});
