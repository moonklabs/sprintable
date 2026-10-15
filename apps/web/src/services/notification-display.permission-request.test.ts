// story #4533 — the bell's dispatched line for an agent's permission request: «권한 대기 · {에이전트}» from the shared label and
// `payload.agent_name` (the server's Korean title is never read), and the /inbox row label; the badge's notice check.
import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import { isPermissionRequestNotice } from '@/lib/designated-pending-count-client';
import { getDispatchedHeadline, getInboxNotificationLabel } from './notification-display';

const tOf = (messages: { inbox: Record<string, unknown> }) => (key: string) => String(messages.inbox[key] ?? key);
const ko = tOf(koMessages as unknown as { inbox: Record<string, unknown> });
const en = tOf(enMessages as unknown as { inbox: Record<string, unknown> });

describe('agent permission request notice (story #4533)', () => {
  it('reads «권한 대기 · {agent}» — the agent name only from the payload, never the server title', () => {
    const payload = { event_type: 'agent.permission_request', agent_name: 'Dev', title: '서버 제목' };
    expect(getDispatchedHeadline(ko, 'dispatched', payload)).toBe('권한 대기 · Dev');
    expect(getDispatchedHeadline(en, 'dispatched', payload)).toBe('Waiting for permission · Dev');
    expect(getDispatchedHeadline(ko, 'dispatched', { event_type: 'agent.permission_request' })).toBe('권한 대기');
    expect(getInboxNotificationLabel(ko, 'agent.permission_request')).toBe('권한 대기');
  });

  it('the badge recounts on that notice only', () => {
    expect(isPermissionRequestNotice(JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'agent.permission_request' } }))).toBe(true);
    expect(isPermissionRequestNotice(JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'conversation.message' } }))).toBe(false);
    expect(isPermissionRequestNotice('not json')).toBe(false);
  });
});
