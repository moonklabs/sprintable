// @vitest-environment jsdom
//
// story #3195(온보딩·FE) — 이메일 인증 왕복(가입 → 1/4 입력 → EMAIL_VERIFICATION_REQUIRED
// 400 → 메일함 링크 → verify-email → 「시작하기」 복귀)이 풀 페이지 네비게이션이라
// OnboardingForm이 통째로 리마운트돼 orgName/orgSlug가 사라졌다(재입력 강요). AC1: 왕복
// 후 복귀 시 1/4 입력값이 sessionStorage draft로 보존돼 있다. AC2: 미인증 상태 안내가
// 제출 전에(마운트 시 /api/auth/me.email_verified===false로) 보인다.
//
// 카디르 QA(PR#3617) 치명 — `/api/me`가 실제로 서빙하는 BE(me.py::get_me, TeamMember
// 필수)는 이 스토리가 겨냥하는 "무 org" 상태에서 404라 email_verified/org_id를 못 읽는다
// (mock 테스트는 실경로를 안 지나 이 갭을 못 잡았음 — PR#3605와 동형 클래스). `/api/auth/
// me`(BFF 신설, BE app.routers.auth.get_auth_me — JWT claims만 읽어 org 유무 무관 항상
// 200)로 교체 — 이 파일의 모든 mock도 그 응답 shape(member_id 포함)로 갱신한다.
//
// codex MED(같은 QA 라운드) — draft 키가 계정-무관 고정 문자열이면 같은 탭 계정 전환 시
// 前 계정 입력이 새 계정 화면에 샌다. member_id로 키잉(uid 확定 後 별도 effect에서
// 복원/저장)해 계정마다 분리한다 — 아래 "계정간 격리" describe가 그 pin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT_PREFIX = 'sp_onboarding_org_draft:';
const UID_A = 'user-aaa';
const UID_B = 'user-bbb';

let container: HTMLDivElement;
let root: Root;

function wrap() {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <OnboardingForm />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function mockFetchDefault(uid: string, overrides: Record<string, () => Promise<unknown>> = {}) {
  return vi.fn(async (url: string) => {
    if (url in overrides) return overrides[url]!();
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
    if (url === '/api/auth/me') {
      return { ok: true, json: async () => ({ data: { member_id: uid, org_id: null, email_verified: true } }) } as Response;
    }
    throw new Error('unexpected fetch: ' + url);
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('OnboardingForm — 1/4 입력값 sessionStorage draft 영속(story #3195 AC1)', () => {
  it('조직명 입력 시 draft가 uid 키로 sessionStorage에 저장된다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A));
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, '새싹상회'); });
    await flush();

    const raw = sessionStorage.getItem(DRAFT_PREFIX + UID_A);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { orgName: string; orgSlug: string };
    expect(parsed.orgName).toBe('새싹상회');
  });

  it('재마운트(=인증 왕복 시뮬레이션) 시 같은 uid의 draft가 복원돼 재입력을 요구하지 않는다', async () => {
    sessionStorage.setItem(DRAFT_PREFIX + UID_A, JSON.stringify({ orgName: '새싹상회', orgSlug: 'saessak-shop' }));
    vi.stubGlobal('fetch', mockFetchDefault(UID_A));
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    expect(nameInput.value).toBe('새싹상회');
    const inputs = container.querySelectorAll('input');
    expect((inputs[1] as HTMLInputElement).value).toBe('saessak-shop');
  });

  it('조직 생성 성공 시 draft를 지운다(더는 필요 없어짐)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A, {
      '/api/organizations': async () => ({ ok: true, json: async () => ({ data: { id: 'org-1' } }) }),
      '/api/auth/refresh': async () => ({ ok: true, json: async () => ({}) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const inputs = container.querySelectorAll('input');
    await act(async () => { setNativeValue(inputs[0] as HTMLInputElement, 'New Org'); });
    await flush();
    expect(sessionStorage.getItem(DRAFT_PREFIX + UID_A)).toBeTruthy();

    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(sessionStorage.getItem(DRAFT_PREFIX + UID_A)).toBeNull();
  });

  it('EMAIL_VERIFICATION_REQUIRED로 실패해도 draft는 그대로 남는다(왕복 중 소실 금지)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A, {
      '/api/organizations': async () => ({
        ok: false, status: 403,
        json: async () => ({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' } }),
      }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const inputs = container.querySelectorAll('input');
    await act(async () => { setNativeValue(inputs[0] as HTMLInputElement, 'New Org'); });
    await flush();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(sessionStorage.getItem(DRAFT_PREFIX + UID_A)).toBeTruthy();
  });
});

describe('OnboardingForm — identityResolved 前 입력 게이팅(유나 design:changes, PR#3617)', () => {
  it('/api/auth/me 미해소 동안 조직명·슬러그 입력이 disabled — 빈 값이 순간이라도 안 채워지는 깜빡임 방지', async () => {
    let resolveMe!: (v: { ok: true; json: () => Promise<unknown> }) => void;
    const mePromise = new Promise<{ ok: true; json: () => Promise<unknown> }>((r) => { resolveMe = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return mePromise;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap()); });

    const inputs = container.querySelectorAll('input');
    expect((inputs[0] as HTMLInputElement).disabled).toBe(true);
    expect((inputs[1] as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      resolveMe({ ok: true, json: async () => ({ data: { member_id: UID_A, org_id: null, email_verified: true } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect((container.querySelectorAll('input')[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('/api/auth/me 조회 실패해도 게이팅이 영영 안 풀리는 게 아니라 해제된다(폼 영구 잠김 방지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/me') throw new Error('network down');
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    expect((container.querySelectorAll('input')[0] as HTMLInputElement).disabled).toBe(false);
  });
});

describe('OnboardingForm — 계정간 draft 격리(codex MED, PR#3617)', () => {
  it('A 계정의 draft가 sessionStorage에 있어도, B 계정으로 마운트하면 B 화면엔 안 새 나간다', async () => {
    sessionStorage.setItem(DRAFT_PREFIX + UID_A, JSON.stringify({ orgName: '유출되면안됨', orgSlug: 'leak' }));
    vi.stubGlobal('fetch', mockFetchDefault(UID_B));
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    expect(container.textContent).not.toContain('유출되면안됨');
    // A의 draft 자체는 훼손 없이 그대로 남아있다(B 세션이 A 슬롯을 안 건드림).
    expect(sessionStorage.getItem(DRAFT_PREFIX + UID_A)).toBeTruthy();
  });

  it('B 계정이 타이핑하면 B 전용 키(uid 분리)로 저장되고 A 슬롯은 안 바뀐다', async () => {
    sessionStorage.setItem(DRAFT_PREFIX + UID_A, JSON.stringify({ orgName: 'A의 값', orgSlug: 'a-org' }));
    vi.stubGlobal('fetch', mockFetchDefault(UID_B));
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, 'B의 값'); });
    await flush();

    const draftA = JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + UID_A)!) as { orgName: string };
    expect(draftA.orgName).toBe('A의 값');
    const draftB = JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + UID_B)!) as { orgName: string };
    expect(draftB.orgName).toBe('B의 값');
  });
});

describe('OnboardingForm — 미인증 선제 고지(story #3195 AC2)', () => {
  it('/api/auth/me.email_verified===false면 제출 前(마운트 시)부터 안내+재전송 버튼이 보인다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A, {
      '/api/auth/me': async () => ({ ok: true, json: async () => ({ data: { member_id: UID_A, org_id: null, email_verified: false } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeTruthy();
    // 아직 제출(조직 만들기)을 누르지 않았다 — 배너가 마운트 시점부터 선제로 떴다는 증거.
    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? ''));
    expect(submitBtn).toBeTruthy();
  });

  it('/api/auth/me.email_verified===true면 선제 고지가 안 뜬다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
  });

  it('/api/auth/me.email_verified===null(판정 불가)이면 안내가 안 뜬다 — 제출 시 400 분기가 안전망으로 남는다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A, {
      '/api/auth/me': async () => ({ ok: true, json: async () => ({ data: { member_id: UID_A, org_id: null, email_verified: null } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
  });

  it('/api/auth/me가 404여도(구 /api/me였다면 무 org에서 이랬을 상황) 크래시 없이 조용히 폴백한다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault(UID_A, {
      '/api/auth/me': async () => ({ ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
    // 폼 자체는 정상 — 크래시 없음(조직명 입력창이 여전히 존재).
    expect(container.querySelector('input')).toBeTruthy();
  });
});
