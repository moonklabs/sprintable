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
vi.mock('next/image', () => ({ default: () => null }));
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
async function render(m: ChatMessage, defs?: Record<string, { name?: string; block_template?: unknown; payload_schema?: unknown }>) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ChatBubble message={m} isMine={false} isGrouped={false} eventDefinitionsByKey={defs as never} />
    </NextIntlClientProvider>);
  });
}
const text = () => (container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement | null)?.textContent ?? '';
const LEAK = /\[이벤트\]|preset\.|work_item|\bstage:|97470487/;

const items = () => Array.from(container.querySelectorAll('[data-testid="event-text-fallback"] li')).map((li) => li.textContent);
const head = () => container.querySelector('[data-testid="event-text-fallback"] p')?.textContent;

describe('ChatBubble — an event message drawn as text (story 4921 · PO 11-13: the body keeps what happened)', () => {
  it('⭐no definition (the read failed): head «이벤트» + the person\'s words + the other fields as a readable list — no header line · no raw key names', async () => {
    await render(msg(MACHINE('org.acme.signup'), { event_key: 'org.acme.signup', payload: { message: '새 가입이 들어왔어요', plan_name: 'team', work_item_id: UUID }, refs: { work_item: { found: true, name: '가입 흐름 정리' } } } as never));
    expect(head()).toBe('이벤트');
    expect(text()).toContain('새 가입이 들어왔어요');
    expect(items()).toEqual(['plan name: team', '대상: 가입 흐름 정리']); // key made readable · the card's own word «대상» · the id shown as the NAME the refs carry
    expect(text()).not.toMatch(/\[이벤트\]|org\.acme|plan_name|work_item_id|97470487/);
  });
  it('⭐label order: the definition schema title wins over the card word and the humanized key', async () => {
    await render(msg(MACHINE('org.acme.signup'), { event_key: 'org.acme.signup', payload: { plan_name: 'team', note: '확인 필요' }, refs: {} } as never), {
      'org.acme.signup': { name: '가입 알림', block_template: null, payload_schema: { properties: { plan_name: { title: '요금제' }, note: { title: '비고' } } } },
    });
    expect(head()).toBe('가입 알림');
    expect(text()).toContain('확인 필요'); // `note` is a words field: shown whole, not in the list
    expect(items()).toEqual(['요금제: team']);
  });
  it('⭐a definition without a card template: its human NAME as the head, the fields still listed', async () => {
    await render(msg(MACHINE('preset.workflow.kanban'), { event_key: 'preset.workflow.kanban', payload: { stage: 'ready', work_item_id: UUID }, refs: {} } as never), { 'preset.workflow.kanban': { name: '칸반 워크플로우', block_template: null } });
    expect(head()).toBe('칸반 워크플로우');
    expect(items()).toEqual(['stage: ready', `대상: ${UUID}`]);
    expect(text()).not.toMatch(/\[이벤트\]|preset\./);
  });
  it('⭐«이벤트» ALONE only when the event has no field at all', async () => {
    await render(msg(MACHINE('org.acme.ping'), { event_key: 'org.acme.ping', payload: {}, refs: {} } as never));
    expect(text()).toBe('이벤트');
    expect(items()).toEqual([]);
  });
  it('an ordinary message and an event whose content a person wrote are left as written', async () => {
    await render(msg('그냥 글입니다'));
    expect(text()).toContain('그냥 글입니다');
    await render(msg('발행이 멈췄어요. 작업 상세에서 다시 시도해 주세요.', { event_key: 'preset.recipe.publish_failed', payload: {}, refs: {} } as never));
    expect(text()).toContain('발행이 멈췄어요');
  });
  it('⭐an OLD event message with no `event` at all: head «이벤트», no machine text', async () => {
    await render(msg(MACHINE('preset.workflow.kanban')));
    expect(text()).toBe('이벤트');
    expect(text()).not.toMatch(LEAK);
  });
  it('⭐a steer drawn as text: the steer sentence WITH the target name as the head (the same sentence as the room list)', async () => {
    await render(msg(MACHINE('preset.steer.instruct'), { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요', target_member_id: UUID }, refs: { target: { found: true, name: '미르코' } } } as never));
    expect(head()).toBe('방향 전환 · 먼저 봐 주세요 → 미르코');
    expect(items()).toEqual(['지시 대상자: 미르코']);
  });
});
