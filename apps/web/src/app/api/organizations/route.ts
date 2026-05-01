import { apiError } from '@/lib/api-response';

// POST /api/organizations — not supported in OSS mode
export async function POST() {
  return apiError('NOT_IMPLEMENTED', 'Organization management is not supported in OSS mode.', 501);
}
