// @vitest-environment jsdom
//
// story 5043 (C10 · PO 11-28) — two presses of Send in one breath (a double click · Enter held) made TWO messages: the guard against a second send was a React state, and both presses ran before it was drawn
// (the live walk saw two copies in the room). The guard is now a flag read at once. The real ChatInput; the send hangs until the test lets it go.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
const sendButton = () => container.querySelector('[data-testid="chat-send"]') as HTMLButtonElement;

async function mount(onSend: (c: string) => Promise<void>) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatInput threadId="c1" onSend={onSend as never} prefillCommand={{ text: 'one line', nonce: 0 }} />
      </NextIntlClientProvider>,
    );
  });
}

describe('ChatInput — one press of Send is one send (5043)', () => {
  it('⭐ two presses in the same breath call the send ONCE (the guard is a flag, not a state that is drawn later)', async () => {
    let release: () => void = () => undefined;
    const onSend = vi.fn(() => new Promise<void>((r) => { release = r; }));
    await mount(onSend);
    expect(textarea().value).toBe('one line');
    await act(async () => { sendButton().click(); sendButton().click(); }); // (one act: both before React draws the «sending» state)
    expect(onSend).toHaveBeenCalledTimes(1); // reverted (state guard only) → 2 → RED
    await act(async () => { release(); await Promise.resolve(); });
  });

  it('⭐ the guard lets go when the send ends — a failed send can be pressed again, and the box was not emptied by it', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(undefined);
    await mount(onSend as never);
    await act(async () => { sendButton().click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('one line'); // a failed send keeps the words
    await act(async () => { sendButton().click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(2); // reverted (the flag is never let go) → stays 1 → RED
    expect(textarea().value).toBe('');
  });

  it('⭐ a failed UPLOAD releases the guard too (the early return): the person can press Send again', async () => {
    const onUploadFile = vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValue({ url: 'https://files/a.txt', name: 'a.txt', content_type: 'text/plain', size: 1 });
    const onSend = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatInput threadId="c1" onSend={onSend as never} onUploadFile={onUploadFile as never} prefillCommand={{ text: 'with a file', nonce: 0 }} />
        </NextIntlClientProvider>,
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await act(async () => { Object.defineProperty(input!, 'files', { value: [file], configurable: true }); input!.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { sendButton().click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { sendButton().click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onUploadFile).toHaveBeenCalledTimes(2); // reverted (the early return keeps the flag) → still 1 → RED
  });
});

// the STEER send (a separate road: «방향 전환») has the same two-presses problem and the same flag
describe('ChatInput — two presses of the STEER send publish ONCE (5043)', () => {
  it('⭐ two presses in one breath publish the instruction once', async () => {
    let publishes = 0; let release: () => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/events/publish' && init?.method === 'POST') { publishes += 1; await new Promise<void>((r) => { release = r; }); return new Response(JSON.stringify({ data: { conversation_id: 'c1', message_id: 'm1' } }), { status: 201 }); }
      return new Response(JSON.stringify({ data: [] }));
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={[{ member_id: 'me', name: '나' }, { member_id: 'u1', name: '동료1' }]} projectId="p1" />
        </NextIntlClientProvider>,
      );
    });
    const toggle = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '방향 전환') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    const setter = (el: HTMLElement, v: string) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
    await act(async () => { setter(textarea(), 'go to A'); });
    await act(async () => { setter(container.querySelector('select') as HTMLSelectElement, 'u1'); });
    await act(async () => { sendButton().click(); sendButton().click(); });
    expect(publishes).toBe(1); // reverted (state guard only) → 2 → RED
    await act(async () => { release(); await Promise.resolve(); });
  });
});
