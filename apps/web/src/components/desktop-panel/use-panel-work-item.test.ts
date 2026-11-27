import { describe, expect, it } from 'vitest';
import { activeStoryIdOf } from './use-panel-work-item';

const ID = '7e0e7cc1-c2b8-4669-bfaa-3b13903fd670';
describe('[SID:5042] the work-item tab\'s read: the story the agent works on now', () => {
  it('⭐a member row with a story → its id · with none → null (the server says «no work item»)', () => {
    expect(activeStoryIdOf({ data: { id: 'a', active_story_id: ID } })).toBe(ID);
    expect(activeStoryIdOf({ data: { id: 'a', active_story_id: null } })).toBeNull();
    expect(activeStoryIdOf({ data: { id: 'a' } })).toBeNull();
  });
  it('⭐anything that is not a member row — or an id that is not a uuid — is undefined (an error, never «no work item»)', () => {
    for (const v of [null, undefined, 7, 'x', [], {}, { data: null }, { data: [] }, { data: 'x' }, { data: { active_story_id: '../x' } }, { data: { active_story_id: 5 } }]) expect(activeStoryIdOf(v)).toBeUndefined();
  });
});
