// @vitest-environment jsdom
//
// story 4946 — the real ChatInput attaches the files the ROOM took (`incomingFiles`) the way it attaches its own drops: as pending-file chips, once per `nonce`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const chips = () => [...container.querySelectorAll('span.max-w-40')].map((s) => s.textContent);
const file = (name: string) => new File(['x'], name, { type: 'application/pdf' });
async function render(incoming: { nonce: number; files: File[] } | null) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatInput threadId="c1" onSend={vi.fn()} projectId="p1" incomingFiles={incoming} /></NextIntlClientProvider>); });
}

describe('ChatInput — incomingFiles (4946)', () => {
  it('⭐files the room took become pending-file chips', async () => {
    await render(null); expect(chips()).toEqual([]);
    await render({ nonce: 1, files: [file('a.pdf'), file('b.pdf')] });
    expect(chips()).toEqual(['a.pdf', 'b.pdf']); // reverted (the prop ignored) → RED
  });
  it('⭐once per nonce: a re-render with the same set adds nothing; a new nonce adds again (the same file dropped twice counts twice)', async () => {
    const set1 = { nonce: 1, files: [file('a.pdf')] };
    await render(set1); await render(set1); await render({ ...set1 });
    expect(chips()).toEqual(['a.pdf']);
    await render({ nonce: 2, files: [file('a.pdf')] });
    expect(chips()).toEqual(['a.pdf', 'a.pdf']);
  });
  it('the files already attached are kept (the same way the composer\'s own drops add)', async () => {
    await render({ nonce: 1, files: [file('one.pdf')] });
    await render({ nonce: 2, files: [file('two.pdf')] });
    expect(chips()).toEqual(['one.pdf', 'two.pdf']);
  });
});
