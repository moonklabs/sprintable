// @vitest-environment jsdom
//
// [P1 후속] 산티아고 조건부 허용(2026-08-26) — custom scheme(ai.sprintable) 홉은 사용자 탭
// 없이 자동 발동 금지(intent-squatting 공격면 완화). 이 페이지가 자동 location.replace를
// 하지 않고 버튼 탭에서만 이동하는지, 이동 대상 URI가 App.js OAUTH_RETURN_SCHEME_URL과
// byte-exact(ai.sprintable:/oauth-return, 단일 슬래시)인지가 이 테스트의 핵심 축.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => h.searchParams,
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
  vi.resetModules();
});

async function mountAndWait() {
  const { default: NativeOauthReturnPage } = await import('./page');
  await act(async () => { root.render(<NativeOauthReturnPage />); });
}

describe('NativeOauthReturnPage — custom scheme 버튼 (P1 후속)', () => {
  it('code 쿼리를 그대로 전달하는 ai.sprintable:/oauth-return 앵커를 렌더한다(자동 리다이렉트 없음)', async () => {
    h.searchParams = new URLSearchParams('code=abc123');
    await mountAndWait();
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('ai.sprintable:/oauth-return?code=abc123');
  });

  it('쿼리가 없으면 물음표 없는 base URI 그대로(가짜 빈 쿼리 접미 금지)', async () => {
    h.searchParams = new URLSearchParams();
    await mountAndWait();
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('ai.sprintable:/oauth-return');
  });

  it('scheme은 이중 슬래시가 아니다(ai.sprintable:/ — App.js OAUTH_RETURN_SCHEME_URL과 byte-exact)', async () => {
    h.searchParams = new URLSearchParams('code=xyz');
    await mountAndWait();
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).not.toContain('ai.sprintable://');
  });

  it('자동 이동 스크립트 없음 — location.replace/href 대입이 마운트만으로 실행되지 않는다', async () => {
    const originalHref = window.location.href;
    h.searchParams = new URLSearchParams('code=abc123');
    await mountAndWait();
    expect(window.location.href).toBe(originalHref);
  });

  it('여러 쿼리 파라미터도 순서 보존해 그대로 전달한다', async () => {
    h.searchParams = new URLSearchParams('code=abc123&state=xyz');
    await mountAndWait();
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('ai.sprintable:/oauth-return?code=abc123&state=xyz');
  });
});
