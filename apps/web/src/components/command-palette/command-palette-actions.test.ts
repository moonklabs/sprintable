import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { buildActionCommands, type ActionCommandTranslator } from './command-palette-actions';
import koMessagesRaw from '../../../messages/ko.json';
import enMessagesRaw from '../../../messages/en.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const enMessages = enMessagesRaw as unknown as LooseMessages;
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'commandPalette' }) as unknown as ActionCommandTranslator;
const tEn = createTranslator({ locale: 'en', messages: enMessages, namespace: 'commandPalette' }) as unknown as ActionCommandTranslator;

describe('buildActionCommands — v1 inventory (route-first, no-fiction)', () => {
  it('without a story context, only the 2 project-scoped commands exist (delegate has no valid target — omitted, not fabricated)', () => {
    const items = buildActionCommands(t);
    expect(items.map((i) => i.id)).toEqual(['action-gate-decision', 'action-recruit-agent']);
  });

  it('with a story context, the delegate command exists, ranked first, targeting the real story route', () => {
    const items = buildActionCommands(t, { storyId: 's1', storyTitle: '웰컴 이메일 시안' });
    expect(items[0]).toEqual(expect.objectContaining({
      id: 'action-delegate-story', targetRoute: '/board?story=s1', danger: false,
    }));
    expect(items[0]!.label).toContain('웰컴 이메일 시안');
    expect(items[0]!.impact).toContain('웰컴 이메일 시안');
  });

  it('gate decision routes to the gate inbox and is flagged as a danger (amber) command', () => {
    const items = buildActionCommands(t);
    const gate = items.find((i) => i.id === 'action-gate-decision')!;
    expect(gate.targetRoute).toBe('/inbox?tab=gates');
    expect(gate.danger).toBe(true);
  });

  it('recruit-agent routes to the recruiter wizard and is not a danger command', () => {
    const items = buildActionCommands(t);
    const recruit = items.find((i) => i.id === 'action-recruit-agent')!;
    expect(recruit.targetRoute).toBe('/organization/workforce/recruiter');
    expect(recruit.danger).toBe(false);
  });

  it('never fabricates the 3 unwired commands (stop run / re-collect evidence / STEER priority) — dead-path guard', () => {
    const items = buildActionCommands(t, { storyId: 's1', storyTitle: 'x' });
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain('action-stop-run');
    expect(ids).not.toContain('action-recollect-evidence');
    expect(ids).not.toContain('action-steer-priority');
  });

  it('renders in English when given the en translator (ko/en parity)', () => {
    const items = buildActionCommands(tEn, { storyId: 's1', storyTitle: 'Welcome email draft' });
    expect(items[0]!.label).toContain('Welcome email draft');
    expect(items.find((i) => i.id === 'action-recruit-agent')!.label).not.toBe('');
  });
});
