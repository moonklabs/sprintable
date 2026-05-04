import { apiError } from '@/lib/api-response';

export async function POST() {
  return apiError('NOT_AVAILABLE', 'Seed is only available in OSS mode', 403);
}
