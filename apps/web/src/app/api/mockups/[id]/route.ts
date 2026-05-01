import { parseBody, updateMockupPageSchema } from '@sprintable/shared';
import { MockupService } from '@/services/mockup';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 목업 상세 (컴포넌트 포함) */
export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Mockups are not available in OSS mode.', 501);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const service = new MockupService(supabase);
    const mockup = await service.getById(id);
    return apiSuccess(mockup);
  } catch (err: unknown) { return handleApiError(err); }
}

/** PUT — 목업 수정 (컴포넌트 트리 일괄 교체) */
export async function PUT(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Mockups are not available in OSS mode.', 501);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, updateMockupPageSchema);
    if (!parsed.success) return parsed.response;

    const service = new MockupService(supabase);
    const result = await service.update(id, parsed.data);
    return apiSuccess(result);
  } catch (err: unknown) { return handleApiError(err); }
}

/** DELETE — 목업 소프트 삭제 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Mockups are not available in OSS mode.', 501);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const service = new MockupService(supabase);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
