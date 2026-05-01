import { apiError } from '@/lib/api-response';
import { isInternalDogfoodEnabled, readInternalDogfoodSession, resolveInternalDogfoodActor } from '@/lib/internal-dogfood';
import { createAdminClient } from '@/lib/db/admin';

export async function getInternalDogfoodContext() {
  if (!isInternalDogfoodEnabled()) {
    return { errorResponse: apiError('NOT_FOUND', 'Not found', 404) };
  }

  const session = await readInternalDogfoodSession();
  if (!session) {
    return { errorResponse: apiError('UNAUTHORIZED', 'Internal dogfood session required', 401) };
  }

  const actor = resolveInternalDogfoodActor(session.teamMemberId);
  if (!actor) {
    return { errorResponse: apiError('FORBIDDEN', 'Internal dogfood actor not allowed', 403) };
  }

  return { db: createAdminClient(), actor };
}
