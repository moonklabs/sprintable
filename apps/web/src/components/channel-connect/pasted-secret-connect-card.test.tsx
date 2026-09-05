// @vitest-environment jsdom
//
// story #3450 FE 후속(3653a18c §2 "②발급해서 붙여넣기", PO 確定 2026-09-04 23:13Z·
// 유나 카드 형태 판정 23:20Z) — WordPress·webhook 연결 카드. pin (a)~(e):
// (a) 성공 제출→onConnected 호출 (b) 3개 에러 코드별 인라인 문구 (c) owner-or-admin
// 아니면 폼 자체 비노출(버튼 없이 사유 한 줄) (d) 제출 성공 후 secret 필드 값이
// 아무 데도 안 남는지(§2 "다시 못 봄") (e) 문구="OO 연결"("만들기" 아님)·도움말
// 두 줄(필드 위=출처, 필드 아래=재입력 원칙).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { PastedSecretConnectCard } from './pasted-secret-connect-card';

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

function TestHarness({ channel, isOwner, onConnected }: { channel: string; isOwner: boolean; onConnected: () => void }) {
  const t = useTranslations('channelConnect');
  return <PastedSecretConnectCard channel={channel} orgId="org-1" isOwner={isOwner} onConnected={onConnected} t={t} />;
}

describe('PastedSecretConnectCard(story #3450 FE 후속)', () => {
  it('⭐(c) owner-or-admin이 아니면 폼/버튼 자체가 안 그려지고 사유 한 줄만', async () => {
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner={false} onConnected={vi.fn()} />)); });
    await flush();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid^="channel-connect-pasted-secret-form-"]')).toBeNull();
    // story #3504 — 붙여넣기 연결 생성은 owner|admin 폭이라 owner·admin 문구가 맞다.
    expect(container.textContent).toContain(koMessages.channelConnect.channelOwnerOrAdminOnlyReason);
  });

  it('필드를 다 채우기 전에는 제출 버튼이 비활성', async () => {
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={vi.fn()} />)); });
    await flush();
    const openBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-submit-wordpress"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    const siteUrlInput = container.querySelector('#wordpress-site_url') as HTMLInputElement;
    const usernameInput = container.querySelector('#wordpress-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#wordpress-app_password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    // React controlled input는 순수 .value 대입으론 onChange가 안 붙는다 — 네이티브
    // setter로 값을 밀어넣고 input 이벤트를 직접 디스패치한다.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(siteUrlInput, 'https://blog.example.com'); siteUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(usernameInput, 'admin'); usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passwordInput, 'app-pw'); passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(submitBtn.disabled).toBe(false);
  });

  async function fillAndSubmitWordpress() {
    const openBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const siteUrlInput = container.querySelector('#wordpress-site_url') as HTMLInputElement;
    const usernameInput = container.querySelector('#wordpress-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#wordpress-app_password') as HTMLInputElement;
    await act(async () => {
      setter.call(siteUrlInput, 'https://blog.example.com'); siteUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(usernameInput, 'admin'); usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passwordInput, 'app-pw'); passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-submit-wordpress"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    return { passwordInput };
  }

  it('⭐(a) 성공 제출 — onConnected 호출·폼이 닫힌다', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(201, { data: { id: 'c1', channel: 'wordpress' } }));
    const onConnected = vi.fn();
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={onConnected} />)); });
    await flush();

    await fillAndSubmitWordpress();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-form-wordpress"]')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/channel-connections/wordpress',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('⭐(d) 성공 뒤에도 실패 뒤에도 secret 필드 값이 폼에 남지 않는다("다시 못 봄")', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(201, { data: { id: 'c1' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={vi.fn()} />)); });
    await flush();
    await fillAndSubmitWordpress();
    // 성공 뒤 폼 자체가 닫히므로(=values state가 리마운트로도 안 남는다) 재오픈해서 확인.
    const reopenBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]') as HTMLButtonElement;
    await act(async () => { reopenBtn.click(); });
    await flush();
    const passwordInput = container.querySelector('#wordpress-app_password') as HTMLInputElement;
    expect(passwordInput.value).toBe('');

    // 실패 케이스 — 폼은 열린 채로 남으므로 그 자리에서 직접 값 잔존을 확인.
    fetchWithAuthMock.mockResolvedValue(jsonResponse(422, { error: { code: 'WORDPRESS_FIELDS_REQUIRED' } }));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const siteUrlInput = container.querySelector('#wordpress-site_url') as HTMLInputElement;
    const usernameInput = container.querySelector('#wordpress-username') as HTMLInputElement;
    await act(async () => {
      setter.call(siteUrlInput, 'https://blog.example.com'); siteUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(usernameInput, 'admin'); usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passwordInput, 'app-pw-2'); passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const submitBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-submit-wordpress"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    const passwordInputAfterFail = container.querySelector('#wordpress-app_password') as HTMLInputElement;
    expect(passwordInputAfterFail.value).toBe('');
  });

  it('⭐(b) 422 WORDPRESS_FIELDS_REQUIRED — 인라인 문구', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(422, { error: { code: 'WORDPRESS_FIELDS_REQUIRED' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={vi.fn()} />)); });
    await flush();
    await fillAndSubmitWordpress();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(koMessages.channelConnect.channelConnectErrorWordpressFieldsRequired);
  });

  it('⭐(b) 422 CHANNEL_CONNECTION_DESTINATION_INSECURE — 인라인 문구(원문 노출 안 함)', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(422, { error: { code: 'CHANNEL_CONNECTION_DESTINATION_INSECURE', message: 'loopback address rejected' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={vi.fn()} />)); });
    await flush();
    await fillAndSubmitWordpress();
    const alertText = container.querySelector('[role="alert"]')?.textContent;
    expect(alertText).toBe(koMessages.channelConnect.channelConnectErrorDestinationInsecure);
    expect(alertText).not.toContain('loopback');
  });

  it('⭐(e) 문구="WordPress 연결"("연결 만들기" 아님) · 도움말 두 줄(필드 위=출처, 아래=재입력 원칙)', async () => {
    await act(async () => { root.render(wrap(<TestHarness channel="wordpress" isOwner onConnected={vi.fn()} />)); });
    await flush();

    const toggleBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]') as HTMLButtonElement;
    expect(toggleBtn.textContent).toBe(koMessages.channelConnect.channelConnectPastedSecretAction.replace('{channel}', 'WordPress'));
    expect(toggleBtn.textContent).not.toContain('만들기');

    await act(async () => { toggleBtn.click(); });
    await flush();

    const hint = container.querySelector('[data-testid="channel-connect-pasted-secret-hint-wordpress"]');
    expect(hint?.textContent).toBe(koMessages.channelConnect.channelConnectPastedSecretHintWordpress);
    const rewriteNote = container.querySelector('[data-testid="channel-connect-pasted-secret-rewrite-note-wordpress"]');
    expect(rewriteNote?.textContent).toBe(koMessages.channelConnect.channelConnectPastedSecretRewriteNote);
    // 필드 위/아래 순서 — hint가 첫 필드 label보다 앞서고, rewrite-note가 마지막 필드보다 뒤에 온다.
    const form = container.querySelector('[data-testid="channel-connect-pasted-secret-form-wordpress"]')!;
    const order = Array.from(form.children).map((el) => el.getAttribute('data-testid') ?? el.tagName);
    expect(order.indexOf('channel-connect-pasted-secret-hint-wordpress')).toBeLessThan(order.indexOf('channel-connect-pasted-secret-rewrite-note-wordpress'));
  });

  it('⭐(b) webhook 채널 — 403 CHANNEL_CONNECTION_HUMAN_ONLY는 제네릭 폴백(방어적 pass-through)', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(403, { error: { code: 'CHANNEL_CONNECTION_HUMAN_ONLY' } }));
    await act(async () => { root.render(wrap(<TestHarness channel="webhook" isOwner onConnected={vi.fn()} />)); });
    await flush();

    const openBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-button-webhook"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const targetUrlInput = container.querySelector('#webhook-target_url') as HTMLInputElement;
    const secretInput = container.querySelector('#webhook-secret') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    await act(async () => {
      setter.call(targetUrlInput, 'https://hook.example.com'); targetUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(secretInput, 'shh'); secretInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const submitBtn = container.querySelector('[data-testid="channel-connect-pasted-secret-submit-webhook"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(koMessages.channelConnect.channelConnectErrorGeneric);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/channel-connections/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
