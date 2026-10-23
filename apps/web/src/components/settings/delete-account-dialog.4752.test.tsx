// @vitest-environment jsdom
//
// story #4752 — «계정 삭제» 확인창. 전에는 REAUTHENTICATION_REQUIRED 말고 모든 실패(403 · 500 · 네트워크)에서 말 없이 닫혀, 눌렀는데 지워졌는지 알 수 없었다.
// 지금은 실패마다 이유 한 줄이 뜨고 창은 열려 있다(다시 시도 가능) · 성공(200)과 «이미 없음»(404)만 로그인 화면으로 나간다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DeleteAccountDialog } from './delete-account-dialog';

// the call goes through fetchWithAuth (CI guard: no new raw fetch('/api/*')); this test hands it the answers
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onDeleted = vi.fn();

beforeEach(() => {
  onClose.mockReset();
  onDeleted.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  fetchWithAuthMock.mockReset();
});

async function mount(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DeleteAccountDialog onClose={onClose} onDeleted={onDeleted} />
      </NextIntlClientProvider>,
    );
  });
}

const confirmButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="delete-account-confirm"]')!;
const errorLine = () => document.body.querySelector('[data-testid="delete-account-error"]');

async function press(response: () => Promise<unknown>) {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(response);
  await act(async () => { confirmButton().click(); });
  await act(async () => { await Promise.resolve(); });
}

const answer = (status: number, body?: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} });

describe('[SID:4752] the delete-account confirmation says what happened', () => {
  it('⭐a 500 leaves the dialog open with «삭제하지 못했어요» and the button usable again (was: closed without a word)', async () => {
    await mount();
    await press(answer(500, { error: { code: 'INTERNAL' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    expect(confirmButton().disabled).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('⭐a 403 that is not a re-login request, and a network error, say the same «삭제하지 못했어요»', async () => {
    await mount();
    await press(answer(403, { error: { code: 'FORBIDDEN' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    await press(async () => { throw new Error('offline'); });
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('⭐REAUTHENTICATION_REQUIRED says to sign in again (in the dialog, not a browser alert)', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    await mount();
    await press(answer(403, { error: { code: 'REAUTHENTICATION_REQUIRED' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.reauthRequired);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('⭐a 401 says the session is over', async () => {
    await mount();
    await press(answer(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteSessionEnded);
  });

  it('⭐200 leaves for the login page; no error line (the button stays locked while the page changes)', async () => {
    await mount();
    await press(answer(200, { ok: true }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  it('⭐404 (no such live account — already deleted) leaves for the login page too', async () => {
    await mount();
    await press(answer(404));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
  });

  it('a failure then a retry that succeeds clears the line', async () => {
    await mount();
    await press(answer(500));
    expect(errorLine()).not.toBeNull();
    await press(answer(200, { ok: true }));
    expect(errorLine()).toBeNull();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('the English copy exists and states the immediate sign-out (no «permanently deleted»)', async () => {
    await mount('en');
    await press(answer(500));
    expect(errorLine()?.textContent).toBe(enMessages.settings.deleteFailed);
    expect(document.body.textContent).toContain('signed out of every device right away');
    expect(document.body.textContent).not.toMatch(/permanently/i);
  });

  it('the Korean copy says «바로 로그아웃» and «익명화» — not «영구 삭제» (what the 30-day job really does)', () => {
    expect(koMessages.settings.deleteConfirmDesc).toContain('로그아웃');
    expect(koMessages.settings.deleteConfirmDesc).toContain('익명화');
    expect(koMessages.settings.deleteConfirmDesc).not.toContain('영구 삭제');
    expect(koMessages.settings.deleteAccountDesc).toContain('다시 로그인할 수 없어요');
  });
});
