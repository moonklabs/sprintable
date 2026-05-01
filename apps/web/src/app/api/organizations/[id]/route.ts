import { apiError, apiSuccess } from '@/lib/api-response';

/** DELETE /api/organizations/[id] — not supported in OSS mode */
export async function DELETE() {
  return apiSuccess({ ok: true, skipped: true });
}
