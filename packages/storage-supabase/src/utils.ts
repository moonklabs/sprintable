import { NotFoundError, ForbiddenError } from '@sprintable/core-storage';

export function mapSupabaseError(error: { code?: string; message: string }): Error {
  if (error.code === 'PGRST116') return new NotFoundError(error.message);
  if (error.code === '42501') return new ForbiddenError('Permission denied');
  return new Error(error.message);
}
