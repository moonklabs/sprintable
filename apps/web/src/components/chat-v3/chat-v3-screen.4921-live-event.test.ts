import { describe, expect, it } from 'vitest';
import { threadsAfterMessage } from './chat-v3-screen';
import type { ChatV3Thread } from './chat-v3-thread-rail';

// story 4921 — a live frame of an event message keeps its `event` on the thread's latest message: the rail's preview line is built from it
describe('threadsAfterMessage — event on a live update (story 4921)', () => {
  const prev = [{ id: 'c1', participants: [], latest_message: null, unread_count: 0 }] as unknown as ChatV3Thread[];
  it('⭐an event message keeps its event · a plain message gets none · a non-object value is ignored', () => {
    const ev = { event_key: 'org.acme.signup', payload: { message: '새 가입' } };
    const a = threadsAfterMessage(prev, { conversation_id: 'c1', content: '[이벤트] org.acme.signup', created_at: '2026-11-13T01:00:00Z', event: ev }, { selectedId: null, meId: 'me' });
    expect(a.next![0]!.latest_message?.event).toEqual(ev);
    const b = threadsAfterMessage(prev, { conversation_id: 'c1', content: '그냥 글', created_at: '2026-11-13T01:00:00Z' }, { selectedId: null, meId: 'me' });
    expect(b.next![0]!.latest_message?.event).toBeUndefined();
    const c = threadsAfterMessage(prev, { conversation_id: 'c1', content: 'x', created_at: '2026-11-13T01:00:00Z', event: 'preset.x' }, { selectedId: null, meId: 'me' });
    expect(c.next![0]!.latest_message?.event).toBeUndefined();
  });
});
