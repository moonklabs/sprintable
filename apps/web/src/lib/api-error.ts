import { NotFoundError, ForbiddenError } from '@/services/sprint';
import { InvalidTransitionError } from '@/services/story';
import { apiError } from './api-response';

export function handleApiError(err: unknown) {
  if (err instanceof NotFoundError) {
    return apiError('NOT_FOUND', err.message, 404);
  }
  if (err instanceof ForbiddenError) {
    return apiError('FORBIDDEN', err.message, 403);
  }
  if (err instanceof InvalidTransitionError) {
    return apiError('INVALID_TRANSITION', err.message, 400);
  }

  // Supabase/Postgrest 에러 코드 직접 매핑
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === '42501') {
      return apiError('PERMISSION_DENIED', 'Permission denied', 403);
    }
    if (code === 'PGRST116') {
      return apiError('NOT_FOUND', 'Not found', 404);
    }
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return apiError('INTERNAL_ERROR', message, 400);
}
