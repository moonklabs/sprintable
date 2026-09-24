// @vitest-environment jsdom
//
// story #4263 AC2 — 모바일 탭바 결재 대기 수: 사이드바와 같은 게이트 SSE 구독(#4245 워터마크 판정 공유)으로 라이브 갱신하고, SSE가 살아 있으면
// 창 포커스 재조회를 생략한다(죽었으면 유지).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { muxState } = vi.hoisted(() => ({ muxState: { alive: false, handlers: {} as Record<string, (data: string) => void> } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/flow' }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({
    isAlive: () => muxState.alive,
    subscribe: (name: string, h: (data: string) => void) => { muxState.handlers[name] = h; return () => { delete muxState.handlers[name]; }; },
    subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let countCalls = 0;
let serverCount = 2;

beforeEach(async () => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  countCalls = 0; serverCount = 2; muxState.alive = false; muxState.handlers = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/gates/designated-pending-count')) {
      countCalls += 1;
      return new Response(JSON.stringify({ count: serverCount }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const { resetDesignatedPendingCountStateForTest } = await import('@/lib/designated-pending-count-client');
  resetDesignatedPendingCountStateForTest();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><MobileTabBar chatUnreadTotal={0} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

describe('MobileTabBar — 결재 대기 수 SSE 라이브 · 생존 시 포커스 재조회 생략(#4263)', () => {
  it('⭐SSE가 살아 있으면 창 포커스 재조회 0', async () => {
    await mount();
    countCalls = 0; muxState.alive = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(countCalls).toBe(0);
  });

  it('SSE가 죽었으면 창 포커스 재조회 1(회귀 0)', async () => {
    await mount();
    countCalls = 0; muxState.alive = false;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(countCalls).toBe(1);
  });

  it('⭐게이트 SSE 이벤트(승인 · 위임 · 토스)를 구독하고, 이벤트가 오면 다시 물어 배지가 바뀐다', async () => {
    await mount();
    expect(Object.keys(muxState.handlers).sort()).toEqual(['conversation.gate_delegated', 'conversation.gate_resolved', 'conversation.gate_tossed']);
    expect(container.querySelector('span[aria-hidden]')?.textContent).toBe('2');
    serverCount = 1;
    await act(async () => { muxState.handlers['conversation.gate_resolved']!(JSON.stringify({ gate_id: 'g-1' })); });
    await flush();
    expect(container.querySelector('span[aria-hidden]')?.textContent).toBe('1');
  });
});
