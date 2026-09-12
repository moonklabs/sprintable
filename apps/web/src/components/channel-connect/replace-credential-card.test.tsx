// @vitest-environment jsdom
//
// story #3816 CHANGES 3(유나 판정 issuecomment-5645662831·PO 確定 2026-09-12) —
// pasted-secret-connect-card.test.tsx와 동형 관례. blanket 리셋 폐기 회귀: 오류
// 응답 뒤 비-시크릿(wordpress의 username)은 유지·시크릿만 비움 + 포커스.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { focusFieldNameForError, ReplaceCredentialCard } from './replace-credential-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function TestHarness({ channel, connectionId, onReplaced }: { channel: string; connectionId: string; onReplaced: () => void }) {
  const t = useTranslations('channelConnect');
  return (
    <ReplaceCredentialCard
      channel={channel} connectionId={connectionId} secretHint={null} isOwner orgId="org-1"
      onReplaced={onReplaced} t={t}
    />
  );
}

const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('ReplaceCredentialCard — 오류 뒤 비-시크릿 필드 유지(story #3816 CHANGES 3)', () => {
  it('⭐wordpress — 자격교체 실패 뒤 username은 유지·app_password만 비움', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(422, { error: { code: 'WORDPRESS_FIELDS_REQUIRED' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" connectionId="conn-1" onReplaced={vi.fn()} />)); });
    const openBtn = container.querySelector('[data-testid="channel-connect-replace-credential-button-conn-1"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    const usernameInput = container.querySelector('#conn-1-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#conn-1-app_password') as HTMLInputElement;
    await fill(usernameInput, 'admin');
    await fill(passwordInput, 'app-pw');

    const submitBtn = container.querySelector('[data-testid="channel-connect-replace-credential-submit-conn-1"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(usernameInput.value).toBe('admin');
    expect(passwordInput.value).toBe('');
  });

  it('⭐ghost — GHOST_ADMIN_KEY_INVALID 뒤 admin_api_key로 포커스', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(422, { error: { code: 'GHOST_ADMIN_KEY_INVALID' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="ghost" connectionId="conn-2" onReplaced={vi.fn()} />)); });
    const openBtn = container.querySelector('[data-testid="channel-connect-replace-credential-button-conn-2"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    const keyInput = container.querySelector('#conn-2-admin_api_key') as HTMLInputElement;
    await fill(keyInput, 'fake-key');

    const submitBtn = container.querySelector('[data-testid="channel-connect-replace-credential-submit-conn-2"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(keyInput.value).toBe('');
    expect(document.activeElement).toBe(keyInput);
  });
});

describe('focusFieldNameForError(replace-credential-card, story #3816 CHANGES 3)', () => {
  const wordpressFields = [
    { name: 'username', labelKey: 'channelConnectFieldUsername', type: 'text' as const, required: false },
    { name: 'app_password', labelKey: 'channelConnectFieldAppPassword', type: 'password' as const, required: true },
  ];

  it('⭐*_FIELDS_REQUIRED — 첫 필수-빈 필드로(선택 필드는 건너뜀)', () => {
    expect(focusFieldNameForError('WORDPRESS_FIELDS_REQUIRED', wordpressFields, { username: '' })).toBe('app_password');
  });

  it('⭐키 오류 — password 필드로', () => {
    expect(focusFieldNameForError('GHOST_ADMIN_KEY_INVALID', wordpressFields, {})).toBe('app_password');
  });

  it('GHOST_SITE_NOT_FOUND — 이 폼엔 site_url 필드가 없어 null(지어내지 않는다)', () => {
    expect(focusFieldNameForError('GHOST_SITE_NOT_FOUND', wordpressFields, {})).toBeNull();
  });
});
