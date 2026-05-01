import { apiError } from '@/lib/api-response';

/** DELETE /api/organizations/[id] — not supported in OSS mode */
export async function DELETE() {
  return apiError('NOT_IMPLEMENTED', 'Organization management is not supported in OSS mode.', 501);
}
