// @vitest-environment jsdom
//
// story 5043 (C10 ⑥) · PO 11-27 — the desktop app lets a person point at an element of the shared browser; the words that go into the room's composer (the person reads them, then sends) are made by the app (desktop-electron/src/agent-browser/pick-model.ts)
// and come from a page the agent browses — a page that may be hostile. This is the web's side of the contract file `contracts/desktop-pick-draft.json` (the mobile repository keeps it; this copy is byte for byte):
//   · the composer takes the draft as plain text and only FILLS it — nothing is sent until the person presses send (the address route `?compose=` and `ChatInput.prefillCommand` are the web's own, older mechanism);
//   · once sent, the message is drawn by the chat's own renderer as PLAIN text: no link, no mention, no work-item chip, no image, no markup — whatever the page wrote.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import { seedFromCompose, MAX_COMPOSE_LENGTH } from '@/components/chat-v3/chat-v3-compose';
import { buildFirstInstructionTarget } from '@/app/onboarding/first-instruction/first-instruction-redirect';
import { DEFAULT_NAV_V3_FLAGS } from '@/lib/nav-v3-destinations';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const ROOT = path.resolve(__dirname, '../../../../..');
const RAW = readFileSync(path.join(ROOT, 'contracts', 'desktop-pick-draft.json'));
const SHA = '23cc1704e98729319f42132e1d7a7cebb429cdcbb717ce29e32e1d39ea92105b'; // the mobile repository's contracts/desktop-pick-draft.json — a copy that drifts is a failure, not a quiet divergence
const C = JSON.parse(RAW.toString('utf8')) as { cases: Array<{ name: string; draft: { ko: string; en: string } }> };

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const message = (content: string): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by: 'member-2', sender_name: '유나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null,
  content, attachments: [], created_at: '2026-11-27T00:00:00.000Z',
}) as ChatMessage;

describe('[SID:5043 ⑥] contracts/desktop-pick-draft.json — the web side', () => {
  it('the file is the mobile repository\'s byte for byte', () => {
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(SHA);
    expect(C.cases.length).toBeGreaterThanOrEqual(6);
  });

  it('⭐every draft is within the composer\'s limit and goes through the address and back unchanged (`?compose=` · both shells) — nothing is cut, nothing is decoded into something else', () => {
    for (const c of C.cases) for (const lang of ['ko', 'en'] as const) {
      const d = c.draft[lang];
      expect(d.length, `${c.name} ${lang}`).toBeLessThanOrEqual(MAX_COMPOSE_LENGTH);
      expect(seedFromCompose(d)).toEqual({ draft: d, tooLong: false });
      for (const chatV3Enabled of [false, true]) {
        const { path: p, tooLong } = buildFirstInstructionTarget('97470487-345a-4e85-9c45-cdf901737adb', d, { ...DEFAULT_NAV_V3_FLAGS, chatV3Enabled });
        expect(tooLong).toBe(false);
        const compose = new URL(p, 'https://web.example').searchParams.get('compose');
        expect(compose, `${c.name} ${lang} v3=${chatV3Enabled}`).toBe(d);
      }
    }
  });

  it('⭐a draft that is sent is drawn as PLAIN text: no link · no mention · no work-item chip · no image · no markup — however hostile the page words are (put a plain-text rule back out of the app and this is RED)', async () => {
    for (const c of C.cases) {
      for (const lang of ['ko', 'en'] as const) {
        const d = c.draft[lang];
        await act(async () => {
          root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatBubble message={message(d)} isMine={false} isGrouped={false} /></NextIntlClientProvider>);
        });
        const body = container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement;
        expect(body, `${c.name} ${lang}`).not.toBeNull();
        const acted = body.querySelectorAll('a, img, button, input, iframe, script, strong, em, del, code, pre, table, blockquote, h1, h2, h3, h4, h5, h6, [data-mention], [data-entity-ref]');
        expect([...acted].map((e) => e.tagName), `${c.name} ${lang}: something acts`).toEqual([]);
        // every quoted line of the draft reads exactly as the app wrote it
        for (const line of d.split('\n').filter((l) => l.startsWith('- '))) expect(body.textContent, `${c.name} ${lang}`).toContain(line.slice(2));
      }
    }
  });
});
