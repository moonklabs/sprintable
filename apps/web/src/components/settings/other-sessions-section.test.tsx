// @vitest-environment jsdom
//
// story #4630 (Yuna «4630» ① · 4624-remote-device-copy.md) — «로그인한 다른 기기»: the confirmation (cancel first) · the result
// line the server's answer picks · this browser not kept → one action, [다시 로그인] · a failure said inside the dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { createTranslator } from 'next-intl';
import { OtherSessionsSection, otherSessionsLine } from './other-sessions-section';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { logoutUserMock } = vi.hoisted(() => ({ logoutUserMock: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/client', () => ({
  logoutUser: logoutUserMock,
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init), // the page's authenticated fetch — stubbed per test
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
  logoutUserMock.mockClear();
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OtherSessionsSection /></NextIntlClientProvider>,
    );
  });
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function confirmWith(answer: Response) {
  const fetchMock = vi.fn(async () => answer);
  vi.stubGlobal('fetch', fetchMock);
  await mount();
  await act(async () => { q('other-sessions-open')!.click(); });
  await flush();
  await act(async () => { q('other-sessions-confirm')!.click(); });
  await flush();
  return fetchMock;
}

describe('[SID:4630] «로그인한 다른 기기»', () => {
  it('the card: title · description · the outline button, word for word (Yuna)', async () => {
    await mount();
    expect(container.textContent).toContain('로그인한 다른 기기');
    expect(container.textContent).toContain('잃어버린 폰이나 로그인을 남겨 둔 컴퓨터가 있으면 여기서 한 번에 끊어요. 지금 이 브라우저는 그대로예요.');
    expect(q('other-sessions-open')!.textContent).toBe('다른 기기에서 모두 로그아웃');
  });

  it('the card carries the #other-sessions anchor, so ?tab=profile#other-sessions lands on it', async () => {
    await mount();
    expect(document.getElementById('other-sessions')).toBe(q('other-sessions'));
  });

  it('the button asks first: the confirmation text · the focus on [취소] · nothing sent yet', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    await act(async () => { q('other-sessions-open')!.click(); });
    await flush();
    expect(document.body.textContent).toContain(
      '다른 기기의 로그인을 모두 끝낼까요? 지금 이 브라우저만 남아요. 다른 기기(폰 앱 · 맥 앱 화면 포함)는 길어야 1시간 안에 로그아웃돼요. 데스크톱 앱의 에이전트는 그대로 일하고, 폰은 다시 로그인하면 페어링이 그대로예요.',
    );
    expect(document.activeElement?.textContent).toBe('취소');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[로그아웃] → POST /api/auth/logout-others → «다른 로그인 2개를 끝냈어요 — …» · the dialog closes', async () => {
    const fetchMock = await confirmWith(new Response(JSON.stringify({ data: { sessions_ended: 2, kept_this: true } }), { status: 200 }));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout-others', { method: 'POST' });
    expect(q('other-sessions-done')!.textContent).toBe('다른 로그인 2개를 끝냈어요 — 길어야 1시간 안에 로그아웃되고, 이 브라우저는 그대로예요');
    expect(q('other-sessions-confirm')).toBeNull();
    expect(q('other-sessions-open')).not.toBeNull();
  });

  it('this browser not kept → the «다시 로그인해야 해요» line and [다시 로그인] alone, which signs out here and goes to the login page', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    await confirmWith(new Response(JSON.stringify({ data: { sessions_ended: 3, kept_this: false } }), { status: 200 }));
    expect(q('other-sessions-done')!.textContent).toBe('다른 기기의 로그인을 모두 끝냈어요 — 이 브라우저도 함께 끝나서 다시 로그인해야 해요');
    expect(q('other-sessions-open')).toBeNull();
    expect(q('other-sessions-sign-in-again')!.textContent).toBe('다시 로그인');
    await act(async () => { q('other-sessions-sign-in-again')!.click(); });
    await flush();
    expect(logoutUserMock).toHaveBeenCalledTimes(1);
    expect(location.href).toBe('/login');
  });

  it('while it runs, the confirm button says «로그아웃하는 중…» (Yuna — not a raw «...»)', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    await mount();
    await act(async () => { q('other-sessions-open')!.click(); });
    await flush();
    await act(async () => { q('other-sessions-confirm')!.click(); });
    expect(q('other-sessions-confirm')!.textContent).toBe('로그아웃하는 중…');
    await act(async () => { answer(new Response(JSON.stringify({ data: { sessions_ended: 0, kept_this: true } }), { status: 200 })); });
    await flush();
  });

  it('a failure is said inside the dialog, which stays for another try; no result line', async () => {
    await confirmWith(new Response(JSON.stringify({ error: { code: 'X' } }), { status: 502 }));
    expect(q('other-sessions-failed')!.textContent).toBe('로그아웃하지 못했어요 — 다시 시도해 주세요');
    expect(q('other-sessions-confirm')).not.toBeNull();
    expect(q('other-sessions-done')!.textContent).toBe('');
  });
});

describe('[SID:4630] the result line the server\'s answer picks', () => {
  const ko = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'settings' });
  const en = createTranslator({ locale: 'en', messages: enMessages, namespace: 'settings' });
  const say = (t: typeof ko, r: Parameters<typeof otherSessionsLine>[1]) => otherSessionsLine(t as never, r);

  it('ko: a count · none · unknown · not kept', () => {
    expect(say(ko, { sessions_ended: 1, kept_this: true })).toBe('다른 로그인 1개를 끝냈어요 — 길어야 1시간 안에 로그아웃되고, 이 브라우저는 그대로예요');
    expect(say(ko, { sessions_ended: 0, kept_this: true })).toBe('다른 곳의 로그인이 없었어요 — 이 브라우저는 그대로예요');
    expect(say(ko, { sessions_ended: null, kept_this: true })).toBe('다른 기기의 로그인을 모두 끝냈어요 — 길어야 1시간 안에 로그아웃되고, 이 브라우저는 그대로예요');
    expect(say(ko, { sessions_ended: 0, kept_this: false })).toBe('다른 기기의 로그인을 모두 끝냈어요 — 이 브라우저도 함께 끝나서 다시 로그인해야 해요');
  });

  it('en: one sign-in · several sign-ins (plural) · not kept', () => {
    expect(say(en, { sessions_ended: 1, kept_this: true })).toBe("Ended 1 other sign-in — it'll be signed out within an hour; this browser stays signed in");
    expect(say(en, { sessions_ended: 3, kept_this: true })).toBe("Ended 3 other sign-ins — they'll be signed out within an hour; this browser stays signed in");
    expect(say(en, { sessions_ended: 2, kept_this: false })).toBe("Ended every other sign-in — this browser's sign-in ended too, so please sign in again");
  });
});
