// @vitest-environment jsdom
//
// story #2485 — 초대 실패 PLAN_LIMIT_EXCEEDED(EE plan_limits.check_member_invite_limit()가
// 실제로 낸다, 그라운딩 확認)는 분기하고, 나머지는 backend가 generic HTTP상태만 준다 —
// raw 서버 message 노출 대신 고정 문구인지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OrgMembersSection } from './org-members-section';
import koMessages from '../../../messages/ko.json';

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountAndInvite(inviteResponse: { ok: boolean; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/org-members') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/organizations/org-1/invites' && (!init || init.method === undefined)) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/organizations/org-1/invites' && init?.method === 'POST') {
      return { ok: inviteResponse.ok, json: async () => inviteResponse.body };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
  await flush();

  const emailInput = Array.from(container.querySelectorAll('input')).find((i) => i.placeholder === 'email@example.com') as HTMLInputElement;
  await act(async () => { setNativeValue(emailInput, 'new@example.com'); });
  const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '초대');
  await act(async () => { inviteBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('OrgMembersSection — error.code 분기 (story #2485)', () => {
  it('PLAN_LIMIT_EXCEEDED — raw 영문 대신 번역 문구', async () => {
    await mountAndInvite({
      ok: false,
      body: { error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'member', limit: 3, message: 'Free plan member limit (3) reached.' } },
    });
    expect(container.textContent).not.toContain('Free plan member limit');
    expect(container.textContent).toContain(koMessages.settings.memberLimitExceededError.replace('{limit}', '3'));
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await mountAndInvite({
      ok: false,
      body: { error: { code: 'CONFLICT', message: 'Email already a member of this organization' } },
    });
    expect(container.textContent).not.toContain('Email already a member');
    expect(container.textContent).toContain(koMessages.settings.memberInviteFailed);
  });
});
