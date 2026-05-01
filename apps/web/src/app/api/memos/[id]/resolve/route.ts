import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createMemoRepository, isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const dbClient = isOssMode() ? undefined : (me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase);
    const repo = await createMemoRepository();
    const service = new MemoService(repo);
    const memo = await service.resolve(id, me.id);
    return apiSuccess(memo);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
