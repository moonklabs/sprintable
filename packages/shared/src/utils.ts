/**
 * 공유 유틸리티
 */
import type { StoryStatus } from './types';

export const STORY_STATUSES: readonly StoryStatus[] = [
  'backlog',
  'ready-for-dev',
  'in-progress',
  'in-review',
  'done',
] as const;

export function isValidStoryStatus(value: string): value is StoryStatus {
  return (STORY_STATUSES as readonly string[]).includes(value);
}
