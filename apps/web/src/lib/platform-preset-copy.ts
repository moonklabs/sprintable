import type { BlockTemplate, BlockTemplateBlock } from '@/lib/block-template';

// story #4202·#4203 — 플랫폼 사이클형 프리셋(event_definitions.org_id IS NULL · `preset.marketing.*`·`preset.workflow.*`)의
// 이름·설명을 로케일별로. 마케팅은 ko = 시드 원문, 워크플로우는 ko·en 모두 유나 확정 새 문안(시드는 언어가 섞여
// 있어 원문이 기준이 아니다 — ko 화면에 «Kanban Flow», en 화면에 «칸반 심플»). 시드는 한 언어뿐이라
// 원문을 그대로 그리면 en 화면에도 한국어가 나온다. 플랫폼 프리셋은 key로 messages `recipePreset` 키를 찾고,
// 표에 없는 key·조직 커스텀 정의(org_id 있음)는 원문 그대로. ko 값 = 시드 원문(마케팅만 — BE 가드
// tests/test_4202_platform_preset_copy_keys_realdb.py가 key 전수·마케팅 ko 동일성을 잰다 — 새 프리셋 시드가 이 표 없이 들어오면 RED).
// 타입을 Record<string, string>으로 둔다 — verify-no-unused-i18n-keys 가드는 이 모양의 리터럴 테이블 값만 «읽힌 키»로 본다.
export const PLATFORM_PRESET_NAME_KEY: Record<string, string> = {
  'preset.marketing.newsletter': 'newsletterName',
  'preset.marketing.blog_article': 'blogArticleName',
  'preset.marketing.social_card_news': 'socialCardNewsName',
  'preset.marketing.social_text_post': 'socialTextPostName',
  'preset.marketing.video_production': 'videoProductionName',
  'preset.workflow.agent_solo': 'workflowAgentSoloName',
  'preset.workflow.solo': 'workflowSoloName',
  'preset.workflow.kanban': 'workflowKanbanName',
  'preset.workflow.kanban_simple': 'workflowKanbanSimpleName',
  'preset.workflow.scrum_3step': 'workflowScrum3StepName',
  'preset.workflow.two_step': 'workflowTwoStepName',
  'preset.workflow.three_step': 'workflowThreeStepName',
  'preset.workflow.loop_agency': 'workflowLoopAgencyName',
};

export const PLATFORM_PRESET_DESCRIPTION_KEY: Record<string, string> = {
  'preset.marketing.newsletter': 'newsletterDescription',
  'preset.marketing.blog_article': 'blogArticleDescription',
  'preset.marketing.social_card_news': 'socialCardNewsDescription',
  'preset.marketing.social_text_post': 'socialTextPostDescription',
  'preset.marketing.video_production': 'videoProductionDescription',
  'preset.workflow.agent_solo': 'workflowAgentSoloDescription',
  'preset.workflow.solo': 'workflowSoloDescription',
  'preset.workflow.kanban': 'workflowKanbanDescription',
  'preset.workflow.kanban_simple': 'workflowKanbanSimpleDescription',
  'preset.workflow.scrum_3step': 'workflowScrum3StepDescription',
  'preset.workflow.two_step': 'workflowTwoStepDescription',
  'preset.workflow.three_step': 'workflowThreeStepDescription',
  'preset.workflow.loop_agency': 'workflowLoopAgencyDescription',
};

type PresetLike = { key: string; name?: string | null; description?: string | null; org_id?: string | null };
type Translate = (key: string) => string;

function platformKey(table: Record<string, string>, def: PresetLike): string | undefined {
  // org_id가 없는 응답(구 타입)은 플랫폼으로 치지 않는다 — 조직 정의를 번역문으로 덮지 않는 쪽으로 기운다.
  return def.org_id === null ? table[def.key] : undefined;
}

/** 화면 이름. 번역 키가 없으면 원문 name, 그것도 비면 key(기존 `name || key`와 같다). */
export function presetName(def: PresetLike, t: Translate): string {
  const k = platformKey(PLATFORM_PRESET_NAME_KEY, def);
  return k ? t(k) : def.name || def.key;
}

/** 화면 설명. 번역 키가 없으면 원문 description(없으면 빈 문자열). */
export function presetDescription(def: PresetLike, t: Translate): string {
  const k = platformKey(PLATFORM_PRESET_DESCRIPTION_KEY, def);
  return k ? t(k) : def.description ?? '';
}

// story #4209(유나 확정 문안) — 단계 설명(stage_metadata[stage].action). 키 = «프리셋 key:stage». 마케팅 ko = 시드 원문,
// 워크플로우 ko·en = 새 문안(원문의 내부어를 걷음). 같은 문장을 쓰는 워크플로우 단계(배정·제출·검토)는 한 키를 공유한다.
// BE 짝 가드(test_4202_platform_preset_copy_keys_realdb.py)가 시드의 action 있는 단계 전수 ↔ 이 표를 잰다.
export const PLATFORM_PRESET_ACTION_KEY: Record<string, string> = {
  'preset.marketing.blog_article:concept_confirmed': 'blogArticleActionConceptConfirmed',
  'preset.marketing.blog_article:draft': 'blogArticleActionDraft',
  'preset.marketing.blog_article:editing': 'blogArticleActionEditing',
  'preset.marketing.blog_article:pending_approval': 'blogArticleActionPendingApproval',
  'preset.marketing.blog_article:publish_checked': 'blogArticleActionPublishChecked',
  'preset.marketing.blog_article:published': 'blogArticleActionPublished',
  'preset.marketing.blog_article:verification': 'blogArticleActionVerification',
  'preset.marketing.newsletter:campaign_created': 'newsletterActionCampaignCreated',
  'preset.marketing.newsletter:collect': 'newsletterActionCollect',
  'preset.marketing.newsletter:draft': 'newsletterActionDraft',
  'preset.marketing.newsletter:review': 'newsletterActionReview',
  'preset.marketing.newsletter:send_checked': 'newsletterActionSendChecked',
  'preset.marketing.newsletter:send_requested': 'newsletterActionSendRequested',
  'preset.marketing.social_card_news:budget_approved': 'socialCardNewsActionBudgetApproved',
  'preset.marketing.social_card_news:concept_confirmed': 'socialCardNewsActionConceptConfirmed',
  'preset.marketing.social_card_news:draft': 'socialCardNewsActionDraft',
  'preset.marketing.social_card_news:editing': 'socialCardNewsActionEditing',
  'preset.marketing.social_card_news:live_generation': 'socialCardNewsActionLiveGeneration',
  'preset.marketing.social_card_news:pending_approval': 'socialCardNewsActionPendingApproval',
  'preset.marketing.social_card_news:published': 'socialCardNewsActionPublished',
  'preset.marketing.social_card_news:verification': 'socialCardNewsActionVerification',
  'preset.marketing.social_text_post:concept_confirmed': 'socialTextPostActionConceptConfirmed',
  'preset.marketing.social_text_post:draft': 'socialTextPostActionDraft',
  'preset.marketing.social_text_post:editing': 'socialTextPostActionEditing',
  'preset.marketing.social_text_post:pending_approval': 'socialTextPostActionPendingApproval',
  'preset.marketing.social_text_post:published': 'socialTextPostActionPublished',
  'preset.marketing.video_production:animatic': 'videoProductionActionAnimatic',
  'preset.marketing.video_production:concept_confirmed': 'videoProductionActionConceptConfirmed',
  'preset.marketing.video_production:draft': 'videoProductionActionDraft',
  'preset.marketing.video_production:editing': 'videoProductionActionEditing',
  'preset.marketing.video_production:live_generation': 'videoProductionActionLiveGeneration',
  'preset.marketing.video_production:pending_approval': 'videoProductionActionPendingApproval',
  'preset.marketing.video_production:published': 'videoProductionActionPublished',
  'preset.marketing.video_production:structure_passed': 'videoProductionActionStructurePassed',
  'preset.marketing.video_production:verification': 'videoProductionActionVerification',
  'preset.workflow.agent_solo:execute': 'workflowAgentSoloActionExecute',
  'preset.workflow.agent_solo:received': 'workflowAgentSoloActionReceived',
  'preset.workflow.agent_solo:report': 'workflowAgentSoloActionReport',
  'preset.workflow.kanban:assign_step_1': 'workflowActionAssign',
  'preset.workflow.kanban_simple:done_check': 'workflowKanbanSimpleActionDoneCheck',
  'preset.workflow.kanban_simple:in_progress': 'workflowKanbanSimpleActionInProgress',
  'preset.workflow.kanban_simple:task_created': 'workflowKanbanSimpleActionTaskCreated',
  'preset.workflow.loop_agency:brief_doc_approval': 'workflowLoopAgencyActionBriefDocApproval',
  'preset.workflow.loop_agency:execute': 'workflowLoopAgencyActionExecute',
  'preset.workflow.loop_agency:generate_variants': 'workflowLoopAgencyActionGenerateVariants',
  'preset.workflow.loop_agency:goal_hypothesis': 'workflowLoopAgencyActionGoalHypothesis',
  'preset.workflow.loop_agency:loop_decision': 'workflowLoopAgencyActionLoopDecision',
  'preset.workflow.loop_agency:track_and_learn': 'workflowLoopAgencyActionTrackAndLearn',
  'preset.workflow.scrum_3step:implementation': 'workflowScrum3StepActionImplementation',
  'preset.workflow.scrum_3step:kickoff': 'workflowScrum3StepActionKickoff',
  'preset.workflow.scrum_3step:qa_review': 'workflowScrum3StepActionQaReview',
  'preset.workflow.solo:assign_step_1': 'workflowActionAssign',
  'preset.workflow.three_step:assign_step_1': 'workflowActionAssign',
  'preset.workflow.three_step:review_step_2': 'workflowActionReview',
  'preset.workflow.three_step:review_step_3': 'workflowThreeStepActionReviewStep3',
  'preset.workflow.three_step:submit_step_1': 'workflowActionSubmit',
  'preset.workflow.two_step:assign_step_1': 'workflowActionAssign',
  'preset.workflow.two_step:review_step_2': 'workflowActionReview',
  'preset.workflow.two_step:submit_step_1': 'workflowActionSubmit',
};

/** 단계 설명. 플랫폼 프리셋이고 표에 있으면 messages 문안, 아니면 원문 action, 그것도 없으면 stage slug(기존 `action ?? stage`). */
export function presetAction(def: PresetLike, stage: string, rawAction: string | null | undefined, t: Translate): string {
  const k = def.org_id === null ? PLATFORM_PRESET_ACTION_KEY[`${def.key}:${stage}`] : undefined;
  return k ? t(k) : rawAction ?? stage;
}

/** 플랫폼 사이클형 프리셋인지(이름 표에 있는 key · org_id null) — 채팅 이벤트 카드 문안을 로케일로 바꿀 대상. */
export function isLocalizedPlatformPreset(def: PresetLike | null | undefined): def is PresetLike {
  return !!def && def.org_id === null && Object.hasOwn(PLATFORM_PRESET_NAME_KEY, def.key);
}

/**
 * story #4209(유나 확정) — 플랫폼 마케팅·워크플로우 프리셋의 채팅 이벤트 카드 문안을 로케일로. 시드 block_template은 한
 * 언어뿐이고(«영상 제작 워크플로우»·«**{{label.stage}}** 단계로 넘어갔습니다»·«Kanban Flow»·«{{payload.stage}}» 원문) 모양은 모두
 * 같다(header · 단계가 든 text · «대상» 필드 — BE 짝 가드가 이 모양을 핀). 조직 커스텀 정의는 원문 그대로.
 * - header → «{이름} 워크플로우»(이름 = presetName, 새 문안 대신 규칙 하나)
 * - 단계 자리(`{{label.stage}}`·`{{payload.stage}}`)가 든 text → 한 템플릿(단계 = 단계 라벨)
 * - 필드 라벨 «대상» → 로케일 «대상/Target»(값 자리는 그대로)
 */
// PR #4575 까디르·유나 QA — 플랫폼 프리셋 시드(마케팅 0398 계열·워크플로우 0260)의 카드 모양은 두 가지뿐이다: [머리말 1 ·
// 단계 문장 1 · «대상» 필드 1]. 그 **정확한 모양**일 때만 통째로 로케일 문안으로 바꾸고, 아니면 원문 그대로 둔다 — 예전엔
// 머리말 전부·단계 자리가 든 text 전부를 바꿔, 시드 본문에 다른 문구가 같이 있으면(`… ; 사유 {{payload.reason}}`) 조용히
// 사라졌다. BE 짝 가드(test_4202)가 시드 전수가 이 모양인지 같은 목록으로 잰다(모양 밖 새 시드 = RED).
export const SEED_STAGE_TEXTS: readonly string[] = ['**{{label.stage}}** 단계로 넘어갔습니다', '**{{payload.stage}}** 로 넘어갔습니다'];
// 워크플로우 시드의 «대상» 값은 `story <UUID>` 원문을 그렸다(유나 반려) — 마케팅과 같은 일감 라벨(제목 링크)로 바꾼다.
export const SEED_TARGET_VALUES: readonly string[] = ['{{label.work_item_target}}', '{{payload.work_item_type}} {{payload.work_item_id}}'];
const TARGET_VALUE = '{{label.work_item_target}}';

function isKnownSeedCardShape(template: BlockTemplate): boolean {
  const [header, text, fields, ...rest] = template.blocks;
  return rest.length === 0
    && header?.type === 'header'
    && text?.type === 'text' && SEED_STAGE_TEXTS.includes(text.text)
    && fields?.type === 'fields' && fields.fields.length === 1
    && fields.fields[0]!.label === SEED_TARGET_LABEL && SEED_TARGET_VALUES.includes(fields.fields[0]!.value);
}

export function localizePresetBlockTemplate(
  template: BlockTemplate,
  def: PresetLike | null | undefined,
  strings: { header: string; body: string | null; targetLabel: string },
): BlockTemplate {
  if (!isLocalizedPlatformPreset(def) || !isKnownSeedCardShape(template)) return template;
  return {
    blocks: template.blocks.map((block): BlockTemplateBlock => {
      if (block.type === 'header') return { ...block, text: strings.header };
      // 단계 값이 없으면(body null) 원문 그대로 — 빈 굵은 글씨를 만들지 않는다.
      if (block.type === 'text') return strings.body !== null ? { ...block, text: strings.body } : block;
      if (block.type === 'fields') return { ...block, fields: block.fields.map((f) => ({ ...f, label: strings.targetLabel, value: TARGET_VALUE })) };
      return block;
    }),
  };
}

/** 시드 block_template의 대상 필드 라벨(한국어 시드 원문) — 이 값일 때만 로케일 라벨로 바꾼다. */
export const SEED_TARGET_LABEL = '대상';
