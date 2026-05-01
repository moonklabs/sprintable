import { apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/projects/:id/invitations — OSS 미지원 */
export async function POST(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
}
