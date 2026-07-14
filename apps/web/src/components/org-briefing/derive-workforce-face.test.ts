import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  buildWorkforceFace, parseActiveEpics, parseEpicStories, parseTeamMembers,
  type RawWorkforceStory, type WorkforceEpic, type WorkforceFaceTranslator,
} from './derive-workforce-face';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'orgBriefing' }) as unknown as WorkforceFaceTranslator;

function story(overrides: Partial<RawWorkforceStory> = {}): RawWorkforceStory {
  return { assigneeIds: [], selfReported: false, humanVerified: false, ...overrides };
}

describe('parseActiveEpics', () => {
  it('unwraps {data:{project_status:{epics:[...]}}} and keeps only status===active', () => {
    const epics = parseActiveEpics({
      data: { project_status: { epics: [
        { epic_id: 'e1', title: 'E-CANVAS', status: 'active' },
        { epic_id: 'e2', title: 'E-DONE', status: 'done' },
        { epic_id: 'e3', title: 'E-UPCOMING', status: 'planning' },
      ] } },
    });
    expect(epics).toEqual([{ epicId: 'e1', title: 'E-CANVAS' }]);
  });

  it('returns [] for malformed shapes (no-fiction)', () => {
    expect(parseActiveEpics(null)).toEqual([]);
    expect(parseActiveEpics({ foo: 'bar' })).toEqual([]);
  });
});

describe('parseEpicStories', () => {
  it('merges assignee_ids + agent_delegate_ids + legacy assignee_id into a distinct set', () => {
    const rows = parseEpicStories({ data: [
      { assignee_ids: ['m1', 'm2'], agent_delegate_ids: ['m2'], assignee_id: 'm3', self_reported: true, human_verified: false },
    ] });
    expect(rows[0]!.assigneeIds.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('treats has_evidence as equivalent to self_reported (BE positive-only field pair)', () => {
    const rows = parseEpicStories({ data: [{ has_evidence: true }] });
    expect(rows[0]!.selfReported).toBe(true);
  });

  it('returns [] for malformed shapes', () => {
    expect(parseEpicStories(null)).toEqual([]);
  });
});

describe('parseTeamMembers', () => {
  it('builds an id->name map, skipping entries missing id or name', () => {
    const map = parseTeamMembers({ data: [{ id: 'm1', name: 'Yuna' }, { id: 'm2' }, { name: 'no id' }] });
    expect(map).toEqual({ m1: 'Yuna' });
  });
});

describe('buildWorkforceFace', () => {
  const epics: WorkforceEpic[] = [{ epicId: 'e1', title: 'E-CANVAS' }];

  it('collects distinct collaborator ids across all stories in the epic (presence only, no counts)', () => {
    const items = buildWorkforceFace(epics, {
      e1: [story({ assigneeIds: ['m1', 'm2'] }), story({ assigneeIds: ['m2', 'm3'] })],
    }, t);
    expect(items[0]!.collaboratorIds.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('marks trust=verified when any story in the epic is human_verified — positive one-directional (verified wins even if others are unverified)', () => {
    const items = buildWorkforceFace(epics, {
      e1: [story({ humanVerified: false }), story({ humanVerified: true })],
    }, t);
    expect(items[0]!.trust).toBe('verified');
    expect(items[0]!.trustLabel).toBe('사람이 확인함');
  });

  it('marks trust=claimed when no story is verified but at least one is self-reported', () => {
    const items = buildWorkforceFace(epics, { e1: [story({ selfReported: true })] }, t);
    expect(items[0]!.trust).toBe('claimed');
  });

  it('omits the trust badge entirely when there is nothing to claim (no-fiction, not a fabricated neutral state)', () => {
    const items = buildWorkforceFace(epics, { e1: [story()] }, t);
    expect(items[0]!.trust).toBeNull();
    expect(items[0]!.trustLabel).toBeNull();
  });

  it('handles an epic with zero stories fetched (still renders the epic, empty collaborators)', () => {
    const items = buildWorkforceFace(epics, {}, t);
    expect(items[0]!.collaboratorIds).toEqual([]);
    expect(items[0]!.trust).toBeNull();
  });
});
