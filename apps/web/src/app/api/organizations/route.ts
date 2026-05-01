import { apiError, apiSuccess } from '@/lib/api-response';

// POST /api/organizations — not supported in OSS mode
export async function POST() {
  return apiSuccess({ ok: true, skipped: true });
}
