import { describe, expect, it } from 'vitest';
import { applyConversationMessageUpdate } from './chat-list-view';

// story 4921 — a live frame (SSE) of an event message keeps its `event` (key · payload · refs): the room row's sentence is built from it. Without it the row would say only «이벤트» until the next refetch.
describe('applyConversationMessageUpdate — event on a live update (story 4921)', () => {
  const prev = [{ id: 'c1', type: 'dm', title: 't', latest_message: null, updated_at: '2026-11-13T00:00:00Z', unread_count: 0 }] as never;
  it('⭐an event message keeps its event · a plain message gets none', () => {
    const next = applyConversationMessageUpdate(prev, {
      conversation_id: 'c1', content: '[이벤트] preset.steer.instruct\n- instruction: 지시', created_at: '2026-11-13T01:00:00Z',
      event: { event_key: 'preset.steer.instruct', payload: { instruction: '지시' }, refs: { target: { found: true, name: '미르코' } } },
    }, () => {});
    expect(next[0]!.latest_message?.event?.event_key).toBe('preset.steer.instruct');
    expect(next[0]!.latest_message?.event?.refs).toEqual({ target: { found: true, name: '미르코' } });
    const plain = applyConversationMessageUpdate(prev, { conversation_id: 'c1', content: '그냥 글', created_at: '2026-11-13T01:00:00Z' }, () => {});
    expect(plain[0]!.latest_message?.event).toBeUndefined();
  });
  it('a non-object event value is ignored', () => {
    const next = applyConversationMessageUpdate(prev, { conversation_id: 'c1', content: 'x', created_at: '2026-11-13T01:00:00Z', event: 'preset.x' }, () => {});
    expect(next[0]!.latest_message?.event).toBeUndefined();
  });
});
