// story #4209 — 단계 설명(presetAction)·채팅 카드 템플릿 로케일(localizePresetBlockTemplate) 헬퍼.
import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import { localizePresetBlockTemplate, presetAction } from './platform-preset-copy';

const t = (key: string) => (enMessages.recipePreset as Record<string, string>)[key] ?? `MISSING:${key}`;
const platform = (key: string) => ({ key, org_id: null, name: 'x' });

describe('presetAction', () => {
  it('플랫폼 프리셋 → 문안(마케팅·워크플로우·공유 키)', () => {
    expect(presetAction(platform('preset.marketing.video_production'), 'draft', '로그라인·컨셉 초안 작성', t)).toBe(enMessages.recipePreset.videoProductionActionDraft);
    expect(presetAction(platform('preset.workflow.scrum_3step'), 'qa_review', 'AC 체크리스트 검증 후 APPROVE/REJECT', t)).toBe(enMessages.recipePreset.workflowScrum3StepActionQaReview);
    expect(presetAction(platform('preset.workflow.solo'), 'assign_step_1', '담당자 배정', t)).toBe(enMessages.recipePreset.workflowActionAssign);
  });
  it('조직 정의 → 원문 action · action 없으면 stage slug', () => {
    expect(presetAction({ key: 'preset.workflow.solo', org_id: 'org-1' }, 'assign_step_1', '원문', t)).toBe('원문');
    expect(presetAction({ key: 'org.x', org_id: 'org-1' }, 'draft', undefined, t)).toBe('draft');
  });
  it('표에 없는 단계 → 원문', () => {
    expect(presetAction(platform('preset.workflow.solo'), 'unknown_stage', '원문', t)).toBe('원문');
  });
});

describe('localizePresetBlockTemplate', () => {
  const tpl = { blocks: [
    { type: 'header' as const, text: 'Kanban Flow' },
    { type: 'text' as const, text: '**{{payload.stage}}** 로 넘어갔습니다' },
    { type: 'text' as const, text: '단계 없는 다른 문장' },
    { type: 'fields' as const, fields: [{ label: '대상', value: '{{payload.work_item_id}}' }, { label: '기타', value: 'v' }] },
  ] };
  const strings = { header: 'H', body: 'B', targetLabel: 'Target' };
  it('플랫폼 프리셋 → 머리말·단계 text·«대상» 라벨만 바꾼다', () => {
    const out = localizePresetBlockTemplate(tpl, platform('preset.workflow.kanban'), strings);
    expect(out.blocks).toEqual([
      { type: 'header', text: 'H' },
      { type: 'text', text: 'B' },
      { type: 'text', text: '단계 없는 다른 문장' },
      { type: 'fields', fields: [{ label: 'Target', value: '{{payload.work_item_id}}' }, { label: '기타', value: 'v' }] },
    ]);
  });
  it('조직 정의·표 밖 key → 그대로', () => {
    expect(localizePresetBlockTemplate(tpl, { key: 'preset.workflow.kanban', org_id: 'org-1' }, strings)).toBe(tpl);
    expect(localizePresetBlockTemplate(tpl, platform('preset.gate.verdict'), strings)).toBe(tpl);
  });
  it('단계 값이 없으면(body null) 본문 원문 유지', () => {
    const out = localizePresetBlockTemplate(tpl, platform('preset.workflow.kanban'), { ...strings, body: null });
    expect(out.blocks[1]).toEqual(tpl.blocks[1]);
  });
});
