import { describe, expect, it } from 'vitest';
import { composeEventBodyFallback, composeEventPreviewLine, readableSlug, type EventPreviewHelpers } from './event-block-card';
import { hasEntityTypeLabel } from './chat-input-entity-tokens';
import { hasRecipeStageLabel } from '@/lib/recipe-stage-label';

// story 4925 — the four older presets' sentences (and the card labels / the bubble list that read them): a value no label knows reads as WORDS (4921's rule: underscore / hyphen → space), never as its slug.
const WORDS: Record<string, string> = {
  entityTypeStory: '스토리', statusChangedHeader: '작업 상태 변경', gateVerdictHeader: '게이트 판정', workAssignedHeader: '작업 배정', goalMeasuredHeader: '목표 측정',
  gateStatusApproved: '승인', genericEventHeader: '이벤트', memberMissing: '(알 수 없는 구성원)',
};
const t = (k: string) => WORDS[k] ?? k;
const helpers: EventPreviewHelpers = {
  tBoard: (k) => ({ statusInProgress: '진행 중', statusInReview: '리뷰 중' } as Record<string, string>)[k] ?? k,
  tCage: t, tDashboard: t, tEventCard: t, tEntity: t, tOutcomeLoop: t,
  domainLabels: { statusLabel: () => undefined },
};
const refs = { assignee: { found: true, name: '미르코' } };

describe('readableSlug', () => {
  it('underscore and hyphen runs become one space', () => {
    expect(readableSlug('waiting-on-legal')).toBe('waiting on legal');
    expect(readableSlug('visual_artifact')).toBe('visual artifact');
    expect(readableSlug('a__b--c')).toBe('a b c');
  });
});

describe('the four older presets with a value no label knows (story 4925)', () => {
  it('⭐work.status_changed: an unknown status reads as words (a known one is still its label)', () => {
    const line = composeEventPreviewLine('preset.work.status_changed', { work_item_type: 'story', from_status: 'waiting-on-legal', to_status: 'in-progress' }, helpers);
    expect(line).toMatch(/^작업 상태 변경 · 스토리 waiting on legal → \S/);
    expect(line).not.toContain('waiting-on-legal');
  });
  it('⭐work.status_changed: an unknown work item type reads as words', () => {
    const line = composeEventPreviewLine('preset.work.status_changed', { work_item_type: 'visual_artifact', from_status: 'a_b', to_status: 'c-d' }, helpers);
    expect(line).toBe('작업 상태 변경 · visual artifact a b → c d');
  });
  it('⭐gate.verdict: an unknown verdict reads as words; a known one is its label', () => {
    expect(composeEventPreviewLine('preset.gate.verdict', { gate_type: 'merge', verdict: 'on-hold_by_legal' }, helpers)).toContain('on hold by legal');
    expect(composeEventPreviewLine('preset.gate.verdict', { gate_type: 'merge', verdict: 'approved' }, helpers)).toContain('승인');
  });
  it('⭐work.assigned: an unknown work item type reads as words', () => {
    expect(composeEventPreviewLine('preset.work.assigned', { work_item_type: 'visual_artifact' }, helpers, refs)).toBe('작업 배정 · visual artifact → 미르코');
    expect(composeEventPreviewLine('preset.work.assigned', { work_item_type: 'story' }, helpers, refs)).toBe('작업 배정 · 스토리 → 미르코');
  });
  it('the bubble list: an unmapped key uses the same rule (one function)', () => {
    const m = composeEventBodyFallback('[이벤트] org.x.y\n- a: b', 'org.x.y', { stage_name: 'x', waiting_on_legal: 'yes' }, {}, null, helpers)!;
    expect(m.items.map((i) => i.label)).toEqual(['stage name', 'waiting on legal']);
    expect(m.items.map((i) => i.value)).toEqual(['x', 'yes']); // the VALUES stay as they are (PO 11-13: «값은 그대로») — only the key is made readable
  });
  it('mapped vs unmapped is decided by the table, not by comparing the label with the slug', () => {
    expect(hasEntityTypeLabel('story')).toBe(true);
    expect(hasEntityTypeLabel('visual_artifact')).toBe(false);
    expect(hasEntityTypeLabel('constructor')).toBe(false); // an inherited object property is not a label
    expect(hasRecipeStageLabel('draft')).toBe(true);
    expect(hasRecipeStageLabel('waiting-on-legal')).toBe(false);
  });
});
