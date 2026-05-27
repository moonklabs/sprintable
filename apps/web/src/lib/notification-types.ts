export const NOTIFICATION_TYPES = [
  // semantic (legacy)
  'story', 'task', 'reward', 'info', 'warning', 'system', 'standup_reminder',
  // action-specific
  'story_assigned',
  'task_assigned', 'task_completed', 'sprint_closed', 'invitation',
  'agent_joined',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];
