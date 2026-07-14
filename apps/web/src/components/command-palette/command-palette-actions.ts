/**
 * ⌘K Command Palette 액션 확장(story 4f991165) — 순수 명령 인벤토리 계층. 설계 SSOT: doc
 * `command-palette-actions-design`. v1 = 실행 배선이 실존하는 3개뿐(위임·게이트 결재·에이전트
 * 모집) — "실행 중단"·"증거 다시 수집"·"STEER 우선순위"는 배선 자체가 없어 no-fiction 원칙상
 * 인벤토리에 넣지 않는다(dead-path 금지, 후속 스토리로 분리).
 */

export interface ActionCommandTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

export interface StoryContext {
  storyId: string;
  storyTitle: string;
}

export interface ActionCommand {
  id: string;
  group: 'action';
  labelKey: 'actionDelegateStory' | 'actionGateDecision' | 'actionRecruitAgent';
  label: string;
  targetRoute: string;
  impact: string;
  /** 위험 명령(승인/반려) — 인라인 발사 없음, 게이트 결재 화면 경유가 곧 확인 단계.
   * amber로만 표시(red는 진짜 kill 전용 — learning-signal 규율). */
  danger: boolean;
}

/**
 * 명령 인벤토리 v1. "이 스토리를 위임"은 story context가 있을 때만 유효한 대상을 가지므로
 * context 없이는 지어내지 않고 생략한다(no-fiction) — context 있으면 맨 앞에 랭크.
 * 나머지 2개(게이트 결재·에이전트 모집)는 프로젝트 범위 명령이라 항상 실존.
 */
export function buildActionCommands(t: ActionCommandTranslator, context?: StoryContext): ActionCommand[] {
  const items: ActionCommand[] = [];
  if (context) {
    items.push({
      id: 'action-delegate-story',
      group: 'action',
      labelKey: 'actionDelegateStory',
      label: t('actionDelegateStory', { title: context.storyTitle }),
      targetRoute: `/board?story=${context.storyId}`,
      impact: t('actionDelegateStoryImpact', { title: context.storyTitle }),
      danger: false,
    });
  }
  items.push({
    id: 'action-gate-decision',
    group: 'action',
    labelKey: 'actionGateDecision',
    label: t('actionGateDecision'),
    targetRoute: '/inbox?tab=gates',
    impact: t('actionGateDecisionImpact'),
    danger: true,
  });
  items.push({
    id: 'action-recruit-agent',
    group: 'action',
    labelKey: 'actionRecruitAgent',
    label: t('actionRecruitAgent'),
    targetRoute: '/agents/recruiter',
    impact: t('actionRecruitAgentImpact'),
    danger: false,
  });
  return items;
}
