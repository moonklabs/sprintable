// @vitest-environment jsdom
//
// story #2750 — 디디 라이브 재현(2748 재실측, 2026-08-18): 온보딩 1/4에서 조직 이름을
// 한국어로만 입력(예: 「우리팀」)하면 handleOrgNameChange의 자동 slug 파생 정규식
// (`[^a-z0-9\s-]` 제거)이 한글을 전부 걸러내 orgSlug가 빈 문자열로 남는다. 그 상태에서
// 「조직 만들기」 버튼이 disabled인데 왜 막혔는지 화면에 안내가 0이었다(무설명 disabled) —
// 한국 시장 제품의 온보딩 첫 화면 이탈 직결. 실제로 폼을 마운트하고 한글만 입력해
// 안내 문구가 뜨는지·수동 slug 입력으로 막힘이 풀리는지를 단언한다.

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
      <OnboardingForm />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
    if (url === '/api/organizations') {
      return { ok: true, json: async () => ({ data: { id: 'org-korean-1', slug: 'woorim' } }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe.each([
  ['ko', koMessages] as const,
  ['en', enMessages] as const,
])('OnboardingForm — 한국어 조직명 slug 자동파생 실패 안내 (story #2750, locale=%s)', (locale, messages) => {
  it('한글만으로 조직명을 입력하면 slug가 비고, 무설명이 아니라 안내 문구가 뜨며, 버튼은 disabled 유지', async () => {
    await act(async () => { root.render(wrap(locale)); });

    const [nameInput, slugInput] = [...container.querySelectorAll('input')] as HTMLInputElement[];
    await act(async () => { setNativeValue(nameInput, '우리팀'); });

    expect(slugInput.value).toBe(''); // 자동 파생이 한글을 전부 걸러내 빈 값
    expect(container.textContent).toContain(messages.onboarding.slugManualRequired);

    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === messages.onboarding.createOrg);
    expect(createBtn?.disabled).toBe(true);
  });

  it('안내를 따라 slug를 직접 입력하면 막힘이 풀려 조직 생성까지 완주한다', async () => {
    await act(async () => { root.render(wrap(locale)); });

    const [nameInput, slugInput] = [...container.querySelectorAll('input')] as HTMLInputElement[];
    await act(async () => { setNativeValue(nameInput, '우리팀'); });
    await act(async () => { setNativeValue(slugInput, 'woorim'); });

    expect(container.textContent).not.toContain(messages.onboarding.slugManualRequired);

    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === messages.onboarding.createOrg);
    expect(createBtn?.disabled).toBe(false);

    await act(async () => { createBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const fetchMock = vi.mocked(fetch);
    const orgCall = fetchMock.mock.calls.find((c) => c[0] === '/api/organizations');
    expect(orgCall).not.toBeUndefined();
    expect(JSON.parse((orgCall![1] as RequestInit).body as string)).toEqual({ name: '우리팀', slug: 'woorim' });
  });
});
