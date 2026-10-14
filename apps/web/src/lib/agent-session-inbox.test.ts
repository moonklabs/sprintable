import { describe, expect, it } from 'vitest';
import { inboxStop } from './agent-session-inbox';

// story 4684 (Yuna ux1-copy §L ② ③): the two stops the strip says; the others and anything unknown say nothing
describe('inboxStop (story 4684)', () => {
  it('the second install was refused → other_receiver · this computer was displaced → taken_over', () => {
    expect(inboxStop({ stream: 'stopped_other_receiver' })).toBe('other_receiver');
    expect(inboxStop({ stream: 'stopped_taken_over' })).toBe('taken_over');
  });

  it('the key refused · the waiting list full (no strip words yet) and every other word → null, never a guessed line', () => {
    for (const stream of ['stopped_auth', 'stopped_inbox_full', 'open', 'closed', 'connecting', 'STOPPED_TAKEN_OVER', 'stopped_taken_over ', 'stopped_x', '', null, undefined]) {
      expect(inboxStop({ stream }), String(stream)).toBeNull();
    }
    expect(inboxStop(null)).toBeNull();
    expect(inboxStop(undefined)).toBeNull();
    expect(inboxStop({})).toBeNull();
  });
});
