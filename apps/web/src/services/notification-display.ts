import { NOTIFICATION_TYPES } from '@/lib/notification-types';

export const NOTIFICATION_TYPE_ICONS: Record<string, string> = {
  story: '📌',
  task: '📋',
  reward: '🏆',
  info: 'ℹ️',
  warning: '⚠️',
  system: '🔧',
  task_assigned: '📋',
  task_completed: '✅',
  sprint_closed: '🏁',
  standup_reminder: '🧍',
  story_assigned: '📌',
  invitation: '✉️',
  agent_joined: '🤖',
};

export const INBOX_FILTER_TYPES = ['', ...NOTIFICATION_TYPES] as const;

export function getInboxNotificationLabel(
  t: (key: string) => string,
  type: string,
) {
  switch (type) {
    case 'story':
      return t('filter_story');
    case 'task':
      return t('filter_task');
    case 'reward':
      return t('filter_reward');
    case 'info':
      return t('filter_info');
    case 'warning':
      return t('filter_warning');
    case 'system':
      return t('filter_system');
    case 'task_assigned':
      return t('filter_task_assigned');
    case 'task_completed':
      return t('filter_task_completed');
    case 'sprint_closed':
      return t('filter_sprint_closed');
    case 'standup_reminder':
      return t('filter_standup_reminder');
    case 'story_assigned':
      return t('filter_story_assigned');
    case 'invitation':
      return t('filter_invitation');
    case 'agent_joined':
      return t('filter_agent_joined');
    default:
      return type;
  }
}

/**
 * raw event_type → 사람 카피 i18n 키 매핑 (e2608901 ⓑ).
 *
 * 알림 벨이 `payload.summary` 부재 시 raw event_type(`conversation.message_created` 등)을
 * 그대로 노출하던 근본(PO 실측 `notification-bell.tsx:253`)을 제거한다. dotted/colon/underscore
 * 표기를 모두 흡수하고, 미상 event_type은 generic 폴백(`eventFallback`)으로 떨어뜨려
 * **raw 노출 0**을 보장한다. 키는 `inbox` 네임스페이스에 위치(en/ko).
 */
const EVENT_TYPE_COPY_KEYS: Record<string, string> = {
  // 메시지/멘션
  'conversation.message_created': 'eventMessage',
  'message.created': 'eventMessage',
  'conversation:mention': 'eventMention',
  mention: 'eventMention',
  mentioned: 'eventMention',
  // 스토리
  'story.status_changed': 'eventStoryStatus',
  story_status_changed: 'eventStoryStatus',
  'story.assignee_changed': 'eventStoryAssignee',
  story_assigned: 'eventStoryAssigned',
  story: 'eventStory',
  // 태스크
  task_assigned: 'eventTaskAssigned',
  task_completed: 'eventTaskCompleted',
  task: 'eventTask',
  // 스프린트/에이전트/시스템
  sprint_closed: 'eventSprintClosed',
  agent_joined: 'eventAgentJoined',
  dispatched: 'eventDispatched',
  standup_reminder: 'eventStandupReminder',
  invitation: 'eventInvitation',
  reward: 'eventReward',
  warning: 'eventWarning',
  system: 'eventSystem',
  info: 'eventFallback',
};

/**
 * event_type을 사람이 읽는 카피로 변환한다. 알림 벨 헤드라인의 summary 폴백 전용.
 * 직접 매핑 → 도메인 prefix 규칙 → generic 폴백 순. 어떤 입력이든 raw event_type을
 * 반환하지 않는다(AC① raw 노출 0).
 */
export function getEventTypeCopy(
  t: (key: string) => string,
  eventType: string | null | undefined,
): string {
  if (!eventType) return t('eventFallback');
  const direct = EVENT_TYPE_COPY_KEYS[eventType];
  if (direct) return t(direct);
  // dotted/colon prefix 도메인 폴백 (신규 이벤트도 raw 노출 없이 흡수)
  if (eventType.startsWith('agent_deployment')) return t('eventAgentDeployment');
  if (eventType.startsWith('story')) return t('eventStory');
  if (eventType.startsWith('task')) return t('eventTask');
  if (eventType.startsWith('doc')) return t('eventDoc');
  if (eventType.startsWith('conversation') || eventType.startsWith('message'))
    return t('eventMessage');
  return t('eventFallback');
}

/**
 * 도달 사유(왜 이 건이 내 인박스에 왔나) i18n 키 추론 — interim FE (efcb3840 ⓐ).
 *
 * BE가 `Notification`에 actor/reason을 노출하기 전(자매 스토리 `e2608901` fold)까지의
 * FE 추론. **확실히 추론 가능한 type만** 사유 키를 반환하고 나머지는 null(사유 칩 생략·
 * graceful degrade — 틀린 사유를 만들지 않는다). raw event_type은 절대 노출하지 않는다.
 */
export function getNotificationReasonKey(type: string): string | null {
  switch (type) {
    case 'story_assigned':
    case 'task_assigned':
      return 'reasonAssigned';
    case 'invitation':
      return 'reasonInvited';
    case 'mention':
    case 'mentioned':
      return 'reasonMentioned';
    default:
      return null;
  }
}
