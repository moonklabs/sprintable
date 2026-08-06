// @vitest-environment jsdom
//
// story #2470 — 미르코 라이브 재현(2026-08-06): Free plan 계정이 새 조직 생성 時 raw 영문
// `Free plan org limit (1) reached. Upgrade to Team or Pro.`가 그대로 노출됐다. BE는 이미
// 구조화 에러(code:PLAN_LIMIT_EXCEEDED·limit·upgrade_required)를 주는데 FE가 그 code로 안
// 갈라 raw message를 그대로 찍은 게 원인(#2441과 동일 클래스). 소스매칭이 아니라 실제로 폼을
// 마운트하고 fetch를 스텁해 UpgradeModal이 실제로 뜨는지·raw 영문이 안 뜨는지를 단언한다.

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function fillOrgForm() {
  const nameInput = container.querySelector('input') as HTMLInputElement;
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setNative.call(nameInput, 'Test Org');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button'));
  return btns.find((b) => /조직 만들기|Create Organization/.test(b.textContent ?? '')) as HTMLButtonElement;
}

function planLimitFetchStub(url: string) {
  if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
  if (url === '/api/organizations') {
    return {
      ok: false,
      status: 402,
      json: async () => ({
        data: null,
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Free plan org limit (1) reached. Upgrade to Team or Pro.',
          resource: 'org', limit: 1, tier: 'free', upgrade_required: true,
        },
        meta: null,
      }),
    } as Response;
  }
  throw new Error('unexpected fetch: ' + url);
}

describe('OnboardingForm — PLAN_LIMIT_EXCEEDED (story #2470)', () => {
  it('ko: code로 분기해 UpgradeModal(한국어 안내+업그레이드 버튼)을 실제로 렌더한다 — raw 영문 노출 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => planLimitFetchStub(url)));

    await act(async () => { root.render(wrap('ko')); });
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // ⚠️UpgradeModal은 base-ui Dialog(portal)라 container 밖 document.body에 렌더된다
    // (E-UI-DAEGBYEON P1-01 교훈 — "base-ui Dialog portal은 document.body 렌더"). container만
    // 보면 항상 실패하는 게 실제로 처음 겪은 함정이라 여기 박아둔다.
    // #2470에서 실제로 겪은 raw 영문 원문이 화면에 그대로 노출되면 안 된다.
    expect(document.body.textContent).not.toContain('Free plan org limit (1) reached');
    expect(document.body.textContent).not.toContain('Upgrade to Team or Pro');
    expect(document.body.textContent).toContain('무료 플랜');
    expect(document.body.textContent).toContain('1개');
    expect(document.body.textContent).toContain('업그레이드');
    const upgradeLink = document.body.querySelector('a[href="/dashboard/settings"]');
    expect(upgradeLink).not.toBeNull();
  });

  it('en: 같은 code에 대해 영문 UpgradeModal을 렌더한다(en/ko 정합)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => planLimitFetchStub(url)));

    await act(async () => { root.render(wrap('en')); });
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('The free plan allows up to 1 organization');
    expect(document.body.querySelector('a[href="/dashboard/settings"]')).not.toBeNull();
  });

  it('limit이 1이 아닌 값이면 그 값 그대로 보간된다(하드코딩 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false, status: 402,
          json: async () => ({ data: null, error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'x', limit: 3, upgrade_required: true }, meta: null }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('3개');
  });

  it('다른 402/코드는 기존 일반 에러 배너로 가고, UpgradeModal은 안 뜬다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false, status: 409,
          json: async () => ({ data: null, error: { code: 'CONFLICT', message: 'Slug already exists' }, meta: null }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('Slug already exists');
    expect(document.body.querySelector('a[href="/dashboard/settings"]')).toBeNull();
  });
});
