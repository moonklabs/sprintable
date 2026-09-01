// @vitest-environment jsdom
//
// story #2485 — code로 분기(backend auth.py request_set_password()가 _err()로 직접 발급하는
// 안정 값: USER_NOT_FOUND, ALREADY_HAS_PASSWORD). story #3155부터 next-intl로 배선돼
// t('setPassword*') 키로 분기한다(linked-accounts-section.test.tsx와 동형 — 기본 ko로
// 마운트, raw error.message가 그대로 노출되지 않는지 고정).
//
// story #ab2a503f(2026-09-01) — set-password가 재인증 게이트(이메일 확인 2단계)로 바뀌면서
// 엔드포인트가 /api/auth/set-password/request로, 성공 응답이 "완료" 대신 "메일함 확인"으로
// 바뀌었다. 아래 submitWithErrorCode 헬퍼·성공 케이스 전부 새 계약으로 갱신.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SetPasswordSection } from './set-password-section';

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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

async function submitWithErrorCode(code: string, message: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
    if (url === '/api/auth/set-password/request') {
      return { ok: false, json: async () => ({ error: { code, message } }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => { root.render(wrap(<SetPasswordSection />)); });
  await flush();
  const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
  await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
  await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
  const submitBtn = container.querySelector('button');
  await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('SetPasswordSection — error.code 분기 (story #2485)', () => {
  it('ALREADY_HAS_PASSWORD — raw error.message 대신 고정 문구', async () => {
    await submitWithErrorCode('ALREADY_HAS_PASSWORD', 'User already has a password set');
    expect(container.textContent).not.toContain('User already has a password set');
    expect(container.textContent).toContain('이 계정에는 이미 비밀번호가 설정되어 있습니다.');
  });

  // 유나 design:changes(PR#3688, 2026-09-01) — ALREADY_HAS_PASSWORD는 실패가 아니라 「이미
  // 완료」라 빨강(destructive/role=alert)이 부적절 — 중립 톤(text-foreground/role=status).
  it('ALREADY_HAS_PASSWORD — 실패 톤(destructive/alert)이 아니라 중립 톤(text-foreground/status)', async () => {
    await submitWithErrorCode('ALREADY_HAS_PASSWORD', 'User already has a password set');
    const msg = [...container.querySelectorAll('p')].find((p) => p.textContent === '이 계정에는 이미 비밀번호가 설정되어 있습니다.');
    expect(msg).not.toBeUndefined();
    expect(msg?.className).toContain('text-foreground');
    expect(msg?.className).not.toContain('text-destructive');
    expect(msg?.getAttribute('role')).toBe('status');
  });

  it('USER_NOT_FOUND(진짜 실패)는 여전히 destructive/alert 톤 그대로다(회귀 0)', async () => {
    await submitWithErrorCode('USER_NOT_FOUND', 'User not found');
    const msg = [...container.querySelectorAll('p')].find((p) => p.textContent === '계정을 찾을 수 없습니다.');
    expect(msg?.className).toContain('text-destructive');
    expect(msg?.getAttribute('role')).toBe('alert');
  });

  it('USER_NOT_FOUND — raw error.message 대신 고정 문구', async () => {
    await submitWithErrorCode('USER_NOT_FOUND', 'User not found');
    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain('계정을 찾을 수 없습니다.');
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await submitWithErrorCode('SOME_NEW_CODE', 'brand new raw string');
    expect(container.textContent).not.toContain('brand new raw string');
    expect(container.textContent).toContain('비밀번호 설정에 실패했습니다.');
  });
});

// story #3155(#3149와 동일 패턴) — 이 섹션이 next-intl 미배선으로 100% 영문 렌더되던
// 결함의 회귀가드(linked-accounts-section.test.tsx의 story #3149 가드와 동형).
describe('SetPasswordSection — story #3155 i18n 배선 회귀가드', () => {
  async function mountVisible() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
  }

  it('제목·부제·버튼이 한국어로 렌더된다("Set Password" 원문 노출 0)', async () => {
    await mountVisible();
    await act(async () => { root.render(wrap(<SetPasswordSection />)); });
    await flush();
    expect(container.textContent).toContain('비밀번호 설정');
    expect(container.textContent).toContain('이 계정은 OAuth로 생성되었습니다');
    expect(container.textContent).not.toContain('Set Password');
    expect(container.textContent).not.toContain('Your account was created with OAuth');
  });

  it('규칙 목록·불일치 문구도 한국어로 렌더된다(raw 영문 노출 0)', async () => {
    await mountVisible();
    await act(async () => { root.render(wrap(<SetPasswordSection />)); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'abc'); });
    await act(async () => { setNativeValue(confirm, 'xyz'); });
    await flush();
    expect(container.textContent).toContain('최소 8자 이상');
    expect(container.textContent).toContain('다음 중 3가지 이상');
    expect(container.textContent).toContain('비밀번호가 일치하지 않습니다.');
    expect(container.textContent).not.toContain('At least 8 characters');
    expect(container.textContent).not.toContain('Passwords do not match.');
  });

  it('en 로케일로 마운트하면 원래 영문 문구가 그대로 나온다(키 자체는 정상 매핑)', async () => {
    await mountVisible();
    const enMessages = (await import('../../../messages/en.json')).default;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
          <SetPasswordSection />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain('Set Password');
    expect(container.textContent).toContain('Your account was created with OAuth');
  });
});

// story #ab2a503f — request 성공은 "완료"가 아니라 "메일함을 확인하세요"다(실제 write는
// /set-password/confirm 페이지가 이메일 링크 클릭으로 한다). delivered:false는 정직하게
// 실패로 보여준다(BE의 "sent"로 거짓 보고하지 않는 관례 그대로 FE도 유지).
describe('SetPasswordSection — 재인증 게이트: request 성공은 "메일함 확인"이지 "완료"가 아니다(#ab2a503f)', () => {
  it('delivered:true — 「메일함 확인」 안내로 전환, 폼은 사라진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password/request') {
        return { ok: true, json: async () => ({ data: { delivered: true } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<SetPasswordSection />)); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = container.querySelector('button');
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('확인 이메일을 보냈습니다');
    expect(container.querySelector('input[type="password"]')).toBeNull(); // 폼이 사라졌다
  });

  it('delivered:false — 「완료」로 거짓 보고하지 않고 실패 문구, 폼은 그대로(재시도 가능)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password/request') {
        return { ok: true, json: async () => ({ data: { delivered: false } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<SetPasswordSection />)); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = container.querySelector('button');
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('확인 이메일 발송에 실패했습니다');
    expect(container.querySelector('input[type="password"]')).not.toBeNull(); // 폼 유지(재시도 가능)
  });

  // 유나 design:changes(PR#3688, 2026-09-01) — 「메일 안 왔나요? 재발송」 동선.
  it('「메일함 확인」 화면에서 재발송 버튼을 누르면 request를 다시 호출하고 확인 문구가 뜬다', async () => {
    let requestCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password/request') {
        requestCallCount += 1;
        return { ok: true, json: async () => ({ data: { delivered: true } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<SetPasswordSection />)); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = container.querySelector('button');
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(requestCallCount).toBe(1);

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '재발송');
    expect(resendBtn, '재발송 버튼을 못 찾음').not.toBeUndefined();
    await act(async () => { resendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(requestCallCount).toBe(2); // 실제로 새 15분 토큰이 다시 발급됐다(재발송 실증)
    expect(container.textContent).toContain('다시 보냈습니다');
  });
});
