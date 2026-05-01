import { apiError } from '@/lib/api-response';

/** POST — 계정 탈퇴 (OSS 미지원) */
export async function POST() {
  return apiError('NOT_IMPLEMENTED', 'Account deletion is not supported in OSS mode.', 501);
}
