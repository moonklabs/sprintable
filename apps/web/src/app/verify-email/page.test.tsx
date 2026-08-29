// @vitest-environment jsdom
//
// story #2484 — 인증 실패가 error.code 분기 없이 json.error?.message(raw 서버 영문)를
// 그대로 노출하던 자리. 이 페이지는 next-intl 미배선(전체 하드코딩 한국어)이라 인라인
// 한국어 문자열로 code별 분기한다 — i18n 전면 전환은 이 스토리 스코프 밖(별도 관찰로 보고).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
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
  pushMock.mockClear();
});

async function mountAndWait() {
  const { default: VerifyEmailPage } = await import('./page');
  await act(async () => { root.render(<VerifyEmailPage />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('VerifyEmailPage — error.code 분기 (story #2484)', () => {
  it('성공(신규 인증) — raw 서버 문구 대신 한국어 문구(유나 design:changes 델타)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ data: { message: 'Email verified successfully' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Email verified successfully');
    expect(container.textContent).toContain('이메일 인증이 완료되었습니다.');
  });

  it('성공(이미 인증됨) — raw 서버 문구 대신 동일 한국어 문구(유나 design:changes 델타)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ data: { message: 'Email already verified' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Email already verified');
    expect(container.textContent).toContain('이메일 인증이 완료되었습니다.');
  });

  it('INVALID_TOKEN — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'Verification link is invalid or expired' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('Verification link is invalid');
    expect(container.textContent).toContain('인증 링크가 유효하지 않거나 만료되었습니다.');
  });

  it('USER_NOT_FOUND — raw 영문 대신 한국어 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain('사용자를 찾을 수 없습니다.');
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    })));
    await mountAndWait();
    expect(container.textContent).not.toContain('brand new raw string');
    expect(container.textContent).toContain('인증에 실패했습니다.');
  });
});

// story #3195 — «시작하기»가 org 유무와 무관하게 항상 /inbox로 갔다. 온보딩 도중(org
// 미생성) 이메일 인증 벽에 걸린 유저는 org가 없어 /inbox가 막다른 곳이었다.
describe('VerifyEmailPage — 「시작하기」 목적지가 org_id 유무로 갈린다(story #3195)', () => {
  function mockFetchByUrl(orgId: string | null) {
    return vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { org_id: orgId } }) };
      return { json: async () => ({ data: { message: 'Email verified successfully' } }) };
    });
  }

  it('org_id 있음 — 「시작하기」가 /inbox로 이동', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl('org-1'));
    await mountAndWait();
    const startBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '시작하기');
    await act(async () => { startBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/inbox');
  });

  it('org_id 없음(온보딩 미완주) — 「시작하기」가 /onboarding으로 이동(전엔 /inbox 막다른 곳)', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl(null));
    await mountAndWait();
    const startBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '시작하기');
    await act(async () => { startBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/onboarding');
  });

  // 유나 design:pass 비차단 ①(2026-08-29) — /api/me 응답 前 빠른 클릭 레이스. 이전엔
  // useState 기본값(/inbox)이 그대로 나가 no-org 유저가 막다른 곳으로 갔다. 지금은 클릭이
  // 판정을 "기다렸다" 라우팅해야 한다.
  it('/api/me 응답 前 클릭해도(레이스) — 응답 도착 후 올바른 목적지(/onboarding)로 이동한다', async () => {
    let resolveMe!: (v: { ok: true; json: () => Promise<unknown> }) => void;
    const mePromise = new Promise<{ ok: true; json: () => Promise<unknown> }>((r) => { resolveMe = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return mePromise;
      return { json: async () => ({ data: { message: 'Email verified successfully' } }) };
    }));
    await mountAndWait();

    const startBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '시작하기');
    // /api/me가 아직 안 끝난 시점에 클릭 — 예전엔 여기서 이미 /inbox로 나갔다.
    await act(async () => { startBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveMe({ ok: true, json: async () => ({ data: { org_id: null } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(pushMock).toHaveBeenCalledWith('/onboarding');
  });
});
