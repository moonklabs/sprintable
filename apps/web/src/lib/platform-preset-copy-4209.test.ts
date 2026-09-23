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

describe('localizePresetBlockTemplate — 알려진 시드 카드 모양일 때만 통째로(PR #4575)', () => {
  // 워크플로우 시드(0260) 모양 그대로.
  const tpl = { blocks: [
    { type: 'header' as const, text: 'Kanban Flow' },
    { type: 'text' as const, text: '**{{payload.stage}}** 로 넘어갔습니다' },
    { type: 'fields' as const, fields: [{ label: '대상', value: '{{payload.work_item_type}} {{payload.work_item_id}}' }] },
  ] };
  const strings = { header: 'H', body: 'B', targetLabel: 'Target' };
  it('워크플로우 시드 모양 → 머리말·본문·«대상» 라벨 + 값은 일감 라벨(`story <UUID>` 원문 대신)', () => {
    const out = localizePresetBlockTemplate(tpl, platform('preset.workflow.kanban'), strings);
    expect(out.blocks).toEqual([
      { type: 'header', text: 'H' },
      { type: 'text', text: 'B' },
      { type: 'fields', fields: [{ label: 'Target', value: '{{label.work_item_target}}' }] },
    ]);
  });
  it('마케팅 시드 모양 → 같은 규칙', () => {
    const mk = { blocks: [
      { type: 'header' as const, text: '영상 제작 워크플로우' },
      { type: 'text' as const, text: '**{{label.stage}}** 단계로 넘어갔습니다' },
      { type: 'fields' as const, fields: [{ label: '대상', value: '{{label.work_item_target}}' }] },
    ] };
    expect(localizePresetBlockTemplate(mk, platform('preset.marketing.video_production'), strings).blocks[1]).toEqual({ type: 'text', text: 'B' });
  });
  it('⭐모양 밖(단계 문장에 다른 문구 · 모르는 «대상» 값 · 블록 추가) → 원문 그대로(문구 증발 0)', () => {
    const withReason = { blocks: [tpl.blocks[0], { type: 'text' as const, text: '**{{payload.stage}}** 로 넘어갔습니다; 사유 {{payload.reason}}' }, tpl.blocks[2]] };
    const otherValue = { blocks: [tpl.blocks[0], tpl.blocks[1], { type: 'fields' as const, fields: [{ label: '대상', value: '{{payload.title}}' }] }] };
    const extraBlock = { blocks: [...tpl.blocks, { type: 'text' as const, text: '덧붙임' }] };
    for (const t of [withReason, otherValue, extraBlock]) {
      expect(localizePresetBlockTemplate(t, platform('preset.workflow.kanban'), strings)).toBe(t);
    }
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
