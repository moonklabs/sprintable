export const NOTIFICATION_TYPES = ['memo', 'story', 'task', 'reward', 'info', 'warning', 'system'] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];
