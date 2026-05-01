import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 버전 히스토리 */
export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess([]);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { data, error } = await supabase
      .from('mockup_versions')
      .select('id, version, created_at')
      .eq('page_id', id)
      .order('version', { ascending: false });

    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 버전 복원 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Mockups are not available in OSS mode.', 501);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json();
    if (!body.version_id) return ApiErrors.badRequest('version_id required');

    // 스냅샷 조회
    const { data: ver, error: verErr } = await supabase
      .from('mockup_versions')
      .select('snapshot')
      .eq('id', body.version_id)
      .eq('page_id', id)
      .single();

    if (verErr || !ver) return ApiErrors.notFound('Version not found');

    // 컴포넌트 교체
    await supabase.from('mockup_components').delete().eq('page_id', id);
    const snapshot = ver.snapshot as { components?: Array<Record<string, unknown>>; title?: string; scenarios?: Array<Record<string, unknown>> };
    if (snapshot.components?.length) {
      await supabase.from('mockup_components').insert(
        snapshot.components.map((c: Record<string, unknown>) => ({ ...c, page_id: id }))
      );
    }

    // title 복원
    if (snapshot.title) {
      await supabase.from('mockup_pages').update({ title: snapshot.title as string }).eq('id', id);
    }

    // scenarios 복원
    if (snapshot.scenarios) {
      await supabase.from('mockup_scenarios').delete().eq('page_id', id);
      if (snapshot.scenarios.length > 0) {
        await supabase.from('mockup_scenarios').insert(
          snapshot.scenarios.map((s: Record<string, unknown>) => ({ ...s, page_id: id, id: undefined }))
        );
      }
    }

    // version +1
    await supabase.rpc('increment_mockup_version', { _page_id: id });

    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
