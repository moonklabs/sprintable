import { NOTIFICATION_TYPES } from '@/lib/notification-types';

export const NOTIFICATION_TYPE_ICONS: Record<string, string> = {
  story: '📌',
  memo: '💬',
  task: '📋',
  reward: '🏆',
  info: 'ℹ️',
  warning: '⚠️',
  system: '🔧',
  memo_reply: '💬',
  memo_mention: '@',
  task_assigned: '📋',
  task_completed: '✅',
  sprint_closed: '🏁',
  standup_reminder: '🧍',
  story_assigned: '📌',
  invitation: '✉️',
};

export const INBOX_FILTER_TYPES = ['', ...NOTIFICATION_TYPES] as const;

export function getInboxNotificationLabel(
  t: (key: string) => string,
  type: string,
) {
  switch (type) {
    case 'story':
      return t('filter_story');
    case 'memo':
      return t('filter_memo');
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
    case 'memo_reply':
      return t('filter_memo_reply');
    case 'memo_mention':
      return t('filter_memo_mention');
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
    default:
      return type;
  }
}
