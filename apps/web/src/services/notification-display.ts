export const NOTIFICATION_TYPE_ICONS: Record<string, string> = {
  story: '📌',
  memo: '💬',
  reward: '🏆',
  info: 'ℹ️',
  warning: '⚠️',
  system: '🔧',
};

export const INBOX_FILTER_TYPES = ['', 'story', 'memo', 'reward', 'info', 'warning', 'system'] as const;

export function getInboxNotificationLabel(
  t: (key: string) => string,
  type: string,
) {
  switch (type) {
    case 'story':
      return t('filter_story');
    case 'memo':
      return t('filter_memo');
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
