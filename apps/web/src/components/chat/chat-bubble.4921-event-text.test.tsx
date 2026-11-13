// @vitest-environment jsdom
//
// story 4921 (second PR) — an event message drawn as TEXT (its definition has no card template, or the definitions could not be read) shows the definition's name + the person's words, or the one word «이벤트» —
// never the machine text an agent reads («[이벤트] preset.x», «- key: value» lines). With a template the card is drawn as before; an ordinary message is untouched.
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
vi.mock('next/image', () => ({ default: ({ src, alt }: { src?: string; alt?: string }) => /* eslint-disable-next-line @next/next/no-img-element */ <img src={src} alt={alt} /> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const MACHINE = (key: string) => `[이벤트] ${key}\n- stage: ready\n- work_item_id: ${UUID}`;
const msg = (content: string, event?: ChatMessage['event']): ChatMessage => ({
  id: 'm1', memo_id: 'conv-1', created_by: 'agent-1', sender_name: '시스템', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content, attachments: [], created_at: '2026-11-13T01:00:00.000Z', ...(event ? { event } : {}),
});
async function render(m: ChatMessage, defs?: Record<string, { name?: string; block_template?: unknown }>) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ChatBubble message={m} isMine={false} isGrouped={false} eventDefinitionsByKey={defs as never} />
    </NextIntlClientProvider>);
  });
}
const text = () => (container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement | null)?.textContent ?? '';
const LEAK = /\[이벤트\]|preset\.|work_item|\bstage:|97470487/;

describe('ChatBubble — an event message drawn as text (story 4921)', () => {
  it('⭐no definition (the read failed): «이벤트» + the person\'s words — no slug · id · key: value', async () => {
    await render(msg(MACHINE('org.acme.signup'), { event_key: 'org.acme.signup', payload: { message: '새 가입이 들어왔어요', work_item_id: UUID }, refs: {} } as never));
    expect(text()).toBe('이벤트 · 새 가입이 들어왔어요');
    expect(text()).not.toMatch(LEAK);
  });
  it('⭐a definition without a card template: its human NAME', async () => {
    await render(msg(MACHINE('preset.workflow.kanban'), { event_key: 'preset.workflow.kanban', payload: { stage: 'ready' }, refs: {} } as never), { 'preset.workflow.kanban': { name: '칸반 워크플로우', block_template: null } });
    expect(text()).toBe('칸반 워크플로우');
    expect(text()).not.toMatch(LEAK);
  });
  it('an ordinary message and an event whose content a person wrote are left as written', async () => {
    await render(msg('그냥 글입니다'));
    expect(text()).toContain('그냥 글입니다');
    await render(msg('발행이 멈췄어요. 작업 상세에서 다시 시도해 주세요.', { event_key: 'preset.recipe.publish_failed', payload: {}, refs: {} } as never));
    expect(text()).toContain('발행이 멈췄어요');
  });
});
