import { apiError } from '@/lib/api-response';

/** GET — 내 웹훅 설정 목록 */
export async function GET() {
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}

/** PUT — 웹훅 설정 upsert */
export async function PUT() {
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}

/** DELETE — 웹훅 설정 삭제 (admin만) */
export async function DELETE() {
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}
