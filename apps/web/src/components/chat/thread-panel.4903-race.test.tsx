// @vitest-environment jsdom
//
// story 4903 AC3 — a REPLY deleted by another person while the replies fetch is still in flight: the late response must not bring the text back (the panel re-applies what is known deleted before paint).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ThreadPanel } from './thread-panel';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import { announceChatMessageDeleted, forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'me-1' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('./chat-input', () => ({ ChatInput: () => <textarea data-testid="mock-composer" /> }));

let container: HTMLDivElement;
let root: Root;
const msg = (o: Partial<ChatMessage> & { id: string; created_by: string; content: string }): ChatMessage => ({
  memo_id: 'conv-1', sender_name: '유나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, attachments: [], created_at: '2026-11-11T00:00:00.000Z', ...o,
}) as ChatMessage;
const parent = msg({ id: 'p1', created_by: 'me-1', content: '내 원본 글' });
const REPLY = msg({ id: 'r-other', parent_id: 'p1', created_by: 'other-1', content: '남의 답글 — 곧 지워질 글', created_at: '2026-11-11T00:02:00.000Z' });

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); forgetKnownDeletedForTests(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); forgetKnownDeletedForTests(); });

describe('ThreadPanel — a delete that arrives while the replies fetch is in flight (story 4903 AC3)', () => {
  it('⭐ the frame arrives BEFORE the replies resolve: the late response does not bring the words back', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('thread_id=')) { await gate; return { ok: true, status: 200, json: async () => ({ data: [REPLY] }) }; }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ThreadPanel parentMessage={parent} conversationId="conv-1" currentTeamMemberId="me-1" projectId="proj-1" onClose={() => {}} /></NextIntlClientProvider>); });
    await act(async () => { announceChatMessageDeleted({ conversationId: 'conv-1', createdAt: REPLY.created_at, messageId: 'r-other', threadId: 'p1', deletedAt: '2026-11-12T01:05:00.000Z' }); });
    release();
    for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.textContent).not.toContain('남의 답글 — 곧 지워질 글'); // reverted (the panel only tombstones what it already holds) → the words are back
    expect(container.textContent).toContain(koMessages.chats.deletedMessagePlaceholder);
  });
});
