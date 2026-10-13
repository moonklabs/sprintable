// @vitest-environment jsdom
//
// story 4669 (U6 · AC2) — the organization step has no slug field. Before (story #2750) a Korean-only name derived no slug
// and the button sat disabled behind a hint; now the name alone is enough and the server derives the slug
// (org_project_create.py: the ASCII part, or `workspace-<8 hex>`, made unique — the app way's one screen has used it since
// 4427). Reverted (the slug field and its `slug:` in the body back) → the second input reappears / the body carries `slug`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(locale: 'ko' | 'en') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      <OnboardingForm todayHref="/today" chatsHref="/chats" />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true } }) };
    if (url === '/api/auth/refresh') return { ok: true, json: async () => ({}) };
    if (url === '/api/organizations') {
      return { ok: true, json: async () => ({ data: { id: 'org-korean-1', slug: 'workspace-3f9a1c2b' } }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

describe.each([
  ['ko', koMessages] as const,
  ['en', enMessages] as const,
])('[SID:4669] OnboardingForm — no slug field · the name alone makes the organization (locale=%s)', (locale, messages) => {
  it('one text input only · no slug label · a Korean-only name enables [조직 만들기] with no hint', async () => {
    await act(async () => { root.render(wrap(locale)); });
    await flush();

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs).toHaveLength(1); // reverted → 2 (name · slug)
    expect(container.textContent).not.toContain('URL');
    expect(container.textContent).not.toContain('slug');

    await act(async () => { setNativeValue(inputs[0]!, '문클랩스'); });
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === messages.onboarding.createOrg);
    expect(createBtn?.disabled).toBe(false);
  });

  it('POST /api/organizations carries the name only — the slug is the server\'s (the same rule as the app way)', async () => {
    await act(async () => { root.render(wrap(locale)); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, '문클랩스'); });
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === messages.onboarding.createOrg);
    await act(async () => { createBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const orgCall = vi.mocked(fetch).mock.calls.find((c) => c[0] === '/api/organizations');
    expect(orgCall).not.toBeUndefined();
    expect(JSON.parse((orgCall![1] as RequestInit).body as string)).toEqual({ name: '문클랩스' }); // reverted → has `slug`
    // and on to the fork (4668)
    expect(container.querySelector('h1')?.textContent).toBe(messages.onboarding.where.title);
  });
});
