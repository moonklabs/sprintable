// @vitest-environment jsdom
//
// story 4831 (측정 중 찾은 기존 결함) — 한글 조합 중의 엔터는 «글자 확정 키»인데 채팅 입력이 발송으로 읽었다. 실제 Chromium 실측(전): 조합 중 엔터가 메시지를 보내고,
// 입력창이 비워진 뒤 확정된 마지막 음절(«요»)이 빈 입력창에 다시 남았다. 조합 중의 에스케이프는 조합 취소 키인데 «뒤로가기»(onEscape)로 읽혔다.
// 지키는 것: 조합 중(isComposing · keyCode 229)의 엔터는 발송하지 않고 기본 동작도 막지 않으며, 에스케이프는 onEscape를 안 부른다. 조합이 아닌 엔터는 발송, Shift+엔터는 발송 안 함.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
async function mount(onSend = vi.fn(async () => {}), onEscape = vi.fn()) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatInput threadId="c1" onSend={onSend} onEscape={onEscape} />
      </NextIntlClientProvider>,
    );
  });
  return { onSend, onEscape };
}
async function typeText(text: string) {
  const el = textarea();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  textarea().dispatchEvent(ev);
  return ev;
}

describe('ChatInput — 한글 조합 중 키 (story 4831 측정 중 발견)', () => {
  it('조합 중의 엔터는 발송하지 않고 기본 동작도 막지 않는다 · 입력은 그대로', async () => {
    const { onSend } = await mount();
    await typeText('안녕하세요');
    let ev!: KeyboardEvent;
    await act(async () => { ev = key('Enter', { isComposing: true }); });
    expect(onSend).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(textarea().value).toBe('안녕하세요');
  });

  it('keyCode 229(조합 중 키의 옛 표지)도 발송하지 않는다', async () => {
    const { onSend } = await mount();
    await typeText('안녕하세요');
    await act(async () => { key('Enter', { keyCode: 229 }); });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('조합이 끝난 뒤의 엔터는 발송한다(기본 동작은 막는다)', async () => {
    const { onSend } = await mount();
    await typeText('안녕하세요');
    let ev!: KeyboardEvent;
    await act(async () => { ev = key('Enter'); });
    await act(async () => { await Promise.resolve(); });
    expect(ev.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect((onSend.mock.calls[0] as unknown[])[0]).toBe('안녕하세요');
  });

  it('Shift+엔터는 발송하지 않는다(그대로)', async () => {
    const { onSend } = await mount();
    await typeText('줄바꿈');
    await act(async () => { key('Enter', { shiftKey: true }); });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('조합 중의 에스케이프는 onEscape(뒤로가기)를 부르지 않고, 조합이 아닌 에스케이프는 부른다', async () => {
    const { onEscape } = await mount();
    await act(async () => { key('Escape', { isComposing: true }); });
    expect(onEscape).not.toHaveBeenCalled();
    await act(async () => { key('Escape'); });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

// 같은 handleKeyDown 안의 고르기 창(멘션 · 명령 · 개체)도 같은 가드 뒤에 있다 — 한글 이름 멘션 «@김» 길로 확인한다.
// 조합 중의 엔터 · 방향키 · 에스케이프는 고르기 창을 건드리지 않고, 조합이 끝난 뒤의 엔터로는 고를 수 있다.
describe('ChatInput — 멘션 고르기 창과 한글 조합 («@김», story 4831 측정 중 발견)', () => {
  const MEMBERS = [
    { id: 'm-kim-1', name: '김철수', role: 'member', type: 'human' },
    { id: 'm-kim-2', name: '김영희', role: 'member', type: 'human' },
    { id: 'm-lee-1', name: '이수', role: 'member', type: 'human' },
  ];
  const options = () => [...document.body.querySelectorAll('[role="option"]')];
  const activeIndex = () => options().findIndex((o) => o.getAttribute('aria-selected') === 'true');
  async function mountWithMention() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: MEMBERS }), { status: 200 })));
    const onSend = vi.fn(async () => {});
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatInput threadId="c1" onSend={onSend} />
        </NextIntlClientProvider>,
      );
    });
    const el = textarea();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, '@김');
      el.selectionStart = 2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { onSend };
  }

  it('«@김»을 치면 김씨 둘만 뜨고 첫째가 고른 상태다', async () => {
    await mountWithMention();
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('김철수'), expect.stringContaining('김영희')]);
    expect(activeIndex()).toBe(0);
  });

  it('조합 중의 방향키 · 엔터 · 에스케이프는 고르기 창을 건드리지 않는다(후보 이동 · 선택 · 닫기 없음, 기본 동작도 막지 않음)', async () => {
    const { onSend } = await mountWithMention();
    let ev!: KeyboardEvent;
    await act(async () => { ev = key('ArrowDown', { isComposing: true }); });
    expect(activeIndex()).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { ev = key('Enter', { isComposing: true }); });
    expect(textarea().value).toBe('@김');
    expect(options()).toHaveLength(2);
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { key('Escape', { isComposing: true }); });
    expect(options()).toHaveLength(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('조합이 끝난 뒤에는 방향키로 옮기고 엔터로 골라 «@김영희 »가 본문에 들어간다', async () => {
    const { onSend } = await mountWithMention();
    await act(async () => { key('ArrowDown'); });
    expect(activeIndex()).toBe(1);
    let ev!: KeyboardEvent;
    await act(async () => { ev = key('Enter'); });
    expect(ev.defaultPrevented).toBe(true);
    expect(textarea().value).toBe('@김영희 ');
    expect(options()).toHaveLength(0);
    expect(onSend).not.toHaveBeenCalled(); // 고르기였지 발송이 아니다
  });

  it('조합이 끝난 뒤의 에스케이프는 고르기 창을 닫는다', async () => {
    await mountWithMention();
    await act(async () => { key('Escape'); });
    expect(options()).toHaveLength(0);
  });
});
