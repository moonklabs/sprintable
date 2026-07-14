import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  buildLoopFace, derivePhrase, parseEpicProgress, parseHypotheses,
  type LoopFaceTranslator, type RawHypothesis,
} from './derive-loop-face';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'orgBriefing' }) as unknown as LoopFaceTranslator;

function hyp(overrides: Partial<RawHypothesis> = {}): RawHypothesis {
  return { id: 'h1', status: 'active', statement: '테스트 가설', epicId: null, createdAt: '2026-07-01T00:00:00Z', ...overrides };
}

describe('parseHypotheses', () => {
  it('unwraps {data:[...]}', () => {
    const rows = parseHypotheses({ data: [{ id: 'h1', status: 'active', statement: 'x', epic_ids: [], created_at: 't' }] });
    expect(rows).toHaveLength(1);
  });

  it('drops rows with unknown status, missing statement, or missing id (no-fiction)', () => {
    const rows = parseHypotheses({
      data: [
        { id: 'h1', status: 'not_a_real_status', statement: 'x' },
        { id: 'h2', status: 'active' }, // no statement
        { status: 'active', statement: 'x' }, // no id
      ],
    });
    expect(rows).toHaveLength(0);
  });

  it('reads the first epic_ids entry as the linked epic', () => {
    const rows = parseHypotheses({ data: [{ id: 'h1', status: 'active', statement: 'x', epic_ids: ['e1', 'e2'] }] });
    expect(rows[0]!.epicId).toBe('e1');
  });
});

describe('parseEpicProgress', () => {
  it('unwraps {data:{project_status:{epics:[...]}}} (dashboard/overview envelope)', () => {
    const map = parseEpicProgress({ data: { project_status: { epics: [{ epic_id: 'e1', title: 'E-CANVAS', completion_pct: 82, total: 11 }] } } });
    expect(map['e1']).toEqual({ title: 'E-CANVAS', completionPct: 82, total: 11 });
  });

  it('returns {} for malformed shapes', () => {
    expect(parseEpicProgress(null)).toEqual({});
    expect(parseEpicProgress({ foo: 'bar' })).toEqual({});
  });
});

describe('derivePhrase (E-GLANCE §4 parity)', () => {
  it.each([
    [0, 10, 'notStarted'], [10, 10, 'justStarted'], [40, 10, 'underway'],
    [75, 10, 'almostThere'], [95, 10, 'wrappingUp'], [50, 0, 'notStarted'],
  ] as const)('completion=%s total=%s -> %s', (pct, total, expected) => {
    expect(derivePhrase(pct, total)).toBe(expected);
  });
});

describe('buildLoopFace', () => {
  it('maps active/measuring -> testing, verified -> achieved, falsified -> learning', () => {
    const items = buildLoopFace(
      [hyp({ id: 'h1', status: 'active' }), hyp({ id: 'h2', status: 'measuring' }), hyp({ id: 'h3', status: 'verified' }), hyp({ id: 'h4', status: 'falsified' })],
      {}, t,
    );
    expect(items.filter((i) => i.kind === 'testing').map((i) => i.id)).toEqual(['h1', 'h2']);
    expect(items.find((i) => i.id === 'h3')!.kind).toBe('achieved');
    expect(items.find((i) => i.id === 'h4')!.kind).toBe('learning');
  });

  it('excludes killed/archived hypotheses entirely (forward-only — no historical archive)', () => {
    const items = buildLoopFace([hyp({ id: 'h1', status: 'killed' }), hyp({ id: 'h2', status: 'archived' })], {}, t);
    expect(items).toHaveLength(0);
  });

  it('never renders a destructive/red class or a "실패" word for a falsified (learning) hypothesis — soul-lock', () => {
    const items = buildLoopFace([hyp({ id: 'h1', status: 'falsified' })], {}, t);
    const learning = items.find((i) => i.id === 'h1')!;
    expect(learning.kindLabel).not.toMatch(/실패|반증됨/);
    expect(learning.kindLabel).toBe('배움');
  });

  it('picks only the single earliest-created proposed hypothesis as "다음 루프", not all of them', () => {
    const items = buildLoopFace(
      [
        hyp({ id: 'p1', status: 'proposed', createdAt: '2026-07-05T00:00:00Z' }),
        hyp({ id: 'p2', status: 'proposed', createdAt: '2026-07-02T00:00:00Z' }),
        hyp({ id: 'p3', status: 'proposed', createdAt: '2026-07-09T00:00:00Z' }),
      ],
      {}, t,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('p2');
    expect(items[0]!.dimmed).toBe(true);
    expect(items[0]!.trajectoryPct).toBeNull();
  });

  it('attaches the linked epic\'s qualitative trajectory (title · phrase), not a bare percentage', () => {
    const items = buildLoopFace(
      [hyp({ id: 'h1', status: 'active', epicId: 'e1' })],
      { e1: { title: 'E-CANVAS', completionPct: 95, total: 11 } },
      t,
    );
    expect(items[0]!.trajectoryLabel).toContain('E-CANVAS');
    expect(items[0]!.trajectoryLabel).toContain('막바지');
    expect(items[0]!.trajectoryPct).toBe(95);
  });

  it('omits the trajectory entirely when the hypothesis has no linked epic or the epic is unresolved (no-fiction, no fabricated progress)', () => {
    const items = buildLoopFace([hyp({ id: 'h1', status: 'active', epicId: null })], {}, t);
    expect(items[0]!.trajectoryLabel).toBeNull();
    expect(items[0]!.trajectoryPct).toBeNull();
  });

  it('sorts testing/achieved/learning before the next-loop row', () => {
    const items = buildLoopFace(
      [hyp({ id: 'p1', status: 'proposed' }), hyp({ id: 'h1', status: 'falsified' }), hyp({ id: 'h2', status: 'active' })],
      {}, t,
    );
    expect(items.map((i) => i.kind)).toEqual(['testing', 'learning', 'next']);
  });

  it('returns [] when there are no hypotheses at all', () => {
    expect(buildLoopFace([], {}, t)).toEqual([]);
  });
});
