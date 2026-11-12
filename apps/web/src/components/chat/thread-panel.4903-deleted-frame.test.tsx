// @vitest-environment jsdom
//
// story 4903 AC3 — ANOTHER person deletes a REPLY of the thread this panel has open: the server's frame (the local announcement with the message's id) turns that reply into the tombstone at once.
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
const wrap = (node: React.ReactNode) => (<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
const msg = (o: Partial<ChatMessage> & { id: string; created_by: string; content: string }): ChatMessage => ({
  memo_id: 'conv-1', sender_name: o.created_by === 'me-1' ? '나' : '유나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, attachments: [], created_at: '2026-11-11T00:00:00.000Z', ...o,
}) as ChatMessage;
const parent = msg({ id: 'p1', created_by: 'me-1', content: '내 원본 글' });
const REPLIES = [
  msg({ id: 'r-mine', parent_id: 'p1', created_by: 'me-1', content: '내 답글', created_at: '2026-11-11T00:01:00.000Z' }),
  msg({ id: 'r-other', parent_id: 'p1', created_by: 'other-1', content: '남의 답글 — 곧 지워질 글', created_at: '2026-11-11T00:02:00.000Z' }),
] as ChatMessage[];

beforeEach(async () => {
  forgetKnownDeletedForTests(); // what an earlier test deleted is remembered by the module: each test starts clean
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('thread_id=') ? { ok: true, status: 200, json: async () => ({ data: REPLIES }) } : { ok: true, status: 200, json: async () => ({ data: [] }) })));
  await act(async () => { root.render(wrap(<ThreadPanel parentMessage={parent} conversationId="conv-1" currentTeamMemberId="me-1" projectId="proj-1" onClose={() => {}} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const frame = (o: { conversationId?: string; messageId?: string | undefined }) => announceChatMessageDeleted({
  conversationId: o.conversationId ?? 'conv-1', createdAt: '2026-11-11T00:02:00.000Z', ...('messageId' in o ? { messageId: o.messageId } : { messageId: 'r-other' }), threadId: 'p1', deletedAt: '2026-11-12T01:05:00.000Z',
});

describe('ThreadPanel — a reply another person deleted turns into a tombstone without a reload (story 4903 AC3)', () => {
  it('⭐ the frame turns THAT reply into the tombstone; the other reply is untouched', async () => {
    expect(container.textContent).toContain('남의 답글 — 곧 지워질 글');
    await act(async () => { frame({}); });
    expect(container.textContent).not.toContain('남의 답글 — 곧 지워질 글'); // reverted (the panel does not listen) → the words stay
    expect(container.textContent).toContain(koMessages.chats.deletedMessagePlaceholder);
    expect(container.textContent).toContain('내 답글');
  });

  it('a frame for another room · or one without a message id changes nothing', async () => {
    await act(async () => { frame({ conversationId: 'other-room' }); frame({ messageId: undefined }); });
    expect(container.textContent).toContain('남의 답글 — 곧 지워질 글'); // reverted (matches any room) → the words go
    expect(container.textContent).not.toContain(koMessages.chats.deletedMessagePlaceholder);
  });
});
