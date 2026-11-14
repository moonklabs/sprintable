// @vitest-environment jsdom
//
// story 4925 — the person's words in an event bubble (drawn as text) are drawn like any chat message: a reference written as a link («[이 일감](entity:story:<id>)») is the same chip / label, never the raw «[…](entity:story:97470487-…)».
// Where there is no chat renderer (the v3 room's plain text) the link reads as its label.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import { EventTextFallback } from './event-text-fallback';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const NOTE = `[이 일감](entity:story:${UUID}) 배포를 확인했어요`;
const CONTENT = `[이벤트] org.acme.deploy\n- note: ${NOTE}`;
const msg: ChatMessage = {
  id: 'm1', memo_id: 'conv-1', created_by: 'agent-1', sender_name: '시스템', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content: CONTENT, attachments: [], created_at: '2026-11-14T00:00:00.000Z',
  event: { event_key: 'org.acme.deploy', payload: { note: NOTE }, refs: {} } as never,
};
const LEAK = /entity:|97470487|\]\(|\[이벤트\]|org\.acme/;

describe('the words of an event bubble', () => {
  it('⭐the chat bubble draws the link like any message (the chip with its label): the raw link text and the id do not show', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatBubble message={msg} isMine={false} isGrouped={false} eventDefinitionsByKey={{ 'org.acme.deploy': { name: '배포 확인', block_template: null } } as never} />
      </NextIntlClientProvider>);
    });
    const body = container.querySelector('[data-testid="event-text-fallback"]') as HTMLElement;
    expect(body.querySelector('p')?.textContent).toBe('배포 확인');
    expect(body.querySelector('button [title="이 일감"]'), 'the reference is the chat chip').not.toBeNull();
    expect(body.textContent).toContain('이 일감');
    expect(body.textContent).toContain('배포를 확인했어요');
    expect(body.textContent).not.toMatch(LEAK);
  });
  it('⭐without a chat renderer (the v3 room) the words are plain text and the link reads as its label', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <EventTextFallback content={CONTENT} eventKey="org.acme.deploy" payload={{ note: NOTE }} />
      </NextIntlClientProvider>);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('이 일감 배포를 확인했어요');
    expect(container.querySelector('button')).toBeNull(); // plain text: no chip
    expect(text).not.toMatch(LEAK);
  });
});
