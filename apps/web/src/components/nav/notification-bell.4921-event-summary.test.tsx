// @vitest-environment jsdom
//
// story 4921 (second PR) — the bell's line for an event message: a row stored in the machine shape «{sender}: [이벤트] preset.x …» (what the server wrote before it wrote the human line) reads
// «{sender}: 이벤트[ · the person's words]»; a row the server wrote with the human line is shown as it is. Never a slug, an id or a «- key: value» line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell } = await import('./notification-bell');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const row = (id: string, payload: Record<string, unknown>) => ({
  id, event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: `${id}-m`, payload, read_at: null, created_at: '2026-11-13T07:14:14Z',
});
const ITEMS = [
  row('old-stage', { summary: `시스템 발행: [이벤트] preset.workflow.kanban\n- stage: ready\n- work_item_id: ${UUID}`, event: { event_key: 'preset.workflow.kanban', payload: { stage: 'ready', work_item_id: UUID } } }),
  row('old-steer', { summary: `페드루: [이벤트] preset.steer.instruct\n- instruction: 먼저 봐 주세요\n- target_member_id: ${UUID}`, event: { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요', target_member_id: UUID } } }),
  row('old-no-card', { summary: '시스템 발행: [Event] org.x.y\n- a: b' }),
  row('new-human', { summary: '페드루: 방향 전환 · 먼저 봐 주세요 → 미르코', event: { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요' } } }),
  row('plain', { summary: '미르코: 안녕하세요' }),
];

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) return new Response(JSON.stringify({ data: ITEMS, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ count: ITEMS.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openBell(locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>); });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const headlines = () => Array.from(document.querySelectorAll('[data-dropdown-panel="notification-bell"] [data-testid="notification-line-headline"]')).map((p) => p.textContent);

describe('NotificationBell — event messages in words (story 4921)', () => {
  it('⭐옛 기계 문장 요약은 «{보낸 이}: 이벤트[ · 글]», 새 사람 문장 · 보통 글은 그대로 — 슬러그 · id · key: value 0', async () => {
    await openBell();
    const lines = headlines();
    expect(lines).toEqual(['시스템 발행: 이벤트', '페드루: 이벤트 · 먼저 봐 주세요', '시스템 발행: 이벤트', '페드루: 방향 전환 · 먼저 봐 주세요 → 미르코', '미르코: 안녕하세요']);
    for (const l of lines) expect(l).not.toMatch(/\[이벤트\]|\[Event\]|preset\.|org\.x|target_member_id|97470487|- \w+:/);
  });
  it('영어 화면: «이벤트» 자리는 «Event»', async () => {
    await openBell('en');
    expect(headlines().slice(0, 3)).toEqual(['시스템 발행: Event', '페드루: Event · 먼저 봐 주세요', '시스템 발행: Event']);
  });
});
