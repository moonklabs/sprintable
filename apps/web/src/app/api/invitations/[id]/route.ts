import { apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

/** DELETE /api/invitations/[id] — OSS 미지원 */
export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiSuccess({ ok: true, skipped: true });
}
