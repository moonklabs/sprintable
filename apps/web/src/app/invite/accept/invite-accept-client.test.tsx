// @vitest-environment jsdom
//
// story #2484 — 초대 수락 실패가 error.code 분기 없이 json.error?.message(raw 서버 영문)를
// 그대로 노출하던 자리. invite/page.tsx의 acceptInvite와 같은 shared helper
// (inviteErrorMessage)를 재사용한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { InviteAcceptClient } from './invite-accept-client';
import koMessages from '../../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mountAndAccept(fetchImpl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <InviteAcceptClient token="tok-1" orgName="뭉클랩" role="member" email="a@b.com" projects={[]} />
      </NextIntlClientProvider>,
    );
  });
  const acceptBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.invite.accept);
  await act(async () => {
    acceptBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

describe('InviteAcceptClient — error.code 분기 (story #2484)', () => {
  it('HTTP_410(만료) — raw 영문 대신 번역 문구', async () => {
    await mountAndAccept(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'HTTP_410', message: 'Invite has expired' } }),
    }));
    expect(container.textContent).not.toContain('Invite has expired');
    expect(container.textContent).toContain(koMessages.invite.inviteExpired);
  });

  it('FORBIDDEN(이메일 불일치) — raw 영문 대신 번역 문구', async () => {
    await mountAndAccept(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'FORBIDDEN', message: 'Email does not match invite' } }),
    }));
    expect(container.textContent).not.toContain('Email does not match invite');
    expect(container.textContent).toContain(koMessages.invite.inviteEmailMismatch);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await mountAndAccept(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    }));
    expect(container.textContent).not.toContain('brand new raw string');
    expect(container.textContent).toContain(koMessages.invite.acceptFailed);
  });
});

// story #2576 — #2575 가드(verify-tint-foreground-contrast/-bg)가 드러낸 라이트 AA 미달
// (text-success/text-destructive on -bg = 4.20/4.30, AA 4.5 미달)의 사용처 회귀가드.
// text-foreground로 바뀐 뒤에도 -bg 배경(status 정체성)은 그대로 유지되는지까지 함께 본다.
describe('InviteAcceptClient — story #2576 AA 수리(계열색 텍스트 대신 text-foreground)', () => {
  it('실패 상태 — text-destructive가 아니라 text-foreground를 쓴다(bg-destructive-bg는 유지)', async () => {
    await mountAndAccept(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'HTTP_410', message: 'Invite has expired' } }),
    }));
    const resultBox = container.querySelector('.bg-destructive-bg');
    expect(resultBox).not.toBeNull();
    expect(resultBox!.className).toContain('text-foreground');
    expect(resultBox!.className).not.toContain('text-destructive ');
    expect(resultBox!.className.endsWith('text-destructive')).toBe(false);
  });

  it('성공 상태 — text-success가 아니라 text-foreground를 쓴다(bg-success-bg는 유지)', async () => {
    await mountAndAccept(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const resultBox = container.querySelector('.bg-success-bg');
    expect(resultBox).not.toBeNull();
    expect(resultBox!.className).toContain('text-foreground');
    expect(resultBox!.className).not.toContain('text-success ');
    expect(resultBox!.className.endsWith('text-success')).toBe(false);
  });
});
