import { parseBody, updateMockupPageSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { MockupService } from '@/services/mockup';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 목업 상세 (컴포넌트 포함) */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const service = new MockupService(supabase);
    const mockup = await service.getById(id);
    return apiSuccess(mockup);
  } catch (err: unknown) { return handleApiError(err); }
}

/** PUT — 목업 수정 (컴포넌트 트리 일괄 교체) */
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
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
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const service = new MockupService(supabase);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
