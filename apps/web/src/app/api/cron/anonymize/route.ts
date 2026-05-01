import { apiSuccess, apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

const CRON_SECRET = process.env.CRON_SECRET;

/** POST — 30일 경과 탈퇴 유저 PII 익명화 + auth 삭제 (cron에서 호출) */
export async function POST(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  // 크론 인증
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Invalid cron secret', 401);
  }

  // SaaS overlay에서 처리
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}
