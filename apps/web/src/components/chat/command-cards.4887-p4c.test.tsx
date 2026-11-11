// @vitest-environment jsdom
//
// story 4887 (UI-4 P4-c) — the two small cards of a chat command are ds parts now: the hint that a runtime cannot take a command is a ds Banner (info) whose one action is a link,
// and the runtime-command bubble is a ds Card with a ds Chip. (The server-command card has its own tests; its outcome is a chip with words now.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommandHintNotice } from './command-hint-notice';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
const wrap = (el: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{el}</NextIntlClientProvider>;

describe('CommandHintNotice — a ds Banner (story 4887 · P4-c)', () => {
  it('⭐ the hint is a ds Banner (info tone, role=status) with the two sentences and ONE action: a link to the agent\'s settings', async () => {
    await act(async () => { root.render(wrap(<CommandHintNotice hint={{ agent_id: 'a-1', agent_name: '검수 에이전트', runtime_type: null, command: 'review', reason: 'unsupported' }} />)); });
    const banner = container.querySelector('[data-slot="ds-banner"]') as HTMLElement | null;
    expect(banner, 'the ds Banner').not.toBeNull(); // reverted (the hand-built box) → null
    expect(banner!.getAttribute('data-tone')).toBe('info');
    expect(banner!.getAttribute('role')).toBe('status');
    expect(banner!.textContent).toContain('검수 에이전트');
    const link = banner!.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('/organization/workforce/a-1');
    expect(link.textContent).toContain(koMessages.chats.commandBlockedSettings);
  });
});

describe('the runtime-command bubble — a ds Card with a ds Chip (story 4887 · P4-c)', () => {
  const message = (content: string): ChatMessage => ({
    id: 'm1', memo_id: 'c1', created_by: 'member-1', sender_name: '나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null,
    content, attachments: [], created_at: '2026-11-10T01:00:00.000Z',
  });
  it('⭐ «/review #12» is a ds Card holding the «커맨드» chip, the /name in mono and the args', async () => {
    await act(async () => { root.render(wrap(<ChatBubble message={message('/review #12 서둘러')} isMine />)); });
    const bubble = container.querySelector('[data-testid="command-bubble"]') as HTMLElement | null;
    expect(bubble, 'the command bubble').not.toBeNull();
    expect(bubble!.getAttribute('data-slot')).toBe('ds-card');
    expect(bubble!.querySelector('[data-slot="ds-chip"]')?.textContent).toBe(koMessages.chats.commandTag);
    expect(bubble!.querySelector('code')?.textContent).toBe('/review');
    expect(bubble!.textContent).toContain('서둘러');
  });
  it('a plain message is not a command bubble', async () => {
    await act(async () => { root.render(wrap(<ChatBubble message={message('안녕하세요')} isMine />)); });
    expect(container.querySelector('[data-testid="command-bubble"]')).toBeNull();
  });
});
