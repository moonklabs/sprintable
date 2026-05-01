import { apiSuccess, apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — OSS 모드에서는 null 반환 */
export async function GET(_request: Request, _ctx: RouteParams) {
  return apiSuccess(null);
}

/** PUT — OSS 미지원 */
export async function PUT(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'AI settings persistence is not supported in OSS mode. Set API keys via environment variables.', 501);
}

/** DELETE — OSS 미지원 */
export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'AI settings are not supported in OSS mode.', 501);
}
