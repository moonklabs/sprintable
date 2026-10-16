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
      <OnboardingForm todayHref="/today" chatsHref="/chats" />
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

// story 4715: no name field — arrival reads who the person is and their invites (none), then sends the organization itself
function arrivalAnswer(url: string): Response | null {
  if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null } }) } as Response;
  if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) } as Response; // the backend's one shape (no envelope)
  return null;
}

async function arrive() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

function planLimitFetchStub(url: string) {
  const a = arrivalAnswer(url);
  if (a) return a;
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
    await arrive();

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
    await arrive();

    expect(document.body.textContent).toContain('The free plan allows up to 1 organization');
    expect(document.body.querySelector('a[href="/dashboard/settings"]')).not.toBeNull();
  });

  it('limit이 1이 아닌 값이면 그 값 그대로 보간된다(하드코딩 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
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
    await arrive();

    expect(document.body.textContent).toContain('3개');
  });

  it('다른 402/코드는 기존 일반 에러 배너로 가고, UpgradeModal은 안 뜬다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
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
    await arrive();

    // story #2484 — 유나 design:changes(2026-08-06): 이 폴백은 raw 서버 message를 그대로
    // 노출했었다(같은 병). 지금은 generic 번역 문구로 간다 — raw는 절대 안 보여야 한다.
    expect(container.textContent).not.toContain('Slug already exists');
    // story #3901 — 리터럴 재-pin 대신 ko.json 값을 읽어 대조.
    expect(container.textContent).toContain(koMessages.onboarding.createOrgFailed);
    expect(document.body.querySelector('a[href="/dashboard/settings"]')).toBeNull();
  });
});
