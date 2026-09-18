// @vitest-environment jsdom
//
// story #2470 — 실측(2026-08-06): 이 다이얼로그의 PLAN_LIMIT_EXCEEDED 감지가
// `json.detail?.code`를 봤는데, 실제 응답 envelope은 `{error:{code,...}}`다(BE
// HTTPException(detail=...)이 exception handler를 거쳐 `error`로 재포장된다 — 직접
// `/api/organizations` 라이브 호출로 확認). `json.detail`은 실제 응답에 없는 필드라 이
// 분기가 항상 죽어있었고, 한도 초과여도 매번 raw `error.message`(영문) 폴백으로 샜다.
// 소스매칭(코드가 "있는지")만으론 이 결함이 안 잡힌다 — 실제로 마운트해 배너가 뜨는지 본다.
//
// story #2470 후속(유나 홀름 design:changes) — 한도 배너 문구가 하드코딩 영한혼용
// ("Free 플랜 Organization 한도 초과")이었다가 온보딩 wizard와 같은 i18n 키
// (`onboarding.orgLimitExceededError`)를 공유하도록 정정 — useTranslations를 쓰므로
// NextIntlClientProvider 없이 마운트하면 "context ... was not found"로 즉시 죽는다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CreateOrganizationDialog } from './create-organization-dialog';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

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

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(locale: 'ko' | 'en' = 'ko') {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const messages = locale === 'ko' ? koMessages : enMessages;
  // Dialog(base-ui)는 body에 portal되므로 container 밖(document.body)에서 내용을 찾는다
  // (create-organization-dialog는 <Dialog open> 자체가 portal 루트라 여기서도 동일 함정).
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <CreateOrganizationDialog open onOpenChange={onOpenChange} onCreated={onCreated} />
      </NextIntlClientProvider>,
    );
  });
  return { onOpenChange, onCreated };
}

async function fillAndSubmit() {
  const nameInput = document.body.querySelector('#org-name') as HTMLInputElement;
  await act(async () => { setNativeValue(nameInput, 'Test Org'); });
  const form = document.body.querySelector('form') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('CreateOrganizationDialog — PLAN_LIMIT_EXCEEDED envelope (story #2470)', () => {
  it('실제 응답 envelope({error:{code}})으로 한도 배너가 실제로 뜬다 — raw 영문 message 노출 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
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
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).not.toContain('Free plan org limit (1) reached');
    expect(document.body.textContent).toContain(koMessages.nav.orgLimitBannerTitle);
    expect(document.body.textContent).toContain(koMessages.onboarding.orgLimitExceededError.replace('{limit}', '1'));
    expect(document.body.querySelector('a[href="/settings?tab=billing"]')).not.toBeNull();
  });

  it('구 shape({detail:{code}})로 응답이 와도(과거 BE) 여전히 배너가 뜬다 — 하위호환 폴백', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ detail: { code: 'PLAN_LIMIT_EXCEEDED', message: 'x' } }),
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).toContain(koMessages.nav.orgLimitBannerTitle);
    expect(document.body.textContent).toContain(koMessages.onboarding.orgLimitExceededError.replace('{limit}', '1'));
  });

  it('다른 에러는 기존 일반 배너로 간다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ data: null, error: { code: 'CONFLICT', message: 'Slug already exists' }, meta: null }),
    })));

    await mount();
    await fillAndSubmit();

    // story #2484 — CONFLICT(=슬러그 중복)도 이제 code로 분기해 raw 영문 대신 번역 문구를
    // 쓴다(이전엔 여기서 raw message가 그대로 노출됐음 — 회귀가드 겸함).
    expect(document.body.textContent).not.toContain('Slug already exists');
    expect(document.body.textContent).toContain(koMessages.nav.createOrgSlugTaken);
    expect(document.body.textContent).not.toContain(koMessages.nav.orgLimitBannerTitle);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출 (story #2484)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ data: null, error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' }, meta: null }),
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).not.toContain('brand new raw string');
    expect(document.body.textContent).toContain(koMessages.nav.createOrgGenericError);
  });

  it('en locale에선 영문 배너로 렌더된다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({
        data: null,
        error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'x', limit: 1, upgrade_required: true },
        meta: null,
      }),
    })));

    await mount('en');
    await fillAndSubmit();

    expect(document.body.textContent).toContain('Upgrade required');
    expect(document.body.textContent).toContain('The free plan allows up to 1 organization');
  });
});

// story #2482 — 카디르가 #2861 QA 때 플래그한 잔여: 제목/라벨/버튼/에러문구가 하드코딩
// 영한혼용이었다("새 Organization 만들기"·"이름"·"취소" 등, i18n 키 없이 리터럴). 순수
// 문자열 i18n화(다이얼로그 로직 무변경) — 기존 nav.switcher* 키를 재사용(사이드바 스위처의
// "새 조직 만들기" 트리거와 같은 개념이라 새 키 대신 공유, #2470 fold-in과 동일 원칙)하고
// 나머지 필드는 신규 키.
describe('CreateOrganizationDialog — i18n (story #2482)', () => {
  it('ko locale: 제목·라벨·placeholder·버튼이 전부 한국어로 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await mount('ko');

    expect(document.body.textContent).toContain('새 조직 만들기');
    // story #3910 — 리터럴 재-pin 대신 ko.json 값을 읽어 대조(온보딩 폼과 낱말 통일 후).
    expect(document.body.textContent).toContain(koMessages.nav.createOrgNameLabel);
    expect(document.body.textContent).toContain(koMessages.nav.createOrgSlugLabel);
    expect(document.body.textContent).toContain('취소');
    expect(document.body.textContent).toContain('만들기');
    const nameInput = document.body.querySelector('#org-name') as HTMLInputElement;
    expect(nameInput.placeholder).toBe(koMessages.nav.createOrgNamePlaceholder);
    const slugInput = document.body.querySelector('#org-slug') as HTMLInputElement;
    expect(slugInput.placeholder).toBe(koMessages.nav.createOrgSlugPlaceholder);
  });

  it('en locale: 제목·라벨·placeholder·버튼이 전부 영문으로 렌더된다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await mount('en');

    expect(document.body.textContent).toContain('Create new organization');
    // story #3910 — 리터럴 재-pin 대신 en.json 값을 읽어 대조(온보딩 폼과 낱말 통일 후).
    expect(document.body.textContent).toContain(enMessages.nav.createOrgNameLabel);
    expect(document.body.textContent).toContain('Cancel');
    expect(document.body.textContent).toContain('Create');
    const nameInput = document.body.querySelector('#org-name') as HTMLInputElement;
    expect(nameInput.placeholder).toBe(enMessages.nav.createOrgNamePlaceholder);
  });

  it('slug 형식 에러도 로케일을 따라간다(ko/en)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await mount('ko');
    const slugInput = document.body.querySelector('#org-slug') as HTMLInputElement;
    // handleSlugChange가 [a-z0-9-] 외 문자는 이미 걸러내므로(공백·특수문자), SLUG_REGEX를
    // 실제로 깨는 값은 "시작/끝이 하이픈"류뿐이다.
    await act(async () => { setNativeValue(slugInput, '-bad-'); });
    expect(document.body.textContent).toContain(koMessages.nav.createOrgSlugError);
  });

  it('제출 실패(일반 에러, code 없음)도 i18n 문구로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ data: null, error: {}, meta: null }),
    })));
    await mount('ko');
    await fillAndSubmit();
    expect(document.body.textContent).toContain(koMessages.nav.createOrgGenericError);
  });

  // 양성대조(AC) — 라벨 하나를 하드코딩으로 되돌리면 이 검사가 실제로 빨간불이어야 한다.
  // next-intl은 없는 키를 요청하면 키 이름 그대로를 렌더하므로(throw하지 않음), "제목이
  // t()로 번역된 실제 문구를 담고 있는가"를 직접 확認하는 이 테스트 자체가 그 반례 역할을
  // 한다 — 소스에서 t('switcherNewOrganization') 대신 하드코딩 문자열로 되돌리면 en
  // locale 테스트가 "Create new organization" 대신 한국어를 보게 되어 즉시 깨진다.
  it('양성대조 — 하드코딩 되돌림을 가정: en에서 한국어 문구가 섞이면 실패한다', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await mount('en');
    expect(document.body.textContent).not.toContain('새 조직 만들기');
    expect(document.body.textContent).not.toContain('이름 *');
  });
});

// story #3910(PO 눈 리뷰, 3905 캡처 그라운딩) — 조직 만들기 대화상자(nav.createOrg*)와
// 온보딩 폼(onboarding.orgName/slug*)이 같은 입력(조직 이름·URL 슬러그)을 다른 낱말로
// 부르던 것을 값 통일했다. 두 화면의 값이 다시 갈리면(한쪽만 고치는 재발) 즉시 잡는다.
describe('CreateOrganizationDialog — 대화상자·온보딩 폼 낱말 일치(story #3910 AC2)', () => {
  it('ko: nav.createOrg*와 onboarding.org*/slug*가 값으로 같다', () => {
    expect(koMessages.nav.createOrgNameLabel).toBe(koMessages.onboarding.orgName);
    expect(koMessages.nav.createOrgNamePlaceholder).toBe(koMessages.onboarding.orgNamePlaceholder);
    expect(koMessages.nav.createOrgSlugLabel).toBe(koMessages.onboarding.slug);
    expect(koMessages.nav.createOrgSlugPlaceholder).toBe(koMessages.onboarding.slugPlaceholder);
  });

  it('en: nav.createOrg*와 onboarding.org*/slug*가 값으로 같다', () => {
    expect(enMessages.nav.createOrgNameLabel).toBe(enMessages.onboarding.orgName);
    expect(enMessages.nav.createOrgNamePlaceholder).toBe(enMessages.onboarding.orgNamePlaceholder);
    expect(enMessages.nav.createOrgSlugLabel).toBe(enMessages.onboarding.slug);
    expect(enMessages.nav.createOrgSlugPlaceholder).toBe(enMessages.onboarding.slugPlaceholder);
  });

  // 양성대조 — 한쪽만 바꾸면(다이얼로그 재-드리프트) RED가 된다는 것을 실제로 증명한다.
  it('양성대조 — nav.createOrgSlugLabel만 되돌리면(값 갈림) RED가 된다', () => {
    const mutatedNav = { ...koMessages.nav, createOrgSlugLabel: 'Slug' };
    expect(mutatedNav.createOrgSlugLabel).not.toBe(koMessages.onboarding.slug);
  });

  // 무관 PR no-op — 이 4쌍과 무관한 다른 nav/onboarding 값 불일치는 이 가드가 안 본다.
  it('무관 PR no-op — 다른 nav/onboarding 키 쌍(switcherNewOrganization 등)은 이 가드 밖이다', () => {
    expect(koMessages.nav.switcherNewOrganization).not.toBe(koMessages.onboarding.welcome);
  });
});
