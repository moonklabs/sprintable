import { NOTIFICATION_TYPES } from '@/lib/notification-types';

export const NOTIFICATION_TYPE_ICONS: Record<string, string> = {
  story: '📌',
  memo: '💬',
  task: '📋',
  reward: '🏆',
  info: 'ℹ️',
  warning: '⚠️',
  system: '🔧',
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
    default:
      return type;
  }
}
