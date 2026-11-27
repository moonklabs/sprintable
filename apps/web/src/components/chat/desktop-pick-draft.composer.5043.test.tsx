// @vitest-environment jsdom
//
// story 5043 (C10 ⑥) · PO 11-27 — the desktop app hands the room's composer a draft made from a picked element (contracts/desktop-pick-draft.json); the composer only FILLS it: the text lands as it is (every line · every character) and NOTHING is sent
// until the person presses send. (The older tests of `prefillCommand` pin the fill; this one adds the two things this story relies on: the words are kept exactly, and the send callback is never called by a fill.)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../..', 'contracts', 'desktop-pick-draft.json'), 'utf8')) as { cases: Array<{ name: string; draft: { ko: string; en: string } }> };

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('[SID:5043 ⑥] the composer takes a picked-element draft as it is and sends nothing', () => {
  it('⭐every draft of the contract fills the box exactly (all lines, every character) and the send callback is not called', async () => {
    for (const c of C.cases) {
      const onSend = vi.fn();
      const d = c.draft.ko;
      await act(async () => {
        root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatInput threadId={`c-${c.name}`} onSend={onSend} prefillCommand={{ text: d, nonce: 1 }} /></NextIntlClientProvider>);
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      const box = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(box.value, c.name).toBe(d);
      expect(onSend, `${c.name}: a fill never sends`).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });
});
