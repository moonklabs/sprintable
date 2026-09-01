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

  // 유나 design:changes(PR#3688, 2026-09-01) ① — BE가 confirm 성공 시 refresh token
  // 전량을 revoke한다(우회체인 봉합 부수효과). 그 사실을 사용자가 놀라지 않게 고지.
  it('성공 — BE의 refresh token 전량 revoke를 「다른 기기 로그아웃」으로 고지한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ data: { message: 'Password set successfully' } }),
    })));
    await mountAndWait();
    expect(container.textContent).toContain('다른 기기');
    expect(container.textContent).toContain('로그아웃');
  });

  it('INVALID_TOKEN(만료·서명불일치) — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'Confirmation link is invalid or expired' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Confirmation link is invalid');
    expect(container.textContent).toContain('확인 링크가 유효하지 않거나 만료되었습니다.');
  });

  // 유나 design:changes(PR#3688) ② — 만료 링크는 "실패로 끝"이 아니라 재요청 경로가
  // 있어야 한다(재요청은 인증 필요라 /settings로 안내 — 이 페이지 자체에서 직접 재발송은
  // 불가, no-fiction).
  it('INVALID_TOKEN — /settings로 가는 재요청 동선이 뜬다(다른 실패 code는 안 뜸)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'expired' } }),
    })));
    await mountAndWait();
    const retryLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings');
    expect(retryLink, '/settings 재요청 링크를 못 찾음').not.toBeUndefined();
  });

  it('USER_NOT_FOUND — 재요청으로 안 풀리는 실패라 /settings 링크는 안 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'not found' } }),
    })));
    await mountAndWait();
    const retryLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings');
    expect(retryLink).toBeUndefined();
  });

  it('ALREADY_HAS_PASSWORD(TOCTOU) — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'ALREADY_HAS_PASSWORD', message: 'User already has a password set' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('User already has a password set');
    expect(container.textContent).toContain('이미 비밀번호가 설정되어 있습니다.');
  });

  // 유나 design:changes(PR#3688) ③ — 「이미 완료」는 실패가 아니라 중립 톤(text-foreground/
  // role=status)이어야 한다(destructive/alert는 진짜 실패에만).
  it('ALREADY_HAS_PASSWORD — 실패 톤(destructive/alert)이 아니라 중립 톤(text-foreground/status)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'ALREADY_HAS_PASSWORD', message: 'x' } }),
    })));
    await mountAndWait();
    const msg = [...container.querySelectorAll('p')].find((p) => p.textContent === '이미 비밀번호가 설정되어 있습니다.');
    expect(msg).not.toBeUndefined();
    expect(msg?.className).toContain('text-foreground');
    expect(msg?.className).not.toContain('text-destructive');
    expect(msg?.getAttribute('role')).toBe('status');
  });

  it('INVALID_TOKEN(진짜 실패)은 여전히 destructive/alert 톤 그대로다(회귀 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'x' } }),
    })));
    await mountAndWait();
    const msg = [...container.querySelectorAll('p')].find((p) => p.textContent === '확인 링크가 유효하지 않거나 만료되었습니다.');
    expect(msg?.className).toContain('text-destructive');
    expect(msg?.getAttribute('role')).toBe('alert');
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
