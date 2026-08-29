// @vitest-environment jsdom
//
// story #3204(acquisition 계측) — sign_up 전환 이벤트 발화 SSOT. 가입 경로 2개(email/pw는
// register/page.tsx, OAuth는 서버 리다이렉트)가 둘 다 같은 `?signup=1` 파라미터로 수렴하고,
// 여기 한 곳에서만 gtag('event','sign_up')을 쏜다(billing-tab.tsx의 Toss checkout 성공
// 쿼리파라미터 소비 패턴과 동형). 처리 直後 파라미터를 제거해 새로고침 시 재발화되지 않는지도 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { pushMock, replaceMock, usePathnameMock, useSearchParamsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  usePathnameMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useSearchParams: useSearchParamsMock,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

vi.mock('next/script', () => ({
  default: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetModules(); // GA_ID는 모듈 최상단 const라 env를 바꾼 뒤엔 재-import가 필요.
  process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-TEST123';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { gtag: (...args: unknown[]) => void }).gtag = vi.fn();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
  delete (window as { gtag?: unknown }).gtag;
  delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
});

async function mount() {
  const { GoogleAnalytics } = await import('./google-analytics');
  await act(async () => { root.render(<GoogleAnalytics />); });
}

describe('GoogleAnalytics — sign_up 전환 이벤트(story #3204)', () => {
  it('?signup=1이 있으면 gtag(event, sign_up)을 발화하고 파라미터를 제거한다', async () => {
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).toHaveBeenCalledWith('event', 'sign_up');
    expect(replaceMock).toHaveBeenCalledWith('/onboarding');
  });

  it('다른 쿼리파라미터가 같이 있으면 signup만 지우고 나머지는 보존한다', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1&from=proj-1'));
    await mount();

    expect(replaceMock).toHaveBeenCalledWith('/inbox?from=proj-1');
  });

  it('signup 파라미터가 없으면 sign_up 이벤트를 발화하지 않는다', async () => {
    usePathnameMock.mockReturnValue('/inbox');
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    const signUpCalls = gtag.mock.calls.filter((c) => c[0] === 'event' && c[1] === 'sign_up');
    expect(signUpCalls.length).toBe(0);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('GA_ID 미설정(dev 음성대조)이면 signup=1이 있어도 이벤트를 발화하지 않는다', async () => {
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    usePathnameMock.mockReturnValue('/onboarding');
    useSearchParamsMock.mockReturnValue(new URLSearchParams('signup=1'));
    await mount();

    const gtag = window.gtag as ReturnType<typeof vi.fn>;
    expect(gtag).not.toHaveBeenCalled();
  });
});
