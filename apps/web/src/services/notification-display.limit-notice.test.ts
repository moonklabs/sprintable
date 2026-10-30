// story #4833 (4814 실측) — the bell's line for «an agent stood at its usage limit» / «works again»: «{에이전트} · 한도로 쉬는 중» /
// «{에이전트} · 다시 일하는 중» from the shared label and `payload.agent_name` (the server's Korean title is never read), and the /inbox row label.
// Before: both fell to the generic «새 알림» — no line for them in the table.
import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import { getDispatchedHeadline, getInboxNotificationLabel } from './notification-display';

const tOf = (messages: { inbox: Record<string, unknown> }) => (key: string) => String(messages.inbox[key] ?? key);
const ko = tOf(koMessages as unknown as { inbox: Record<string, unknown> });
const en = tOf(enMessages as unknown as { inbox: Record<string, unknown> });

describe('agent limit notice (story #4833)', () => {
  it('«한도로 쉬는 중» with the agent name from the payload only', () => {
    const payload = { event_type: 'agent.limit_paused', agent_name: 'Lead', title: '서버 제목' };
    expect(getDispatchedHeadline(ko, 'dispatched', payload)).toBe('Lead · 한도로 쉬는 중');
    expect(getDispatchedHeadline(en, 'dispatched', payload)).toBe('Lead · Paused at its usage limit');
    expect(getDispatchedHeadline(ko, 'dispatched', { event_type: 'agent.limit_paused' })).toBe('한도로 쉬는 중');
  });

  it('«다시 일하는 중» when the limit lifted', () => {
    const payload = { event_type: 'agent.limit_lifted', agent_name: 'Lead' };
    expect(getDispatchedHeadline(ko, 'dispatched', payload)).toBe('Lead · 다시 일하는 중');
    expect(getDispatchedHeadline(en, 'dispatched', payload)).toBe('Lead · Working again');
  });

  it('the /inbox row label is the same words, and neither reads as the generic fallback', () => {
    expect(getInboxNotificationLabel(ko, 'agent.limit_paused')).toBe('한도로 쉬는 중');
    expect(getInboxNotificationLabel(ko, 'agent.limit_lifted')).toBe('다시 일하는 중');
    expect(getDispatchedHeadline(ko, 'dispatched', { event_type: 'agent.limit_paused', agent_name: 'Lead' })).not.toBe(ko('eventFallback'));
  });

  it('negative control — an unknown agent event still falls to the generic line (the table did not become a catch-all)', () => {
    expect(getDispatchedHeadline(ko, 'dispatched', { event_type: 'agent.something_new', agent_name: 'Lead' })).toBe(ko('eventFallback'));
  });
});
