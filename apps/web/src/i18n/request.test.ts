import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocale } from './request';

// story #3778 CHANGES(유나 design:changes 2026-09-10) — getLocale()을 export해 회고
// 내보내기 BFF가 재사용하게 만든 계기가 된 바로 그 버그의 재현·고정. 최초본은 export
// route가 `locale` 쿠키만 직접 읽어(헤더 폴백 없이) — 쿠키를 한 번도 세팅 안 한 신규
// 사용자(세팅 자리는 locale-switcher.tsx 단 한 곳)는 화면이 실제로 보여주는 언어
// (Accept-Language로 en 결정)와 전혀 다른 값(쿠키 부재→헤더 미전달→BE 자체 기본값)을
// 받았다. getLocale() 자체를 여기서 직접 검증해 그 갭이 재발하면 이 테스트가 먼저 잡는다.
const { cookieGet, headerGet } = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  headerGet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
  headers: vi.fn(async () => ({ get: headerGet })),
}));

// getRequestConfig(next-intl/server)는 이 테스트에서 호출 경로 밖(default export)이라
// 목 불요 — getLocale은 named export로 직접 호출한다.

beforeEach(() => {
  cookieGet.mockReset();
  headerGet.mockReset();
});

describe('getLocale() — story #3778 CHANGES 재현·고정', () => {
  it('쿠키 있음(locale=ko) → 헤더 무시하고 쿠키 그대로', async () => {
    cookieGet.mockReturnValue({ value: 'ko' });
    headerGet.mockReturnValue('en-US,en;q=0.9');
    expect(await getLocale()).toBe('ko');
  });

  it('⭐쿠키 없음·Accept-Language: en → en(신규 사용자가 화면과 같은 언어의 문서를 받는다)', async () => {
    cookieGet.mockReturnValue(undefined);
    headerGet.mockReturnValue('en-US,en;q=0.9');
    expect(await getLocale()).toBe('en');
  });

  it('쿠키 없음·Accept-Language: ko 포함 → ko', async () => {
    cookieGet.mockReturnValue(undefined);
    headerGet.mockReturnValue('ko-KR,ko;q=0.9');
    expect(await getLocale()).toBe('ko');
  });

  it('⭐쿠키 없음·헤더도 없음 → en(DEFAULT_LOCALE — ko 아님, 최초본이 실제로 틀렸던 자리)', async () => {
    cookieGet.mockReturnValue(undefined);
    headerGet.mockReturnValue(null);
    expect(await getLocale()).toBe('en');
  });

  it('쿠키가 지원 밖 값이면 무시하고 헤더/기본값으로 폴백', async () => {
    cookieGet.mockReturnValue({ value: 'ja' });
    headerGet.mockReturnValue(null);
    expect(await getLocale()).toBe('en');
  });
});
