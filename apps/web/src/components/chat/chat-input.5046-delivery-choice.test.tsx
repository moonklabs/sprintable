// @vitest-environment jsdom
//
// story 5046 (C13) — the choice «지금 끼어들기 / 끝나고 이어서» above the input. Red when: it is drawn without a working agent the message would reach (a group line that calls nobody · nothing typed · an agent that
// is not working · steer mode) · «지금» stops being the default · the send carries the word for the default · an after-turn pick is not sent (or is sent when the choice is not drawn any more) · a pick outlives its send ·
// the one-line «cannot interrupt» (OpenCode) is missing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

type SendSpy = ReturnType<typeof vi.fn<(content: string, mentionedIds?: string[], attachments?: unknown[], deliveryMode?: 'after_turn') => Promise<void>>>;
const newSpy = (): SendSpy => vi.fn<(content: string, mentionedIds?: string[], attachments?: unknown[], deliveryMode?: 'after_turn') => Promise<void>>(async () => {});

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ME = { member_id: 'me-1', name: '나' };
const A1 = { member_id: 'a-1', name: '미르코' };
const A2 = { member_id: 'a-2', name: '카디르' };
const WORKING = [{ id: 'a-1', name: '미르코', runtimeType: 'claude-code' }];

async function mount(o: { participants: { member_id: string; name: string }[]; working?: { id: string; name: string; runtimeType: string | null }[]; onSend?: SendSpy }) {
  const onSend = o.onSend ?? newSpy();
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatInput threadId="c1" onSend={onSend} participants={o.participants} currentTeamMemberId="me-1" workingAgents={o.working} />
      </NextIntlClientProvider>,
    );
  });
  return onSend;
}
const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
const type = async (v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(textarea(), v); textarea().dispatchEvent(new Event('input', { bubbles: true })); });
};
const choice = () => container.querySelector('[data-testid="delivery-choice"]');
const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
const send = async () => { await act(async () => { (container.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click(); }); for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };

describe('when the choice is drawn', () => {
  it('a 1:1 with a WORKING agent and something typed → drawn, «지금» pressed', async () => {
    await mount({ participants: [ME, A1], working: WORKING });
    expect(choice()).toBeNull(); // nothing typed yet
    await type('이것도 봐 줘');
    expect(choice()).not.toBeNull();
    expect(btn('지금 끼어들기').getAttribute('aria-pressed')).toBe('true');
  });
  it('not drawn for an agent that is NOT working, nor for a room with no working-agent list', async () => {
    await mount({ participants: [ME, A1], working: [] });
    await type('hi'); expect(choice()).toBeNull();
    await mount({ participants: [ME, A1], working: undefined });
    await type('hi again'); expect(choice()).toBeNull();
  });
  it('a group line that calls nobody does not reach the working agent → not drawn', async () => {
    await mount({ participants: [ME, A1, A2], working: WORKING });
    await type('to everyone'); expect(choice()).toBeNull();
  });
});

describe('what the send carries', () => {
  it('the default sends NO delivery word (the 4th argument is absent — «지금» is the server\'s default)', async () => {
    const onSend = await mount({ participants: [ME, A1], working: WORKING });
    await type('now please'); await send();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![3]).toBeUndefined();
  });
  it('«끝나고 이어서» sends `after_turn` — and the pick is for ONE message: «지금» is back after the send', async () => {
    const onSend = await mount({ participants: [ME, A1], working: WORKING });
    await type('later please');
    await act(async () => { btn('끝나고 이어서').click(); });
    expect(btn('끝나고 이어서').getAttribute('aria-pressed')).toBe('true');
    await send();
    expect(onSend.mock.calls[0]![3]).toBe('after_turn');
    await type('and now this');
    expect(btn('지금 끼어들기').getAttribute('aria-pressed')).toBe('true');
    await send();
    expect(onSend.mock.calls[1]![3]).toBeUndefined();
  });
  it('a pick made while the agent was working is NOT sent once the choice is gone (the agent stopped working before the send)', async () => {
    const onSend = newSpy();
    await mount({ participants: [ME, A1], working: WORKING, onSend });
    await type('later please');
    await act(async () => { btn('끝나고 이어서').click(); });
    await mount({ participants: [ME, A1], working: [], onSend }); // the same composer, the agent is idle now
    expect(choice()).toBeNull();
    await send();
    expect(onSend.mock.calls[0]![3]).toBeUndefined();
  });
});

describe('the one-line «cannot interrupt»', () => {
  it('OpenCode while «지금» is on: one line naming it; «끝나고 이어서» takes it away', async () => {
    await mount({ participants: [ME, A1], working: [{ id: 'a-1', name: '미르코', runtimeType: 'opencode' }] });
    await type('hi');
    expect(container.querySelector('[data-testid="delivery-choice-note"]')!.textContent).toBe('지금 끼어들 수 없는 에이전트: 미르코 — 끝난 뒤 전해요');
    await act(async () => { btn('끝나고 이어서').click(); });
    expect(container.querySelector('[data-testid="delivery-choice-note"]')).toBeNull();
  });
  it('another runtime: no line', async () => {
    await mount({ participants: [ME, A1], working: WORKING });
    await type('hi'); expect(container.querySelector('[data-testid="delivery-choice-note"]')).toBeNull();
  });
});
