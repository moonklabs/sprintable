import { parseBody, createMockupPageSchema } from '@sprintable/shared';
import { MockupService } from '@/services/mockup';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkResourceLimit } from '@/lib/check-feature';
import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

/** GET — 목업 목록 (페이지네이션) */
export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess([]);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get('page') ?? '1');
    const limit = Number(searchParams.get('limit') ?? '20');

    const service = new MockupService(supabase);
    const result = await service.list(me.project_id, page, limit);
    return apiSuccess(result.items, { total: result.total, page, limit });
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 목업 생성 */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Mockups are not available in OSS mode.', 501);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    // Feature Gating
    const check = await checkResourceLimit(supabase, me.org_id, 'max_mockups', 'mockup_pages');
    if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Mockup limit reached', 403);

    const parsed = await parseBody(request, createMockupPageSchema);
    if (!parsed.success) return parsed.response;

    const service = new MockupService(supabase);
    const mockup = await service.create({
      org_id: me.org_id, project_id: me.project_id,
      slug: parsed.data.slug, title: parsed.data.title,
      category: parsed.data.category, viewport: parsed.data.viewport,
      created_by: me.id,
    });
    return apiSuccess(mockup, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
