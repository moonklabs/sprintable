// @vitest-environment jsdom
//
// story 4906 (lap 3) — the real ChatInput tells its owner the WHOLE text of the box whenever it changes (`onDraftChange`): the room's «moved from 홈» note lives on that report.
// The prefilled text is reported, so is the box being emptied; the first report is the empty box before the prefill lands (the owner must not read that as «cleared»).
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

async function mount(onDraftChange: (t: string) => void, prefill: { text: string; nonce: number } | null) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatInput threadId="c1" onSend={vi.fn()} prefillCommand={prefill} onDraftChange={onDraftChange} />
      </NextIntlClientProvider>,
    );
  });
}

describe('ChatInput — onDraftChange (4906)', () => {
  it('⭐ reports the box empty first, then the prefilled text, then empty again when the person clears it', async () => {
    const seen: string[] = [];
    await mount((t) => seen.push(t), { text: '릴리스 점검해 줘', nonce: 0 });
    expect(seen[0]).toBe(''); // the owner has to be able to tell this first, empty report from «cleared» (it waits for text first)
    expect(seen).toContain('릴리스 점검해 줘'); // reverted (not reported) → RED
    expect(textarea().value).toBe('릴리스 점검해 줘');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea(), ''); textarea().dispatchEvent(new Event('input', { bubbles: true })); });
    expect(seen[seen.length - 1]).toBe('');
  });

  it('without a callback nothing changes (the prop is optional)', async () => {
    await mount(undefined as unknown as (t: string) => void, null);
    expect(textarea().value).toBe('');
  });
});
