// @vitest-environment jsdom
//
// story #3122(계정·후속) — 수동 «계정 연결(link)». #3118 그라운딩(Apple private relay
// 이메일이면 자동 이메일 병합 불가)에 대한 처방: 사용자 주도 수동 연결 UI.
// AC1(연결 표면)·AC2(다른 계정에 이미 묶인 provider 명시 거부 문구)·AC3(최소 1개 로그인
// 수단 — 클라 disabled + 서버 거부 시 문구 분기)를 렌더 레벨에서 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useSearchParamsMock } = vi.hoisted(() => ({
  useSearchParamsMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => useSearchParamsMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

async function mount(meData: { linked_providers: string[]; has_password?: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return { ok: true, json: async () => ({ data: meData }) };
    throw new Error('unexpected fetch: ' + url);
  }));
  const { LinkedAccountsSection } = await import('./linked-accounts-section');
  await act(async () => { root.render(wrap(<LinkedAccountsSection />)); });
  await flush();
}

describe('LinkedAccountsSection — 연결 상태 렌더 (AC1)', () => {
  it('linked_providers에 있으면 연결됨+연결 해제, 없으면 연결 안 됨+연결', async () => {
    await mount({ linked_providers: ['google'], has_password: true });
    const items = Array.from(container.querySelectorAll('li'));
    const googleItem = items.find((li) => li.textContent?.includes('Google'));
    const appleItem = items.find((li) => li.textContent?.includes('Apple'));
    expect(googleItem?.textContent).toContain('연결됨');
    expect(googleItem?.querySelector('button')?.textContent).toBe('연결 해제');
    expect(appleItem?.textContent).toContain('연결 안 됨');
    expect(appleItem?.querySelector('a')?.getAttribute('href')).toBe('/auth/link?provider=apple');
  });

  it('Connect 링크는 /auth/link?provider={id}로 나간다', async () => {
    await mount({ linked_providers: [], has_password: true });
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      expect.arrayContaining(['/auth/link?provider=google', '/auth/link?provider=apple']),
    );
  });
});

describe('LinkedAccountsSection — 최소 1개 로그인 수단 가드 (AC3)', () => {
  it('연결된 provider 1개뿐 + has_password=false면 Disconnect 버튼이 disabled', async () => {
    await mount({ linked_providers: ['apple'], has_password: false });
    const items = Array.from(container.querySelectorAll('li'));
    const appleItem = items.find((li) => li.textContent?.includes('Apple'));
    const btn = appleItem?.querySelector('button');
    expect(btn?.disabled).toBe(true);
  });

  it('연결된 provider 2개면(비밀번호 없어도) 둘 다 Disconnect 활성', async () => {
    await mount({ linked_providers: ['google', 'apple'], has_password: false });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  it('서버가 LAST_LOGIN_METHOD로 거부하면 전용 안내 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { linked_providers: ['google', 'apple'], has_password: false } }) };
      if (url === '/api/auth/oauth/unlink' && init) {
        return { ok: false, json: async () => ({ error: { code: 'LAST_LOGIN_METHOD' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    const { LinkedAccountsSection } = await import('./linked-accounts-section');
    await act(async () => { root.render(wrap(<LinkedAccountsSection />)); });
    await flush();
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '연결 해제');
    await act(async () => { btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain('이 계정의 유일한 로그인 수단입니다');
  });
});

describe('LinkedAccountsSection — 콜백 리다이렉트 쿼리 문구 (AC2)', () => {
  it('linked=apple면 성공 문구', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('linked=apple'));
    await mount({ linked_providers: ['apple'] });
    expect(container.textContent).toContain('Apple 계정이 연결되었습니다.');
  });

  it('link_error=PROVIDER_ALREADY_LINKED면 "다른 계정에 이미 연결됨" 문구(병합 아님을 명시)', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('link_error=PROVIDER_ALREADY_LINKED'));
    await mount({ linked_providers: [] });
    expect(container.textContent).toContain('이미 다른 Sprintable 계정에 연결되어 있습니다');
  });

  it('link_error=LINK_SESSION_MISMATCH면 세션 변경 안내', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('link_error=LINK_SESSION_MISMATCH'));
    await mount({ linked_providers: [] });
    expect(container.textContent).toContain('연결 중 세션이 변경되었습니다');
  });
});

// story #3149(선생님 실사용 발견) — 이 섹션이 next-intl 미배선으로 100% 영문 렌더되던
// 결함의 회귀가드. i18n 배선 전 문구가 다시 하드코딩 영문으로 새지 않는지 직접 고정.
describe('LinkedAccountsSection — story #3149 i18n 배선 회귀가드', () => {
  it('제목·부제가 한국어로 렌더된다("Connected Accounts" 원문 노출 0)', async () => {
    await mount({ linked_providers: [], has_password: true });
    expect(container.textContent).toContain('연결된 계정');
    expect(container.textContent).toContain('다른 로그인 방법을 이 계정에 연결하거나');
    expect(container.textContent).not.toContain('Connected Accounts');
    expect(container.textContent).not.toContain('Connect another sign-in method');
  });

  it('en 로케일로 마운트하면 원래 영문 문구가 그대로 나온다(키 자체는 정상 매핑)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { linked_providers: [], has_password: true } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    const enMessages = (await import('../../../messages/en.json')).default;
    const { LinkedAccountsSection } = await import('./linked-accounts-section');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
          <LinkedAccountsSection />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain('Connected Accounts');
    expect(container.textContent).toContain('Connect another sign-in method to this account');
  });
});
