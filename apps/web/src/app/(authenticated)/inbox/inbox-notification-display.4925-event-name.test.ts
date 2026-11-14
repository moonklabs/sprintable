import { describe, expect, it } from 'vitest';
import type { EventPreviewHelpers } from '@/components/chat/event-block-card';
import { composeNotificationDisplay, type Notification } from './inbox-notification-display';

// story 4925 — a chat row whose body the SERVER put in words («이벤트 · …», it reads no definition names) is said by this screen with the definition's NAME (the same line as the room list); a row that is not a chat line, and the events with a sentence of their own, stay.
const UUID = '97470487-345a-4e85-9c45-cdf901737adb';
const names: Record<string, string> = { 'org.acme.deploy': '배포 확인' };
const helpers: EventPreviewHelpers = {
  tBoard: (k) => k, tCage: (k) => k, tDashboard: (k) => k,
  tEventCard: (k) => ({ genericEventHeader: '이벤트', steerHeader: '방향 전환' } as Record<string, string>)[k] ?? k,
  tEntity: (k) => k, tOutcomeLoop: (k) => k, domainLabels: { statusLabel: () => undefined },
  eventDefinitionName: (key) => names[key],
};
const t = (key: string, values?: Record<string, string | number>) => (key === 'messageTitle' ? `${values?.name}님의 새 메시지` : key);
const row = (over: Partial<Notification>): Notification => ({
  id: 'n1', type: 'conversation.message', title: '페드루님의 새 메시지', body: '이벤트 · 확인', is_read: false, created_at: '2026-11-14T00:00:00Z', reference_type: 'conversation', reference_id: 'c1', href: null,
  event: { sender_name: '페드루', event_key: 'org.acme.deploy', payload: { note: '확인' } },
  ...over,
} as Notification);

describe('composeNotificationDisplay — an event with no sentence of its own, named (story 4925)', () => {
  it('⭐a message row: «definition name · words» instead of the server\'s «이벤트 · words» (the title is untouched)', () => {
    expect(composeNotificationDisplay(row({}), t, helpers)).toEqual({ title: '페드루님의 새 메시지', body: '배포 확인 · 확인' });
  });
  it('⭐a mention row too; and the link in the words is its label — never the id', () => {
    const d = composeNotificationDisplay(row({ type: 'conversation.mention', body: '이벤트', event: { sender_name: '페드루', event_key: 'org.acme.deploy', payload: { note: `[이 일감](entity:story:${UUID}) 확인` } } }), t, helpers);
    expect(d.body).toBe('배포 확인 · 이 일감 확인');
    expect(d.body).not.toMatch(/entity:|97470487/);
  });
  it('no definition name known → «이벤트 · words» (the word, never the key)', () => {
    const d = composeNotificationDisplay(row({ event: { sender_name: '페드루', event_key: 'org.acme.unknown', payload: { note: '확인' } } }), t, helpers);
    expect(d.body).toBe('이벤트 · 확인');
  });
  it('a row that is not a chat line keeps its own body; a plain message (no event key) keeps its text', () => {
    expect(composeNotificationDisplay(row({ type: 'dispatched', body: '그대로 둘 글' }), t, helpers).body).toBe('그대로 둘 글');
    expect(composeNotificationDisplay(row({ body: '안녕하세요', event: { sender_name: '페드루' } }), t, helpers).body).toBe('안녕하세요');
  });
});
