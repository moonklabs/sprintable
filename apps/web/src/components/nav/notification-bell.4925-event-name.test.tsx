// @vitest-environment jsdom
//
// story 4925 — the bell says an event that has no sentence of its own by its definition's NAME (the room list and the inbox already did), and a link in the person's words as its label. The server's own line is «{sender}: 이벤트[ · words]» (it reads no
// definition names, and for words that are a link it said «이벤트» alone): this screen has the names and the payload, so it says «{sender}: 배포 확인 · 이 일감 확인». A known preset's sentence and a row that is not a chat line stay as they are.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { resetEventDefinitionNames } from '@/hooks/use-event-definition-names';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell } = await import('./notification-bell');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const row = (id: string, payload: Record<string, unknown>, eventType = 'conversation.message_created') => ({
  id, event_type: eventType, source_entity_type: 'conversation_message', source_entity_id: `${id}-m`, payload, read_at: null, created_at: '2026-11-14T00:00:00Z',
});
const ITEMS = [
  row('with-link', { summary: '페드루: 이벤트', event: { event_key: 'org.acme.deploy', payload: { note: `[이 일감](entity:story:${UUID}) 확인` } } }),
  row('with-words', { summary: '페드루: 이벤트 · 배포를 확인했어요', event: { event_key: 'org.acme.deploy', payload: { note: '배포를 확인했어요' } } }),
  row('no-name', { summary: '페드루: 이벤트 · 말', event: { event_key: 'org.acme.unknown', payload: { note: '말' } } }),
  row('steer', { summary: '페드루: 방향 전환 · 먼저 봐 주세요 → 미르코', event: { event_key: 'preset.steer.instruct', payload: { instruction: '먼저 봐 주세요' } } }),
  row('not-chat', { summary: '시스템: 이벤트 · 그대로', event: { event_key: 'org.acme.deploy', payload: { note: '바뀌면 안 되는' } } }, 'gate.pending_approval'),
  row('plain', { summary: '미르코: 안녕하세요' }),
];

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  resetEventDefinitionNames();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/events/definitions')) return new Response(JSON.stringify([{ key: 'org.acme.deploy', name: '배포 확인' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/event-notifications?')) return new Response(JSON.stringify({ data: ITEMS, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ count: ITEMS.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openBell() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>); });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
}
const headlines = () => Array.from(document.querySelectorAll('[data-dropdown-panel="notification-bell"] [data-testid="notification-line-headline"]')).map((p) => p.textContent);

describe('NotificationBell — an event named by its definition (story 4925)', () => {
  it('⭐«{보낸 이}: 정의 이름 · 말», 링크는 라벨 — 서버가 «이벤트»만 말한 줄도; 이름 모르면 «이벤트 · 말»; 문장이 있는 프리셋 · 채팅 줄이 아닌 행 · 보통 글은 그대로', async () => {
    await openBell();
    const lines = headlines();
    expect(lines).toEqual([
      '페드루: 배포 확인 · 이 일감 확인',
      '페드루: 배포 확인 · 배포를 확인했어요',
      '페드루: 이벤트 · 말',
      '페드루: 방향 전환 · 먼저 봐 주세요 → 미르코',
      '시스템: 이벤트 · 그대로',
      '미르코: 안녕하세요',
    ]);
    for (const l of lines) expect(l).not.toMatch(/entity:|97470487|org\.acme|\]\(/);
  });
});
