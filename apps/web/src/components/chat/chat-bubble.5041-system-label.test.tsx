// @vitest-environment jsdom
//
// story 5041 (PO 11-27, QA lap on dev) — «시스템 발행» is the SERVER's own voice (the approval result line): it is not an agent a person talks to, so its head line carries no «에이전트» chip.
// An ordinary agent keeps the chip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const message = (runtime: string | null): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by: 'other-1', sender_name: '발신자', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: runtime,
  content: '안녕하세요', attachments: [], created_at: '2026-11-10T01:00:00.000Z',
});
async function render(runtime: string | null) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatBubble message={message(runtime)} isMine={false} isGrouped={false} /></NextIntlClientProvider>);
  });
}
// the head line is the element that holds the sender's name
const headLine = () => (Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '발신자') as HTMLElement).parentElement as HTMLElement;

describe('ChatBubble — the agent chip is not put on the system sender (story 5041)', () => {
  it('an ordinary agent keeps the «에이전트» chip', async () => {
    await render('claude-code');
    expect(headLine().textContent).toContain(koMessages.chats.agent);
  });

  it('⭐ the system publisher («시스템 발행») carries no agent chip — put the check back and this goes RED', async () => {
    await render('system-publisher');
    expect(headLine().textContent).not.toContain(koMessages.chats.agent);
    expect(headLine().textContent).toContain('발신자');
  });
});
