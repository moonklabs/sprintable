// @vitest-environment jsdom
//
// story 4831 부품 교체(인증 화면 묶음) — 날것 입력칸 · 체크박스가 바탕 Input · Checkbox가 되어도 그대로여야 하는 것을 결과로 잠근다.
// ① 큰 글자(인증 코드 칸): 부품의 `text-base lg:text-sm`에 덮이지 않고 데스크톱에서도 제 크기(실제 Tailwind 캐스케이드로 잼)
// ② 입력 정리(숫자만 6자) · 자동 초점 · 오류 테두리가 부품 위에서도 같은 조건으로 켜지고 꺼짐
// ③ 약관 체크박스: 라벨 글자를 눌러도 켜지고, 엔터로는 켜지지 않고(날것 체크박스처럼), 스페이스로는 켜진다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { loadTailwindCascade } from '@/components/docs/lib/tailwind-cascade.test-helper';

const { loginWithPasswordMock } = vi.hoisted(() => ({ loginWithPasswordMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ loginWithPassword: loginWithPasswordMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('token=tok-1'), // 재설정 화면은 링크의 토큰이 있어야 입력칸을 그린다(로그인 · 가입은 이 값을 안 읽음)
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  loginWithPasswordMock.mockReset();
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
function setNative(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function toPx(value: string): number {
  const m = /^([\d.]+)(px|rem)$/.exec(value.trim());
  if (!m) throw new Error(`font-size를 px로 못 바꿈: «${value}»`);
  return m[2] === 'rem' ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
}
const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('인증 코드 칸 — 큰 글자 · 입력 정리 · 자동 초점', () => {
  async function mountMfa() {
    const { MfaClient } = await import('./mfa/mfa-client');
    await act(async () => { root.render(wrap(<MfaClient chatsHref="/chats" />)); });
    return container.querySelector<HTMLInputElement>('input[data-slot="input"][inputmode="numeric"]')!;
  }
  it('MFA 코드 칸: 바탕 Input이고, 모바일 · 데스크톱 모두 20px(부품의 lg:text-sm에 덮이지 않음) · 숫자만 6자 · 자동 초점', async () => {
    const code = await mountMfa();
    expect(code).toBeTruthy();
    expect(code.maxLength).toBe(6);
    await act(async () => { setNative(code, '12ab345678'); });
    expect(code.value).toBe('123456');
    expect(document.activeElement).toBe(code);
    for (const viewportWidth of [390, 1280]) {
      const cascade = await loadTailwindCascade(container, { viewportWidth });
      expect(cascade.unparsable()).toEqual([]);
      expect(toPx(cascade.computed(code, 'font-size', 'light')), `폭 ${viewportWidth}`).toBe(20);
    }
  });

  it('로그인 TOTP 칸: 인증 코드가 필요하다는 응답 뒤에 나타나는 바탕 Input(ds Input — story 4891)이고, 모바일 · 데스크톱 모두 18px · 숫자만 6자 · 자동 초점', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'TOTP_REQUIRED', message: 'totp' } });
    const { default: LoginPage } = await import('./login/page');
    await act(async () => { root.render(wrap(<LoginPage />)); });
    const email = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="email"]')!;
    const pw = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="password"]')!;
    await act(async () => { setNative(email, 'a@b.co'); setNative(pw, 'secret-pass'); });
    await act(async () => { press(pw, 'Enter'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(loginWithPasswordMock).toHaveBeenCalledTimes(1);
    const totp = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][inputmode="numeric"]')!;
    expect(totp).toBeTruthy();
    expect(totp.maxLength).toBe(6);
    await act(async () => { setNative(totp, '9x8y7654321'); });
    expect(totp.value).toBe('987654');
    expect(document.activeElement).toBe(totp);
    for (const viewportWidth of [390, 1280]) {
      const cascade = await loadTailwindCascade(container, { viewportWidth });
      expect(toPx(cascade.computed(totp, 'font-size', 'light')), `폭 ${viewportWidth}`).toBe(18);
    }
    // 코드를 넣고 엔터 — 같은 로그인 요청이 코드와 함께 다시 나간다
    loginWithPasswordMock.mockResolvedValue({ data: {} });
    await act(async () => { press(totp, 'Enter'); });
    expect(loginWithPasswordMock).toHaveBeenCalledTimes(2);
    expect(loginWithPasswordMock.mock.calls[1]).toEqual(['a@b.co', 'secret-pass', '987654']);
  });
});

describe('비밀번호 재설정 칸 — 오류 테두리', () => {
  it('규칙을 못 채우면 오류 테두리(border-destructive), 채우면 사라진다 · 부품 기본 테두리와 겹쳐 남지 않는다', async () => {
    const { default: ResetPage } = await import('./reset-password/page');
    await act(async () => { root.render(wrap(<ResetPage />)); });
    const pw = container.querySelector<HTMLInputElement>('input[data-slot="input"][type="password"]')!;
    expect(pw).toBeTruthy();
    expect(pw.className.split(/\s+/)).not.toContain('border-destructive'); // 건드리기 전
    await act(async () => { setNative(pw, 'a'); });
    const bad = pw.className.split(/\s+/);
    expect(bad).toContain('border-destructive');
    expect(bad).not.toContain('border-input');
    await act(async () => { setNative(pw, 'Str0ng!Passw0rd#2026'); });
    const good = pw.className.split(/\s+/);
    expect(good).not.toContain('border-destructive');
    expect(good).toContain('border-input');
  });
});

describe('가입 화면 약관 체크박스', () => {
  it('라벨 글자를 눌러도 켜지고 다시 누르면 꺼진다 · 엔터로는 안 켜지고 스페이스로는 켜진다', async () => {
    const { default: RegisterPage } = await import('./register/page');
    await act(async () => { root.render(wrap(<RegisterPage />)); });
    const box = () => container.querySelector<HTMLElement>('[data-slot="ds-checkbox"]')!;
    expect(box()).toBeTruthy();
    expect(box().getAttribute('aria-checked')).toBe('false');
    const labelText = [...container.querySelectorAll('label span')].find((s) => s.textContent?.includes(koMessages.register.tosPrefix))!;
    expect(labelText).toBeTruthy();
    await act(async () => { (labelText as HTMLElement).click(); });
    expect(box().getAttribute('aria-checked')).toBe('true');
    await act(async () => { (labelText as HTMLElement).click(); });
    expect(box().getAttribute('aria-checked')).toBe('false');
    await act(async () => { press(box(), 'Enter'); });
    expect(box().getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      box().dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    });
    expect(box().getAttribute('aria-checked')).toBe('true');
  });
});

describe('가입 제출 — 엔터 · 요청 내용 (인증은 되돌리기 어려운 길이라 결과로 잠근다)', () => {
  it('이름 · 이메일 · 비밀번호 칸 어디서든 엔터로 가입이 제출되고, 요청 본문은 입력 그대로다 · 약관을 안 켜면 제출되지 않는다', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return { ok: false, status: 400, json: async () => ({ error: { code: 'X', message: 'x' } }) };
    }));
    const { default: RegisterPage } = await import('./register/page');
    await act(async () => { root.render(wrap(<RegisterPage />)); });
    const name = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="text"]')!;
    const email = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="email"]')!;
    const pw = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="password"]')!;
    await act(async () => { setNative(name, '홍길동'); setNative(email, ' a@b.co '); setNative(pw, 'Str0ng!Passw0rd#2026'); });
    // 약관을 켜기 전에는 어느 칸의 엔터도 제출하지 않는다
    await act(async () => { press(name, 'Enter'); });
    expect(calls).toHaveLength(0);
    const labelText = [...container.querySelectorAll('label span')].find((s) => s.textContent?.includes(koMessages.register.tosPrefix))!;
    await act(async () => { (labelText as HTMLElement).click(); });
    for (const field of [name, email, pw]) {
      await act(async () => { press(field, 'Enter'); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe('/api/auth/register');
      expect(c.body).toEqual({ email: 'a@b.co', password: 'Str0ng!Passw0rd#2026', display_name: '홍길동', tos_accepted: true });
    }
  });
});
