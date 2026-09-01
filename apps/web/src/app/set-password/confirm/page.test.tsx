// @vitest-environment jsdom
//
// story #ab2a503f([버그·보안·HIGH] set-password 재인증 게이트) — 이메일 확인 링크가 여는
// 착지 페이지. verify-email/page.test.tsx(story #2484)와 동형 패턴: next-intl 미배선이라
// 인라인 한국어 문자열로 code별 분기, raw 서버 message 미노출을 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=tok-1'),
}));

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
  vi.resetModules();
});

async function mountAndWait() {
  const { default: SetPasswordConfirmPage } = await import('./page');
  await act(async () => { root.render(<SetPasswordConfirmPage />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('SetPasswordConfirmPage — error.code 분기(#ab2a503f)', () => {
  it('성공 — raw 서버 문구 대신 한국어 문구, 로그인 링크로 안내', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ data: { message: 'Password set successfully — please log in with your new password' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Password set successfully');
    expect(container.textContent).toContain('비밀번호가 설정되었습니다');
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === '로그인하기')).toBe(true);
  });

  it('INVALID_TOKEN(만료·서명불일치) — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'Confirmation link is invalid or expired' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Confirmation link is invalid');
    expect(container.textContent).toContain('확인 링크가 유효하지 않거나 만료되었습니다.');
  });

  it('ALREADY_HAS_PASSWORD(TOCTOU) — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'ALREADY_HAS_PASSWORD', message: 'User already has a password set' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('User already has a password set');
    expect(container.textContent).toContain('이미 비밀번호가 설정되어 있습니다.');
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('brand new raw string');
    expect(container.textContent).toContain('비밀번호 설정에 실패했습니다.');
  });

  it('token 쿼리파라미터 자체가 없으면 fetch 없이 즉시 에러 상태', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('should not fetch without a token');
    }));
    // useSearchParams 모킹을 이 테스트만 토큰 없는 값으로 오버라이드.
    vi.doMock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
    const { default: SetPasswordConfirmPage } = await import('./page');
    await act(async () => { root.render(<SetPasswordConfirmPage />); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('유효하지 않은 확인 링크입니다.');
  });
});
