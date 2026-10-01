// @vitest-environment jsdom
//
// story #4453 — the «verify your e-mail» gate in front of the two org-creating screens: when it shows, how it opens in place
// (poll while visible · focus · visibility), and what [인증 메일 다시 보내기] / [다른 주소로 가입하기] do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EmailVerifyGate, VERIFY_POLL_MS, gateClosed, registerAgainHref } from './email-verify-gate';

const { logoutUser } = vi.hoisted(() => ({ logoutUser: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init),
  logoutUser,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let me: { email_verified: boolean | null; email_verification_required: boolean | null; email?: string } | 'down';
let resend: () => Response;
let meReads = 0;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  me = { email_verified: false, email_verification_required: true, email: 'jiwoo@example.com' };
  resend = () => new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 });
  meReads = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  logoutUser.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/me') {
      meReads += 1;
      if (me === 'down') throw new Error('offline');
      return new Response(JSON.stringify({ data: me }), { status: 200 });
    }
    if (url === '/api/auth/resend-verification') return resend();
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <EmailVerifyGate><p data-testid="behind">레시피 고르기</p></EmailVerifyGate>
      </NextIntlClientProvider>,
    );
  });
  await flush();
}
const gate = () => container.querySelector('[data-testid=email-verify-gate]');
const behind = () => container.querySelector('[data-testid=behind]');
const buttonNamed = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;

describe('[SID:4453] the «verify your e-mail» gate', () => {
  it('closed only for «required» and «not verified» — never on a missing or unknown answer', () => {
    expect(gateClosed({ required: true, verified: false })).toBe(true);
    expect(gateClosed({ required: true, verified: true })).toBe(false);
    expect(gateClosed({ required: false, verified: false })).toBe(false); // a self-hosted server with the setting off
    expect(gateClosed({ required: null, verified: false })).toBe(false);
    expect(gateClosed({ required: true, verified: null })).toBe(false);
  });

  it('an unverified e-mail sign-up: the gate with the address in bold, and nothing of the screen behind it', async () => {
    await mount();
    expect(gate()).not.toBeNull();
    expect(behind()).toBeNull();
    expect(gate()!.textContent).toContain('메일함에서 인증해 주세요');
    expect(gate()!.querySelector('strong')?.textContent).toBe('jiwoo@example.com');
    expect(gate()!.querySelector('[role=status]')?.textContent).toBe('인증을 기다리는 중이에요');
  });

  it('verified already (a social sign-in) · not required · /me unreachable → the screen at once, no gate', async () => {
    for (const m of [
      { email_verified: true, email_verification_required: true },
      { email_verified: false, email_verification_required: false },
      'down' as const,
    ]) {
      me = m;
      await mount();
      expect(gate()).toBeNull();
      expect(behind()).not.toBeNull();
    }
  });

  it('nothing at all until /me answers (no gate flashing past a verified person)', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    await mount();
    expect(container.textContent).toBe('');
    await act(async () => { answer(new Response(JSON.stringify({ data: { email_verified: true, email_verification_required: true } }))); });
    await flush();
    expect(behind()).not.toBeNull();
  });

  it('the link clicked elsewhere: the next 3-second read opens it in place — no reload, no button', async () => {
    await mount();
    me = { email_verified: true, email_verification_required: true };
    await act(async () => { vi.advanceTimersByTime(VERIFY_POLL_MS); });
    await flush();
    expect(gate()).toBeNull();
    expect(behind()).not.toBeNull();
  });

  it('a hidden tab does not poll; coming back (visible · focus) reads at once', async () => {
    await mount();
    const before = meReads;
    visibility = 'hidden';
    await act(async () => { vi.advanceTimersByTime(VERIFY_POLL_MS * 5); });
    expect(meReads).toBe(before);
    visibility = 'visible';
    me = { email_verified: true, email_verification_required: true };
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(meReads).toBe(before + 1);
    expect(behind()).not.toBeNull();
  });

  it('focus reads at once too (back from the mail app)', async () => {
    await mount();
    const before = meReads;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(meReads).toBe(before + 1);
  });

  it('[인증 메일 다시 보내기]: sent · not delivered · three an hour — one muted line each', async () => {
    const cases: [() => Response, string][] = [
      [() => new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 }), '인증 메일을 다시 보냈어요.'],
      [() => new Response(JSON.stringify({ data: { delivered: false } }), { status: 200 }), '메일을 보내지 못했어요 — 잠시 뒤 다시 보내 주세요.'],
      [() => new Response('{}', { status: 429 }), '한 시간에 세 번까지 보낼 수 있어요 — 조금 뒤에 다시 보내 주세요.'],
      [() => new Response('{}', { status: 500 }), '메일을 보내지 못했어요 — 잠시 뒤 다시 보내 주세요.'],
    ];
    for (const [answer, line] of cases) {
      resend = answer;
      await mount();
      await act(async () => { buttonNamed('인증 메일 다시 보내기').click(); });
      await flush();
      expect(container.querySelector('[data-testid=email-verify-gate-resend]')?.textContent).toBe(line);
    }
  });

  it('«already verified» from [다시 보내기] opens the gate like the poll does (no words)', async () => {
    await mount();
    resend = () => new Response(JSON.stringify({ data: { message: 'Email already verified' } }), { status: 200 });
    me = { email_verified: true, email_verification_required: true };
    await act(async () => { buttonNamed('인증 메일 다시 보내기').click(); });
    await flush();
    expect(gate()).toBeNull();
    expect(behind()).not.toBeNull();
  });

  it('[다른 주소로 가입하기]: signs out, then /register coming back here — without the # (the desktop shell puts it back)', async () => {
    expect(registerAgainHref({ pathname: '/desktop/setup', search: '' })).toBe('/register?next=%2Fdesktop%2Fsetup');
    expect(registerAgainHref({ pathname: '/onboarding', search: '?next=%2Fdesktop%2Fsetup' })).toBe('/register?next=%2Fonboarding%3Fnext%3D%252Fdesktop%252Fsetup');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/desktop/setup', search: '', hash: '#code=x&setup=s', assign });
    await mount();
    await act(async () => { buttonNamed('다른 주소로 가입하기').click(); });
    await flush();
    expect(logoutUser).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/register?next=%2Fdesktop%2Fsetup');
  });
});
