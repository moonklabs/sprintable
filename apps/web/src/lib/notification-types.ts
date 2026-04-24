export const NOTIFICATION_TYPES = [
  // semantic (legacy)
  'memo', 'story', 'task', 'reward', 'info', 'warning', 'system', 'standup_reminder',
  // action-specific
  'story_assigned', 'memo_reply', 'memo_mention',
  'task_assigned', 'task_completed', 'sprint_closed', 'invitation',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];
