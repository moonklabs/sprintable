import { handleApiError } from '@/lib/api-error';
import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

/** POST — 메모를 스토리로 전환 */
export async function POST(_request: Request) {
  try {
    if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Memo conversion is not available in OSS mode.', 501);
    // SaaS overlay가 이 핸들러를 오버라이드함
    return apiError('NOT_IMPLEMENTED', 'Memo conversion is not available in OSS mode.', 501);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
